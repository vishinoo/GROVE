/**
 * The one thing Grove offers to do next, and all the reasons it does not.
 *
 * Talking about a book and then having to say "send me the Amazon link" is a
 * sentence the conversation already contained. Saying "I want food" and then
 * having to separately ask for delivery, then for somewhere that fits what you
 * are eating this month, then for the link, is three sentences where one
 * exchange would do. So Grove may add **one line** to the end of a reply
 * offering the thing it could obviously do next.
 *
 * THE MODEL DECIDES WHAT; CODE DECIDES WHETHER
 *
 * The first version of this file was a list of keywords — books, the gym,
 * shares — each wired to one ability. It worked for exactly the three cases
 * written into it and was useless everywhere else, which is the definition of
 * a rail rather than a feature. Worse, it was wrong in the way a rail is
 * always wrong: "I'm running three minutes late" matched the gym rule and
 * offered a training plan.
 *
 * The model already sees the whole conversation, the long memory, the
 * constraints and every ability as a typed function, on a call that is being
 * made anyway. It is the only thing in the system that can tell a book worth
 * owning from a book mentioned in passing, or know that the restaurant should
 * suit what someone said about eating in January. So it proposes, in the same
 * breath as its reply, at no extra cost — the same bargain `ask_back` makes.
 *
 * This file is now the *whether*, which is the half a model should not be
 * trusted with:
 *
 *   1. **An offer must name a real ability and survive its schema.** The tool
 *      has to exist, be allowed in this mode, and have its required arguments
 *      filled. A proposal that fails any of that is dropped silently — the
 *      reply is still said, minus the offer.
 *
 *   2. **A kind you refuse stops being offered.** Per ability, so two nos to
 *      research notes switches research notes off and leaves the rest alone.
 *      Nobody should have to say no to the same sort of thing three times, or
 *      find a setting for it.
 *
 *   3. **Caps as a backstop.** The model's judgement is the primary control
 *      now, so these are looser than they were: four a day, two turns apart,
 *      never the same subject twice. They exist to bound a model having an
 *      enthusiastic afternoon, not to decide what is useful.
 *
 * WHAT AN OFFER IS NOT
 *
 * An offer is not a confirmation. Saying yes to "want me to send you the
 * link?" runs the ability from the beginning, which then asks for its own
 * press if it has one. Nothing here may set `confirmed`, and `npm run verify`
 * checks that — an offer that carried a confirmation would be a way to reach a
 * paid app with one yes to a question Grove thought of by itself.
 */

import { abilityById, type Ability } from './abilities';
import { abilityIdFor } from './tools';
import { vault } from './vault';

/** What the model proposed, before anything has been checked about it. */
export type Proposal = {
  /** The offer, one line, in Grove's own voice. */
  say: string;
  /** The tool it would call, however the model spelled it. */
  tool: string;
  /** Its arguments, as the model passed them — JSON, or already an object. */
  args: unknown;
};

export type Offer = {
  /**
   * The ability id. Also the unit the learning counts in: refusing to be sent
   * links is a different decision from refusing research notes.
   */
  kind: string;
  ability: string;
  /** What it would run with — checked against the ability's own schema. */
  args: Record<string, string>;
  /** The sentence added to the reply. */
  say: string;
  /** What it is about, so the same thing is never offered twice. */
  subject: string;
};

/**
 * The turn fills these in itself. A model that could set them would be able to
 * approve on the person's behalf, which is the one thing the confirmation
 * exists to prevent — so they are stripped here as well as in tools.ts, because
 * an offer is a second door into the same room.
 */
const NEVER_THE_MODELS = new Set(['confirmed', 'draft', 'new_email']);

/** An offer has to be a question, short, and not a receipt. */
const SAYABLE = /\?\s*$/;

function cleanArgs(raw: unknown): Record<string, string> | null {
  let value = raw;
  // Passed as a JSON string, because a flat function schema has nowhere to put
  // a nested object. Tolerant on purpose: a model that wraps it in prose or
  // forgets a brace should cost the offer, not the reply.
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return {};
    try {
      value = JSON.parse(text);
    } catch {
      const braced = /\{[\s\S]*\}/.exec(text);
      if (!braced) return null;
      try {
        value = JSON.parse(braced[0]);
      } catch {
        return null;
      }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_THE_MODELS.has(name)) continue;
    if (item === null || item === undefined) continue;
    const text = typeof item === 'string' ? item : String(item);
    if (text.trim()) out[name] = text.trim();
  }
  return out;
}

/**
 * What the model proposed, if it holds up.
 *
 * Null for anything that does not, and silently — the reply is still said. An
 * offer is the least important thing in the turn and must never be the reason
 * a turn fails.
 */
