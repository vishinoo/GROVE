/**
 * The calendar and the reminders list.
 *
 * Everything platform-specific lives here, behind four functions, so abilities.ts
 * stays a list of plain descriptions rather than a place that knows about
 * EventKit. Loaded with a lazy `require` for the same reason as everything else
 * native: on a build without it, the import must not take the bundle down.
 *
 * WHY THIS ONE IS DIFFERENT FROM THE OTHER NATIVE WORK
 *
 * expo-calendar ships inside Expo Go, unlike expo-speech-recognition and the
 * ring module. So this works today, on a phone, with no development build —
 * which makes calendar and reminders by far the cheapest real capability Grove
 * can have, and the reason they were wired before music or mail.
 *
 * DATES ARE PARSED LOCALLY AND DELIBERATELY BADLY
 *
 * "Thursday at two" is resolved here by keyword, not by a model. The same
 * reasoning as detectActIntent: a model that misreads a date silently moves a
 * real appointment in a real calendar, and being unable to parse something is a
 * question Grove can ask, whereas being confidently wrong is a meeting missed.
 */

import { capabilities } from './capabilities';

type CalendarModule = typeof import('expo-calendar');

function mod(): CalendarModule | null {
  if (!capabilities().calendar) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-calendar') as CalendarModule;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------- permissions */

export async function ensureCalendarAccess(): Promise<boolean> {
  const m = mod();
  if (!m) return false;
  try {
    const existing = await m.getCalendarPermissionsAsync();
    if (existing.granted) return true;
    return (await m.requestCalendarPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

export async function ensureRemindersAccess(): Promise<boolean> {
  const m = mod();
  if (!m) return false;
  try {
    const existing = await m.getRemindersPermissionsAsync();
    if (existing.granted) return true;
    return (await m.requestRemindersPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- dates */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * A spoken time to a real Date, or null when it cannot be read confidently.
 *
 * Null is the useful answer. It means Grove asks "when?" rather than booking
 * something for a moment nobody chose.
 */
export function readWhen(text: string, from = new Date()): Date | null {
  const t = text.toLowerCase().trim();
  if (!t) return null;

  const base = new Date(from);
  base.setSeconds(0, 0);
  let matched = false;

  if (/\btomorrow\b/.test(t)) {
    base.setDate(base.getDate() + 1);
    matched = true;
  } else if (/\btoday\b|\btonight\b|\bthis (?:morning|afternoon|evening)\b/.test(t)) {
    matched = true;
  } else {
    for (let i = 0; i < DAYS.length; i++) {
      if (new RegExp(`\\b(?:next\\s+)?${DAYS[i]}\\b`).test(t)) {
        const ahead = (i - base.getDay() + 7) % 7 || 7;
        base.setDate(base.getDate() + ahead);
        matched = true;
        break;
      }
    }
  }

  // The clock. Written for speech: "half four" and "at eight" as often as 16:30.
  const WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const hourPart = `(\\d{1,2}|${Object.keys(WORDS).join('|')})`;
  const toHour = (tok: string) => WORDS[tok] ?? Number(tok);

  const settle = (h: number, mer?: string) => {
    if (mer === 'pm') return h < 12 ? h + 12 : h;
    if (mer === 'am') return h === 12 ? 0 : h;
    if (/\bmorning\b/.test(t)) return h === 12 ? 0 : h;
    if (/\b(?:evening|afternoon|tonight)\b/.test(t)) return h < 12 ? h + 12 : h;
    return h >= 1 && h <= 6 ? h + 12 : h;
  };

  let hh: number | null = null;
  let mm = 0;

  const hm = /\b(\d{1,2}):(\d{2})\s*(am|pm)?/.exec(t);
  const half = new RegExp(`\\bhalf (?:past )?${hourPart}\\b`).exec(t);
  const at = new RegExp(`\\bat ${hourPart}\\s*(am|pm)?`).exec(t);

  if (hm) {
    hh = settle(Number(hm[1]), hm[3]);
    mm = Number(hm[2]);
  } else if (half) {
    hh = settle(toHour(half[1]));
    mm = 30;
  } else if (at) {
    hh = settle(toHour(at[1]), at[2]);
  } else if (/\bnoon\b/.test(t)) hh = 12;
  else if (/\bmidnight\b/.test(t)) hh = 0;

  if (hh === null && !matched) return null;

  base.setHours(hh ?? 9, mm, 0, 0);
  // A time already gone with no day named means they meant tomorrow.
  if (!matched && base <= from) base.setDate(base.getDate() + 1);
  return base;
}

/** "Thursday at 14:00" — for reading a confirmation back. */
export function sayWhen(date: Date): string {
  const day = DAYS[date.getDay()];
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const label = sameDay ? 'today' : `${day.charAt(0).toUpperCase()}${day.slice(1)}`;
  return `${label} at ${hh}:${mm}`;
}

/* --------------------------------------------------------------- events */

export type SimpleEvent = { id: string; title: string; start: Date; allDay: boolean };

/** Everything in the next `hours`, soonest first. */
/**
 * How many calendars this phone can actually see.
 *
 * The number matters because zero and "an empty day" are indistinguishable in
 * a list of events, and Grove used to report both as "Nothing on" — which is a
 * lie in the first case, and the more damaging kind, because the person can see
 * their own calendar is full.
 *
 * EventKit only sees accounts added to iOS itself. A Google account connected
 * through Noctus grants Grove's *server* access and puts nothing on the phone,
 * so this is very often zero on an otherwise well-configured install.
 */
export async function calendarCount(): Promise<number | null> {
  const m = mod();
  if (!m || !(await ensureCalendarAccess())) return null;
  try {
    return (await m.getCalendarsAsync(m.EntityTypes.EVENT)).length;
  } catch {
    return null;
  }
}

export async function eventsAhead(hours = 24): Promise<SimpleEvent[] | null> {
  const m = mod();
  if (!m || !(await ensureCalendarAccess())) return null;
  try {
    const calendars = await m.getCalendarsAsync(m.EntityTypes.EVENT);
    const ids = calendars.map((c) => c.id);
    if (ids.length === 0) return [];

    const from = new Date();
    const to = new Date(from.getTime() + hours * 3600_000);
    const found = await m.getEventsAsync(ids, from, to);

    return found
      .map((e) => ({
        id: e.id,
        title: e.title || 'Untitled',
        start: new Date(e.startDate as string),
        allDay: Boolean(e.allDay),
      }))
      .sort((a, b) => a.start.getTime() - b.start.getTime());
  } catch {
    return null;
  }
}

/**
 * Moves the next event whose title matches, and reports what it did.
 *
 * Matched by substring against upcoming events rather than searched globally:
 * "move my two o'clock" means one in the near future, and a fuzzy match across
 * a whole calendar is how you move the wrong thing.
 */
export async function moveEvent(
  which: string,
  to: Date
): Promise<{ ok: boolean; title?: string }> {
  const m = mod();
  if (!m || !(await ensureCalendarAccess())) return { ok: false };
  try {
    const upcoming = (await eventsAhead(24 * 14)) ?? [];
    const needle = which.toLowerCase().replace(/^(?:my|the)\s+/, '').trim();
    const hit =
      upcoming.find((e) => e.title.toLowerCase().includes(needle)) ??
      // "my two o'clock" names a time, not a title.
      upcoming.find((e) => {
        const h = e.start.getHours() % 12 || 12;
        return needle.includes(String(h)) || needle.includes(numberWord(h));
      });
    if (!hit) return { ok: false };

    await m.updateEventAsync(hit.id, { startDate: to, endDate: new Date(to.getTime() + 3600_000) });
    return { ok: true, title: hit.title };
  } catch {
    return { ok: false };
  }
}

/**
 * The calendar new events should land in.
 *
 * `getDefaultCalendarAsync` is the right answer and is not always available —
 * on a phone whose only account is Google it can return something unwritable —
 * so the first calendar that actually allows modification is the fallback.
 * Writing into a read-only calendar fails silently at the OS level, which is
 * the worst outcome: Grove would say "added" and nothing would be there.
 */
async function writableCalendarId(): Promise<string | null> {
  const m = mod();
  if (!m) return null;
  try {
    const preferred = await m.getDefaultCalendarAsync?.();
    if (preferred?.allowsModifications) return preferred.id;
  } catch {
    // Not available on every install; fall through to the scan.
  }
  try {
    const all = await m.getCalendarsAsync(m.EntityTypes.EVENT);
    return all.find((c) => c.allowsModifications)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Puts something in the calendar.
 *
 * Grove had no way to do this at all, so "add an event at 9:30" was routed to
 * the nearest thing that existed — moving one — which then failed looking for
 * an event that was never there and asked "which one?".
 *
 * An hour is assumed when no end is given, because that is what most things
 * are and a zero-length event is invisible in every calendar app.
 */
export async function createEvent(
  title: string,
  start: Date,
  minutes = 60
): Promise<{ ok: boolean; reason?: 'no-access' | 'no-calendar' | 'failed' }> {
  const m = mod();
  if (!m) return { ok: false, reason: 'no-access' };
  if (!(await ensureCalendarAccess())) return { ok: false, reason: 'no-access' };

  const calendarId = await writableCalendarId();
  if (!calendarId) return { ok: false, reason: 'no-calendar' };

  try {
    await m.createEventAsync(calendarId, {
      title: title.slice(0, 120),
      startDate: start,
      endDate: new Date(start.getTime() + minutes * 60_000),
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/**
 * Removes an event by describing it.
 *
 * Matched the same way moveEvent matches, and for the same reason: a fuzzy
 * match across a whole calendar is how you delete the wrong thing. Returns
 * what it removed so Grove can name it back — deleting silently is not
 * something to be quiet about.
 */
export async function removeEvent(which: string): Promise<{ ok: boolean; title?: string }> {
  const m = mod();
  if (!m || !(await ensureCalendarAccess())) return { ok: false };
  try {
    const hit = (await findEvents(which)) ?? [];
    if (hit.length === 0) return { ok: false };
    await m.deleteEventAsync(hit[0].id);
    return { ok: true, title: hit[0].title };
  } catch {
    return { ok: false };
  }
}

/**
 * Events whose title matches, soonest first.
 *
 * "When is my dentist appointment" is a different question from "what is on
 * today", and answering it by reading the whole day out and hoping the right
 * one is in there is what made the calendar feel like it could not be asked
 * anything specific.
 */
export async function findEvents(
  query: string,
  days = 60
): Promise<SimpleEvent[] | null> {
  const upcoming = await eventsAhead(24 * days);
  if (upcoming === null) return null;
  const needle = query.toLowerCase().replace(/^(?:my|the|a)\s+/, '').trim();
  if (!needle) return upcoming;
  const words = needle.split(/\s+/).filter((w) => w.length > 2);
  return upcoming.filter((e) => {
    const title = e.title.toLowerCase();
    return title.includes(needle) || words.some((w) => title.includes(w));
  });
}

function numberWord(n: number): string {
  return ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][n] ?? '';
}

/* ------------------------------------------------------------ reminders */

export async function addReminder(title: string, due: Date | null): Promise<boolean> {
  const m = mod();
  if (!m || !(await ensureRemindersAccess())) return false;
  try {
    const lists = await m.getCalendarsAsync(m.EntityTypes.REMINDER);
    const list = lists.find((c) => c.allowsModifications) ?? lists[0];
    if (!list) return false;
    await m.createReminderAsync(list.id, {
      title,
      ...(due ? { dueDate: due, startDate: due } : {}),
    });
    return true;
  } catch {
    return false;
  }
}
