/**
 * The things that keep going wrong.
 *
 * Every other memory in Grove records what is true. This one records friction —
 * a thing that goes wrong more than once — which is the only kind of memory
 * that earns its place by being about something the person cannot reliably do.
 *
 * It began as a tutor: a record of concepts someone did not understand, so a
 * quiz could test them on it. That was a different product wearing this one's
 * clothes, and the quiz is gone. What survives is the half that makes Grove
 * feel like it knows you — "you always forget your charger" — which costs one
 * storage read and rides in the prompt, so it is in mind at the moment the
 * thing is about to happen again.
 *
 * **Twice is the bar.** Everyone forgets something once. A list that records
 * the first time is a list of someone's bad days, which is the thing this must
 * never become; the count is the whole signal, and it is shown on screen
 * beside each line for the same reason.
 */

import { vault } from './vault';

export type Struggle = {
  id: string;
  /** The concept or the behaviour, in their own words where possible. */
  what: string;
  /** What it belongs to — a course, a project, a topic. Lower-cased. */
  about: string;
  /** The sentence that revealed it, kept because the wording is a clue. */
  said?: string;
  firstAt: string;
  /** Bumped every time it comes up again. Three times is a real problem. */
  raised: number;
  lastAt: string;
  /** Correct answers in a row. Two closes it; see the note above. */
  right: number;
  /** Set when it is closed. Kept rather than deleted — the history is the point. */
  gotItAt?: string;
};

/** Plenty for years of one degree. */
const LIMIT = 200;

/** Closed and older than this is history nobody is quizzing on. */
const KEEP_CLOSED_FOR_MS = 180 * 86_400_000;

