/**
 * Standing jobs.
 *
 * A spark is not an app and not an agent you install. It is one sentence you
 * said, an ability to carry it out, and when it should happen. "Give me a
 * briefing on my watchlist every weekday morning" is a spark; "play my
 * favourite song" is not — that just runs and is done.
 *
 * WHAT MAKES A SPARK, AND WHAT DOES NOT
 *
 * Only a recurrence does. Grove does not guess that you meant something
 * standing, and it does not quietly start doing things on a schedule because a
 * model thought you would like that. You have to have said when. That rule is
 * local and keyword-based for exactly the reason detectActIntent is: the cost
 * of a false positive here is Grove waking you at seven every morning for
 * something you asked once.
 *
 * WHERE THEY RUN
 *
 * A spark whose ability is server-side runs on Noctus at the stated time and
 * pushes the result, phone asleep or not. A spark touching anything on the
 * device cannot — iOS will not run your code at a chosen moment — so it fires
 * the next time Grove is awake, and `schedulable` is false so the UI can say
 * so rather than silently missing.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { isSchedulable } from './abilities';

export type Schedule =
  | { kind: 'daily'; at: string }
  | { kind: 'weekdays'; at: string }
  | { kind: 'weekly'; day: number; at: string }
  | { kind: 'hourly' };

/**
 * What sets a spark off.
 *
 * Two kinds, because "every weekday at seven" and "whenever I say play my
 * favourite song" are both standing instructions and only one of them is a
 * clock. A phrase trigger is how you teach Grove a shorthand: the words become
 * the button.
 */
export type Trigger =
  | { kind: 'schedule'; schedule: Schedule }
  | { kind: 'phrase'; phrase: string };

export type Spark = {
  id: string;
  /**
   * Two or three words, as a person would label it on a card. The sentence
   * someone speaks is never a good title — it opens with "also" and carries the
   * schedule inside it — so the name is separate from the instruction.
   */
  title: string;
  /**
   * What it should do, in your words.
   *
   * This used to be a stored ability id and a bag of arguments, chosen from a
   * fixed list. That was the wrong shape: it could only ever express the six
   * things someone had already written functions for, so "read my email for
   * anything from Priya and tell me what she said" had nowhere to go. It is
   * plain language now, resolved to an ability when it runs, which means the
   * instruction can say more than the ability list currently knows how to do —
   * and says it in a form that still makes sense when the list grows.
   */
  instruction: string;
  trigger: Trigger;
  /**
   * The ability this currently resolves to, kept only so the card can show
   * which apps it touches and whether it can run with the phone asleep. Not
   * chosen by hand, and recomputed whenever the instruction changes.
   */
  abilityId: string | null;
  /**
   * False when the spark needs the phone. It still runs, but only when Grove is
   * awake, and the UI has to say that rather than imply 7am.
   */
  schedulable: boolean;
  enabled: boolean;
  /** ISO of the last run, or null. */
  lastRun: string | null;
  createdAt: string;
};

/* ------------------------------------------------------------ schedules */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The time in a spoken sentence.
 *
 * Written for speech rather than for a form. People say "half four" and "at
 * eight", and a recogniser hands those over as words at least as often as
 * digits, so a digits-only parser silently falls back to a default and the
 * spark fires at the wrong time — which looks like it is broken rather than
 * misheard.
 *
 * The am/pm guess is the other half of speaking naturally: nobody says "at
 * five pm", they say "at five" and mean the afternoon. One to six is read as
 * afternoon, seven to eleven as morning, which is how those hours are used.
 */
const CLOCK_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const HOUR = `(\\d{1,2}|${Object.keys(CLOCK_WORDS).join('|')})`;

function toHour(token: string): number | null {
  const word = CLOCK_WORDS[token.toLowerCase()];
  if (word !== undefined) return word;
  const n = Number(token);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}

