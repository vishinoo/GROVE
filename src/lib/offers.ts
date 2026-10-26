/**
 * The one thing Grove offers to do next, and all the reasons it does not.
 *
 * Talking about a book and then having to say "order that on Amazon" is a
 * sentence the conversation already contained. Talking about training three
 * days a week and then asking for a plan is the same. The useful move is for
 * Grove to notice the thing it could do and ask once — and the useful move is
 * one word away from the thing that ruins it, which is an assistant that ends
 * every reply trying to sell you something.
 *
 * So this file is mostly restraint, and the restraint is the feature. It is
 * the same shape as interrupt.ts and for the same reason: what Grove *could*
 * say is easy and what it is *worth* saying is the product.
 *
 * FOUR RULES, AND THE SECOND ONE IS THE IMPORTANT ONE
 *
 *   1. **Rules, not a model.** This runs on every finished turn. A model call
 *      to decide whether to make an offer would cost more than the answer it
 *      is attached to, and would be wrong in a more imaginative way. Keywords
 *      over the person's own sentence, and a title lifted out of the reply.
 *
 *   2. **An offer must be able to name what it would do.** Every offer
 *      carries a real ability id and the real arguments it would run with,
 *      assembled from words that were actually said. If no arguments can be
 *      assembled there is no offer — which is what stops this becoming "shall
 *      I help with that?", the most annoying sentence software can produce.
 *      It is also why a vague conversation gets nothing: there is nothing to
 *      name.
 *
 *   3. **A kind you refuse stops being offered.** Not globally, per kind:
 *      saying no twice to research notes switches research notes off and
 *      leaves the rest alone. Nobody should have to find a setting for this,
 *      and nobody should have to say no three times.
 *
 *   4. **Hard caps over judgement.** One per turn, two a day, never two turns
 *      running, never the same kind twice in a day, never the same subject
 *      twice at all. Each of those is a number rather than a decision,
 *      because a judgement call made sixty times a day is a judgement call
 *      that will eventually be made badly.
 *
 * WHAT AN OFFER IS NOT
 *
 * An offer is not a confirmation. Saying yes to "want me to pull that up on
 * Amazon?" runs `shop.order` from the beginning, which then asks for its own
 * press like it always did. Nothing here may set `confirmed`, and
 * `npm run verify` checks that, because an offer that carried a confirmation
 * would be a way to reach a paid app with one yes to a question Grove thought
 * of by itself.
 */

import { vault } from './vault';

/**
 * The kinds, which are the unit everything here counts in.
 *
 * Deliberately few. Each one exists because there is an ability it maps onto
 * exactly, and a kind with no ability behind it is a conversation starter,
 * which is not what this is for.
 */
export type OfferKind = 'buy' | 'plan' | 'research';

export type Offer = {
  kind: OfferKind;
  /** The ability it would run. An id, checked against the real set by verify. */
  ability: string;
  /** What it would run with — from what was said, never invented. */
  args: Record<string, string>;
  /** The sentence added to the reply. One line, ends in a question. */
  say: string;
  /** What it is about, so the same thing is never offered twice. */
  subject: string;
};

/* ------------------------------------------------------------- noticing */

/** Already being done. An offer to do what was just asked for is noise. */
const ASKED_FOR =
  /\b(?:order|buy|purchase|add to (?:my )?(?:cart|basket)|write (?:me )?(?:a|an|the)? ?(?:doc|document|report|plan|note)|make me a doc|put together a (?:doc|report|note))\b/i;

/**
 * A title, as it appears in a sentence that was spoken aloud.
 *
 * Grove names a book in one of two ways: in quotes, or in title case. Both are
 * cheap to find and both fail closed — no title means no offer, which is
 * correct, because "want me to look up that book on Amazon?" asked about a
 * book Grove cannot name is a question the person has to answer twice.
 *
 * Markdown has already been stripped by `plainSpeech` before this sees it, so
 * asterisks are not a third case.
 */
