/**
 * What has gone wrong lately.
 *
 * Errors used to appear as a banner on the Talk screen and then vanish with
 * the next turn. That is the wrong place and the wrong lifetime for both of
 * the things an error has to do. Grove already *says* what went wrong, out
 * loud, at the moment it matters — "I can't reach your calendar" — so the
 * banner was telling you a second time, on a screen built to be glanced at,
 * about something you had already been told. And then it threw the record
 * away, so the one genuinely useful thing, "is this happening a lot", was
 * never answerable.
 *
 * So the spoken line stays where it is and this is the other half: a dated
 * list, on the screen you go to when you want to know whether something is
 * actually broken. Next to the self-check and the connections, which is what
 * you would reach for next.
 *
 * REPEATS COLLAPSE
 *
 * The same failure twenty times in a row is one fault, not twenty, and a list
 * of twenty identical lines tells you less than one line saying it happened
 * twenty times. Same wording within the window bumps a count and the
 * timestamp rather than adding a row — which is also what makes the count the
 * interesting part, the way it is for a friction in struggles.ts.
 */

import { vault } from './vault';

export type Trouble = {
  id: string;
  /** The message as it was said, which is what makes two of them "the same". */
  what: string;
  /** What was being attempted, when anything knows: an ability id, a screen. */
  where?: string;
  /** First time this wording was seen. */
  firstAt: string;
  /** Most recent. The one the list is sorted and dated by. */
  lastAt: string;
  /** How many times in a row. One is the common case and is not shown. */
  count: number;
};

/**
 * Kept, not shown. The screen shows five at a time; this is how far back
 * "show more" can reach, and it is small because a fault older than the last
 * couple of dozen is history, not a diagnosis.
 */
const LIMIT = 24;

/** Older than this is not a current problem whatever it was. */
const KEEP_FOR_MS = 14 * 86_400_000;

const KEY = 'grove:troubles:v1';

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

export async function loadTroubles(uid: string): Promise<Trouble[]> {
  try {
    const raw = await vault.getItem(storageKey(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Trouble[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - KEEP_FOR_MS;
    return parsed
      .filter((t) => t && typeof t.what === 'string' && new Date(t.lastAt).getTime() > cutoff)
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  } catch {
    return [];
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Records a failure.
 *
 * Serialised through a queue for the same reason every other store here is:
 * two failures landing in the same tick would otherwise each read the list
 * before the other wrote it, and one of them would be lost — which is exactly
 * the moment you would want both.
 */
export function noteTrouble(uid: string, what: string, where?: string): Promise<void> {
  if (!uid || uid === 'anon') return Promise.resolve();
  const text = what.trim().slice(0, 240);
  if (!text) return Promise.resolve();

  const run = queue.then(async () => {
    const now = new Date().toISOString();
    const current = await loadTroubles(uid);
    const same = current.find((t) => t.what === text);

    const next = same
      ? current.map((t) =>
          t.id === same.id ? { ...t, count: t.count + 1, lastAt: now, where: t.where ?? where } : t
        )
      : [
          {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            what: text,
            ...(where ? { where } : {}),
            firstAt: now,
            lastAt: now,
            count: 1,
          },
          ...current,
        ];

    /*
      Evicted by usefulness, not purely by age.

      Dropping the oldest row meant a burst of forty one-off errors pushed out
      the thing that had failed twenty times — and when it next happened it
      came back as a fresh row with a count of one, losing the only part of it
      worth knowing. Anything that has recurred is kept ahead of anything that
      has not, and age decides within each group.

      Two different sorts because there are two different jobs: this one
      chooses what survives, and the list is written back newest-first because
      that is how it is read.
    */
    const keep = [...next]
      .sort(
        (a, b) =>
          (b.count > 1 ? 1 : 0) - (a.count > 1 ? 1 : 0) || b.lastAt.localeCompare(a.lastAt)
      )
      .slice(0, LIMIT)
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt));

    try {
      await vault.setItem(storageKey(uid), JSON.stringify(keep));
    } catch {
      // Losing the record of a failure is not worth failing over.
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function forgetTroubles(uid: string): Promise<void> {
  await vault.removeItem(storageKey(uid)).catch(() => {});
}

/** "Today at 14:02", "Tue 21 Oct" — dated, because the date is the point. */
export function whenTrouble(at: string, now = new Date()): string {
  const then = new Date(at);
  if (Number.isNaN(then.getTime())) return '';
  const sameDay = then.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today ${then.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  }
  return then.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
