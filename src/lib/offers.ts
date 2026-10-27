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
  learned: Record<string, { yes: number; no: number }>;
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
 * Chances a kind gets before it has to have earned one.
 *
 * Something never offered has no evidence either way, and refusing to try is
 * how a feature never gets used. Two is enough to tell the difference between
 * "not now" and "not this".
 */
const FREE_GOES = 2;

/** Said no this many times with nothing to show for it, and it is done. */
const ENOUGH_NO = 2;

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

/**
 * Whether a kind has earned the right to be offered.
 *
 * Exported because the Memory screen shows it: an offer Grove has stopped
 * making is a decision about someone's experience of the app, and a decision
 * they cannot see is one they cannot overrule.
 */
export function welcome(learned: Ledger['learned'], kind: string): boolean {
  const score = learned[kind] ?? { yes: 0, no: 0 };
  if (score.yes === 0 && score.no >= ENOUGH_NO) return false;
  if (score.yes + score.no < FREE_GOES) return true;
  // One in three is a low bar on purpose. These are useful rarely and worth a
  // lot when they land, so the thing to avoid is nagging, not a miss.
  return score.yes / (score.yes + score.no) >= 1 / 3;
}

export type OfferVerdict =
  | { offer: true; chosen: Offer }
  | { offer: false; why: 'nothing' | 'unwelcome' | 'spent' | 'too-soon' | 'repeat' };

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
  if (!welcome(ledger.learned, candidate.kind)) return { offer: false, why: 'unwelcome' };
  if (ledger.subjects.includes(candidate.subject)) return { offer: false, why: 'repeat' };
  if (ledger.today.length >= PER_DAY) return { offer: false, why: 'spent' };
  return { offer: true, chosen: candidate };
}

/** Charges the caps, once the offer has actually been spoken. */
export async function made(uid: string, offer: Offer, now = new Date()): Promise<void> {
  if (!uid || uid === 'anon') return;
  const ledger = await load(uid, now);
  await save(uid, {
    ...ledger,
    today: [{ kind: offer.kind, subject: offer.subject, at: now.toISOString() }, ...ledger.today],
    subjects: [...ledger.subjects, offer.subject].slice(-SUBJECTS_KEPT),
  });
}

/**
 * They said yes, or they said no.
 *
 * The only thing here that learns anything, and it learns from an answer to a
 * direct question — far better evidence than interrupt.ts gets, where silence
 * has to stand in for a verdict.
 */
export async function answered(
  uid: string,
  kind: string,
  yes: boolean,
  now = new Date()
): Promise<void> {
  if (!uid || uid === 'anon') return;
  const ledger = await load(uid, now);
  const score = ledger.learned[kind] ?? { yes: 0, no: 0 };
  await save(uid, {
    ...ledger,
    learned: {
      ...ledger.learned,
      [kind]: { yes: score.yes + (yes ? 1 : 0), no: score.no + (yes ? 0 : 1) },
    },
  });
}

/** For the Memory screen: what Grove has been told to stop offering. */
export async function offerStanding(
  uid: string,
  now = new Date()
): Promise<{ kind: string; yes: number; no: number; welcome: boolean }[]> {
  const ledger = await load(uid, now);
  return Object.keys(ledger.learned)
    .map((kind) => ({
      kind,
      yes: ledger.learned[kind]?.yes ?? 0,
      no: ledger.learned[kind]?.no ?? 0,
      welcome: welcome(ledger.learned, kind),
    }))
    .sort((a, b) => b.no - a.no || a.kind.localeCompare(b.kind));
}

export async function forgetOffers(uid: string): Promise<void> {
  await vault.removeItem(`${KEY}:${uid}`).catch(() => {});
}