function stamp(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Applies am/pm if stated, and guesses from the hour if not. */
function settleHour(h: number, meridiem: string | undefined, text: string): number {
  if (meridiem === 'pm') return h < 12 ? h + 12 : h;
  if (meridiem === 'am') return h === 12 ? 0 : h;
  if (/\bmorning\b/.test(text)) return h === 12 ? 0 : h;
  if (/\bevening\b|\bafternoon\b|\btonight\b/.test(text)) return h < 12 ? h + 12 : h;
  // No marker: one to six is the afternoon, seven to eleven is the morning.
  return h >= 1 && h <= 6 ? h + 12 : h;
}

function readClock(text: string): string | null {
  const t = text.toLowerCase();

  const hhmm = /\b(\d{1,2}):(\d{2})\s*(am|pm)?/.exec(t);
  if (hhmm) return stamp(settleHour(Number(hhmm[1]), hhmm[3], t), Number(hhmm[2]));

  const quarterTo = new RegExp(`\\bquarter to ${HOUR}\\b`).exec(t);
  if (quarterTo) {
    const h = toHour(quarterTo[1]);
    if (h !== null) return stamp((settleHour(h, undefined, t) + 23) % 24, 45);
  }

  const quarterPast = new RegExp(`\\bquarter past ${HOUR}\\b`).exec(t);
  if (quarterPast) {
    const h = toHour(quarterPast[1]);
    if (h !== null) return stamp(settleHour(h, undefined, t), 15);
  }

  const half = new RegExp(`\\bhalf (?:past )?${HOUR}\\b`).exec(t);
  if (half) {
    const h = toHour(half[1]);
    if (h !== null) return stamp(settleHour(h, undefined, t), 30);
  }

  const oclock = new RegExp(`\\bat ${HOUR}\\s*(am|pm)?`).exec(t);
  if (oclock) {
    const h = toHour(oclock[1]);
    if (h !== null) return stamp(settleHour(h, oclock[2], t), 0);
  }

  if (/\bmorning\b/.test(t)) return '07:00';
  if (/\bevening\b|\btonight\b/.test(t)) return '18:00';
  if (/\bnoon\b|\blunchtime\b/.test(t)) return '12:00';
  return null;
}

/**
 * The recurrence in a sentence, or null if there isn't one.
 *
 * Null is the common case and the safe one — it means "do this now and forget
 * it", which is what almost everything said to Grove is.
 */
export function parseSchedule(text: string): Schedule | null {
  const t = text.toLowerCase();
  const at = readClock(t) ?? '07:00';

  if (/\bevery hour\b|\bhourly\b/.test(t)) return { kind: 'hourly' };

  if (/\b(?:every|each) (?:week ?day|working day)\b|\bweekdays\b/.test(t)) {
    return { kind: 'weekdays', at };
  }

  for (let i = 0; i < DAYS.length; i++) {
    if (new RegExp(`\\b(?:every|each) ${DAYS[i]}s?\\b`).test(t)) {
      return { kind: 'weekly', day: i, at };
    }
  }

  if (/\b(?:every|each) (?:day|morning|evening|night)\b|\bdaily\b/.test(t)) {
    return { kind: 'daily', at };
  }

  // "every week" with no named day lands on Monday, which is what people mean.
  if (/\b(?:every|each) week\b|\bweekly\b/.test(t)) return { kind: 'weekly', day: 1, at };

  return null;
}

/** What sets it off, in a phrase — for the card and for saying back. */
export function describeTrigger(t: Trigger): string {
  return t.kind === 'schedule' ? describeSchedule(t.schedule) : `When you say “${t.phrase}”`;
}

/** "Every weekday at 07:00" — for the card, and for confirming out loud. */
export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case 'hourly':
      return 'Every hour';
    case 'daily':
      return `Every day, ${s.at}`;
    case 'weekdays':
      return `Weekdays, ${s.at}`;
    case 'weekly': {
      const day = DAYS[s.day] ?? 'monday';
      return `Every ${day.charAt(0).toUpperCase()}${day.slice(1)}, ${s.at}`;
    }
  }
}

