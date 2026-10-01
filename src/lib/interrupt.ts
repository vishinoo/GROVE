/**
 * What an interruption costs, and how much of that Grove may spend in a day.
 *
 * attention.ts decides what *could* be said. This decides whether it is worth
 * saying, which is a different question and the more important one. An
 * assistant that speaks whenever it has something true to say becomes a
 * notification machine, and a notification machine gets switched off — so the
 * product is not the things Grove can notice, it is the restraint about which
 * ones reach you.
 *
 * THE MEASURE IS NOT ENGAGEMENT
 *
 * Every other assistant is tuned to be used more. This one is tuned to use as
 * little of someone's attention as it can get away with. Those produce opposite
 * software, and this file is where the difference lives.
 *
 * WHY THE SCORE IS THREE THINGS AND NOT FIVE
 *
 * The obvious design multiplies five factors — importance, confidence, time
 * sensitivity, relevance, expected benefit. Three of those cannot be known here
 * and would be invented: relevance and expected benefit are the same guess
 * wearing different names, and both collapse into "how much would they regret
 * missing it", which the rule that produced the candidate already knows. So
 * there are three, each of which something real can be said about:
 *
 *   - **cost of missing**, stated by the rule itself, on a scale small enough
 *     that nobody can pretend to fine-grained judgement: 1 to 5.
 *   - **confidence**, which is genuinely computable wherever the evidence is a
 *     count. A fixture seen three of the last four weeks is 0.75, and saying so
 *     is honest in a way that 0.82 is not.
 *   - **perishability**, because being told to leave is worthless afterwards
 *     and a note about your spending is as true tomorrow.
 *
 * Confidence dressed up as a number nobody calibrated is worse than a count,
 * which is why none of these pretends to more precision than it has.
 *
 * THE ONE THING THE BUDGET MAY NEVER DO
 *
 * It may never silence a leave-by. A budget that can stop Grove saying "you
 * need to leave now" has turned a safety feature into a rationing problem, and
 * the first time it does that the whole thing is worthless. Anything scoring
 * above `ALWAYS` is exempt from the cap, the spacing and the learned threshold
 * alike. Everything else queues behind them.
 */

import { vault } from './vault';

/** A thing attention.ts could say, before anyone has decided whether to. */
export type Candidate = {
  id: string;
  say: string;
  /**
   * How much it costs this person to miss it, 1 to 5, stated by the rule.
   *
   *   5 — they will be late for something they chose.
   *   4 — they are about to walk into something unprepared.
   *   3 — something they committed to has slipped.
   *   2 — a pattern has broken and they may not have noticed.
   *   1 — true, and would keep until they asked.
   */
  costOfMissing: 1 | 2 | 3 | 4 | 5;
  /** 0–1. Taken from a count wherever there is a count to take it from. */
  confidence: number;
  /** How long it stays worth saying. */
  perishable: 'now' | 'today' | 'whenever';
};

export type Scored = Candidate & { score: number };

/** How much each kind of urgency is worth as a multiplier. */
const PERISHES: Record<Candidate['perishable'], number> = {
  // Useless once the moment passes, so its whole value is in being said now.
  now: 1,
  today: 0.6,
  // As true tomorrow, so there is no reason this had to be an interruption.
  whenever: 0.25,
};

/**
 * The bar, in the units above.
 *
 * Calibrated against the cases rather than chosen: a leave-by (5 × ~1 × 1 = 5)
 * clears it several times over, a fixture missing from the diary seen three of
 * four weeks (2 × 0.75 × 0.6 = 0.9) clears it, and the same fixture seen twice
 * (2 × 0.5 × 0.6 = 0.6) does not. A true observation that would keep until
 * tomorrow (1 × 1 × 0.25 = 0.25) never clears it, which is the intended result:
 * if it can wait, it waits.
 */
const THRESHOLD = 0.75;

/**
 * Above this, nothing may hold it back — not the daily cap, not the spacing,
 * not a learned tolerance. Reached only by a cost of 4 or 5 that perishes now.
 */
const ALWAYS = 3;

/** Three a day. Past that, Grove is a feed. */
const PER_DAY = 3;

/** Two interruptions inside this are one interruption too many. */
const SPACING_MINUTES = 45;

export function score(candidate: Candidate): Scored {
  const sure = Math.max(0, Math.min(1, candidate.confidence));
  return { ...candidate, score: candidate.costOfMissing * sure * PERISHES[candidate.perishable] };
}

/** Confidence from a count of occurrences out of the chances it had. */
export function outOf(seen: number, chances: number): number {
  if (chances <= 0) return 0;
  return Math.max(0, Math.min(1, seen / chances));
}

/* --------------------------------------------------------------- budget */

type Spend = {
  /** Local date, so the cap is a day's cap and not a rolling window. */
  day: string;
  /** What was said today, newest first, with when. */
  said: { id: string; at: string; score: number; answered?: boolean }[];
  /**
   * The last few interruptions and whether the person engaged with each.
   *
   * This is the whole of "learning their tolerance", and it is deliberately
   * crude: an interruption followed by them saying something within a few
   * minutes was wanted, and one followed by silence probably was not. Silence
   * is weak evidence — they may have been driving — so it takes a lot of it to
   * move the bar, and the bar can only move within a band.
   */
  history: { at: string; answered: boolean }[];
};

