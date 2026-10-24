/**
 * The right to interrupt.
 *
 * Everything else in Grove waits to be asked. This is the part that speaks
 * first, which makes it the part most likely to ruin the product: an assistant
 * that talks into your ear while you are working, about something you already
 * knew, gets switched off within a day and never switched back on.
 *
 * So the rule is not "what could Grove say" but "what would a person regret not
 * being told". That is a short list:
 *
 *   - You need to leave now, or you will be late for something you chose.
 *   - The thing you are about to walk into starts in a few minutes.
 *   - Something you said you would do today is now late.
 *
 * Anything else — a pleasant fact, a thing that can wait an hour, a summary of
 * your day — is not worth the interruption and is left for when you ask.
 *
 * WHY THIS IS RULES AND NOT A MODEL
 *
 * It runs every couple of minutes, all day, in the background. A model call per
 * check would cost more than the rest of the app put together and would be
 * wrong in a more interesting way. The judgement here is simple enough to
 * write down, and writing it down means it behaves the same way every time —
 * which, for something that speaks unprompted, is the whole point.
 *
 * Nothing here speaks. It returns at most one thing worth saying, and the
 * caller decides whether the mode, the moment and the last interruption allow
 * it.
 */

import { hasRemindersAccess, openReminders } from './deviceCalendar';
import * as google from './google';
import { localTime } from './when';
import { outOf, spent as chargeBudget, worthSaying, type Candidate } from './interrupt';
import { clockOf, missingToday, rhythms } from './rhythms';

export type Moment = {
  /** Stable for the thing itself, so it is said once and not once a minute. */
  id: string;
  /** How long the person has: now means act, soon means get ready. */
  urgency: 'now' | 'soon';
  /** The line, as it would be said aloud. */
  say: string;
};

/** Minutes of slack before a journey: nobody leaves the second they should. */
const GETTING_READY = 5;

/** How far ahead a journey is worth mentioning at all. */
const HORIZON_MINUTES = 90;

/** An event with no travel involved is worth a word this close to starting. */
const STARTS_SOON_MINUTES = 12;

function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

