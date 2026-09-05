/**
 * The ring.
 *
 * Grove never talks to the ring. It cannot: iOS gives no third-party app
 * access to a Bluetooth HID device's key presses, in the foreground or out of
 * it. What it gives instead is the remote command centre — the transport
 * controls on a headset or a car stereo — delivered to whichever app is
 * currently "now playing". So Grove becomes that app (see the native module),
 * and a cheap BLE ring that pairs as a media remote reaches it for free.
 *
 * The consequence is that we do not know, and cannot know in advance, which
 * button sends what. A ring might emit `play`, or `toggle`, or `next`, or two
 * of them at once. This file therefore does three things:
 *
 *   1. Collapses every transport command into one semantic trigger, so the
 *      rest of the app never branches on media keys.
 *   2. De-duplicates, because a single physical press very often arrives as
 *      two commands in quick succession — `pause` immediately followed by
 *      `toggle` is the usual pair — and two events would start and instantly
 *      stop a listening session.
 *   3. Keeps the last few raw signals so the diagnostics panel can show the
 *      user what their particular ring actually emits. That is the only honest
 *      way to support hardware neither of us has documentation for.
 */

import {
  activate,
  deactivate,
  getRoute,
  isAvailable,
  isHolding,
  onInterruption,
  onRemoteCommand,
  isVolumeTriggerOn,
  onRouteChange,
  setKeepAlive as setNativeKeepAlive,
  requestMicrophone,
  setVolumeTrigger as setNativeVolumeTrigger,
  type AudioRoute,
  type RemoteCommand,
  type RemoteEvent,
} from 'grove-remote';

export type { AudioRoute, RemoteCommand } from 'grove-remote';

export type Trigger =
  /** A press. Start talking, or stop Grove talking. */
  | { kind: 'tap'; raw: RemoteCommand; at: number }
  /** Press-and-hold began — keep listening until it ends. */
  | { kind: 'hold-start'; raw: RemoteCommand; at: number }
  | { kind: 'hold-end'; raw: RemoteCommand; at: number };

/** One raw signal exactly as iOS delivered it, for diagnostics. */
export type Signal = {
  command: RemoteCommand;
  phase?: 'begin' | 'end';
  at: number;
  /**
   * Milliseconds since the previous raw signal, absent on the first one.
   *
   * This is the measurement COALESCE_MS is currently a guess at. A ring that
   * fires twice for one press shows a gap in the low tens; two deliberate
   * presses from a person sit in the hundreds. Reading a real one off the
   * diagnostics panel is how that window gets set from the hardware in
   * someone's hand rather than from taste.
   */
  gap?: number;
  /** Whether this one was swallowed as a duplicate of the press before it. */
  coalesced: boolean;
};

/**
 * Two commands closer together than this are one press.
 *
 * 400ms is generous. It is set by how hardware behaves rather than by how fast
 * a person can press twice: a remote that reports `pause` and `toggle` for one
 * tap delivers them microseconds apart, while a deliberate double-press from a
 * human is rarely under half a second. Erring long costs an occasional missed
 * second tap; erring short makes every single tap toggle listening twice, which
 * looks exactly like the trigger being broken.
 */
const COALESCE_MS = 400;

type Listener = (trigger: Trigger) => void;

const listeners = new Set<Listener>();
const signals: Signal[] = [];
let lastAt = 0;
/** Set by `reactivate`; volume presses inside this window are our own echo. */
let suppressVolumeUntil = 0;
let unsubscribes: (() => void)[] = [];
let resident = false;

/** The trigger is only real when the native module is here. */
export function isSupported(): boolean {
  return isAvailable();
}

/** Whether the ring can reach Grove right now. */
export function isArmed(): boolean {
  return resident && isHolding();
}

/**
 * Take the audio session and start listening for the ring.
 *
 * Called on sign-in and again on every foreground, because an audio session
 * lost to a phone call is not handed back on its own — and a Grove that has
 * silently stopped being the now-playing app looks identical to one that is
 * working right up until you press the ring.
 */
export async function arm(): Promise<boolean> {
  if (!isAvailable()) return false;

  await requestMicrophone();
  await activate(true);

  if (unsubscribes.length === 0) {
    unsubscribes = [
      onRemoteCommand(handleRemote),
      // A phone call takes the session. Re-arming on the far side is the
      // difference between the ring working for one call and working all day.
      onInterruption((event) => {
        if (event.type === 'ended') void activate(true);
      }),
    ];
  }

  resident = true;
  return true;
}

/**
 * Turn the volume-down fallback on or off.
 *
 * Kept separate from `arm` because it is not part of the normal story: it is
 * for hardware that cannot reach the remote command centre at all. The J09
 * ring this was written for sends `AC Back`, `VolumeDown` and `Sleep`, none of
 * which iOS forwards to an app — so without this its middle button is the only
 * one that can be made to work, and only indirectly.
 *
 * The cost is real and the Settings copy says so: while this is on, the
 * phone's own volume-down button triggers Grove too.
 */
