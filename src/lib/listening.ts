/**
 * What Grove has played, so "something like yesterday" has an answer.
 *
 * iOS does keep a play history, but only native code can read it, and adding
 * that means a new build. Until then this is the honest version: Grove
 * remembers the songs it put on itself. It knows nothing about what was played
 * straight from the Music app, and the tool that reads this says so.
 *
 * Kept on the phone, per account, like notes and memory.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type Played = { title: string; artist?: string; at: string };

/** A month of listening is plenty to answer "yesterday" or "last week". */
const LIMIT = 150;

const KEY = 'grove:listening:v1';

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

export async function loadPlayed(uid: string): Promise<Played[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(uid));
    const parsed = raw ? (JSON.parse(raw) as Played[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function recordPlayed(uid: string, title: string, artist?: string): Promise<void> {
  try {
    const entry: Played = { title, ...(artist ? { artist } : {}), at: new Date().toISOString() };
    const next = [entry, ...(await loadPlayed(uid))].slice(0, LIMIT);
    await AsyncStorage.setItem(storageKey(uid), JSON.stringify(next));
  } catch {
    // A song that plays but is not logged is a gap in history, not a failure.
  }
}

/** One line per song, newest first, dated so the model can find "yesterday". */
export function playedLines(played: Played[]): string {
  return played
    .map((p) => {
      const when = new Date(p.at).toLocaleString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      return `${when} — ${p.title}${p.artist ? ` by ${p.artist}` : ''}`;
    })
    .join('\n');
}
