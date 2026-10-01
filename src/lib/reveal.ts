/**
 * The first week.
 *
 * Grove is worth nothing on the day it is installed and quite hard to replace a
 * month later, and the gap between those two facts is where people give up. So
 * for the first week it offers one thing a day that it could not have offered
 * the day before.
 *
 * WHAT THESE LINES ARE NOT
 *
 * They are not a feature tour. "I can write documents" is an advert, and an
 * advert read into your ear by something you are paying for is worse than
 * silence. Every line here says something about the person's own life — a name,
 * a promise, a date, a thing they said — which is the only proof that any of
 * this is working. If the thing it would need to say that is not there, nothing
 * is said and the day passes quietly.
 *
 * WHAT MAKES ONE EARNED
 *
 *   - The data behind it exists. Each discovery looks for something real and
 *     returns null when it finds nothing, so a quiet first week stays quiet.
 *   - It is at least as old as its day. Nothing from the week is offered on the
 *     first afternoon, because a week's worth of insight delivered at once is a
 *     monologue.
 *   - It is said once, ever, and at most one a day. The ids are stored, so
 *     reinstalling the thought is not possible and reopening the app is not an
 *     occasion.
 *
 * Nothing here costs a model call or a network request: it reads what Grove
 * already has on the phone. The calendar is deliberately left to attention.ts —
 * being told to leave is urgent, and this is not.
 */

import { vault } from './vault';

import { loadDocs } from './docs';
import { loadInbox, open as openCaptures } from './inbox';
import { loadLife, openCommitments, type Life } from './life';
import { loadFacts, type Fact } from './memory';
import { loadNotes, type Note } from './notes';

/** A discovery, ready to be said. */
export type Discovery = { id: string; say: string };

type Progress = {
  /** When Grove was first opened by this person. */
  firstAt: string;
  /** Discovery id to the day it was said, so none is repeated. */
  said: Record<string, string>;
};

const KEY = 'grove:reveal:v1';

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

async function loadProgress(uid: string, now: Date): Promise<Progress> {
  try {
    const raw = await vault.getItem(storageKey(uid));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Progress>;
      return {
        firstAt: typeof parsed.firstAt === 'string' ? parsed.firstAt : now.toISOString(),
        said: parsed.said && typeof parsed.said === 'object' ? parsed.said : {},
      };
    }
  } catch {
    // Losing this costs a week of small talk, not anything of substance.
  }
  const fresh = { firstAt: now.toISOString(), said: {} };
  await save(uid, fresh);
  return fresh;
}

async function save(uid: string, progress: Progress): Promise<void> {
  try {
    await vault.setItem(storageKey(uid), JSON.stringify(progress));
  } catch {
    // Worst case a line is offered twice. Nothing is lost.
  }
}

/** Whole days since first run, counting the first day as one. */
function dayNumber(firstAt: string, now: Date): number {
  const started = new Date(firstAt);
  const days = Math.floor((now.getTime() - started.getTime()) / 86_400_000);
  return days + 1;
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysOld(iso: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'long' });
}

/** Two or three names read better than a count, and prove more. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Everything a discovery is allowed to look at: all of it already on the phone. */
type Ground = {
  life: Life;
  facts: Fact[];
  captures: ReturnType<typeof openCaptures>;
  notes: Note[];
  documents: number;
  now: Date;
};

type Discoverer = {
  id: string;
  /** The earliest day this may be offered. */
  day: number;
  find: (ground: Ground) => string | null;
};

/**
 * Seven, in the order they become true rather than the order they were
 * thought of. A day with nothing to show is skipped, and its discovery stays
 * available for whenever its evidence turns up.
 */