/* -------------------------------------------------------------- storage */

const KEY = 'grove:sparks:v1';
const LIMIT = 30;

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

export async function loadSparks(uid: string): Promise<Spark[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Spark[];
    if (!Array.isArray(parsed)) return [];
    // Sparks saved before titles existed show their raw sentence otherwise.
    // Sparks saved before instructions and triggers existed carried a `said`
    // string and a bare `schedule`. Migrated rather than dropped.
    return parsed.map((raw) => {
      const old = raw as Spark & { said?: string; schedule?: Schedule };
      return {
        ...old,
        title: old.title || 'Standing job',
        instruction: old.instruction || old.said || '',
        trigger:
          old.trigger ??
          (old.schedule
            ? { kind: 'schedule' as const, schedule: old.schedule }
            : { kind: 'phrase' as const, phrase: '' }),
        abilityId: old.abilityId ?? null,
      };
    });
  } catch {
    return [];
  }
}

async function write(uid: string, sparks: Spark[]): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(uid), JSON.stringify(sparks));
  } catch {
    // A spark that fails to persist is one lost job, not a broken app.
  }
}

/**
 * Turns a request into a standing job.
 *
 * Returns null when the sentence carried no recurrence, which is the caller's
 * signal to just run the thing once instead.
 */
export async function createSpark(
  uid: string,
  input: { said: string; title?: string; instruction?: string; abilityId?: string | null }
): Promise<Spark | null> {
  const schedule = parseSchedule(input.said);
  const phrase = phraseTrigger(input.said);
  // No clock and no phrase means this was a one-off. Saying it once should not
  // quietly enrol you in a daily job.
  if (!schedule && !phrase) return null;

  const trigger: Trigger = schedule
    ? { kind: 'schedule', schedule }
    : { kind: 'phrase', phrase: phrase as string };

  const abilityId = input.abilityId ?? null;

  const spark: Spark = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    title: (input.title || '').trim().slice(0, 40) || 'Standing job',
    instruction: (input.instruction || input.said).trim().slice(0, 400),
    trigger,
    abilityId,
    schedulable: trigger.kind === 'schedule' && abilityId ? isSchedulable([abilityId]) : false,
    enabled: true,
    lastRun: null,
    createdAt: new Date().toISOString(),
  };

  const existing = await loadSparks(uid);
  await write(uid, [spark, ...existing].slice(0, LIMIT));
  return spark;
}

/**
 * A phrase someone wants to become a shortcut.
 *
 * "whenever I say X", "when I say X" — the words become the button. Deliberately
 * narrow: only an explicit "when I say" counts, because inferring that an
 * ordinary sentence was meant as a standing trigger is how Grove would start
 * firing at things you only said once.
 */
export function phraseTrigger(text: string): string | null {
  const hit =
    /\b(?:when(?:ever)?|any time|each time)\s+i\s+say\s+["“']?(.+?)["”']?\s*(?:,|then|it should|just|please|$)/i.exec(
      text.trim()
    );
  const phrase = hit?.[1]?.trim().replace(/[.?!]+$/, '');
  return phrase && phrase.length >= 2 ? phrase.slice(0, 80) : null;
}

/**
 * The spark a spoken sentence should fire, if any.
 *
 * Substring both ways, so "play my favourite song" matches whether the trigger
 * was stored longer or shorter than what was actually said.
 */
export function matchPhrase(text: string, sparks: Spark[]): Spark | null {
  const said = text.toLowerCase().trim().replace(/[.?!]+$/, '');
  if (said.length < 2) return null;
  for (const spark of sparks) {
    if (!spark.enabled || spark.trigger.kind !== 'phrase') continue;
    const phrase = spark.trigger.phrase.toLowerCase().trim();
    if (!phrase) continue;
    if (said === phrase || said.includes(phrase) || phrase.includes(said)) return spark;
  }
  return null;
}