const KEY = 'grove:struggles:v1';

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function loadStruggles(uid: string): Promise<Struggle[]> {
  try {
    const raw = await vault.getItem(storageKey(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Struggle[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let queue: Promise<unknown> = Promise.resolve();

function update(uid: string, change: (list: Struggle[]) => Struggle[]): Promise<Struggle[]> {
  const run = queue.then(async () => {
    const next = tidy(change(await loadStruggles(uid)));
    try {
      await vault.setItem(storageKey(uid), JSON.stringify(next));
    } catch {
      // Losing one costs a quiz question.
    }
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

function tidy(list: Struggle[]): Struggle[] {
  const cutoff = Date.now() - KEEP_CLOSED_FOR_MS;
  return list
    .filter((s) => !s.gotItAt || new Date(s.gotItAt).getTime() > cutoff)
    // Open first, then whatever came up most recently: a quiz should reach for
    // the live problems before the historical ones.
    .sort((a, b) => Number(Boolean(a.gotItAt)) - Number(Boolean(b.gotItAt)) || b.lastAt.localeCompare(a.lastAt))
    .slice(0, LIMIT);
}

/**
 * Something the same, however it was worded.
 *
 * "I always forget my charger" and "I keep forgetting my charger" are one
 * thing said twice, and recording them separately is
 * how one habit becomes four entries. Matched on
 * containment either direction, which is loose on purpose: a false merge costs
 * a shared counter, and a false split costs the whole point of counting.
 */
/** Everything recorded here, gone. */
export async function forgetAllStruggles(uid: string): Promise<void> {
  await vault.removeItem(storageKey(uid)).catch(() => {});
}

export function same(list: Struggle[], what: string): Struggle | undefined {
  const target = norm(what);
  if (target.length < 3) return undefined;
  return list.find((s) => {
    const theirs = norm(s.what);
    return theirs === target || theirs.includes(target) || target.includes(theirs);
  });
}

/** Records a gap, or counts an existing one again. */
export async function note(
  uid: string,
  what: string,
  about: string,
  said?: string
): Promise<{ list: Struggle[]; again: boolean }> {
  const clean = what.trim().slice(0, 140);
  if (!clean) return { list: await loadStruggles(uid), again: false };
  const stamp = new Date().toISOString();
  let again = false;

  const list = await update(uid, (current) => {
    const known = same(current, clean);
    if (!known) {
      return [
        {
          id: newId(),
          what: clean,
          about: about.trim().toLowerCase().slice(0, 60),
          ...(said ? { said: said.trim().slice(0, 240) } : {}),
          firstAt: stamp,
          raised: 1,
          lastAt: stamp,
          right: 0,
        },
        ...current,
      ];
    }
    again = true;
    return current.map((s) =>
      s.id === known.id
        ? {
            ...s,
            // Asking again after thinking you had it is the same gap reopening.
            raised: s.raised + 1,
            lastAt: stamp,
            right: 0,
            about: s.about || about.trim().toLowerCase().slice(0, 60),
            gotItAt: undefined,
          }
        : s
    );
  });
  return { list, again };
}

/** Still unresolved, worst first — raised most, then most recent. */
export function open(list: Struggle[]): Struggle[] {
  return list
    .filter((s) => !s.gotItAt)
    .sort((a, b) => b.raised - a.raised || b.lastAt.localeCompare(a.lastAt));
}

/**
 * The few worth having in mind right now.
 *
 * These go into the turn's prompt rather than into a quiz, and they are capped
 * hard: three is enough to be useful and ten is a list of someone's failings
 * read back to them, which is the thing this feature must never become.
 */
export function habits(list: Struggle[]): Struggle[] {
  return open(list).slice(0, 3);
}

/**
 * How the turn's prompt is told about them.
 *
 * Framed as something to help with at the moment it matters, and explicitly
 * not as a topic — the failure mode here is Grove bringing up that you skip the
 * gym while you are asking about the weather.
 */
export function frictionBlock(list: Struggle[]): string {
  const theirs = habits(list);
  if (theirs.length === 0) return '';
  return [
    'Things that go wrong for them more than once:',
    ...theirs.map((s) => `- ${s.what}${s.raised > 1 ? ` (${s.raised} times)` : ''}`),
    'Use these only when the thing is about to happen again — a word at the right moment. Never as a topic, never as a list, and never to tell them what they are like.',
  ].join('\n');
}

/** Unresolved and raised inside the window, for "this week". */
export function openSince(list: Struggle[], days: number): Struggle[] {
  const cutoff = Date.now() - days * 86_400_000;
  return open(list).filter((s) => new Date(s.lastAt).getTime() >= cutoff);
}

/** Narrowed to a course or topic, when they named one. */
export function about(list: Struggle[], subject: string): Struggle[] {
  const target = norm(subject);
  if (!target) return open(list);
  return open(list).filter((s) => norm(s.about).includes(target) || norm(s.what).includes(target));
}

/**
 * Marks an answer. Two in a row closes it; a wrong one resets the count.
 *
 * Returns whether that answer closed it, so the quiz can say so — "that's it
 * twice now, I'll stop asking" is the only moment in this whole feature where
 * the person gets to hear that they have finished something.
 */
export async function mark(uid: string, id: string, right: boolean): Promise<boolean> {
  let closed = false;
  await update(uid, (list) =>
    list.map((s) => {
      if (s.id !== id) return s;
      if (!right) return { ...s, right: 0, gotItAt: undefined, lastAt: new Date().toISOString() };
      const count = s.right + 1;
      closed = count >= 2;
      return {
        ...s,
        right: count,
        ...(closed ? { gotItAt: new Date().toISOString() } : {}),
        lastAt: new Date().toISOString(),
      };
    })
  );
  return closed;
}

/** Told outright that it has stopped being a problem. */
export async function gotIt(uid: string, id: string): Promise<Struggle[]> {
  return update(uid, (list) =>
    list.map((s) => (s.id === id ? { ...s, right: 2, gotItAt: new Date().toISOString() } : s))
  );
}

export async function forget(uid: string, id: string): Promise<Struggle[]> {
  return update(uid, (list) => list.filter((s) => s.id !== id));
}

/** The list as prompt, for the card on screen and for the model. */
export function studyBlock(list: Struggle[]): string {
  return list
    .map(
      (s, i) =>
        `${i + 1}. ${s.what}${s.about ? ` (${s.about})` : ''} — raised ${s.raised} time${s.raised === 1 ? '' : 's'}${s.said ? `, originally: "${s.said}"` : ''}`
    )
    .join('\n');
}