export function offerFrom(proposal: Proposal | null, available: Ability[]): Offer | null {
  if (!proposal) return null;

  const say = proposal.say.trim().replace(/\s+/g, ' ');
  // One line, and a question. A model that writes a paragraph here has
  // misunderstood the job, and a statement is not an offer — there would be
  // nothing for the person to say yes to.
  if (!say || say.length > 160 || !SAYABLE.test(say)) return null;

  const ids = available.map((a) => a.id);
  const ability = abilityById(abilityIdFor(proposal.tool, ids));
  // Not a real tool, or not one this mode allows. The model can only see what
  // it is given, so this is it inventing a name.
  if (!ability || !ids.includes(ability.id)) return null;

  const args = cleanArgs(proposal.args);
  if (!args) return null;

  /*
    Its own schema is the test of whether the offer is real.

    This is what replaced the keyword list, and it is a better rule than any
    list could be: an offer that cannot fill the required arguments of the
    thing it is offering has not actually worked out what it would do. "Want
    me to look that up for you?" with no topic is the sentence this feature
    exists to never say.
  */
  for (const [name, spec] of Object.entries(ability.args)) {
    if (spec.required === true && !(args[name] ?? '').trim()) return null;
  }

  /*
    What it is about, for "never the same thing twice".

    Taken from the arguments rather than from the sentence, because the
    arguments are the part that says what would actually happen — two
    differently-worded offers to buy the same book are one offer.
  */
  const subject = `${ability.id}:${Object.keys(args)
    .sort()
    .map((name) => args[name])
    .join(' ')
    .toLowerCase()
    .slice(0, 80)}`;

  return { kind: ability.id, ability: ability.id, args, say, subject };
}

/* --------------------------------------------------------------- budget */

type Ledger = {
  /** Local date, so the day's cap is a day's cap. */
  day: string;
  /** Made today: kind and subject, so neither repeats. */
  today: { kind: string; subject: string; at: string }[];
  /** Every subject offered, for as long as it is kept. Never offered twice. */
  subjects: string[];
  /** What each kind has earned. This is the whole of the learning. */
  learned: Record<string, Score>;
};

/**
 * What one kind of offer has earned, and why that is four fields.
 *
 * It used to be two — `yes` and `no` — with a rule that two nos and no yes
 * switched a kind off for good. That rule mistook **declining a bad call for
 * disagreeing with the idea**, and the two are not the same thing at all.
 * Saying no to two badly-chosen links is a verdict on those two links; it is
 * not an instruction to stop sending links, and treating it as one made a
 * genuinely useful ability look broken. Which is worse than never having
 * built it, because now the person knows it exists and has watched it stop.
 *
 * So declining and vetoing are recorded separately:
 *
 *   - `run` is declines since the last accept, and it buys **rest**, not
 *     death. A kind that has just been turned down twice waits a day before
 *     it tries again, and the wait grows if it keeps missing. Nothing here
 *     can take a kind to zero.
 *   - `vetoed` is only ever set by the person saying so out loud — "stop
 *     offering that". An explicit instruction outranks every count, which is
 *     the right way round: they should be able to switch something off in one
 *     sentence, and Grove should not be able to infer the same thing from two
 *     shrugs.
 *
 * `yes` and `no` are kept as running totals because the Memory screen shows
 * them. They no longer decide anything by themselves.
 */
type Score = {
  yes: number;
  no: number;
  /** Declines since the last accept. An accept resets it to nothing. */
  run: number;
  /** When the last decline landed, so the rest can expire on its own. */
  lastNo?: string;
  /** They said to stop. Only ever set by them saying so. */
  vetoed?: boolean;
};

const KEY = 'grove:offers:v1';

/**
 * Four. Looser than it was, because the model's own judgement is the control
 * now and a cap that bites every day is a cap doing the deciding.
 */
const PER_DAY = 4;

/**
 * Turns of ordinary conversation between offers.
 *
 * Counted in turns rather than minutes because an offer is part of a
 * conversation, not an interruption of one — two in a row reads as eagerness
 * whether they are a minute apart or an hour.
 *
 * The count itself is the caller's, held in memory rather than written down.
 * Spacing only has to hold within a conversation, and keeping it on disk would
 * have meant a read on every single turn — the one cost this must not have.
 */
export const TURNS_BETWEEN = 2;

/**
 * How long a kind rests after being turned down, by how many times in a row.
 *
 * Indexed by the run of declines since the last accept, in days. The first no
 * costs nothing extra — the generic spacing already covers it, and one no is
 * a verdict on one offer. The second buys a day. After that it climbs, and
 * stops climbing at a week, because a fortnight of silence is indistinguishable
 * from being switched off and that is the outcome this table exists to avoid.
 *
 * Seven days is the ceiling on what Grove may conclude from being ignored.
 * Anything longer has to be asked for.
 */