const DISCOVERIES: Discoverer[] = [
  {
    // Day one is the only one whose evidence comes from being told rather than
    // noticed — and saying the names back is what makes the difference between
    // "I saved your answers" and "I was listening".
    id: 'people',
    day: 1,
    find: ({ life }) => {
      const named = [...life.entities]
        .sort((a, b) => b.mentions - a.mentions || b.lastSeen.localeCompare(a.lastSeen))
        .slice(0, 3)
        .map((e) => e.name);
      if (named.length < 2) return null;
      return `I've got ${listOf(named)} written down. Ask me what I know about any of them.`;
    },
  },
  {
    id: 'promise',
    day: 2,
    find: ({ life, now }) => {
      const owed = openCommitments(life).find((e) => daysOld(e.at, now) >= 1);
      if (!owed) return null;
      return `You said you'd ${lower(owed.title)}, on ${day(owed.at)}. Has that gone out?`;
    },
  },
  {
    id: 'sitting',
    day: 3,
    find: ({ captures, now }) => {
      const stale = captures.find((c) => daysOld(c.at, now) >= 2);
      if (!stale) return null;
      return `"${stale.text}" has been sitting in your list since ${day(stale.at)}. Still want it there?`;
    },
  },
  {
    // What they talk about, which nobody can see about themselves and which
    // Grove only knows because it kept the week rather than the last hour.
    id: 'running',
    day: 4,
    find: ({ life, now }) => {
      const week = life.episodes.filter((e) => daysOld(e.at, now) <= 7);
      if (week.length < 4) return null;
      const counts = new Map<string, number>();
      for (const episode of week) {
        for (const id of episode.about) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      if (!top || top[1] < 3) return null;
      const subject = life.entities.find((e) => e.id === top[0]);
      if (!subject) return null;
      return `${subject.name} has come up more than anything else this week — ${top[1]} times. Worth a look?`;
    },
  },
  {
    id: 'note',
    day: 5,
    find: ({ notes, now }) => {
      const kept = notes.find((n) => daysOld(n.createdAt, now) >= 1);
      if (!kept) return null;
      return `That note you recorded on ${day(kept.createdAt)} — "${kept.title}". Want the short version?`;
    },
  },
  {
    id: 'goal',
    day: 6,
    find: ({ facts }) => {
      const goal = facts.find((f) => f.kind === 'goal');
      if (!goal) return null;
      return `You told me ${lower(goal.value)}. Where are you with that?`;
    },
  },
  {
    // The week, stated plainly. The one line here about Grove rather than
    // about them, and it has earned the right by being a count of their own
    // things rather than a list of features.
    id: 'week',
    day: 7,
    find: ({ life, notes, documents }) => {
      const people = life.entities.filter((e) => e.kind === 'person').length;
      const projects = life.entities.filter((e) => e.kind === 'project').length;
      if (people + projects + life.episodes.length < 6) return null;
      const made = [
        people ? `${people} ${people === 1 ? 'person' : 'people'}` : '',
        projects ? `${projects} ${projects === 1 ? 'project' : 'projects'}` : '',
        life.episodes.length ? `${life.episodes.length} things that happened` : '',
        notes.length ? `${notes.length} ${notes.length === 1 ? 'note' : 'notes'}` : '',
        documents ? `${documents} ${documents === 1 ? 'document' : 'documents'}` : '',
      ].filter(Boolean);
      return `A week in: ${listOf(made)}. That's what I'm working from now, rather than starting from nothing every time.`;
    },
  },
];

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * How many days in they are, so the seventh can be recognised.
 *
 * Reads the same record the discoveries use, and creates it on first call —
 * which means the day Grove was first opened, not the day something first
 * thought to ask.
 */
export async function dayIn(uid: string, now = new Date()): Promise<number> {
  if (!uid || uid === 'anon') return 0;
  const progress = await loadProgress(uid, now);
  return dayNumber(progress.firstAt, now);
}

/**
 * The one discovery worth offering today, or nothing.
 *
 * Recorded as said before it is returned, because the caller is about to speak
 * it and a crash between the two is better than saying it twice.
 */
export async function nextDiscovery(uid: string, now = new Date()): Promise<Discovery | null> {
  if (!uid || uid === 'anon') return null;
  const progress = await loadProgress(uid, now);
  const today = dayStamp(now);

  // One a day. Anything else is a feed, and a feed read aloud is a podcast
  // nobody subscribed to.
  if (Object.values(progress.said).includes(today)) return null;

  const reached = dayNumber(progress.firstAt, now);
  if (reached > 10) return null; // The first week, plus a few days of grace.

  const waiting = DISCOVERIES.filter((d) => d.day <= reached && !progress.said[d.id]);
  if (waiting.length === 0) return null;

  const [life, facts, captures, notes, documents] = await Promise.all([
    loadLife(uid),
    loadFacts(uid),
    loadInbox(uid).then((items) => openCaptures(items)),
    loadNotes(uid),
    loadDocs(uid).then((docs) => docs.length),
  ]);
  const ground: Ground = { life, facts, captures, notes, documents, now };

  for (const discovery of waiting) {
    const say = discovery.find(ground);
    if (!say) continue;
    progress.said[discovery.id] = today;
    await save(uid, progress);
    return { id: discovery.id, say };
  }
  return null;
}
