/**
 * The ear.
 *
 * Wraps iOS's speech recogniser behind a shape the rest of the app can hold:
 * start, get partials, get one final transcript, stop. Everything package- and
 * platform-specific stays in this file, including the fact that the package
 * isn't present at all in Expo Go.
 *
 * Two decisions worth knowing about:
 *
 *   ON-DEVICE by default. Grove is listening more or less continuously and
 *   often in public, so shipping every utterance to Apple's servers is the
 *   wrong default. On-device recognition is slightly worse at proper nouns and
 *   much better at not being creepy; `preferOnDevice` can be turned off in
 *   Settings for accuracy.
 *
 *   NOT continuous. `continuous: false` lets the recogniser decide when you
 *   stopped talking and return a final result, which is exactly the endpointing
 *   Grove would otherwise have to write itself. A held ring press overrides it
 *   — see trigger.ts — because press-and-hold means "I am still talking".
 */

import { capabilities } from './capabilities';

export type ListenHandlers = {
  /** Fires repeatedly as you speak. Never treat as an instruction. */
  onPartial?: (text: string) => void;
  /** The recogniser's settled transcript. This is what gets acted on. */
  onFinal: (text: string) => void;
  /** Mic level, already normalised to 0–1 for the trigger's animation. */
  onLevel?: (level: number) => void;
  onError?: (message: string) => void;
  /** Recognition finished, for any reason. Always fires exactly once. */
  onEnd?: () => void;
};

type Subscription = { remove: () => void };

type SpeechModule = {
  start: (options: Record<string, unknown>) => void;
  stop: () => void;
  abort: () => void;
  requestPermissionsAsync: () => Promise<{ granted: boolean }>;
  getPermissionsAsync: () => Promise<{ granted: boolean }>;
  addListener: (event: string, listener: (payload: never) => void) => Subscription;
};

function speech(): SpeechModule | null {
  if (!capabilities().speech) return null;
  try {
    // Lazy for the same reason as capabilities.ts: the package resolves its
    // native module at import time and throws when there isn't one.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-speech-recognition').ExpoSpeechRecognitionModule as SpeechModule;
  } catch {
    return null;
  }
}

let subscriptions: Subscription[] = [];
let running = false;

export function isListening(): boolean {
  return running;
}

/**
 * The audio session the recogniser must leave behind, which is Grove's own.
 *
 * Passed on every start, and the reason music would not play.
 *
 * `expo-speech-recognition` configures the shared session itself, and given no
 * category it uses its own default: `.playAndRecord` in `.measurement` mode
 * with `[.defaultToSpeaker, .allowBluetooth]` — **no `.mixWithOthers`** — and
 * then calls `setActive(true, .notifyOthersOnDeactivation)`. A non-mixable
 * `playAndRecord` session going active interrupts whatever else is making
 * sound, so opening the microphone stopped the Music app.
 *
 * Which is the bug `configureSession` in grove-remote already carries a long
 * comment about having fixed — "start a song and it stops, every time" —
 * reintroduced from the other side, by the package rather than by us, and
 * invisible from the Swift because nothing in that file was wrong.
 *
 * Two things made it total rather than occasional:
 *
 *   EVERY REPLY OPENS THE MICROPHONE now, for the grace window. So the
 *   override ran after every single turn, about half a second after the song
 *   had been resumed — Grove said "Playing Wait For U" and then killed it.
 *
 *   AND IT STUCK. Nothing sets the category back. `setKeepAlive` only plays
 *   or pauses the silence; it does not reconfigure. So one press left the
 *   session non-mixable for the rest of the launch, with Grove's own
 *   keep-alive silence holding it open — and from then on nothing could play
 *   at all, which is why this looked like music being broken rather than like
 *   listening breaking music.
 *
 * Deliberately identical to `configureSession`, field for field, rather than
 * merely mixable: if the two differ the category is swapped on every listen,
 * and swapping category mid-conversation audibly clips the first syllable.
 * **If you change one, change both.**
 *
 * Plain strings rather than the package's enums, which are string constants of
 * exactly these values. Importing them would be a static import of the native
 * half, which is the one thing this file exists to avoid.
 */
