/**
 * What a normal week looks like for one person.
 *
 * Everything else in Grove knows what is happening. This is the only part that
 * knows what *usually* happens, which is a different kind of fact and the one
 * missing input behind the line this whole feature exists for:
 *
 *   "You slept late, so I'd leave around 10:20."
 *
 * That sentence needs three things. The calendar gives the eleven o'clock. The
 * route planner gives the forty minutes. Neither of them can tell you that
 * today started two hours later than it usually does, and without that the
 * advice is the same advice every day, which is a timetable rather than an
 * assistant.
 *
 * WHAT IS ACTUALLY OBSERVABLE
 *
 * No new permission and no new plumbing. Two sources, both already here:
 *
 *   - **When the day starts and ends.** The first and last thing said to Grove
 *     on each day, which is a proxy for waking and turning in. It is a rough
 *     proxy and is treated as one: it is only ever used as a comparison against
 *     the same person's own median, never stated as a fact about their sleep.
 *   - **What the weeks look like.** A month of calendar history, grouped by
 *     what the thing is called and which day of the week it falls on. Three
 *     Wednesdays at seven is a Wednesday-at-seven thing; two is a coincidence.
 *
 * WHY THERE IS NO MODEL CALL HERE
 *
 * A median and a group-by are a median and a group-by. Handing a month of
 * diary to a model to be told "you have class on Mondays" would cost money
 * every day to be less reliable than four lines of arithmetic, and the whole
 * value of this file is that it is in the prompt on every turn, which means it
 * has to be free.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not score, rank or predict. A rhythm here is a plain statement of
 * what has happened often enough to mention, with the count attached so that
 * whoever reads it — the model, or a rule in attention.ts — can decide how much
 * weight it deserves. Confidence dressed up as a number nobody calibrated is
 * worse than a count.
 */

import { vault } from './vault';

import * as google from './google';

/** One day's worth of signals. Small on purpose: this is written every turn. */
type DayLog = {
  /** Local date, YYYY-MM-DD. */
  day: string;
  /** Minutes past local midnight of the first thing said to Grove. */
  first?: number;
  /** And of the last. */
  last?: number;
  /** How many turns that day, which is a usable measure of a busy day. */
  turns: number;
};

type Store = {
  days: DayLog[];
  /** The last calendar history read, held so it happens once a day at most. */
  week?: { at: string; habits: Habit[] };
  /**
   * Habits the person has thrown away.
   *
   * Kept rather than simply deleted, because the next calendar read would find
   * exactly the same pattern and put it straight back — which is the most
   * annoying possible response to someone deleting something.
   */
  hidden?: string[];
};

/** Something that happens on the same weekday often enough to be a pattern. */
export type Habit = {
  /** What it is called, as the calendar calls it. */
  what: string;
  /**
   * 0–6, Sunday first, matching Date#getDay — or EVERY_DAY for a thing that
   * happens on most of them.
   */
  weekday: number;
  /** Minutes past midnight, the median of the times it has started at. */
  at: number;
  /** How many times it has happened in the window. Never dressed up as a score. */
  seen: number;
  /** Where it happens, when that has been consistent. */
  where?: string;
};

/**
 * Two months. Long enough that a term's timetable is visible and a week off
 * does not erase it, short enough that last summer is not pulling the median
 * of when someone gets up.
 */
const KEEP_DAYS = 60;

/** Below this, a median is one person's odd week rather than their habits. */
const ENOUGH_DAYS = 4;

/** Three of the same weekday is a pattern. Two is a coincidence. */
const ENOUGH_TIMES = 3;

/**
 * The weekday of something that does not have one.
 *
 * "Wake up", "water", "get ready" are on a calendar every morning, and grouping
 * strictly by weekday turned each of them into five or six near-identical rows
 * that said the same thing about the same routine. Past this many weekdays it
 * is not a Tuesday thing, it is a daily thing, and it is one row.
 */
export const EVERY_DAY = -1;