/**
 * Edits a spark in place.
 *
 * A spark is made from one spoken sentence, and speech is misheard — the wrong
 * time, the wrong ability, a title built from the wrong four words. Without
 * this the only repair is to delete it and say the whole thing again, which is
 * a poor trade for a typo in a time.
 *
 * `schedulable` is recomputed rather than carried over, because changing the
 * ability can change whether the job can run with the phone asleep, and a stale
 * flag there is the difference between a 7am briefing and one that never comes.
 */
export async function editSpark(
  uid: string,
  id: string,
  patch: Partial<Pick<Spark, 'title' | 'instruction' | 'trigger' | 'abilityId'>>
): Promise<Spark[]> {
  const next = (await loadSparks(uid)).map((spark) => {
    if (spark.id !== id) return spark;
    const merged = { ...spark, ...patch };
    // Recomputed rather than carried over: changing either the instruction or
    // the trigger can change whether this runs with the phone asleep, and a
    // stale flag there is the difference between a 7am briefing and silence.
    return {
      ...merged,
      title: merged.title.trim().slice(0, 40) || spark.title,
      instruction: merged.instruction.trim().slice(0, 400) || spark.instruction,
      schedulable:
        merged.trigger.kind === 'schedule' && merged.abilityId
          ? isSchedulable([merged.abilityId])
          : false,
    };
  });
  await write(uid, next);
  return next;
}

/**
 * Records that a spark just ran.
 *
 * Without this `dueSparks` keeps returning the same job every time it is
 * asked, so a catch-up on foreground would fire the morning brief over and
 * over for as long as the app stayed open.
 */
export async function markRun(uid: string, id: string): Promise<Spark[]> {
  const now = new Date().toISOString();
  const next = (await loadSparks(uid)).map((s) => (s.id === id ? { ...s, lastRun: now } : s));
  await write(uid, next);
  return next;
}

export async function setSparkEnabled(
  uid: string,
  id: string,
  enabled: boolean
): Promise<Spark[]> {
  const next = (await loadSparks(uid)).map((s) => (s.id === id ? { ...s, enabled } : s));
  await write(uid, next);
  return next;
}

/** Every standing job, gone. Part of starting over. */
export async function clearSparks(uid: string): Promise<Spark[]> {
  try {
    await AsyncStorage.removeItem(storageKey(uid));
  } catch {
    // Nothing stored is the desired end state anyway.
  }
  return [];
}

export async function deleteSpark(uid: string, id: string): Promise<Spark[]> {
  const next = (await loadSparks(uid)).filter((s) => s.id !== id);
  await write(uid, next);
  return next;
}

/**
 * The sparks that should have fired by now and haven't.
 *
 * This is how a device-side spark ever runs at all: iOS will not wake Grove to
 * order, so the next time it *is* awake we look for anything overdue. Bounded
 * to one catch-up per spark, because coming back after a week away should not
 * produce seven briefings.
 */
export function dueSparks(sparks: Spark[], now = new Date()): Spark[] {
  return sparks.filter((s) => s.enabled && isDue(s, now));
}

function isDue(spark: Spark, now: Date): boolean {
  // A phrase trigger has no clock. It fires when you say the words, and is
  // never "overdue".
  if (spark.trigger.kind !== 'schedule') return false;
  const schedule = spark.trigger.schedule;

  const last = spark.lastRun ? new Date(spark.lastRun).getTime() : 0;
  if (!Number.isFinite(last)) return true;

  const sinceLast = now.getTime() - last;
  if (schedule.kind === 'hourly') return sinceLast >= 3_600_000;

  // Anything else runs at most once a day, and only after its stated time.
  if (sinceLast < 20 * 3_600_000) return false;

  if (schedule.kind === 'weekdays') {
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
  }
  if (schedule.kind === 'weekly' && now.getDay() !== schedule.day) return false;

  const [h, m] = schedule.at.split(':').map(Number);
  const dueToday = new Date(now);
  dueToday.setHours(h, m, 0, 0);
  return now >= dueToday;
}