const REST_DAYS = [0, 0, 1, 3, 7];

/**
 * A decline older than this says nothing about today.
 *
 * Without it, two nos in January and two in June add up to a run of four and
 * a week of silence, which is a conclusion drawn from evidence five months
 * apart. Applied when the next decline is recorded, so the run restarts
 * rather than accumulating across a gap.
 */
const FORGETS_A_NO_AFTER_MS = 30 * 86_400_000;

/** Long enough that a subject is not offered again; short enough to forget. */
const SUBJECTS_KEPT = 80;

function dayStamp(now: Date): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function blank(now: Date): Ledger {
  return { day: dayStamp(now), today: [], subjects: [], learned: {} };
}

async function load(uid: string, now: Date): Promise<Ledger> {
  const fresh = blank(now);
  try {
    const raw = await vault.getItem(`${KEY}:${uid}`);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as Partial<Ledger>;
    return {
      day: fresh.day,
      // A new day clears the cap and keeps everything learned. The subjects
      // are kept too: a book offered yesterday is still the same book.
      today: parsed.day === fresh.day && Array.isArray(parsed.today) ? parsed.today : [],
      subjects: Array.isArray(parsed.subjects) ? parsed.subjects.slice(-SUBJECTS_KEPT) : [],
      learned: parsed.learned && typeof parsed.learned === 'object' ? parsed.learned : {},
    };
  } catch {
    return fresh;
  }
}

