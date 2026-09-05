/**
 * What this particular build can actually do.
 *
 * Grove needs native code that Expo Go does not carry: speech recognition, and
 * the module that holds the audio session so the ring can reach us. Rather
 * than crash on a build without them — or, worse, show a trigger that silently
 * does nothing — every native dependency is probed once here and the UI is
 * told the truth.
 *
 * The probing is `require` inside try/catch rather than a static import on
 * purpose. These packages call `requireNativeModule` at load time, which
 * throws when the native half is missing, and a static import would take the
 * whole bundle down before the first screen rendered.
 */

import { Platform } from 'react-native';

export type Capability = 'speech' | 'remote' | 'haptics';

export type CapabilityReport = {
  /** On-device speech recognition — the ear. */
  speech: boolean;
  /** The audio session + ring trigger module. */
  remote: boolean;
  haptics: boolean;
  /**
   * True only when every part of the always-on story is present. When false,
   * Grove still works — you type instead of talking, and the phone speaks the
   * reply — which is what makes it developable without a device build.
   */
  full: boolean;
  /** Plain-language explanation for the Settings screen. */
  missing: string[];
};

function probe(load: () => unknown): boolean {
  try {
    return load() != null;
  } catch {
    return false;
  }
}

/*
 * The `require`s below are the point of this file, not a shortcut.
 *
 * A static `import` is hoisted and evaluated before any of this runs, so on a
 * build without the native halves it would throw during module initialisation
 * and take the whole bundle down before the first screen rendered — which is
 * exactly the failure this module exists to prevent. They stay lazy.
 */
/* eslint-disable @typescript-eslint/no-require-imports */

let cached: CapabilityReport | null = null;

export function capabilities(): CapabilityReport {
  if (cached) return cached;

  const speech =
    Platform.OS !== 'web' &&
    probe(() => require('expo-speech-recognition').ExpoSpeechRecognitionModule);

  const remote =
    Platform.OS === 'ios' && probe(() => (require('grove-remote').isAvailable() ? true : null));

  const haptics = Platform.OS !== 'web' && probe(() => require('expo-haptics').impactAsync);

  const missing: string[] = [];
  if (!speech) missing.push('speech recognition');
  if (!remote && Platform.OS === 'ios') missing.push('the ring trigger');

  cached = { speech, remote, haptics, full: speech && remote, missing };
  return cached;
}
/* eslint-enable @typescript-eslint/no-require-imports */

export function has(capability: Capability): boolean {
  return capabilities()[capability];
}

/**
 * Why the app is in reduced mode, in a sentence a person can act on.
 *
 * There is exactly one cause in practice — running in Expo Go rather than a
 * development build — so the copy names the fix rather than the symptom.
 */
export function reducedModeReason(): string | null {
  const report = capabilities();
  if (report.full) return null;
  if (Platform.OS === 'web') {
    return 'The web preview can’t listen or reach your ring. Grove runs for real on iOS.';
  }
  // Android reaches here with nothing missing: `full` requires the ring, and
  // the ring is iOS-only, so it can never be true. Without this guard the
  // notice read "This build is missing nothing" — permanently, on both the
  // Talk and Settings screens. There is nothing to fix, so there is no notice.
  if (report.missing.length === 0) return null;
  return `This build is missing ${readableList(report.missing)}. Grove needs a development build for those — in Expo Go you can still type to it and hear it reply.`;
}

function readableList(items: string[]): string {
  if (items.length === 0) return 'nothing';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
