/**
 * "Last month", "in August", "a couple of weeks ago" — as a window of time.
 *
 * Searching memory by what was said works until someone remembers *when*
 * instead: "that idea I had last month" has one useful word in it, and it is not
 * "idea". This turns the time half of the question into a range the search can
 * filter on, so the words half only has to pick between a handful of things.
 *
 * Generous on purpose. People are vague about when things happened, and a
 * window that is a little too wide finds the thing; one that is exact to the day
 * misses it by an afternoon.
 */

export type Window = { from: Date; to: Date; label: string };

const DAY = 86_400_000;

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const COUNTS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, couple: 2, 'a couple of': 2, few: 3, 'a few': 3, three: 3,
  four: 4, five: 5, six: 6, several: 4,
};

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeek(d: Date): Date {
  // Weeks start on Monday, which is how people mean "this week".
  const x = startOfDay(d);
  const back = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - back);
  return x;
}

/**
 * A window for the time words in a phrase, or null when it names no time.
 *
 * Null is the common answer and the right one: most questions are not about
 * when, and inventing a window for them would hide everything outside it.
 */
export function windowFor(phrase: string, now = new Date()): Window | null {
  const t = ` ${phrase.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ')} `;
  const today = startOfDay(now);
  const tomorrow = new Date(today.getTime() + DAY);

  if (/ today | this morning | tonight | this afternoon | this evening /.test(t)) {
    return { from: today, to: tomorrow, label: 'today' };
  }
  if (/ yesterday | last night /.test(t)) {
    return { from: new Date(today.getTime() - DAY), to: today, label: 'yesterday' };
  }
  if (/ this week /.test(t)) {
    return { from: startOfWeek(now), to: tomorrow, label: 'this week' };
  }
  if (/ last week /.test(t)) {
    const thisWeek = startOfWeek(now);
    // A few days either side: "last week" said on a Monday usually means the
    // last seven days, not the calendar week that ended yesterday.
    return { from: new Date(thisWeek.getTime() - 9 * DAY), to: new Date(thisWeek.getTime() + 2 * DAY), label: 'last week' };
  }
  if (/ this month /.test(t)) {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: tomorrow, label: 'this month' };
  }
  if (/ last month /.test(t)) {
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth(), 1);
    // Plus a week into this month, since "last month" said on the 3rd often
    // means a few weeks back rather than strictly the previous calendar month.
    return { from: new Date(from.getTime() - 5 * DAY), to: new Date(to.getTime() + 7 * DAY), label: 'last month' };
  }
  if (/ (?:recently|lately|the other day) /.test(t)) {
    return { from: new Date(today.getTime() - 14 * DAY), to: tomorrow, label: 'recently' };
  }
  if (/ this year /.test(t)) {
    return { from: new Date(now.getFullYear(), 0, 1), to: tomorrow, label: 'this year' };
  }
  if (/ last year /.test(t)) {
    return { from: new Date(now.getFullYear() - 1, 0, 1), to: new Date(now.getFullYear(), 0, 1), label: 'last year' };
  }

  // "Three weeks ago", "a couple of days ago", "a few months back".
  const ago = / ((?:a couple of|a few|\d+|[a-z]+)) (day|week|month)s? (?:ago|back) /.exec(t);
  if (ago) {
    const n = /^\d+$/.test(ago[1]) ? Number(ago[1]) : COUNTS[ago[1]] ?? COUNTS[ago[1].replace(/^a /, '')];
    if (n) {
      const unit = ago[2] === 'day' ? DAY : ago[2] === 'week' ? 7 * DAY : 30 * DAY;
      const centre = today.getTime() - n * unit;
      // Half a unit either side, and at least two days.
      const slack = Math.max(2 * DAY, unit / 2 + (ago[2] === 'day' ? DAY : 0));
      return { from: new Date(centre - slack), to: new Date(Math.min(centre + slack, tomorrow.getTime())), label: `${ago[1]} ${ago[2]}s ago` };
    }
  }

  // "In August", "back in March". The most recent one that has started.
  for (let i = 0; i < MONTHS.length; i += 1) {
    if (new RegExp(` (?:in|during|back in|from) ${MONTHS[i]} `).test(t) || t.trim() === MONTHS[i]) {
      let year = now.getFullYear();
      if (i > now.getMonth()) year -= 1;
      return { from: new Date(year, i, 1), to: new Date(year, i + 1, 1), label: MONTHS[i] };
    }
  }

  return null;
}

/** Whether an ISO time falls inside a window. No window means everything does. */
export function within(iso: string, window: Window | null): boolean {
  if (!window) return true;
  const at = new Date(iso).getTime();
  return Number.isFinite(at) && at >= window.from.getTime() && at < window.to.getTime();
}

/** A date as it reads in a list the model will read: "Mon 14 Sep". */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
