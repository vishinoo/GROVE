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

export async function requestPermission(): Promise<boolean> {
  const module = speech();
  if (!module) return false;
  try {
    const existing = await module.getPermissionsAsync();
    if (existing.granted) return true;
    const asked = await module.requestPermissionsAsync();
    return asked.granted;
  } catch {
    return false;
  }
}

export type ListenOptions = {
  /** Keep audio on the device rather than sending it to Apple. */
  preferOnDevice?: boolean;
  /**
   * Stay open until explicitly stopped, rather than ending at the first
   * natural pause. Used while the ring is being held down.
   */
  continuous?: boolean;
  lang?: string;
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