async function save(uid: string, ledger: Ledger): Promise<void> {
  try {
    await vault.setItem(`${KEY}:${uid}`, JSON.stringify(ledger));
  } catch {
    // Worst case the caps reset, which errs towards one offer too many. Not
    // good, and better than losing what has been learned about refusals.
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Read, change, write — one at a time.
 *
 * Every write here was a bare load-then-save, which is a lost update waiting
 * to happen: two of them landing in the same tick each read the ledger before
 * the other wrote it, and one is thrown away. The cases are real if rare —
 * charging the cap and recording the answer are two writes a second apart,
 * and a decline arriving while the previous offer is still being filed would
 * drop one of them. Which one gets dropped is the interesting part: losing
 * the decline means Grove never learns, and losing the charge means it offers
 * again immediately.
 *
 * The same shape as the queue in troubles.ts, and for the same reason.
 */
async function write(
  uid: string,
  change: (ledger: Ledger) => Ledger,
  now: Date
): Promise<void> {
  const run = queue.then(async () => {
    const ledger = await load(uid, now);
    const next = change(ledger);
    if (next !== ledger) await save(uid, next);
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Whether a kind has earned the right to be offered.
 *
 * Exported because the Memory screen shows it: an offer Grove has stopped
 * making is a decision about someone's experience of the app, and a decision
 * they cannot see is one they cannot overrule.
 */
export function welcome(
  learned: Ledger['learned'],
  kind: string,
  now: Date = new Date()
): boolean {
  const score = learned[kind];
  if (!score) return true;
  // Said outright. The only thing here that is permanent, and the only thing
  // the person has to ask for rather than Grove inferring it.
  if (score.vetoed) return false;

  const since = score.lastNo ? now.getTime() - Date.parse(score.lastNo) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(since) || Number.isNaN(since)) return true;
  // Long enough ago that it is history rather than a signal.
  if (since > FORGETS_A_NO_AFTER_MS) return true;

  const rest = REST_DAYS[Math.min(score.run, REST_DAYS.length - 1)] * 86_400_000;
  return since >= rest;
}

export type OfferVerdict =
  | { offer: true; chosen: Offer }
  | {
      offer: false;
      /*
        Stable reason codes, because these are read by something other than a
        person: the Memory screen says why a kind is quiet, and "resting" and
        "switched off" are different sentences to show somebody. Collapsing
        them was lazy — one of them recovers on its own and the other needs
        them to change their mind.
      */
      why: 'nothing' | 'resting' | 'vetoed' | 'spent' | 'too-soon' | 'repeat';
    };

/**
 * Whether to actually make it.
 *
 * Records nothing — the caller may still find the turn has moved on between
 * asking and speaking, and a cap charged for an offer nobody heard is an offer
 * nobody will ever get. `made` is called once the words are out.
 */
export async function worthOffering(
  uid: string,
  candidate: Offer | null,
  turnsSinceLast: number,
  now = new Date()
): Promise<OfferVerdict> {
  if (!candidate) return { offer: false, why: 'nothing' };
  if (!uid || uid === 'anon') return { offer: false, why: 'nothing' };
  // Checked before the read, so an ordinary conversation never touches
  // storage at all.
  if (turnsSinceLast < TURNS_BETWEEN) return { offer: false, why: 'too-soon' };

  const ledger = await load(uid, now);
  if (!welcome(ledger.learned, candidate.kind, now)) {
    return {
      offer: false,
      why: ledger.learned[candidate.kind]?.vetoed === true ? 'vetoed' : 'resting',
    };
  }
  if (ledger.subjects.includes(candidate.subject)) return { offer: false, why: 'repeat' };
  if (ledger.today.length >= PER_DAY) return { offer: false, why: 'spent' };
  return { offer: true, chosen: candidate };
}

/** Charges the caps, once the offer has actually been spoken. */
export async function made(uid: string, offer: Offer, now = new Date()): Promise<void> {
  if (!uid || uid === 'anon') return;
  await write(uid, (ledger) => ({
    ...ledger,
    today: [{ kind: offer.kind, subject: offer.subject, at: now.toISOString() }, ...ledger.today],
    subjects: [...ledger.subjects, offer.subject].slice(-SUBJECTS_KEPT),
  }), now);
}

/**
 * They said yes, or they said no.
 *
 * The only thing here that learns anything, and it learns from an answer to a
 * direct question — far better evidence than interrupt.ts gets, where silence
 * has to stand in for a verdict.
 */
export type Answer =
  /** Yes. The strongest signal there is, and it clears the slate. */
  | 'accepted'
  /** No to this one. Buys the kind some rest; never switches it off. */
  | 'declined'
  /** "Stop offering that." Said, not inferred. Permanent until undone. */
  | 'vetoed';

export async function answered(
  uid: string,
  kind: string,
  answer: Answer,
  now = new Date()
): Promise<void> {
  if (!uid || uid === 'anon') return;
  await write(uid, (ledger) => {
    const score: Score = ledger.learned[kind] ?? { yes: 0, no: 0, run: 0 };
    let next: Score;
    if (answer === 'accepted') {
      /*
        An accept clears the run and lifts a veto.

        Clearing the run is the point: it is what stops a kind that works
        from accumulating a sentence of its own out of the odd miss. And
        lifting the veto is how someone undoes one without finding a
        setting — they said stop, then later said yes, and the second is
        more recent and more specific than the first.
      */
      next = { yes: score.yes + 1, no: score.no, run: 0 };
    } else if (answer === 'vetoed') {
      next = { ...score, no: score.no + 1, run: score.run + 1, lastNo: now.toISOString(), vetoed: true };
    } else {
      // A gap long enough that the old declines are history restarts the run
      // rather than adding to it. See FORGETS_A_NO_AFTER_MS.
      const since = score.lastNo ? now.getTime() - Date.parse(score.lastNo) : Number.POSITIVE_INFINITY;
      const stale = !Number.isFinite(since) || since > FORGETS_A_NO_AFTER_MS;
      next = {
        yes: score.yes,
        no: score.no + 1,
        run: stale ? 1 : score.run + 1,
        lastNo: now.toISOString(),
        ...(score.vetoed ? { vetoed: true } : {}),
      };
    }
    return { ...ledger, learned: { ...ledger.learned, [kind]: next } };
  }, now);
}

/** Lets someone take a veto back from the Memory screen. */
export async function allowAgain(uid: string, kind: string, now = new Date()): Promise<void> {
  if (!uid || uid === 'anon') return;
  await write(uid, (ledger) => {
    const score = ledger.learned[kind];
    if (!score) return ledger;
    const { vetoed: _dropped, ...rest } = score;
    return { ...ledger, learned: { ...ledger.learned, [kind]: { ...rest, run: 0 } } };
  }, now);
}

/** For the Memory screen: what Grove has been told to stop offering. */
export async function offerStanding(
  uid: string,
  now = new Date()
): Promise<
  { kind: string; yes: number; no: number; welcome: boolean; vetoed: boolean; restingUntil?: string }[]
> {
  const ledger = await load(uid, now);
  return Object.keys(ledger.learned)
    .map((kind) => {
      const score = ledger.learned[kind];
      const rest = REST_DAYS[Math.min(score?.run ?? 0, REST_DAYS.length - 1)] * 86_400_000;
      // Shown rather than implied: "resting until Thursday" is a thing
      // somebody can disagree with, and "quietly off" is not.
      const until =
        score?.lastNo && rest > 0 ? new Date(Date.parse(score.lastNo) + rest) : null;
      return {
        kind,
        yes: score?.yes ?? 0,
        no: score?.no ?? 0,
        welcome: welcome(ledger.learned, kind, now),
        vetoed: score?.vetoed === true,
        ...(until && until.getTime() > now.getTime() ? { restingUntil: until.toISOString() } : {}),
      };
    })
    .sort((a, b) => Number(a.welcome) - Number(b.welcome) || b.no - a.no || a.kind.localeCompare(b.kind));
}

export async function forgetOffers(uid: string): Promise<void> {
  await vault.removeItem(`${KEY}:${uid}`).catch(() => {});
}