const KEY = 'grove:interrupt:v1';
/** Enough to see a habit of ignoring, not so much that last month still counts. */
const HISTORY_LIMIT = 20;
/** Below this many, there is nothing to learn from and the bar stays put. */
const ENOUGH_HISTORY = 6;
/** How long after a line counts as having answered it. */
const ANSWERED_WITHIN_MS = 3 * 60_000;

function dayStamp(now: Date): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

async function load(uid: string, now: Date): Promise<Spend> {
  const fresh: Spend = { day: dayStamp(now), said: [], history: [] };
  try {
    const raw = await vault.getItem(`${KEY}:${uid}`);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as Partial<Spend>;
    const history = Array.isArray(parsed.history) ? parsed.history.slice(-HISTORY_LIMIT) : [];
    // A new day resets what was spent and keeps what was learned.
    if (parsed.day !== fresh.day) return { ...fresh, history };
    return {
      day: fresh.day,
      said: Array.isArray(parsed.said) ? parsed.said : [],
      history,
    };
  } catch {
    return fresh;
  }
}

async function save(uid: string, spend: Spend): Promise<void> {
  try {
    await vault.setItem(`${KEY}:${uid}`, JSON.stringify(spend));
  } catch {
    // Worst case the cap resets, which errs towards one interruption too many
    // rather than towards silence. Neither is good; this one is recoverable.
  }
}

/**
 * How high the bar is for this person, given how they have reacted.
 *
 * Moves inside a band and no further. Someone who ignores everything should not
 * be able to drive the threshold past the point where a leave-by would be
 * caught by it — and nothing above ALWAYS consults this anyway.
 */
export function barFor(history: Spend['history']): number {
  if (history.length < ENOUGH_HISTORY) return THRESHOLD;
  const answered = history.filter((h) => h.answered).length;
  const rate = answered / history.length;
  // Answering most of them lowers the bar a little; ignoring most raises it.
  if (rate >= 0.6) return THRESHOLD * 0.8;
  if (rate <= 0.2) return THRESHOLD * 1.8;
  if (rate <= 0.4) return THRESHOLD * 1.3;
  return THRESHOLD;
}

export type Verdict =
  | { speak: true; chosen: Scored; bar: number }
  | { speak: false; why: 'nothing' | 'below-bar' | 'spent' | 'too-soon'; bar: number; best?: Scored };

/**
 * Whether to say any of these, and which.
 *
 * Does not record anything: the caller may still decide the moment has passed
 * between asking and speaking, and a budget charged for a line nobody heard is
 * a line nobody will ever hear. `spend` is called once the words are out.
 */
export async function worthSaying(
  uid: string,
  candidates: Candidate[],
  now = new Date()
): Promise<Verdict> {
  const spend = await load(uid, now);
  const bar = barFor(spend.history);
  if (candidates.length === 0) return { speak: false, why: 'nothing', bar };

  const ranked = candidates.map(score).sort((a, b) => b.score - a.score);
  const already = new Set(spend.said.map((s) => s.id));
  const fresh = ranked.filter((c) => !already.has(c.id));
  if (fresh.length === 0) return { speak: false, why: 'nothing', bar, best: ranked[0] };

  const best = fresh[0];

  // Nothing holds back a leave-by. See the note at the top.
  if (best.score >= ALWAYS) return { speak: true, chosen: best, bar };

  if (best.score < bar) return { speak: false, why: 'below-bar', bar, best };
  if (spend.said.length >= PER_DAY) return { speak: false, why: 'spent', bar, best };

  const last = spend.said[0];
  if (last && now.getTime() - new Date(last.at).getTime() < SPACING_MINUTES * 60_000) {
    return { speak: false, why: 'too-soon', bar, best };
  }
  return { speak: true, chosen: best, bar };
}

/** Charges the budget, once the words have actually been said. */
export async function spent(uid: string, chosen: Scored, now = new Date()): Promise<void> {
  const spend = await load(uid, now);
  await save(uid, {
    ...spend,
    said: [{ id: chosen.id, at: now.toISOString(), score: chosen.score }, ...spend.said].slice(0, 12),
    history: [...spend.history, { at: now.toISOString(), answered: false }].slice(-HISTORY_LIMIT),
  });
}

/**
 * The person said something. If it was soon after an interruption, that
 * interruption earned its place.
 *
 * Called on every turn, which is why it does nothing at all unless there is a
 * recent unanswered line to credit — this must not be a storage write per
 * sentence.
 */
export async function noteAnswered(uid: string, now = new Date()): Promise<void> {
  if (!uid || uid === 'anon') return;
  const spend = await load(uid, now);
  const last = spend.history[spend.history.length - 1];
  if (!last || last.answered) return;
  if (now.getTime() - new Date(last.at).getTime() > ANSWERED_WITHIN_MS) return;
  const history = [...spend.history];
  history[history.length - 1] = { ...last, answered: true };
  const said = spend.said.map((s, i) => (i === 0 ? { ...s, answered: true } : s));
  await save(uid, { ...spend, said, history });
}

/** For the screen: what Grove has spent today, and where the bar is. */
export async function budgetToday(
  uid: string,
  now = new Date()
): Promise<{ used: number; of: number; bar: number }> {
  const spend = await load(uid, now);
  return { used: spend.said.length, of: PER_DAY, bar: barFor(spend.history) };
}