function clock(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Both of the things below run on a timer, all day, and both want the same two
 * answers: what is next, and how far away it is. Asked straight through, that
 * is a calendar request and a route lookup every minute for as long as Grove is
 * open — which would be the most expensive thing in the app and would say
 * nothing a two-minute-old answer does not.
 *
 * So both answers are held briefly. The windows are shorter than the thing they
 * describe can meaningfully change: a diary does not rearrange itself inside
 * two minutes, and traffic does not inside five.
 */
const CALENDAR_FOR_MS = 150_000;
const ROUTE_FOR_MS = 5 * 60_000;

type Upcoming = { id: string; title: string; at: Date; location: string };
let diary: { at: number; events: Upcoming[] } | null = null;
const routes = new Map<string, { at: number; minutes: number | null }>();

/** Today's remaining appointments, soonest first. All-day entries are not. */
async function upcoming(now: Date): Promise<Upcoming[]> {
  if (diary && Date.now() - diary.at < CALENDAR_FOR_MS) {
    return diary.events.filter((e) => e.at.getTime() > now.getTime());
  }
  const events = await google.readCalendar(1).catch(() => null);
  if (events === null) return diary ? diary.events.filter((e) => e.at.getTime() > now.getTime()) : [];
  const parsed = events
    .filter((e) => !e.allDay)
    .map((e) => ({ id: e.id, title: e.title, at: localTime(e.start), location: e.location }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  diary = { at: Date.now(), events: parsed };
  return parsed.filter((e) => e.at.getTime() > now.getTime());
}

/**
 * How long it takes to get somewhere, or null when that cannot be known.
 *
 * Only ever asked for an event that has a location and starts within the
 * horizon, because it is a real piece of work — a route lookup on the device —
 * and doing it every two minutes for a day of meetings would be rude to the
 * battery. Held for five minutes for the same reason.
 */
async function travelMinutes(to: string): Promise<number | null> {
  const held = routes.get(to);
  if (held && Date.now() - held.at < ROUTE_FOR_MS) return held.minutes;
  const minutes = await askRoute(to);
  routes.set(to, { at: Date.now(), minutes });
  return minutes;
}

async function askRoute(to: string): Promise<number | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const remote = require('grove-remote') as typeof import('grove-remote');
    if (!remote.isAvailable()) return null;
    const route = await remote.travelTime(to, true);
    return route.ok && route.seconds ? Math.round(route.seconds / 60) : null;
  } catch {
    return null;
  }
}

export type Attention = {
  /** What Grove has already said, so nothing is said twice. */
  said: Set<string>;
  /** Used to space out the cheap checks from the expensive ones. */
  lastRouteAt?: number;
};

/**
 * The one thing worth saying right now, or nothing.
 *
 * Ordered by what it costs the person to miss, not by what is soonest.
 */
export async function whatMatters(
  state: Attention,
  uid: string,
  /**
   * Whether Grove may volunteer beyond what someone would regret missing.
   *
   * The first two rules have a clock on them and always run: being told to
   * leave is not chat. The rest are standing observations, and they wait for
   * the answer to the question asked on the seventh day. See `proactive` in
   * persona.ts.
   */
  freely = false,
  now = new Date()
): Promise<Moment | null> {
  const found = await candidates(state, uid, freely, now);
  const verdict = await worthSaying(uid, found, now);
  if (!verdict.speak) return null;

  // Charged here rather than by the caller, because the caller's next act is to
  // speak — and a budget charged for a line nobody heard is a line nobody will
  // ever hear, whereas one charged a moment early costs at most one slot.
  await chargeBudget(uid, verdict.chosen, now);
  return {
    id: verdict.chosen.id,
    urgency: verdict.chosen.perishable === 'now' ? 'now' : 'soon',
    say: verdict.chosen.say,
  };
}

/**
 * Everything Grove could truthfully say right now, with what each is worth.
 *
 * Every rule returns rather than short-circuits, which is the change that
 * matters: the old version returned the first thing it found, so "you need to
 * leave now" and "you haven't started studying" were ordered by the order they
 * were written in. Now they are ordered by what missing them costs, and
 * interrupt.ts decides whether the best of them clears the bar at all.
 */
async function candidates(
  state: Attention,
  uid: string,
  freely: boolean,
  now: Date
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const unsaid = (id: string) => !state.said.has(id);
  const soon = await upcoming(now);

  // 1. Leaving. The only thing here that is genuinely urgent, because being
  //    told after the fact is worthless — and the only thing that is exempt
  //    from the daily budget.
  const journey = soon.find(
    (e) => e.location.trim() && minutesBetween(now, e.at) <= HORIZON_MINUTES
  );
  if (journey) {
    const travel = await travelMinutes(journey.location);
    if (travel !== null) {
      const leaveIn = minutesBetween(now, journey.at) - travel - GETTING_READY;
      // A route the planner actually answered is as sure as anything here gets.
      if (leaveIn <= 0 && unsaid(`leave:${journey.id}`)) {
        out.push({
          id: `leave:${journey.id}`,
          say: `You need to leave for ${journey.title} now — it's ${travel} minutes away and it starts at ${clock(journey.at)}.`,
          costOfMissing: 5,
          confidence: 0.95,
          perishable: 'now',
        });
      }
      // A warning while there is still time to do something about it.
      if (leaveIn > 0 && leaveIn <= 10 && unsaid(`leaving:${journey.id}`)) {
        out.push({
          id: `leaving:${journey.id}`,
          say: `Leave for ${journey.title} in about ${leaveIn} minutes. It's ${travel} minutes away.`,
          costOfMissing: 4,
          confidence: 0.95,
          perishable: 'now',
        });
      }
    }
  }

  // 2. Starting. No journey to make, but walking in late is still worse than
  //    being told.
  const starting = soon.find((e) => minutesBetween(now, e.at) <= STARTS_SOON_MINUTES);
  if (starting && unsaid(`soon:${starting.id}`)) {
    const minutes = minutesBetween(now, starting.at);
    out.push({
      id: `soon:${starting.id}`,
      say: `${starting.title} in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      costOfMissing: 4,
      confidence: 0.9,
      perishable: 'now',
    });
  }

  if (!freely) return out;

  // 3. Missing. The one thing on this list the calendar cannot tell you,
  //    because it is about what is *not* in it: a weekly fixture whose hour is
  //    coming round with nothing in the diary. Basketball at seven for four
  //    Wednesdays running, and an empty Wednesday evening, is either a
  //    cancellation or a thing about to be forgotten — and being asked costs
  //    nothing in the first case.
  //
  //    Its confidence is the count, which is the point of counting: three of
  //    the last four weeks is 0.75 and clears the bar, twice is 0.5 and does
  //    not. Nobody had to pick those numbers.
  const usual = await rhythms(uid, now).catch(() => null);
  const absent = usual ? missingToday(usual, soon, now) : null;
  const absentId = absent ? `usual:${absent.what}:${now.toDateString()}` : '';
  if (absent && unsaid(absentId)) {
    out.push({
      id: absentId,
      say: `You normally have ${absent.what} around ${clockOf(absent.at)} on a ${now.toLocaleDateString('en-GB', { weekday: 'long' })} — ${absent.seen} of the last four weeks — and there's nothing in your diary for it. Still on?`,
      costOfMissing: 2,
      confidence: outOf(absent.seen, 4),
      perishable: 'today',
    });
  }

  // 4. Late. Something they chose to be reminded of, whose time has passed —
  //    raised an hour after the fact rather than the moment it slips, so a
  //    reminder set for nine is not a nine o'clock alarm.
  const reminders = (await openReminders(10).catch(() => null)) ?? [];
  const late = reminders.find(
    (r) => r.due && r.overdue && minutesBetween(r.due, now) >= 60 && minutesBetween(r.due, now) < 600
  );
  if (late && unsaid(`late:${late.title}`)) {
    out.push({
      id: `late:${late.title}`,
      say: `You still haven't ${late.title.toLowerCase()}.`,
      costOfMissing: 3,
      confidence: 1,
      perishable: 'today',
    });
  }

  return out;
}

/**
 * What the Talk screen shows without being asked: the next thing, and when to
 * leave for it. Quiet, glanceable, and never spoken.
 */
export type NextUp = { title: string; at: Date; leaveBy?: Date; where?: string } | null;

export async function nextUp(now = new Date()): Promise<NextUp> {
  const next = (await upcoming(now))[0];
  if (!next) return null;

  const where = next.location.trim();
  if (!where || minutesBetween(now, next.at) > HORIZON_MINUTES) {
    return { title: next.title, at: next.at };
  }
  const travel = await travelMinutes(where);
  return travel === null
    ? { title: next.title, at: next.at, where }
    : {
        title: next.title,
        at: next.at,
        where,
        leaveBy: new Date(next.at.getTime() - (travel + GETTING_READY) * 60_000),
      };
}

/**
 * A reminder due today, for the line under the sky.
 *
 * Asks permission of nobody: this runs on a minute timer, and a dialog that
 * appears because a screen refreshed is the opposite of ambient. Without
 * access already granted it is simply never there.
 */
export async function dueToday(now = new Date()): Promise<string | null> {
  if (!(await hasRemindersAccess())) return null;
  const reminders = (await openReminders(20).catch(() => null)) ?? [];
  const today = reminders.find((r) => r.due && r.due.toDateString() === now.toDateString());
  return today?.title || null;
}