const SESSION = {
  category: 'playAndRecord',
  mode: 'spokenAudio',
  categoryOptions: ['allowBluetooth', 'allowBluetoothA2DP', 'mixWithOthers', 'defaultToSpeaker'],
} as const;

export type ListenOptions = {
  /** Keep audio on the device rather than sending it to Apple. */
  preferOnDevice?: boolean;
  /**
   * Stay open until explicitly stopped, rather than ending at the first
   * natural pause. Used while the ring is being held down.
   */
  continuous?: boolean;
  lang?: string;
  /**
   * Words this person says that a general recogniser gets wrong: the names of
   * the people and projects in their life, course codes, Grove's own name.
   * Handed to iOS as hints, so "Noctus" stops arriving as "no tuss".
   */
  hints?: string[];
};

/**
 * Begin listening. Safe to call when already listening — the previous session
 * is torn down first, which is what makes a double ring-press behave like a
 * restart rather than stacking two recognisers on one microphone.
 */
export function startListening(handlers: ListenHandlers, options: ListenOptions = {}): boolean {
  const module = speech();
  if (!module) {
    handlers.onError?.('This build can’t listen. Grove needs a development build for that.');
    handlers.onEnd?.();
    return false;
  }

  stopListening();

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    running = false;
    clear();
    handlers.onEnd?.();
  };

  const listen = <T,>(event: string, fn: (payload: T) => void) => {
    subscriptions.push(module.addListener(event, fn as (p: never) => void));
  };

  listen<{ results?: { transcript: string }[]; isFinal?: boolean }>('result', (event) => {
    const text = event.results?.[0]?.transcript?.trim() ?? '';
    if (!text) return;
    if (event.isFinal) handlers.onFinal(text);
    else handlers.onPartial?.(text);
  });

  listen<{ error: string; message?: string }>('error', (event) => {
    // "no-speech" is the recogniser reporting silence, not a failure worth
    // showing — Grove is listening far more often than it is being spoken to.
    if (event.error === 'no-speech') return;
    handlers.onError?.(event.message || describeError(event.error));
  });

  // -2 is inaudible and 10 is shouting; the trigger wants 0–1.
  listen<{ value: number }>('volumechange', ({ value }) => {
    handlers.onLevel?.(Math.max(0, Math.min(1, (value + 2) / 12)));
  });

  listen('end', finish);
  listen('nomatch', () => handlers.onPartial?.(''));

  try {
    module.start({
      lang: options.lang ?? 'en-US',
      interimResults: true,
      continuous: options.continuous ?? false,
      requiresOnDeviceRecognition: options.preferOnDevice ?? true,
      addsPunctuation: true,
      // Keeps the session mixable, so opening the microphone does not stop
      // the music. See SESSION above — this is the whole fix.
      iosCategory: SESSION,
      // iOS caps how many it uses; the most important come first.
      ...(options.hints && options.hints.length > 0 ? { contextualStrings: options.hints.slice(0, 100) } : {}),
      volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
    });
    running = true;
    return true;
  } catch (error) {
    handlers.onError?.(error instanceof Error ? error.message : 'Couldn’t start listening.');
    finish();
    return false;
  }
}

/** Ask for a final transcript and wind down. */
export function stopListening(): void {
  const module = speech();
  if (running && module) {
    try {
      module.stop();
    } catch {
      // Already stopped, or the session went away with an interruption.
    }
  }
  running = false;
  clear();
}

/** Drop everything heard so far. Used when Grove is interrupted mid-sentence. */
export function abortListening(): void {
  const module = speech();
  if (running && module) {
    try {
      module.abort();
    } catch {
      // As above — nothing to abort is not an error.
    }
  }
  running = false;
  clear();
}

function clear(): void {
  for (const sub of subscriptions) {
    try {
      sub.remove();
    } catch {
      // A subscription whose module has gone is already removed.
    }
  }
  subscriptions = [];
}

function describeError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Grove doesn’t have permission to listen. Turn on Microphone and Speech Recognition in iOS Settings.';
    case 'network':
      return 'Speech recognition needed the network and couldn’t reach it.';
    case 'audio-capture':
      return 'Nothing is reaching the microphone. Check your glasses are connected.';
    case 'aborted':
      return 'Listening stopped.';
    default:
      return 'Grove couldn’t make that out.';
  }
}
