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
  | 'seek-backward';

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

type Native = {
  activate(playSilence: boolean): Promise<void>;
  deactivate(): Promise<void>;
  isHolding(): boolean;
  getRoute(): AudioRoute;
  requestMicrophone(): Promise<boolean>;
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

export async function requestMicrophone(): Promise<boolean> {
  return (await native?.requestMicrophone()) ?? false;
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