/** Four of the seven. Below that it genuinely is a weekday pattern. */
const MOST_DAYS = 4;

/** A pattern that took a month to form does not change inside a day. */
const HISTORY_FOR_MS = 20 * 3_600_000;

const KEY = 'grove:rhythms:v1';

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

function dayStamp(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function minutesInto(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function clockOf(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = Math.round(minutes % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The middle value, not the mean.
 *
 * One 4am night out would drag an average wake-up time half an hour earlier
 * for a fortnight. The median ignores it, which is the behaviour anyone would
 * expect from the phrase "what time do I usually get up".
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function load(uid: string): Promise<Store> {
  try {
    const raw = await vault.getItem(storageKey(uid));
    if (!raw) return { days: [] };
    const parsed = JSON.parse(raw) as Partial<Store>;
    return {
      days: Array.isArray(parsed.days) ? parsed.days : [],
      week: parsed.week,
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
    };
  } catch {
    // A corrupt log means Grove does not know your habits yet. Nothing breaks.
    return { days: [], hidden: [] };
  }
}

/** One writer at a time, for the same reason life.ts has one. */
let queue: Promise<unknown> = Promise.resolve();

function update(uid: string, change: (store: Store) => Store): Promise<Store> {
  const run = queue.then(async () => {
    const store = change(await load(uid));
    const next: Store = { ...store, days: store.days.slice(-KEEP_DAYS) };
    try {
      await vault.setItem(storageKey(uid), JSON.stringify(next));
    } catch {
      // Losing one day costs a little accuracy in a median.
    }
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Called on every turn, and the only thing here that writes.
 *
 * Deliberately not called on a proactive line Grove started itself: the point
 * of the first mark of the day is that it is the person waking up and reaching
 * for their glasses, and a 7am leave-by reminder landing before they have said
 * anything would file every day as an early one.
 */
export async function noteTurn(uid: string, now = new Date()): Promise<void> {
  if (!uid || uid === 'anon') return;
  const day = dayStamp(now);
  const at = minutesInto(now);
  await update(uid, (store) => {
    const days = [...store.days];
    const i = days.findIndex((d) => d.day === day);
    if (i < 0) {
      days.push({ day, first: at, last: at, turns: 1 });
      return { ...store, days };
    }
    days[i] = {
      ...days[i],
      first: days[i].first === undefined ? at : Math.min(days[i].first, at),
      last: Math.max(days[i].last ?? at, at),
      turns: days[i].turns + 1,
    };
    return { ...store, days };
  });
}

/* ------------------------------------------------------------- reading */

export type Rhythms = {
  /** The usual minute of the day the first word is said, over the window. */
  usualStart: number | null;
  /** And the last. */
  usualEnd: number | null;
  /** Today's first word, if there has been one. */
  startedAt: number | null;
  /**
   * How much later than usual today started, in minutes, when that is enough
   * to matter. Negative is never reported: being up early needs no comment.
   */
  lateBy: number | null;
  /** Days with any signal at all. Below ENOUGH_DAYS nothing above is set. */
  knownDays: number;
  /** What normally happens on each weekday. */
  habits: Habit[];
};

/** Later than this and it is worth saying; under it, it is just a morning. */
const LATE_BY_MINUTES = 60;

export async function rhythms(uid: string, now = new Date()): Promise<Rhythms> {
  const empty: Rhythms = {
    usualStart: null,
    usualEnd: null,
    startedAt: null,
    lateBy: null,
    knownDays: 0,
    habits: [],
  };
  if (!uid || uid === 'anon') return empty;

  const store = await load(uid);
  const today = dayStamp(now);
  const past = store.days.filter((d) => d.day !== today);
  const startedAt = store.days.find((d) => d.day === today)?.first ?? null;

  const dropped = new Set(store.hidden ?? []);
  const habits = (store.week?.habits ?? []).filter((h) => !dropped.has(habitKey(h)));
  if (past.length < ENOUGH_DAYS) return { ...empty, startedAt, knownDays: past.length, habits };

  const usualStart = median(past.map((d) => d.first).filter((v): v is number => v !== undefined));
  const usualEnd = median(past.map((d) => d.last).filter((v): v is number => v !== undefined));
  const behind =
    usualStart !== null && startedAt !== null ? startedAt - usualStart : null;

  return {
    usualStart,
    usualEnd,
    startedAt,
    lateBy: behind !== null && behind >= LATE_BY_MINUTES ? behind : null,
    knownDays: past.length,
    habits,
  };
}

/**
 * Works out the weekly shape from a month of calendar history.
 *
 * Called at most once a day, in the background, with nobody waiting — and
 * failing is quiet, because not knowing someone's habits is the state this
 * started in rather than a fault.
 */
export async function learnWeek(uid: string, now = new Date()): Promise<Habit[]> {
  if (!uid || uid === 'anon') return [];
  const store = await load(uid);
  if (store.week && now.getTime() - new Date(store.week.at).getTime() < HISTORY_FOR_MS) {
    const dropped = new Set(store.hidden ?? []);
    return store.week.habits.filter((h) => !dropped.has(habitKey(h)));
  }

  const events = await google.calendarHistory(4).catch(() => null);
  if (events === null) return store.week?.habits ?? [];

  const habits = habitsIn(events);
  await update(uid, (s) => ({ ...s, week: { at: now.toISOString(), habits } }));
  const dropped = new Set(store.hidden ?? []);
  return habits.filter((h) => !dropped.has(habitKey(h)));
}

/**
 * Throws a habit away for good.
 *
 * The key is kept rather than the row deleted, because the row is rebuilt from
 * the calendar every day and deleting it alone would bring it straight back.
 */
export async function forgetHabit(uid: string, habit: Habit): Promise<Habit[]> {
  const key = habitKey(habit);
  const next = await update(uid, (s) => ({
    ...s,
    hidden: [...new Set([...(s.hidden ?? []), key])].slice(-200),
  }));
  const dropped = new Set(next.hidden ?? []);
  return (next.week?.habits ?? []).filter((h) => !dropped.has(habitKey(h)));
}

/**
 * The same thing, on the same weekday, three times or more.
 *
 * Titles are normalised because a calendar is full of near-duplicates —
 * "FIN 312", "FIN 312 Lecture", "fin312" — and three spellings of one class
 * look like three coincidences rather than one timetable. All-day entries are
 * excluded: a date with no time has no time to be a habit at.
 */
export function habitsIn(events: google.CalendarEvent[]): Habit[] {
  const groups = new Map<string, { what: string; weekday: number; times: number[]; wheres: string[] }>();

  for (const event of events) {
    if (event.allDay) continue;
    const at = new Date(event.start);
    if (!Number.isFinite(at.getTime())) continue;
    const key = `${norm(event.title)}|${at.getDay()}`;
    const group = groups.get(key) ?? {
      what: event.title.trim(),
      weekday: at.getDay(),
      times: [],
      wheres: [],
    };
    group.times.push(minutesInto(at));
    if (event.location.trim()) group.wheres.push(event.location.trim());
    groups.set(key, group);
  }

  const strong = [...groups.values()].filter((g) => g.times.length >= ENOUGH_TIMES);

  // Anything happening on most weekdays is one routine, not five patterns.
  // Counted before the per-weekday rows are built, because the merge has to
  // replace them rather than sit alongside them.
  const spread = new Map<string, typeof strong>();
  for (const g of strong) {
    const key = norm(g.what);
    spread.set(key, [...(spread.get(key) ?? []), g]);
  }

  const made: Habit[] = [];
  for (const [, days] of spread) {
    const sameThing = days[0];
    const everyDay = days.length >= MOST_DAYS;
    const times = everyDay ? days.flatMap((d) => d.times) : null;
    const wheres = everyDay ? days.flatMap((d) => d.wheres) : null;

    if (everyDay && times && wheres) {
      made.push({
        what: sameThing.what,
        weekday: EVERY_DAY,
        at: median(times) ?? times[0],
        seen: times.length,
        ...(wheres.length >= ENOUGH_TIMES && new Set(wheres).size === 1 ? { where: wheres[0] } : {}),
      });
      continue;
    }
    for (const g of days) {
      const at = median(g.times) ?? g.times[0];
      // A place is only worth repeating when it has been the same place.
      const where =
        g.wheres.length >= ENOUGH_TIMES && new Set(g.wheres).size === 1 ? g.wheres[0] : undefined;
      made.push({ what: g.what, weekday: g.weekday, at, seen: g.times.length, ...(where ? { where } : {}) });
    }
  }

  return made.sort((a, b) => b.seen - a.seen || a.weekday - b.weekday || a.at - b.at);
}

/** Identifies a habit across reads, so one can be hidden and stay hidden. */
export function habitKey(habit: Habit): string {
  return `${norm(habit.what)}|${habit.weekday}`;
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * What goes into the prompt: a few lines, or nothing at all.
 *
 * Nothing at all is the common case for the first week, and an empty block is
 * better than a block saying it does not know yet — the model treats a stated
 * absence as a thing worth mentioning, and "I don't know your routine yet" is
 * not an answer to any question anyone asked.
 */
export function rhythmLines(r: Rhythms, now = new Date()): string {
  const lines: string[] = [];

  if (r.usualStart !== null && r.knownDays >= ENOUGH_DAYS) {
    lines.push(
      `Normally up and talking to you by about ${clockOf(r.usualStart)}${
        r.usualEnd !== null ? `, and done for the day around ${clockOf(r.usualEnd)}` : ''
      } (over ${r.knownDays} days).`
    );
  }
  if (r.lateBy !== null && r.startedAt !== null) {
    const hours = r.lateBy >= 90 ? `${Math.round((r.lateBy / 60) * 10) / 10} hours` : `${r.lateBy} minutes`;
    lines.push(
      `Today started at ${clockOf(r.startedAt)}, about ${hours} later than usual — worth accounting for in anything to do with time today, but do not bring it up on its own.`
    );
  }

  const daily = r.habits.filter((h) => h.weekday === EVERY_DAY);
  if (daily.length > 0) {
    lines.push(
      `Most days: ${daily
        .slice(0, 5)
        .map((h) => `${h.what} around ${clockOf(h.at)}`)
        .join('; ')}.`
    );
  }

  const todays = r.habits.filter((h) => h.weekday === now.getDay());
  if (todays.length > 0) {
    lines.push(
      `Usually on a ${WEEKDAYS[now.getDay()]}: ${todays
        .slice(0, 5)
        .map((h) => `${h.what} around ${clockOf(h.at)}${h.where ? ` at ${h.where}` : ''} (${h.seen} of the last 4 weeks)`)
        .join('; ')}.`
    );
  }
  const rest = r.habits
    .filter((h) => h.weekday !== now.getDay() && h.weekday !== EVERY_DAY)
    .slice(0, 6);
  if (rest.length > 0) {
    lines.push(
      `The rest of their week: ${rest
        .map((h) => `${WEEKDAYS[h.weekday]} ${clockOf(h.at)} ${h.what}`)
        .join('; ')}.`
    );
  }

  return lines.length ? `Their usual rhythm:\n${lines.join('\n')}` : '';
}

/**
 * How today differs from a normal one of this weekday.
 *
 * The single most useful sentence this file can produce, and the one that needs
 * both halves of it: a normal Thursday is a median and a group-by, and today is
 * a diary. Said together they are a comparison, which is what "today is
 * structurally different" actually means — and the thing nobody can see about
 * their own day while they are in it.
 *
 * Every claim carries its count. "You normally study around 2 on a Thursday" is
 * an assertion about someone's life made by a machine, and the only thing that
 * makes it trustworthy rather than presumptuous is saying how it knows: 11
 * observed sessions is evidence, and the same sentence without it is a guess
 * wearing a confident tone.
 */
export function structurally(
  r: Rhythms,
  todaysEvents: { title: string; start: string; allDay?: boolean }[],
  now = new Date()
): string {
  const lines: string[] = [];
  const day = WEEKDAYS[now.getDay()];

  if (r.lateBy !== null && r.startedAt !== null && r.usualStart !== null) {
    const hours = r.lateBy >= 90 ? `${Math.round((r.lateBy / 60) * 10) / 10} hours` : `${r.lateBy} minutes`;
    lines.push(
      `Started at ${clockOf(r.startedAt)} rather than the usual ${clockOf(r.usualStart)} — ${hours} later, measured over ${r.knownDays} days.`
    );
  }

  const todays = r.habits.filter((h) => h.weekday === now.getDay() || h.weekday === EVERY_DAY);
  if (todays.length > 0) {
    const minute = now.getHours() * 60 + now.getMinutes();
    const planned = todaysEvents
      .filter((e) => !e.allDay)
      .map((e) => norm(e.title))
      .filter((t) => t.length > 2);
    const inDiary = (what: string) => {
      const target = norm(what);
      return planned.some((t) => t.includes(target) || target.includes(t));
    };

    const absent = todays.filter((h) => !inDiary(h.what));
    const gone = absent.filter((h) => h.at < minute);
    const ahead = absent.filter((h) => h.at >= minute);

    if (gone.length > 0) {
      lines.push(
        `Normally done by now on a ${day} and not in today's diary: ${gone
          .map((h) => `${h.what} (${clockOf(h.at)}, ${h.seen} of the last 4 weeks)`)
          .join('; ')}.`
      );
    }
    if (ahead.length > 0) {
      lines.push(
        `Usually still to come on a ${day}, with nothing in the diary for it: ${ahead
          .map((h) => `${h.what} (${clockOf(h.at)}, ${h.seen} of the last 4)`)
          .join('; ')}.`
      );
    }
    if (absent.length === 0) {
      lines.push(`Their usual ${day} fixtures are all in today's diary.`);
    }
  }

  if (lines.length === 0) return '';
  return `How today compares with a normal ${day}:\n${lines.join('\n')}`;
}

/**
 * A weekly fixture whose hour is approaching with nothing in today's diary.
 *
 * The one rule here worth interrupting someone for, and it is only possible
 * with history: the calendar cannot tell you about the thing that is missing
 * from it. Basketball at seven for four Wednesdays running, and today is
 * Wednesday with an empty evening, is either a cancellation or a thing about to
 * be forgotten — and being asked is cheap in the first case.
 *
 * Returns the habit, or null. Deliberately strict: it has to have happened at
 * least three of the last four weeks, the hour has to be close, and anything
 * even loosely matching in today's diary cancels it.
 */
export function missingToday(
  r: Rhythms,
  /** Whatever is actually in the diary for the rest of today. Titles are all
   *  this needs, so the caller can pass its own lighter shape. */
  todaysEvents: { title: string }[],
  now = new Date()
): Habit | null {
  const soonest = 20;
  const latest = 90;
  const minute = minutesInto(now);

  // Containment rather than equality, because the diary is where a fixture
  // goes when it changes: "Basketball (moved)" and "Basketball — away" are the
  // thing itself, and an exact match would nag someone about an event they are
  // looking at. Either direction, since the diary's name may be the shorter.
  const planned = todaysEvents.map((e) => norm(e.title)).filter((t) => t.length > 2);
  const already = (what: string): boolean => {
    const target = norm(what);
    return planned.some((t) => t.includes(target) || target.includes(t));
  };

  return (
    r.habits.find((h) => {
      // Never a daily routine. "You normally have wake up around 07:30 on a
      // Thursday and there's nothing in your diary for it" is not a sentence
      // worth interrupting anyone with.
      if (h.weekday === EVERY_DAY || h.weekday !== now.getDay() || h.seen < ENOUGH_TIMES) return false;
      const away = h.at - minute;
      if (away < soonest || away > latest) return false;
      return !already(h.what);
    }) ?? null
  );
}
