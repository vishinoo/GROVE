/**
 * Where the music plays when both the phone and the Mac could play it.
 *
 * Asked once, then kept, because asking every time is a question about the
 * plumbing and not about the music. Changed only when they say so ("move it to
 * my phone"), which is the music switch tool, and that carries the song across
 * rather than just changing the setting.
 *
 * Unset means not chosen yet, and the turn asks (brain.ts) rather than guess.
 */

import { vault } from './vault';

export type Place = 'mac' | 'phone';
const KEY = 'grove.musicPlace';
let cached: Place | null | undefined;

export async function musicPlace(): Promise<Place | null> {
  if (cached !== undefined) return cached;
  const stored = await vault.getItem(KEY).catch(() => null);
  cached = stored === 'mac' || stored === 'phone' ? stored : null;
  return cached;
}

export async function setMusicPlace(place: Place): Promise<void> {
  cached = place;
  await vault.setItem(KEY, place).catch(() => {});
}

/** For the turn's context, from what is already loaded. */
export function musicPlaceContext(): string {
  if (cached === undefined || cached === null) return 'Music plays on: not chosen yet.';
  return `Music plays on: their ${cached === 'mac' ? 'Mac' : 'phone'} (they chose; to move it, use the music switch tool).`;
}
