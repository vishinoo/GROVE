/**
 * Getting the update you were told was published.
 *
 * `fallbackToCacheTimeout: 0` in app.config.js means expo-updates never makes
 * anyone wait at launch: it starts the bundle it already has, downloads any new
 * one in the background, and runs that one **next** time. Which is the right
 * default — nobody should watch a spinner because a developer shipped something
 * — and it quietly breaks the only sentence anyone cares about:
 *
 *   "I pushed an update, you'll have it when you open it."
 *
 * You will not. You will have it the time after that, and nothing on screen
 * says so, so the honest-looking conclusion is that the update never shipped.
 * That cost a morning: an update published, the app opened, and Settings still
 * showing the previous bundle's id.
 *
 * So this closes the gap at the one moment it is safe to close it.
 *
 * WHY ONLY AT LAUNCH
 *
 * `reloadAsync` restarts the JavaScript. At the gate, before the first screen,
 * there is nothing to lose — no audio session, no turn in flight, no half-read
 * confirmation. A second later there might be all three, and a reload then
 * would abandon an answer mid-sentence and drop the session that the ring
 * reaches Grove through. There is no version of this that is worth doing
 * mid-use, so it is not offered mid-use.
 *
 * WHY IT IS BOUNDED
 *
 * The check is a network request, and the gate is the splash screen. Past a
 * few seconds the wait costs more than the newer bundle is worth, so it gives
 * up, lets the app start on what it has, and leaves the update for the next
 * launch exactly as before. A slow connection must never turn opening Grove
 * into staring at a spinner.
 */

import * as Updates from 'expo-updates';

export type Caught = 'reloading' | 'current' | 'unavailable' | 'failed';

/** Long enough for a check and a small bundle; short enough not to be noticed. */
const BOUND_MS = 4500;

/** Once per process. A reload starts a new one, so this is not a loop guard so much as a sanity one. */
let tried = false;

async function check(): Promise<Caught> {
  // In development the bundler serves the bundle and these throw rather than
  // answering; there is no update to be behind.
  if (__DEV__ || !Updates.isEnabled) return 'unavailable';

  try {
    const found = await Updates.checkForUpdateAsync();
    if (!found.isAvailable) return 'current';
    const fetched = await Updates.fetchUpdateAsync();
    if (!fetched.isNew) return 'current';
    await Updates.reloadAsync();
    return 'reloading';
  } catch {
    // No signal, a rolled-back release, a server that did not answer. None of
    // these is worth a word: the app runs on the bundle it has, which is what
    // it would have done anyway.
    return 'failed';
  }
}

/**
 * Catches up to the newest bundle, if that can be done quickly.
 *
 * Resolves either way, and resolving does not mean it reloaded — on 'reloading'
 * the caller is about to be restarted and should simply stop.
 */
export async function catchUpToLatest(): Promise<Caught> {
  if (tried) return 'unavailable';
  tried = true;
  return Promise.race([
    check(),
    new Promise<Caught>((resolve) => setTimeout(() => resolve('failed'), BOUND_MS)),
  ]);
}

/**
 * The same thing, from Settings, with no deadline.
 *
 * Someone who has just tapped "check for an update" has said they are willing
 * to wait, which is the one case where the bound above is wrong.
 */
export async function checkNow(): Promise<Caught> {
  tried = true;
  return check();
}

/** What is running now, for the Version card. */
export function runningLabel(): string {
  if (Updates.isEmbeddedLaunch) return 'built in (no OTA yet)';
  const id = (Updates.updateId ?? '').slice(0, 8);
  const when = Updates.createdAt ? Updates.createdAt.toLocaleString() : 'unknown date';
  return `${id || 'unknown'} · ${when}`;
}
