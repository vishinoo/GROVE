/**
 * Granting the permissions a device connection stands for.
 *
 * connections.ts already draws the distinction this file acts on: a 'device'
 * connection is an iOS permission granted on the phone, and an 'account' one is
 * an OAuth round trip brokered by Noctus. The Connections screen sent both down
 * the OAuth path, so tapping Connect on Calendar — a permission that has nothing
 * to do with any account — answered "OAuth not configured", which is true and
 * entirely beside the point.
 *
 * THREE OUTCOMES, NOT TWO
 *
 * "Granted" and "not granted" is not enough vocabulary. iOS only ever shows its
 * dialogue once per install, so a second tap after a refusal returns false
 * without asking anyone anything — and telling someone "not granted" when no
 * dialogue appeared reads as a broken button. Worse, a binary built before a
 * permission existed also returns false, and the fix there is a rebuild rather
 * than a trip to Settings.
 *
 * So: `granted`, `blocked` (refused earlier — Settings is the only way back),
 * and `unavailable` (this build cannot ask). Each gets its own sentence.
 */

import { ensureCalendarAccess, ensureRemindersAccess } from './deviceCalendar';

export type GrantOutcome = 'granted' | 'blocked' | 'unavailable';

/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * The module's JS wrapper, or null on a build without the native half.
 *
 * Lazy for the reason capabilities.ts is lazy: a static import is hoisted and
 * evaluated before the first screen renders, so on Expo Go it would take the
 * whole bundle down rather than degrade. The wrapper — not the raw native
 * object — because the wrapper is where the version-skew guards live.
 */
function remote(): typeof import('grove-remote') | null {
  try {
    return require('grove-remote') as typeof import('grove-remote');
  } catch {
    return null;
  }
}

/**
 * Music and Maps live in the Swift module, so a binary built before those calls
 * existed has the module but not the function. The wrapper returns null for
 * exactly that case, which is why it is distinguishable from a refusal here.
 */
async function viaRemote(
  name: 'requestMusicAccess' | 'requestLocationAccess'
): Promise<GrantOutcome> {
  const native = remote();
  const ask = native?.[name];
  if (typeof ask !== 'function') return 'unavailable';
  const granted = await ask();
  if (granted === null) return 'unavailable';
  return granted ? 'granted' : 'blocked';
}

/**
 * Messages has no permission to grant.
 *
 * iOS never lets an app read Messages, and composing one opens a share sheet at
 * the point of use with nothing to authorise beforehand. So the row is marked
 * granted without a prompt — a dialogue that does not exist cannot be shown,
 * and pretending otherwise would be the same lie in a new place.
 */
const GRANTERS: Record<string, () => Promise<GrantOutcome>> = {
  calendar: async () => ((await ensureCalendarAccess()) ? 'granted' : 'blocked'),
  reminders: async () => ((await ensureRemindersAccess()) ? 'granted' : 'blocked'),
  music: () => viaRemote('requestMusicAccess'),
  maps: () => viaRemote('requestLocationAccess'),
  messages: async () => 'granted',
};

export function isDevicePermission(key: string): boolean {
  return key in GRANTERS;
}

export async function grantDevice(key: string): Promise<GrantOutcome> {
  const granter = GRANTERS[key];
  if (!granter) return 'unavailable';
  try {
    return await granter();
  } catch {
    return 'unavailable';
  }
}

/** What to say, and whether iOS Settings is where this gets fixed. */
export function grantMessage(
  label: string,
  outcome: Exclude<GrantOutcome, 'granted'>
): { text: string; settings: boolean } {
  if (outcome === 'unavailable') {
    return {
      text: `This build can't ask for ${label} yet. It needs a rebuild — the JS updated over the air, the native half did not.`,
      settings: false,
    };
  }
  return {
    text: `${label} is turned off for Grove. iOS only asks once, so this is changed in Settings.`,
    settings: true,
  };
}
