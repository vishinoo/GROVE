/**
 * Whether the intro has been seen.
 *
 * Stored per device rather than per account, deliberately: this runs before
 * anyone has signed in, so there is no uid to namespace by yet. The cost is
 * that two people sharing a phone see the intro once between them, which is
 * the right trade for not showing a stranger's app a second time to the person
 * who already sat through it.
 *
 * Nothing here is sensitive, so it stays in AsyncStorage rather than the
 * Keychain — see secureStorage.ts for the things that don't.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const SEEN_KEY = 'grove.onboarded';

/**
 * Dev-only: send every launch through the intro, whatever storage says.
 *
 * Iterating on the intro otherwise means clearing AsyncStorage after every
 * reload. Gated on `__DEV__`
 * as well as the env flag, for the same reason the dev sign-in button is: a
 * stray EXPO_PUBLIC_ALWAYS_ONBOARD=1 must not be able to strand a shipped
 * build on the intro. Finishing still lands on /login, so this never locks
 * anyone out of the app.
 */
export const ALWAYS_SHOW_ONBOARDING =
  __DEV__ && process.env.EXPO_PUBLIC_ALWAYS_ONBOARD === '1';

export async function hasSeenOnboarding(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(SEEN_KEY)) === '1';
  } catch {
    // A storage failure should send someone through the intro again, not
    // strand them on a blank gate.
    return false;
  }
}

export async function markOnboardingSeen(): Promise<void> {
  await AsyncStorage.setItem(SEEN_KEY, '1').catch(() => {});
}

/** "Replay intro", for when the hardware walkthrough is worth seeing again. */
export async function resetOnboarding(): Promise<void> {
  await AsyncStorage.removeItem(SEEN_KEY).catch(() => {});
}
