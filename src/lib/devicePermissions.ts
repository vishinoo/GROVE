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
 * Each entry here asks iOS the question the row is really asking. Nothing is
 * requested at import time; the prompt appears when someone taps the button.
 */

import { ensureCalendarAccess, ensureRemindersAccess } from './deviceCalendar';

/** Thrown so the screen can say what to do rather than showing a dead button. */
export class PermissionUnavailable extends Error {}

/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * The native module, or null on a build without it.
 *
 * Lazy for the reason capabilities.ts is lazy: a static import is hoisted and
 * evaluated before the first screen renders, so on Expo Go it would take the
 * whole bundle down rather than degrade.
 */
function remote(): typeof import('grove-remote') | null {
  try {
    return require('grove-remote') as typeof import('grove-remote');
  } catch {
    return null;
  }
}

/**
 * Music and Maps live in the Swift module, so a build made before those calls
 * existed has the module but not the function. Checked rather than assumed —
 * calling straight through would throw "not a function" at someone who only
 * tapped a button, and the honest answer is that this build is too old.
 */
async function viaRemote(name: 'requestMusicAccess' | 'requestLocationAccess'): Promise<boolean> {
  const native = remote() as Record<string, unknown> | null;
  if (!native) {
    throw new PermissionUnavailable('This needs a development build. Expo Go cannot reach it.');
  }
  const fn = native[name];
  if (typeof fn !== 'function') {
    throw new PermissionUnavailable('This build predates that permission. Rebuild to enable it.');
  }
  return Boolean(await (fn as () => Promise<boolean>)());
}

/**
 * Messages has no permission to grant.
 *
 * iOS never lets an app read Messages, and composing one opens a share sheet at
 * the point of use with nothing to authorise beforehand. So the row is marked
 * connected without a prompt — a dialogue that does not exist cannot be shown,
 * and pretending otherwise would be the same lie in a new place.
 */
const GRANTERS: Record<string, () => Promise<boolean>> = {
  calendar: ensureCalendarAccess,
  reminders: ensureRemindersAccess,
  music: () => viaRemote('requestMusicAccess'),
  maps: () => viaRemote('requestLocationAccess'),
  messages: async () => true,
};

export function isDevicePermission(key: string): boolean {
  return key in GRANTERS;
}

/**
 * Asks for one, returning whether it was granted.
 *
 * A denial is a false, not a throw: the person tapped "Don't Allow", which is an
 * answer rather than a failure, and the screen says so without an error banner.
 */
export async function grantDevice(key: string): Promise<boolean> {
  const granter = GRANTERS[key];
  if (!granter) throw new PermissionUnavailable('Nothing to grant here.');
  return granter();
}
