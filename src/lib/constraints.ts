/**
 * Everything standing between this person and what they want, in one place.
 *
 * Money was the first one built and it is not actually about money. The useful
 * abstraction underneath it is a **constraint**: a fact about someone's
 * situation that makes some answers wrong which would otherwise be right. A
 * budget is one. So are the forty minutes before a lecture, the fact that today
 * started two hours late, the thing they promised Jason on Tuesday, and the
 * concept they have never managed to follow.
 *
 * Collected together they let a reply do something no single integration can:
 * answer "what should I do now" against the actual shape of the day rather than
 * against a calendar. "You have an hour, £180 left for the month, and you have
 * not started the thing due Friday" is a different answer from "you are free
 * until 4".
 *
 * WHY THIS IS A READ AND NOT A STORE
 *
 * Nothing here is stored. Every line is assembled from somewhere that already
 * owns it — money.ts, rhythms.ts, inbox.ts, life.ts, memory.ts, struggles.ts,
 * the calendar — and the whole point is that the assembling happens in one
 * place so a new constraint reaches every answer at once rather than being
 * threaded through each ability by hand.
 *
 * WHY IT IS NOT IN EVERY PROMPT
 *
 * Because it needs the diary, and the diary is a network call. A constraint
 * read on every turn would put a Google request in front of "what's the
 * weather", which is the kind of cost that makes an assistant feel slow for no
 * benefit anyone asked for. So the cheap constraints — the rhythm, the focus
 * session, the few things on their list, the frictions — ride in the prompt on
 * every turn, and the full picture is assembled by `now.context`, which is the
 * ability someone reaches when the shape of their day is actually the question.
 */

import { localTime } from './when';
import * as inbox from './inbox';
import * as money from './money';
import { loadFacts } from './memory';
import { loadLife, openCommitments } from './life';
import { loadStruggles, frictionBlock, open as openStruggles } from './struggles';
import type { CalendarEvent } from './google';

/** One thing that narrows what a good answer looks like. */
export type Constraint = {
  /**
   * What kind of limit this is. Grouped rather than ranked, because the
   * ordering that matters is whatever the question is about.
   */
  kind: 'time' | 'money' | 'commitment' | 'energy' | 'knowledge' | 'attention';
  /** One line, written to be read by a model rather than spoken. */
  says: string;
  /**
   * Where it came from, which is the difference between a fact and a guess.
   *
   *   'told'     — they said so.
   *   'observed' — counted from something that happened, with the count in the
   *                line itself wherever there is one.
   *   'inferred' — worked out from the two above, and the only kind that can be
   *                wrong in a way they would not recognise.
   */
  how: 'told' | 'observed' | 'inferred';
};

function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

/**
 * The constraints in force right now.
 *
 * `events` is passed in rather than fetched, because the one caller that wants
 * this already has the diary and fetching it twice for one answer is the sort
 * of thing nobody notices until the turn takes four seconds.
 */
export async function constraints(
  uid: string,
  events: CalendarEvent[] | null,
  now = new Date()
): Promise<Constraint[]> {
  const [held, facts, life, captures, focus, stuck] = await Promise.all([
    money.loadMoney(uid).catch(() => null),
    loadFacts(uid).catch(() => []),
    loadLife(uid).catch(() => null),
    inbox.loadInbox(uid).then(inbox.open).catch(() => []),
    inbox.loadFocus(uid).catch(() => null),
    loadStruggles(uid).catch(() => []),
  ]);

  const out: Constraint[] = [];

  /* ------------------------------------------------------------ time */

  if (focus) {
    const left = inbox.remaining(focus);
    out.push({
      kind: 'attention',
      says: `They are deliberately on ${focus.what}${left ? `, ${left}` : ''}. Anything else is an interruption they asked you to defend them from.`,
      how: 'told',
    });
  }

  const timed = (events ?? []).filter((e) => !e.allDay);
  const next = timed
    .map((e) => ({ ...e, at: localTime(e.start) }))
    .filter((e) => e.at.getTime() > now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())[0];
  if (next) {
    const gap = minutesBetween(now, next.at);
    out.push({
      kind: 'time',
      says:
        gap <= 240
          ? `${gap} minutes free before ${next.title}. Nothing suggested should take longer than that.`
          : `Nothing in the diary for ${Math.round(gap / 60)} hours, until ${next.title}.`,
      how: 'told',
    });
  } else if (events !== null) {
    out.push({ kind: 'time', says: 'Nothing else in the diary today.', how: 'told' });
  }

  /* ----------------------------------------------------------- money */

  if (held && (held.monthly !== undefined || held.purchases.length > 0)) {
    const s = money.standing(held, now);
    const through = Math.round(s.through * 100);
    out.push({
      kind: 'money',
      says:
        s.left === null
          ? `${money.asMoney(s.thisMonth, held.currency)} spent this month, with no budget set. Do not assume anything about what they can afford.`
          : `${money.asMoney(s.left, held.currency)} left of ${money.asMoney(held.monthly ?? 0, held.currency)} for the month, which is ${through}% through. Nothing you suggest should quietly cost money.`,
      how: 'told',
    });
  }

  /* ----------------------------------------------- commitments owed */

  const promised = life ? openCommitments(life) : [];
  if (promised.length > 0) {
    out.push({
      kind: 'commitment',
      says: `Promised and not done: ${promised.slice(0, 4).map((e) => e.title).join('; ')}.`,
      how: 'observed',
    });
  }
  const owed = facts.filter((f) => f.open).map((f) => f.value);
  if (owed.length > 0) {
    out.push({ kind: 'commitment', says: `Still owed: ${owed.slice(0, 4).join('; ')}.`, how: 'told' });
  }
  if (captures.length > 0) {
    out.push({
      kind: 'attention',
      says: `${captures.length} caught and not dealt with, oldest first: ${captures
        .slice(-3)
        .map((c) => c.text)
        .join('; ')}.`,
      how: 'told',
    });
  }

  /* ---------------------------------------------------------- goals */

  const goals = facts.filter((f) => f.kind === 'goal').map((f) => f.value);
  if (goals.length > 0) {
    out.push({
      kind: 'commitment',
      says: `Working towards: ${goals.join('; ')}. A suggestion that works against one of these is the wrong suggestion.`,
      how: 'told',
    });
  }

  /* ------------------------------------------------------ knowledge */

  const gaps = openStruggles(stuck).filter((x) => (x.kind ?? 'knowledge') === 'knowledge');
  if (gaps.length > 0) {
    out.push({
      kind: 'knowledge',
      says: `Not yet understood: ${gaps.slice(0, 4).map((g) => `${g.what}${g.raised > 1 ? ` (raised ${g.raised} times)` : ''}`).join('; ')}.`,
      how: 'observed',
    });
  }
  const friction = frictionBlock(stuck);
  if (friction) out.push({ kind: 'knowledge', says: friction, how: 'observed' });

  return out;
}

/**
 * The same thing as prompt.
 *
 * Provenance is printed, not dropped. A model reading "normally up by 08:00
 * (observed)" beside "£400 a month (told)" can tell which of the two it is
 * allowed to state back as a fact, and which one it should hedge — and the
 * person hearing "you're usually up by eight" deserves to find out it came
 * from counting rather than from being told.
 */
export function constraintLines(all: Constraint[]): string {
  if (all.length === 0) return '';
  return [
    'What is actually constraining them right now:',
    ...all.map((c) => `- [${c.kind}, ${c.how}] ${c.says}`),
  ].join('\n');
}