export async function setVolumeFallback(enabled: boolean): Promise<void> {
  console.log('[grove:volume] setVolumeFallback', enabled, 'native available:', isAvailable());
  if (!isAvailable()) return;
  await setNativeVolumeTrigger(enabled);
}

/**
 * Re-take the audio session, right now.
 *
 * `arm` does this on foreground and after interruptions, but neither fires
 * when the trigger is pressed with the app already backgrounded — and iOS will
 * have quietly let the session lapse by then. Starting a recogniser against a
 * lapsed session is what produces CoreAudio's 'what' error, so this is called
 * immediately before recording rather than being trusted to still be true.
 */
export async function reactivate(): Promise<void> {
  if (!isAvailable()) return;
  // Re-configuring the session moves the reported output volume, and the
  // volume fallback cannot tell that movement from a press. Left unguarded it
  // triggers another listen, which re-takes the session, which moves the
  // volume again — a loop that presents as "stuck on Listening" while the
  // volume visibly bounces. So the fallback is blinded across the re-take.
  // Measured, not guessed: the recogniser's own engine start moves the volume
  // about 700ms after the press. 1.4s clears that with margin while keeping
  // the window in which a press cannot cancel a listen as short as possible.
  suppressVolumeUntil = Date.now() + 1400;
  await activate(true);
}

/**
 * Let go of the audio graph so the recogniser can have it, and take it back
 * afterwards.
 *
 * Every caller must pair these. The silence is what keeps Grove resident in
 * the background, so one that is paused and never resumed is a Grove that gets
 * suspended and a ring that stops working until the app is reopened.
 */
export async function setKeepAlive(playing: boolean): Promise<void> {
  if (!isAvailable()) return;
  await setNativeKeepAlive(playing);
}

/**
 * Whether the native volume observer is actually installed right now.
 *
 * Asked of the native module rather than inferred from the preference,
 * because the whole point is to catch the case where the two disagree — a
 * toggle that is on while nothing is listening looks identical, from the
 * outside, to hardware that sends nothing.
 */
export function isVolumeFallbackOn(): boolean {
  return isVolumeTriggerOn();
}

export async function disarm(): Promise<void> {
  for (const off of unsubscribes) off();
  unsubscribes = [];
  resident = false;
  await deactivate();
}

export function onTrigger(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onRoute(listener: (route: AudioRoute) => void): () => void {
  return onRouteChange(listener);
}

export function currentRoute(): AudioRoute {
  return getRoute();
}

/** The last few raw signals, newest first. Drives the diagnostics panel. */
export function recentSignals(): Signal[] {
  return [...signals].reverse();
}

export function clearSignals(): void {
  signals.length = 0;
}

/**
 * Where the raw hardware meets the app's one idea of "the user pressed it".
 *
 * Seek commands carry a begin/end phase, which is the only signal iOS gives
 * that distinguishes a hold from a tap — so a ring whose button sends seek
 * gets press-and-hold to talk, and every other ring gets tap to start and tap
 * to stop. Both are wired; which one a user gets depends on their hardware,
 * and the diagnostics panel tells them which they have.
 */
function handleRemote(event: RemoteEvent): void {
  const at = event.at * 1000;

  // Our own session re-take, not a finger. Recorded so the diagnostics panel
  // shows it was seen and discarded rather than silently dropped.
  if (event.command === 'volume-down' && Date.now() < suppressVolumeUntil) {
    record(event, true);
    return;
  }

  if (event.command === 'seek-forward' || event.command === 'seek-backward') {
    record(event, false);
    emit({
      kind: event.phase === 'begin' ? 'hold-start' : 'hold-end',
      raw: event.command,
      at,
    });
    return;
  }

  const duplicate = at - lastAt < COALESCE_MS;
  record(event, duplicate);
  if (duplicate) return;

  lastAt = at;
  emit({ kind: 'tap', raw: event.command, at });
}

function emit(trigger: Trigger): void {
  for (const listener of listeners) listener(trigger);
}

function record(event: RemoteEvent, coalesced: boolean): void {
  // Printed as well as recorded: the diagnostics panel needs the app open on
  // that screen, and the interesting presses happen with the phone locked.
  const sincePrevious = signals.length > 0 ? Math.round(event.at * 1000 - signals[signals.length - 1].at) : 0;
  console.log(
    '[grove:trigger]',
    event.command,
    event.phase ?? '',
    coalesced ? 'merged' : 'used',
    `+${sincePrevious}ms`
  );

  const at = event.at * 1000;
  const previous = signals[signals.length - 1];

  signals.push({
    command: event.command,
    phase: event.phase,
    at,
    // Measured against the previous *raw* signal rather than against the last
    // one that counted as a press, because the pair we are trying to see —
    // `pause` then `toggle` from a single tap — is precisely the case where
    // the second is discarded and would have nothing left to measure against.
    gap: previous ? Math.round(at - previous.at) : undefined,
    coalesced,
  });
  // A ring buffer, because this exists to be read on a diagnostics screen and
  // nobody needs the thousandth-most-recent button press.
  if (signals.length > 40) signals.shift();
}
