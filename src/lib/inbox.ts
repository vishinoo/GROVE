/**
 * The capture inbox, and the focus session that defends it.
 *
 * One rule: capture, don't switch. A thought that arrives while you are doing
 * something else — email the PE guy, look up that paper, you promised Jason a
 * call — costs five seconds to say and nothing to act on. Pursuing it costs the
 * rest of the hour.
 *
 * WHY THIS IS NOT REMINDERS, NOTES OR MEMORY
 *
 * Reminders need a time and belong to iOS. Notes are long and are dictated on
 * purpose. The long memory is what Grove worked out about your life, written
 * by a model after the fact. This is none of those: a flat list of raw
 * thoughts, in your words, written the instant you say them, that you empty
 * later. The value is entirely in how little it asks of you at the moment of
 * capture — no date, no list, no category, no question back.
 *
 * The focus session is the other half. While one is running Grove knows what
 * you are meant to be doing, so anything off-topic gets captured and handed
 * back to you at the end instead of turning into a new errand.
 *
 * On the phone, per account, like notes and memory.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type Capture = {
  id: string;
  /** Exactly what they said, tidied only of filler like "capture". */
  text: string;
  at: string;
  /** What they were focused on when it arrived, if anything. */
  during?: string;
  doneAt?: string;
};

export type Focus = {
  /** What they are working on, in their words. */
  what: string;
  startedAt: string;
  /** When they said it would end, if they said. */
  until?: string;
};

/** Enough for months of thinking; small enough to load in a blink. */
const LIMIT = 300;

const KEY = 'grove:inbox:v1';
const FOCUS_KEY = 'grove:focus:v1';

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function loadInbox(uid: string): Promise<Capture[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(uid));
    const parsed = raw ? (JSON.parse(raw) as Capture[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function write(uid: string, items: Capture[]): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(uid), JSON.stringify(items.slice(0, LIMIT)));
  } catch {
    // A capture that fails to save is a lost thought, not a broken app — and
    // the caller has already said it out loud, which is the usual backup.
  }
}

/** Words people put in front of a thought that are not part of it. */
const FILLER =
  /^\s*(?:(?:hey|ok|okay)\s+)?(?:[a-z]{2,14},?\s+)?(?:please\s+)?(?:capture|jot down|jot|note down|note|write down|add|remember|put down|log)\b(?:\s+(?:this|that|it|down))?(?:\s*[:,-]\s*|\s+)/i;

export function tidy(said: string): string {
  return said.replace(FILLER, '').trim().replace(/^[:,-]\s*/, '') || said.trim();
}

export async function capture(uid: string, text: string, during?: string): Promise<Capture[]> {
  const clean = tidy(text).slice(0, 300);
  if (!clean) return loadInbox(uid);
  const next = [
    { id: newId(), text: clean, at: new Date().toISOString(), ...(during ? { during } : {}) },
    ...(await loadInbox(uid)),
  ];
  await write(uid, next);
  return next;
}

export function open(items: Capture[]): Capture[] {
  return items.filter((i) => !i.doneAt);
}

export async function complete(uid: string, id: string): Promise<Capture[]> {
  const next = (await loadInbox(uid)).map((i) =>
    i.id === id ? { ...i, doneAt: new Date().toISOString() } : i
  );
  await write(uid, next);
  return next;
}

export async function remove(uid: string, id: string): Promise<Capture[]> {
  const next = (await loadInbox(uid)).filter((i) => i.id !== id);
  await write(uid, next);
  return next;
}

/** The open capture that best matches some words, for ticking one off by voice. */
export function bestMatch(items: Capture[], said: string): Capture | undefined {
  const words = said
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length > 2);
  if (words.length === 0) return undefined;
  return open(items)
    .map((item) => {
      const text = item.text.toLowerCase();
      return { item, score: words.filter((w) => text.includes(w)).length };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.item;
}

/** One line each, newest first, for the model to read back. */
export function inboxLines(items: Capture[]): string {
  return open(items)
    .slice(0, 25)
    .map((i) => {
      const when = new Date(i.at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      return `- ${i.text} (${when}${i.during ? `, while on ${i.during}` : ''})`;
    })
    .join('\n');
}

/**
 * "For the next hour", "40 minutes", "half an hour" — as an end time.
 *
 * `readWhen` in deviceCalendar reads clock times and days, which is what a
 * reminder needs; a focus session is said as a length instead, and dropping it
 * left every session open-ended.
 */
export function endsIn(said: string, now = new Date()): Date | null {
  const t = said.toLowerCase();
  if (/half an hour|30 ?min/.test(t)) return new Date(now.getTime() + 30 * 60_000);
  if (/an hour|1 ?hour|next hour/.test(t)) return new Date(now.getTime() + 60 * 60_000);
  const hit = /(\d{1,3})\s*(minute|min|hour|hr)/.exec(t);
  if (hit) {
    const n = Number(hit[1]);
    const minutes = /hour|hr/.test(hit[2]) ? n * 60 : n;
    if (minutes > 0 && minutes <= 8 * 60) return new Date(now.getTime() + minutes * 60_000);
  }
  return null;
}

/* ----------------------------------------------------------------- focus */

export async function loadFocus(uid: string): Promise<Focus | null> {
  try {
    const raw = await AsyncStorage.getItem(`${FOCUS_KEY}:${uid}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Focus;
    if (!parsed?.what) return null;
    // A session nobody ended is over: four hours is longer than anyone sits
    // down for, and a stale one would have Grove refusing to help with
    // whatever they are actually doing tomorrow.
    const age = Date.now() - new Date(parsed.startedAt).getTime();
    if (age > 4 * 3_600_000) return null;
    if (parsed.until && Date.now() > new Date(parsed.until).getTime() + 30 * 60_000) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function setFocus(uid: string, focus: Focus | null): Promise<void> {
  try {
    if (focus) await AsyncStorage.setItem(`${FOCUS_KEY}:${uid}`, JSON.stringify(focus));
    else await AsyncStorage.removeItem(`${FOCUS_KEY}:${uid}`);
  } catch {
    // Losing the session means Grove stops defending it, not that it breaks.
  }
}

/** How long is left, said as a person would: "about 40 minutes". */
export function remaining(focus: Focus, now = new Date()): string {
  if (!focus.until) return '';
  const minutes = Math.round((new Date(focus.until).getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return 'time is up';
  if (minutes < 60) return `about ${minutes} minutes left`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `about ${hours} hour${hours === 1 ? '' : 's'} left`;
}