function titleIn(text: string): string {
  const quoted = /["“']([A-Za-z0-9][^"”']{2,60})["”']/.exec(text);
  if (quoted) return quoted[1].trim();
  // Two or more capitalised words in a row, not at the start of a sentence
  // (where a capital is grammar rather than a name). Stop words let a title
  // keep its own small words — "The Art of Doing Science".
  const runs = text.match(
    /(?:[A-Z][a-z'’]+|[A-Z]{2,})(?:\s+(?:of|the|and|a|an|in|to|for|on)\s+|\s+)(?:[A-Z][a-z'’]+|[A-Z]{2,})(?:(?:\s+(?:of|the|and|a|an|in|to|for|on)\s+|\s+)(?:[A-Z][a-z'’]+|[A-Z]{2,}))*/g
  );
  if (!runs) return '';
  // The longest one, which is the title rather than a person's name in passing.
  const best = runs
    .map((r) => r.trim())
    .filter((r) => r.split(/\s+/).length >= 2 && !/^(?:I|I'?m|Want|Here|There|Your|You)\b/.test(r))
    .sort((a, b) => b.length - a.length)[0];
  return best ?? '';
}

const BOOK = /\b(?:book|books|novel|read(?:ing)?|author|audiobook|paperback|textbook)\b/i;

/** Already got it. Offering to buy someone a book they own is worse than silence. */
const HAS_IT = /\b(?:already (?:read|have|own|bought|got)|i'?ve read|i own|finished it|on my shelf)\b/i;

/**
 * A practice someone can have a plan for. Unambiguous on their own.
 */
const PRACTICE =
  /\b(?:gym|workout|workouts|training|lifting|weights|cardio|marathon|5k|10k|squats?|deadlifts?|bench press|revision|midterm|exam|finals?|syllabus|meal plan|macros)\b/i;

/**
 * The same subjects, said with words that mean other things too. These only
 * count alongside an intention.
 *
 * `run` is deliberately not here, and it is the instructive one. "I'm running
 * three minutes late" is what got through the first version, and pairing it
 * with an intention does not save it either: "I need to run to the shop" has
 * both. The word is a training word perhaps a third of the time, so it is out
 * altogether, and running as training arrives through `marathon`, `5k`, `10k`
 * and `cardio` instead. "I want to start running" is therefore missed — which
 * is the right way round to be wrong. A missed offer costs nothing; one that
 * fires on somebody being late is the whole feature discrediting itself.
 */
const PRACTICE_LOOSE = /\b(?:study|studying|revise|diet)\b/i;

/**
 * Wanting to do something about it, which is what makes a plan wanted.
 *
 * Mentioning a practice is not the same as having designs on it. "I went to
 * the gym today" is a remark; "I'm trying to get to the gym three times a
 * week" is a plan waiting to be written down, and only the second one should
 * produce an offer. This is the difference between the two.
 */
const INTENT =
  /\b(?:want(?:ing)? to|trying to|need to|have to|should|thinking (?:about|of)|going to|planning to|plan to|get(?:ting)? (?:back )?into|start(?:ing|ed)?|build(?:ing)?|improve|work on|keep up|stick to|cut (?:down|back)|\d+\s*(?:x|times)?\s*(?:a|per)\s*week|(?:once|twice|three times|four times|five times)\s*(?:a|per)\s*week|every (?:day|morning|week))\b/i;

const MONEY =
  /\b(?:stock|stocks|share|shares|equity|equities|portfolio|invest|investing|investment|etf|index fund|ticker|dividend|market cap|s&p|nasdaq)\b/i;

/**
 * Their money, rather than the news.
 *
 * "How did the market do today" is a lookup and gets its answer; it is not an
 * invitation to write a research note, and offering one is the feature being
 * pushy. A note is worth offering when the conversation is about what *they*
 * might do with their own money.
 */
const MINE =
  /\b(?:my|mine|i'?m|i am|i'?ve|i have|should i|for me|i want|i'?d like|thinking (?:of|about)|looking at|considering|put(?:ting)? (?:some )?money)\b/i;

/** A subject worth writing about, in the person's own words. */
function gistOf(said: string): string {
  return said.replace(/\s+/g, ' ').trim().slice(0, 240);
}

/**
 * Whether this exchange contains an offer, and which.
 *
 * Pure, and takes everything it needs. No storage, no clock, no model — so it
 * is testable by itself, which matters because the whole question about this
 * feature is how often it fires.
 *
 * `ran` is what the turn already did. An offer to write a document on a turn
 * that just wrote a document is the feature at its worst.
 */
export function offerFor(input: { said: string; replied: string; ran: string[] }): Offer | null {
  const said = input.said.trim();
  const replied = input.replied.trim();
  if (said.length < 12) return null;
  if (ASKED_FOR.test(said)) return null;

  const ran = new Set(input.ran);
  const both = `${said}\n${replied}`;

  /*
    A book, on Amazon.

    Needs a name. The trigger may come from either side of the exchange —
    they asked for a recommendation, or they mentioned one — but the title has
    to be findable in the reply, where Grove actually said it. No title, no
    offer, and that is the common case: most conversations about books do not
    name one.
  */
  if (BOOK.test(both) && !HAS_IT.test(said) && !ran.has('shop.order')) {
    const title = titleIn(replied) || titleIn(said);
    if (title) {
      return {
        kind: 'buy',
        ability: 'shop.order',
        // Never `confirmed`. shop.order asks for its own press; see the note
        // at the top of this file.
        args: { what: `${title} book`, store: 'amazon' },
        say: `Want me to pull ${title} up on Amazon?`,
        subject: title.toLowerCase(),
      };
    }
  }

  /*
    A plan, in their documents.

    Triggered on the person's own sentence rather than on Grove's reply: Grove
    mentioning the gym while answering something else is not the same as
    someone talking about their training, and the second is the only one where
    a plan is wanted.
  */
  if (
    (PRACTICE.test(said) || PRACTICE_LOOSE.test(said)) &&
    INTENT.test(said) &&
    !ran.has('doc.create') &&
    !ran.has('doc.append')
  ) {
    const subject = (
      PRACTICE.exec(said)?.[0] ??
      PRACTICE_LOOSE.exec(said)?.[0] ??
      ''
    ).toLowerCase();
    const studying = /\b(?:study|studying|revision|revise|exam|midterm|final|syllabus)\b/i.test(said);
    return {
      kind: 'plan',
      ability: 'doc.create',
      args: {
        title: studying ? 'Study plan' : 'Training plan',
        // Their words, which is what makes the document about their actual
        // situation rather than about the keyword that matched.
        about: `A practical ${studying ? 'study' : 'training'} plan for them, based on what they said: "${gistOf(
          said
        )}". Write it as a week they could follow, with specific sessions.`,
      },
      say: studying
        ? 'Want me to turn that into a study plan in your docs?'
        : 'Want me to write that up as a plan in your docs?',
      subject: `plan:${subject}`,
    };
  }

  /*
    A research note, on something with money attached.

    `research: 'yes'` because the whole failure mode here is a document full
    of figures that were true last year — doc.create's researched path looks
    each subject up against the web first. It is research and says so; it
    names no price target and no amount to spend. See the money note in
    abilities.ts.
  */
  if (MONEY.test(said) && (INTENT.test(said) || MINE.test(said)) && !ran.has('doc.create')) {
    const subject = (MONEY.exec(said)?.[0] ?? '').toLowerCase();
    return {
      kind: 'research',
      ability: 'doc.create',
      args: {
        title: 'Research note',
        about: `A research note on what they were asking about: "${gistOf(
          said
        )}". Current figures, dated, with the risks stated. Research rather than advice: no price targets, no recommendation of how much to put in.`,
        research: 'yes',
      },
      say: 'Want me to put a research note together on that?',
      subject: `research:${subject}`,
    };
  }

  return null;
}

/* --------------------------------------------------------------- budget */

type Ledger = {
  /** Local date, so the day's cap is a day's cap. */
  day: string;
  /** Made today: kind and subject, so neither repeats. */
  today: { kind: OfferKind; subject: string; at: string }[];
  /** Every subject offered, for as long as it is kept. Never offered twice. */
  subjects: string[];
  /** What each kind has earned. This is the whole of the learning. */
  learned: Record<string, { yes: number; no: number }>;
};

const KEY = 'grove:offers:v1';

/** Two. An assistant that proposes a third thing in a day is a salesman. */
const PER_DAY = 2;

/**
 * Turns of ordinary conversation between offers.
 *
 * Counted in turns rather than minutes because an offer is part of a
 * conversation, not an interruption of one — two in a row reads as eagerness
 * whether they are a minute apart or an hour.
 *
 * The count itself is the caller's, held in memory rather than written down.
 * Spacing only has to hold within a conversation, and keeping it on disk
 * would have meant a read and sometimes a write on every single turn — which
 * is the one cost this feature is not allowed to have. Across a relaunch the
 * day's cap and the subject list still hold.
 */
export const TURNS_BETWEEN = 6;

/**
 * Chances a new kind gets before it has to have earned one.
 *
 * Something never offered has no evidence either way, and refusing to try is
 * how a feature never gets used. Two is enough to tell the difference between
 * "not now" and "not this".
 */
const FREE_GOES = 2;

/** Said no this many times with nothing to show for it, and it is done. */
const ENOUGH_NO = 2;

/** Long enough that a subject is not offered again; short enough to forget. */
const SUBJECTS_KEPT = 60;

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
    const kept: Ledger = {
      day: fresh.day,
      // A new day clears the cap and keeps everything learned. The subjects
      // are kept too: a book offered yesterday is still the same book.
      today: parsed.day === fresh.day && Array.isArray(parsed.today) ? parsed.today : [],
      subjects: Array.isArray(parsed.subjects) ? parsed.subjects.slice(-SUBJECTS_KEPT) : [],
      learned: parsed.learned && typeof parsed.learned === 'object' ? parsed.learned : {},
    };
    return kept;
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
export function welcome(learned: Ledger['learned'], kind: OfferKind): boolean {
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
  if (ledger.today.some((t) => t.kind === candidate.kind)) return { offer: false, why: 'repeat' };
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
 * direct question — which is far better evidence than interrupt.ts gets, where
 * silence has to stand in for a verdict.
 */
export async function answered(
  uid: string,
  kind: OfferKind,
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

/** For the Memory screen: what Grove offers, and what it has stopped offering. */
export async function offerStanding(
  uid: string,
  now = new Date()
): Promise<{ kind: OfferKind; yes: number; no: number; welcome: boolean }[]> {
  const ledger = await load(uid, now);
  return (['buy', 'plan', 'research'] as OfferKind[]).map((kind) => ({
    kind,
    yes: ledger.learned[kind]?.yes ?? 0,
    no: ledger.learned[kind]?.no ?? 0,
    welcome: welcome(ledger.learned, kind),
  }));
}

export async function forgetOffers(uid: string): Promise<void> {
  await vault.removeItem(`${KEY}:${uid}`).catch(() => {});
}
