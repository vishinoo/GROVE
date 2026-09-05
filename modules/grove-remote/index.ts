/**
 * The JS face of the native remote/route module.
 *
 * Everything here is written so that importing it on a build without the
 * native half — Expo Go, or the web export — is harmless. `requireNativeModule`
 * throws when the module is missing, so it is caught once at load and the rest
 * of the app asks `isAvailable()` rather than discovering the absence inside a
 * try/catch of its own.
 */

import { requireNativeModule } from 'expo-modules-core';
import type { EventSubscription } from 'expo-modules-core';

/** Every transport command a paired remote might send. */
export type RemoteCommand =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'stop'
  | 'next'
  | 'previous'
  | 'seek-forward'
  | 'seek-backward'
  /**
   * Not a transport command at all — a volume-down press, inferred from the
   * system volume falling. It arrives on the same event because by the time it
   * reaches JS it means the same thing: the user pressed their trigger. See
   * `setVolumeTrigger` for why this exists and what it costs.
   */
  | 'volume-down';

export type RemoteEvent = {
  command: RemoteCommand;
  /** Only on seek commands — how a press-and-hold is told from a tap. */
  phase?: 'begin' | 'end';
  at: number;
};

export type AudioRoute = {
  /** What the user would call it: "Glasses", "AirPods", "Speaker". */
  name: string;
  /** The raw AVAudioSession port type, shown in diagnostics. */
  port: string;
  /** Sound is leaving the phone for something worn. */
  isExternal: boolean;
  isBluetooth: boolean;
  /**
   * The route can also *hear*. False on an A2DP-only pair, which is the case
   * where the glasses play audio but the phone's own mic is still listening.
   */
  hasExternalMic: boolean;
  inputName: string;
  inputPort: string;
};

export type MusicResult = {
  ok: boolean;
  title?: string;
  artist?: string;
  count?: number;
  /** 'denied' when the library was refused, 'notFound' when nothing matched. */
  reason?: string;
};

type Native = {
  activate(playSilence: boolean): Promise<void>;
  playMusic(query: string): Promise<MusicResult>;
  controlMusic(action: string): Promise<{ ok: boolean; title?: string }>;
  nowPlaying(): { title: string; artist: string; playing: boolean };
  deactivate(): Promise<void>;
  isHolding(): boolean;
  getRoute(): AudioRoute;
  requestMicrophone(): Promise<boolean>;
  setVolumeTrigger(enabled: boolean): Promise<void>;
  setKeepAlive(playing: boolean): Promise<void>;
  isVolumeTriggerOn(): boolean;
  addListener(event: string, listener: (payload: never) => void): EventSubscription;
};

const native: Native | null = (() => {
  try {
    return requireNativeModule<Native>('GroveRemote');
  } catch {
    return null;
  }
})();

/** False in Expo Go and on web. The UI reports this rather than hiding it. */
export function isAvailable(): boolean {
  return native !== null;
}

/** Silence when unavailable, so callers never branch on the platform. */
const OFFLINE_ROUTE: AudioRoute = {
  name: 'Speaker',
  port: 'Speaker',
  isExternal: false,
  isBluetooth: false,
  hasExternalMic: false,
  inputName: '',
  inputPort: '',
};

/**
 * Hold the audio session and claim the remote.
 *
 * `playSilence` is what keeps the session alive with nothing to say, and it is
 * the whole reason the ring works with the screen locked — see the Swift for
 * why it is also the risky part.
 */
export async function activate(playSilence = true): Promise<void> {
  await native?.activate(playSilence);
}

export async function deactivate(): Promise<void> {
  await native?.deactivate();
}

/** Whether the ring can reach us right now. */
export function isHolding(): boolean {
  return native?.isHolding() ?? false;
}

export function getRoute(): AudioRoute {
  return native?.getRoute() ?? OFFLINE_ROUTE;
}

/**
 * Play from the user's own library.
 *
 * Resolves `{ ok: false }` rather than throwing when the native half is absent,
 * so the ability above it reports "not on this build" instead of crashing a
 * turn — the same contract every other function here keeps.
 */
export async function playMusic(query: string): Promise<MusicResult> {
  return (await native?.playMusic(query)) ?? { ok: false, reason: 'unavailable' };
}

export async function controlMusic(
  action: 'play' | 'pause' | 'next' | 'previous'
): Promise<boolean> {
  return Boolean((await native?.controlMusic(action))?.ok);
}

export function nowPlaying(): { title: string; artist: string; playing: boolean } {
  return native?.nowPlaying() ?? { title: '', artist: '', playing: false };
}

export async function requestMicrophone(): Promise<boolean> {
  return (await native?.requestMicrophone()) ?? false;
}

/**
 * Watch the system volume and treat a fall as a press.
 *
 * For rings that send no transport commands at all — only `VolumeDown`, which
 * iOS consumes itself and never delivers to an app. Off unless asked for,
 * because it takes volume-down away from the user and the phone's own
 * volume-down button fires it too; iOS reports the new level and never who
 * caused it, so the two cannot be told apart.
 */
export async function setVolumeTrigger(enabled: boolean): Promise<void> {
  await native?.setVolumeTrigger(enabled);
}

/**
 * Pause or resume the silence that holds the session.
 *
 * Paused for the length of a recognition, because iOS will not start the
 * recogniser's audio engine alongside it in the background. Must always be
 * resumed — the silence is what keeps Grove from being suspended.
 */
export async function setKeepAlive(playing: boolean): Promise<void> {
  await native?.setKeepAlive(playing);
}

export function isVolumeTriggerOn(): boolean {
  return native?.isVolumeTriggerOn() ?? false;
}

export function onRemoteCommand(listener: (event: RemoteEvent) => void): () => void {
  const sub = native?.addListener('onRemoteCommand', listener as (p: never) => void);
  return () => sub?.remove();
}

export function onRouteChange(listener: (route: AudioRoute) => void): () => void {
  const sub = native?.addListener('onRouteChange', listener as (p: never) => void);
  return () => sub?.remove();
}

/** A phone call takes the session; this fires when it is handed back. */
export function onInterruption(
  listener: (event: { type: 'began' | 'ended' }) => void
): () => void {
  const sub = native?.addListener('onInterruption', listener as (p: never) => void);
  return () => sub?.remove();
}
