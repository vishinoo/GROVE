/**
 * Grove's brain.
 *
 * WHAT CHANGED, AND WHY
 *
 * This used to send every turn to Indy on Noctus, pick from a catalogue of 74
 * Noctus agents, and run one there. All three are gone. The catalogue was a
 * business-agent catalogue — Marketing, Sales, Wholesale Fulfilment — and
 * three of its seventy-four were shaped like anything a person does with their
 * own day. Indy was capped at two messages an hour, which is not a budget you
 * can hold a conversation inside.
 *
 * So Noctus is plumbing now: it brokers OAuth, it will hold the model key, and
 * it runs scheduled sparks while the phone sleeps. It has no opinion about what
 * Grove can do. That lives in abilities.ts, as functions.
 *
 * TWO DECISIONS STAY LOCAL AND STAY BORING
 *
 *   detectActIntent  — whether a sentence should cause something to happen.
 *   parseSchedule    — whether it should keep happening.
 *
 * Both are keyword-based, both are biased toward "no", and neither is ever
 * delegated to a model. A false negative costs one more sentence. A false
 * positive sends mail you did not write, or wakes you at seven every morning
 * for something you asked once.
 */

import { usableAbilities, type Ability } from './abilities';
import { askWithTools, type RanTool } from './brain';
import { type Extracted, type Fact } from './memory';
import { type Persona } from './persona';
import type { Proposal } from './offers';

export type TurnTool = {
  name: string;
  state: 'running' | 'done' | 'failed' | 'blocked';
  detail?: string;
  needs?: string[];
};

export type Turn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tool?: TurnTool;
  createdAt: string;
};

export type GroveReply = {
  /**
   * The model asked something back on purpose and is waiting for the answer,
   * so the microphone should open when it has finished speaking.
   */
  expectsReply?: boolean;
  /**
   * One more thing the model reckons it could do next, proposed and not run.
   *
   * Unchecked at this point — it is whatever the model said. `offerFrom` in
   * offers.ts decides whether it names a real ability with real arguments,
   * and the budget decides whether it is worth a line. See that file.
   */
  offer?: Proposal;
  /** What Grove says. Always non-empty. */
  text: string;
  /** The ability to run now, when the user asked for something to happen. */
  ability?: Ability;
  args: Record<string, string>;
  /**
   * Set when the sentence carried a recurrence, so the caller saves a spark
   * instead of just running the thing once.
   */
  schedule?: never;
  /**
   * Set when the sentence taught a phrase — "whenever I say X". The other kind
   * of standing job, and the reason a caller must not test `schedule` alone to
   * decide whether to save one.
   */
  phrase?: string;
  /** An ability that fits but is not built or connected yet. */
  blocked?: Ability;
  /** A short name for the standing job, when this is one. */
  title?: string;
  /**
   * What the standing job should do, in plain language, with the scheduling
   * clause taken out. Stored on the spark and re-read when it runs, so an
   * instruction can say more than today's ability list knows how to do.
   */
  instruction?: string;
  /** A fact worth keeping, pulled locally from what was said. */
  fact?: Extracted;
  /**
   * Say nothing yet — a read is running and its result is the answer.
   *
   * Set for abilities marked `reads`, where anything said first is either a
   * second holding line or the model guessing at data it has not seen.
   */
  holdForTool?: boolean;
  /**
   * Whether `text` is the model's own line about the action it is handing
   * back, rather than the answer to some other part of the sentence.
   *
   * "What's the weather and remind me to call mum at six" runs the weather
   * inside the loop and hands back the reminder, so `text` is the forecast —
   * which says nothing whatever about the reminder. Substituting it for the
   * tool's confirmation set the reminder and never mentioned it. The two have
   * to be told apart: one replaces the confirmation, the other precedes it.
   */
  wroteForAction?: boolean;
  /**
   * Reads that already ran while the model was working out its answer.
   *
   * Recorded so the Talk screen can show what was looked up — the answer is
   * spoken from these, and a card that says nothing ran would be untrue.
   */
  ran?: RanTool[];
};

export function newTurn(role: Turn['role'], text: string, extra: Partial<Turn> = {}): Turn {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    role,
    text,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

/* ---------------------------------------------------------------- intent */

const QUESTION_OPENERS =
  /^\s*(what|what'?s|how|how'?s|why|when|where|who|which|whose|should|shall|can|could|would|will|is|are|was|were|do|does|did|have|has|am|any|tell me|explain|remind me what)\b/i;

/**
 * A go-ahead is the WHOLE sentence, not a word it happens to start with.
 *
 * Anchored at both ends, and that anchoring is the entire point. Matching on a
 * prefix meant "Now what's on my calendar?" and "Go on, what did she say?" both
 * read as instructions — they start with "now" and "go on" — and went on to
 * pick something and run it. Those are questions.
 */
/**
 * A mode named on its own.
 *
 * Anchored to the whole sentence so that "I need to focus" and "the study is
 * upstairs" are untouched — only a sentence that is nothing but a mode name
 * counts as asking for one.
 */
const BARE_GO_AHEAD =
  /^\s*(?:(?:ok|okay|yes|yeah|yep|sure|right)[,.\s]+)?(?:please\s+)?(?:do it|do that|go ahead|go on|run it|sort it|handle it|get on with it|make it so|please do|go|now)[.!\s]*$/i;

/** "yes", "yeah", "ok", "yes please" — answering something Grove just offered. */
const BARE_YES =
  /^\s*(?:(?:ok|okay|yes|yeah|yep|sure)(?:[,\s]+please)?|please do)[.!\s]*$/i;

/** A verb of work aimed at Grove. */
/**
 * Verbs that mean something should happen — in the position that means it.
 *
 * Matching a verb anywhere in the sentence was the original design and it was
 * wrong in the dangerous direction: "I was going to text Sam later" and "she
 * said she would email me back" both fired, because both contain the verb. The
 * rule this gate exists to protect is that a false positive sends mail nobody
 * wrote, and a statement about sending mail is exactly how that happens.
 *
 * An instruction to Grove leads with its verb. A statement puts a subject
 * first. That distinction does the work that counting keywords could not:
 *
 *   "text Sam that we are going at seven"   -> acts
 *   "I was going to text Sam later"         -> does not
 *
 * Address forms are allowed in front of it, because people say "please" and
 * "hey Grove" and mean the imperative that follows.
 */
const VERBS = String.raw`make|create|build|draft|write|plan|book|schedule|send|order|buy|find|check|update|add|put|move|cancel|remind|track|log|sync|generate|prepare|set up|play|read|brief|tell me about|email|text|message|call|switch to|switch into|go into|turn on|turn off|open|handle|push|reschedule|delay|shift|dim|start|stop|queue|skip|pause|resume|let .{2,20} know|give me|reply|respond|answer|forward|let'?s go|take me|drive me|directions|navigate|which way|delete|remove|take|summari[sz]e|catch me up|recap|digest|remember|note|jot|keep in mind|don'?t let me forget|tick|mark|ring|dial|complete|finished|get me|order|uber|book me|share|capture|focus(?: on)?|jot|forget|set|talk me out of`;

/** "hey Grove, please …" — anything that can precede an instruction. */
/**
 * Whatever people say before the instruction.
 *
 * Grove is renameable, so hardcoding its own name was never going to be
 * enough — someone who calls theirs "Buddy" said "Buddy, just check my email"
 * and the gate saw no imperative at the start of the sentence and refused the
 * whole turn. Any single word followed by a comma is treated as an address,
 * which is what a vocative looks like and is not something a statement does.
 */
const ADDRESS = String.raw`(?:(?:hey|hi|yo|ok(?:ay)?)\s+)?(?:[a-z]{2,14},\s*)?(?:(?:ok(?:ay)?|now|then|also|and|please|just|quickly)\s+)*`;

const IMPERATIVE = new RegExp(`^\\s*${ADDRESS}(?:${VERBS})\\b`, 'i');

/**
 * "Can you play something?" is an instruction wearing a question mark.
 *
 * The subject is what separates it from a question that must never act:
 * "can YOU send it" is addressed to Grove, "should I send it" is asking for
 * advice about something the person will do themselves.
 */
/** "Can you do it for me", and nothing looser than that. */
const DO_IT_FOR_ME =
  /\bcan you (?:please )?(?:just )?do (?:it|this|that|the \w[\w '-]{0,30}) for me\b/i;

const POLITE_COMMAND = new RegExp(
  `^\\s*${ADDRESS}(?:can|could|will|would)\\s+you\\s+(?:please\\s+)?(?:${VERBS})\\b`,
  'i'
);

/**
 * Asking to be taken somewhere.
 *
 * Anchored to the start of the sentence, like the imperative test and for the
 * same reason: "she said she would drive to work tomorrow" contains a perfectly
 * good route request belonging to someone else. A destination has to follow,
 * which keeps "I want to go" out of it.
 */
const NAV_COMMAND = new RegExp(
  `^\\s*${ADDRESS}(?:` +
    // "take me to…", "navigate to…", "directions to…"
    `(?:take me|navigate|directions|route|drive|walk|head)\\s+(?:me\\s+)?to\\s+\\S` +
    // "I want to go to…", "I'm going to head to…"
    `|(?:i(?:'d| would)? (?:want|need|like) to |i'?m going to )(?:go|get|drive|walk|head)\\s+to\\s+\\S` +
    // "how do I get to…", "which way to…", "let's go to…"
    `|how (?:do i|can i|long to) get to\\s+\\S` +
    `|which way to\\s+\\S` +
    `|let'?s (?:go|head|drive) to\\s+\\S` +
    `)`,
  'i'
);

/**
 * Asking for something to be ordered, with the subject in front.
 *
 * Anchored and narrow: it needs the verb AND something after it, so "I want to
 * order" on its own is not a request and "we should order sometime" is talk.
 */
const ORDER_COMMAND = new RegExp(
  `^\\s*${ADDRESS}(?:i(?:'d| would)? (?:want|need|like) to |i'?m going to )(?:order|get)\\s+\\S`,
  'i'
);

/**
 * Stating a figure: what something cost, or what they have to spend.
 *
 * Needed for the same reason STRUGGLE_STATEMENT is — these are statements, not
 * instructions, and every one of them leads with a subject rather than a verb.
 * "I spent eighty on shoes" is the sentence that makes every later piece of
 * money advice specific instead of hedged, and without a gate it reached
 * nothing at all.
 *
 * The last branch is the narrow one and is anchored at the end on purpose:
 * "dinner was 140" is a price and "the film was 140 minutes" is not, and the
 * only reliable difference is whether a unit follows the number.
 */
const MONEY_STATEMENT = new RegExp(
  `^\\s*${ADDRESS}(?:` +
    String.raw`i (?:just |only )?(?:spent|paid|bought|picked up|dropped)\b` +
    String.raw`|i(?:'ve| have)? got (?:about )?(?:[$£€]\s*)?\d` +
    String.raw`|i have (?:about )?(?:[$£€]\s*)?\d[\d.,]*\s*(?:a|per|each) (?:month|week)\b` +
    String.raw`|my (?:\w+ )?budget is\b` +
    String.raw`|my monthly (?:budget|spend|allowance)\b` +
    ')' +
    String.raw`|^.{0,40}\bwas\s+(?:[$£€]\s*)?\d+(?:\.\d{1,2})?\s*(?:dollars|pounds|euros|bucks|quid)?\s*[.!]?\s*$`,
  'i'
);

/**
 * Saying you did not understand something.
 *
 * Shaped like ordinary conversation rather than like an instruction, which is
 * why it needs its own gate: "I don't get integration by parts" leads with
 * "I", carries no verb the imperative test knows, and is the single most
 * important sentence in the whole study feature. Without this it reached
 * nothing, and Grove explained the concept again and wrote nothing down —
 * which is exactly the version of an AI tutor that is worth nothing.
 *
 * The last branch is the opposite statement, because "I actually get beta now"
 * has to be able to close one. A false positive here costs a question on a
 * quiz, which is also what a true positive costs.
 */
const STRUGGLE_STATEMENT = new RegExp(
  `^\\s*${ADDRESS}(?:` +
    String.raw`i (?:don'?t|do not|didn'?t|did not|cannot|can'?t|still don'?t) (?:understand|get|follow|grasp|see)\b` +
    String.raw`|i'?m (?:confused|lost|stuck|not following)\b` +
    String.raw`|(?:this|that|it|none of (?:this|it)) (?:still )?(?:isn'?t|is not|doesn'?t|does not|never) (?:click|clicking|clicks|mak(?:e|ing) sense|land|landing)\b` +
    String.raw`|i (?:actually |finally |think i )?(?:get|understand|follow) \S.{0,40}\bnow\b` +
    // The behavioural half: a thing that keeps going wrong rather than a thing
    // not understood. Same primitive, same gate, and the same reason — it is a
    // statement about themselves with no verb the imperative test can see.
    String.raw`|i (?:always|keep|constantly|never) (?:remember|forget|forgetting|skip|skipping|miss|missing|put off|leave|leaving|lose|losing|mess up|get .{0,20} wrong)\b` +
    ')',
  'i'
);

/**
 * Things that follow "go to" and are not places.
 *
 * "I want to go to bed" and "I need to get to the bottom of this" are the two
 * that actually came up: both are shaped exactly like a route request and
 * neither is one. Checked separately rather than woven into the pattern above,
 * because a list of exceptions is easier to read and to add to than a regex
 * with holes cut in it.
 */
const NOT_A_DESTINATION =
  /\b(?:bed|sleep|the bottom of|the trouble|the point)\b/i;


/**
 * Whether the user wants something done, rather than discussed.
 *
 * This gates every ability run, so it errs toward "no".
 */
/**
 * Questions that can only be answered by looking something up.
 *
 * detectActIntent refuses every question, which is right for anything with
 * consequences and wrong for the ones whose whole content is "go and read
 * something". "What's on my calendar" was answered from the model's own head,
 * and the answer was "nothing on" to a person looking at a full calendar —
 * confidently, specifically wrong, which is the worst failure this app has.
 *
 * The safety property is kept intact by narrowing what may run rather than by
 * loosening when: this gate only ever admits abilities marked `reads`, so a
 * false positive here costs a calendar lookup nobody wanted. It cannot send
 * mail, move an event or message anyone — those still need detectActIntent.
 */
/**
 * Requests that read as questions without being shaped like one.
 *
 * Anchored to the start, so this admits "anything from Priya" and leaves
 * "I'll do anything" alone.
 */
const ELLIPTICAL_LOOKUP =
  /^\s*(?:anything|any (?:mail|messages|emails|news)|catch me up|brief me|where am i at|remind me who)\b/i;

const LOOKUP_QUESTION =
  /\b(calendar|schedule|diary|agenda|weather|forecast|temperature|rain|coat|umbrella|wear|traffic|how long|how far|eta|leave for|leave by|set off|get there|get home|which way|way to|route to|far is|my day|day looking|got on|first thing|last thing|next thing|what time is|what time'?s|note|notes|memo|memos|to-?do|task|tasks|my list|still have to do|number|phone number|contact|first class|last class|of the day|first class|class|appointment|meeting|event|events|booked|flight|this week|anything with|anything on|on today|on tomorrow|next (?:thing|meeting|event)|free (?:at|on|today|tomorrow)|inbox|email|emails|mail|doc|docs|document|plan|notes|spreadsheet|drive|document|documents|report|reports|written|inbox|captured|capture|news|markets|happened|remind me (?:what|who|about)|supposed to|do i know about|did i say|what did i|anything from|say about|did .{2,20} say|supposed to be doing|should i (?:do|work on|be doing|start)|what now|where am i at|catch me up|idea|ideas|decide|decided|decision|working on|been up to|happened|brief me|who is|who's|important|attention|urgent|deal with|needs me|need(?:s)? (?:my )?(?:attention|doing)|outstanding|promised|owe|commitment|commitments|free time|have (?:an? )?(?:hour|minutes?)|did .{2,20} do|score|won|win|lose|lost|game|match|free online|free to|how much|cost|costs|price|open|opens|close|closes|hours|where can i|where do i|buy|available|afford|budget|spent|spend|spending|money|cheaper|worth it)\b/i;

/**
 * Whether this is a question Grove should look up rather than answer offhand.
 *
 * Deliberately requires the sentence to be a question AND to name something
 * lookable. Either alone is too broad — "what do you think of jazz" names
 * nothing to read, and "calendar" on its own is not a question.
 */
export function detectLookupIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Already handled by the stricter gate; nothing to add.
  if (detectActIntent(t)) return false;
  // "Anything from Priya?" without the question mark is not question-shaped and
  // carries no verb, so both gates refused it and the mail ability could never
  // run. It is still unmistakably a request to go and look.
  // "I have 40 minutes before class, what should I do" puts the question after
  // the context it depends on, so testing only the opening word refused it.
  const LATE_QUESTION = /,\s*(?:what|which|who|when|where|how)\b/i;
  const isQuestion =
    QUESTION_OPENERS.test(t) || t.endsWith('?') || ELLIPTICAL_LOOKUP.test(t) || LATE_QUESTION.test(t);
  return isQuestion && LOOKUP_QUESTION.test(t);
}

/**
 * Starting or ending a focus session, said as people say it.
 *
 * Checked before the mode words, because "focus on the Noctus build" is a
 * session on a thing and "focus mode" is a mode, and the words overlap.
 */
const FOCUS_SESSION =
  /^\s*(?:(?:hey|ok|okay)\s+)?(?:[a-z]{2,14},?\s+)?(?:(?:i(?:'m| am) (?:working on|studying|on|focusing on)|focus on|let'?s focus on|start (?:a )?focus session)\b|(?:i(?:'m| am) )?(?:done|finished) (?:focusing|studying|with that)\b|(?:end|stop) (?:the )?focus session\b)/i;

/**
 * "I have to do the dishes." A thing they have to do, said out loud.
 *
 * Not a question and not a request, which is why both gates refused it — and
 * refusing it meant the thing was lost, which is the one outcome a capture
 * inbox exists to prevent. Anchored to the start so "he said I need to check"
 * stays a remark, and "I should" is left out on purpose: "I should probably
 * cancel that" is someone thinking aloud, and this gate can reach the ability
 * that cancels things.
 */
const TODO_STATEMENT =
  /^\s*(?:(?:hey|ok|okay)\s+)?(?:[a-z]{2,14},?\s+)?(?:oh,?\s+)?(?:and\s+)?(?:i (?:have|need) to|i'?ve got to|i gotta|i must)\s+\S/i;

export function detectActIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (FOCUS_SESSION.test(t)) return true;
  if (TODO_STATEMENT.test(t)) return true;
  // "I don't get this" is a request to write it down, however little it looks
  // like one. See STRUGGLE_STATEMENT.
  if (STRUGGLE_STATEMENT.test(t)) return true;
  // "I spent eighty on shoes" is a thing to write down, and leads with a
  // subject like every other statement the imperative test cannot see.
  if (MONEY_STATEMENT.test(t)) return true;
  // A bare go-ahead beats the question test, because it is the whole sentence.
  if (BARE_GO_AHEAD.test(t) || BARE_YES.test(t)) return true;
  // Asking to be taken somewhere is a request however it is phrased, and most
  // phrasings put the verb after the subject: "I want to go to the airport"
  // led with "I", so the imperative test refused it — and the goal extractor
  // then filed it as an ambition and said "noted".
  if (NAV_COMMAND.test(t) && !NOT_A_DESTINATION.test(t)) return true;
  // "I want to order food" is a request with the subject in front of it, the
  // same shape as "I want to go to the airport" — and it fell through for the
  // same reason, since the imperative test looks for a verb at the start.
  if (ORDER_COMMAND.test(t)) return true;
  // "I have an assignment due, can you do it for me" — an instruction with no
  // verb the gate knows, because the verb is "do". Matched as the whole phrase
  // rather than by adding "do" to the verb list, which would admit "can you do
  // that?" and half of ordinary conversation with it.
  if (DO_IT_FOR_ME.test(t)) return true;
  // Addressed to Grove and carrying a verb: an instruction, question mark or
  // not. Checked before the question tests, which would otherwise refuse it.
  if (POLITE_COMMAND.test(t)) return true;
  if (QUESTION_OPENERS.test(t)) return false;
  if (t.endsWith('?')) return false;
  return IMPERATIVE.test(t);
}

/**
 * Whether a reply promises something that will never arrive.
 *
 * Grove has exactly one turn. Nothing runs in the background, and no follow-up
 * message is ever sent, so "let me check that for you" is not a stall — it is
 * the end of the conversation, with the person still waiting. The prompt
 * forbids it; this catches the times the model does it anyway.
 */
const PROMISES = [
  /\b(?:let me|i'?ll|i will|going to|gonna|hang on|one (?:sec|moment|minute)|give me a (?:sec|moment|minute))\b.{0,40}\b(?:check|look|find|see|fetch|get|grab|pull|search|have a look)\b/i,
  /\b(?:checking|looking (?:it |that )?up|fetching|getting that|on it|right (?:back|away))\b/i,
  /\bi'?ll (?:let you know|get back to you|tell you|come back)\b/i,
];

export function promisesAction(text: string): boolean {
  return PROMISES.some((p) => p.test(text));
}

/* -------------------------------------------------------------- routing */

/**
 * Which ability, if any, a sentence is asking for — without a model.
 *
 * The fallback for when the cheap tier is unconfigured or unreachable, and the
 * sanity check on what it returns. Scores an ability's own example sentences
 * against the words in the request, which is crude and entirely predictable.
 */
/**
 * The title out of "play the Sunday playlist", without a model.
 *
 * pickAbility chooses an ability and never fills its arguments, so on the
 * keyword fallback music.play arrives with nothing in `what`. That was
 * harmless while an empty title was refused; now that an empty title means
 * "shuffle", it would quietly play the wrong thing — someone naming a song and
 * getting a shuffled library is a worse failure than being asked to repeat
 * themselves. So the fallback reads the title itself.
 *
 * Returns '' for the genuinely unnamed requests — "play a song", "put some
 * music on" — which is exactly the shuffle case.
 */
export function musicQueryFrom(text: string): string {
  const m = /\b(?:play|put on|listen to)\b\s*(.*)$/i.exec(text.trim());
  if (!m) return '';
  const rest = (m[1] || '')
    .replace(/[.?!]+$/, '')
    .replace(/^(?:some|a|an|the)\s+/i, '')
    .replace(/\b(?:for me|please|on (?:spotify|apple music))\b/gi, '')
    .trim();
  // The words people use when they mean "anything". Left as an empty query so
  // it shuffles rather than hunting for a song called "something".
  if (/^(?:music|a song|song|songs|something|anything|some music|tunes)?$/i.test(rest)) return '';

  // "Play a song by Playboi Carti" leaves "song by Playboi Carti", which
  // matches no title, artist or album — so the search failed and an empty-ish
  // query shuffled the library instead. The artist is the part after "by";
  // everything before it is filler. "over by" is in here because that is what
  // speech recognition does to "by" often enough to matter.
  const byArtist =
    /^(?:a\s+|some\s+|any\s+)?(?:song|songs|track|tracks|tune|tunes|music|something|anything)\s+(?:over\s+)?(?:by|from)\s+(.+)$/i.exec(
      rest
    );
  if (byArtist?.[1]) return byArtist[1].trim().slice(0, 120);

  return rest.slice(0, 120);
}

/** Words too common to distinguish one ability from another. */
const NOT_DISTINCTIVE = new Set([
  'what', 'whats', 'when', 'where', 'which', 'that', 'this', 'with', 'from',
  'your', 'have', 'will', 'would', 'should', 'could', 'about', 'they', 'them',
  'then', 'than', 'into', 'some', 'more', 'most', 'just', 'like', 'does',
  'need', 'want', 'been', 'being', 'here', 'there', 'today',
]);

/** "what's on today" -> "whats on today", so an example can be matched whole. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Arguments for the turn, with what the model left out read back off the
 * sentence.
 *
 * The model drops arguments often enough to matter, and an ability that only
 * ever sees `args` cannot tell "they did not say" from "the model did not pass
 * it on". Music played a random track for a named artist that way; the calendar
 * read the whole day back for "what is my first class", because the position
 * lived in the sentence and never reached the ability.
 *
 * Only ever fills a gap. Anything the model did supply wins, since it sees the
 * whole conversation and this sees one sentence.
 */
/** The backfill, exposed so `npm run verify` can exercise it directly. */
export function fillArgsForTest(
  chosen: Ability,
  fromModel: Record<string, string> | undefined,
  userText: string
): Record<string, string> {
  return fillArgs(chosen, fromModel, userText);
}

function fillArgs(
  chosen: Ability | null,
  fromModel: Record<string, string> | undefined,
  userText: string
): Record<string, string> {
  const args = { ...(fromModel ?? {}) };

  if (chosen?.id === 'music.play' && !(args.what ?? '').trim()) {
    const heard = musicQueryFrom(userText);
    if (heard) args.what = heard;
  }

  if (chosen?.id === 'mail.search' || chosen?.id === 'mail.summarise') {
    // "Any recent emails from Xbox" arrived with no `from` at all, so the
    // search fell back to "everything from the last two days" and read out five
    // unrelated messages. The sender is right there in the sentence.
    if (!(args.from ?? '').trim()) {
      const named = senderIn(userText);
      if (named) args.from = named;
    }
    if (!(args.category ?? '').trim() && CATEGORY_IN.test(userText)) {
      args.category = (CATEGORY_IN.exec(userText)?.[1] ?? '').trim();
    }
    if (!(args.when ?? '').trim() && /\b(today|yesterday|this week|this morning)\b/i.test(userText)) {
      args.when = userText;
    }
    // The position lives in the sentence, the same as it does for the calendar.
    if (!(args.which ?? '').trim() && POSITION_WORD.test(userText)) {
      args.which = userText;
    }
  }

  // The thing being looked for is the sentence itself.
  //
  // calendar.find asks "what am I looking for?" when `which` is empty, and the
  // model leaves it empty often enough that the question became the usual
  // answer — asked about a specific event, Grove asked which event. The whole
  // sentence is safe to pass because cleanTerm strips the framing: the verbs,
  // the position words, the day, and words like "what" and "find" that describe
  // the asking rather than the thing.
  if (chosen?.id === 'calendar.find' && !(args.which ?? '').trim()) {
    args.which = userText;
  }
  if (chosen?.id === 'calendar.remove' && !(args.which ?? '').trim()) {
    args.which = userText;
  }
  if (chosen?.id === 'calendar.move' && !(args.event ?? '').trim()) {
    args.event = userText;
  }

  if (chosen?.id === 'calendar.read') {
    // The position and the day are both in what was said, and both change the
    // answer completely — "my last thing" is one event, "today" is a window.
    if (!(args.which ?? '').trim() && POSITION_WORD.test(userText)) {
      args.which = userText;
    }
    if (!(args.when ?? '').trim() && /\b(today|tomorrow|week|tonight)\b/i.test(userText)) {
      args.when = userText;
    }
  }

  return args;
}

/**
 * The sender named in a question about mail.
 *
 * Written out rather than done in one regex because the stopping rule is the
 * whole problem: a name runs until a word that cannot be part of one. The regex
 * version used a case-insensitive flag, which quietly made its "second word
 * must be capitalised" rule match anything — so "emails from linkedin today"
 * came back as a sender called "linkedin today", which matches nothing.
 *
 * Two words at most, because "from Ali Express" is a sender and "from Priya
 * about the invoice we discussed" is a sender and then a subject.
 */
const NOT_PART_OF_A_NAME = new Set([
  'about', 'regarding', 're', 'today', 'yesterday', 'this', 'last', 'in', 'on',
  'at', 'with', 'and', 'or', 'the', 'a', 'any', 'my', 'me', 'recently', 'lately',
  'saying', 'that', 'which', 'week', 'month', 'morning', 'afternoon',
]);

export function senderIn(text: string): string | null {
  const after = /\bfrom\s+(.*)$/i.exec(text);
  if (!after?.[1]) return null;

  const words: string[] = [];
  for (const raw of after[1].split(/\s+/)) {
    const word = raw.replace(/[?.!,;:]+$/, '');
    if (!word) break;
    if (NOT_PART_OF_A_NAME.has(word.toLowerCase())) break;
    words.push(word);
    // A second word only counts when it looks like part of a proper name —
    // "Ali Express", not "linkedin today".
    if (words.length === 2) break;
    if (words.length === 1 && !/^[A-Z]/.test(word)) {
      // A lowercase first word is a service name like "xbox" or "linkedin",
      // which is one word on its own.
      break;
    }
  }
  const name = words.join(' ').trim();
  return name.length > 1 ? name : null;
}

/** A kind of mail, when one is named. */
const CATEGORY_IN =
  /\b(unread|important|urgent|starred|flagged|new)\b/i;

/** Any wording that names a position rather than a window. */
const POSITION_WORD =
  /\b(first|last|next|final|latest|earliest|upcoming|after (?:this|that))\b/i;

export function pickAbility(text: string): Ability | null {
  const haystack = text.toLowerCase();
  const words = new Set(
    haystack
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3)
      .slice(0, 24)
  );
  if (words.size === 0) return null;

  const said = normalise(text);
  const scored = usableAbilities()
    .map((ability) => {
      const corpus = `${ability.name} ${ability.what} ${ability.examples.join(' ')}`.toLowerCase();
      let score = 0;
      for (const w of words) if (!NOT_DISTINCTIVE.has(w) && corpus.includes(w)) score += 1;
      // An ability that advertises this exact sentence wins outright. Counting
      // shared words alone let "what's on today" — verbatim one of the calendar
      // examples — go to the weather, because both mention "today" and neither
      // word count knew which phrase it came from.
      const quoted = ability.examples.some((e) => {
        const example = normalise(e);
        return example.length > 6 && (said.includes(example) || example.includes(said));
      });
      if (quoted) score += 5;
      return { ability, score };
    })
    .filter((s) => s.score > 1)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.ability ?? null;
}

export type GroveContext = {
  /**
   * How they talk, as a line of prompt. Worked out by rapport.ts rather than
   * set on a screen; passed in so the one caller that already has it does not
   * make every prompt load it again.
   */
  rapport?: string;
  persona: Persona;
  facts: Fact[];
};

/**
 * One turn.
 *
 * This used to be the whole router: a keyword tier that decided whether
 * anything was allowed to run, then a light model call, then argument
 * recovery. All of that is gone — the model is handed every ability as a typed
 * function and chooses, which it does better than any keyword list could.
 *
 * What kept this function alive afterwards was standing jobs: a schedule or a
 * phrase trigger saved a spark rather than doing something now, and that path
 * had its own gate and its own reply. Sparks are gone too — iOS cannot wake a
 * terminated app, so a job scheduled for eight in the morning only ever fired
 * if Grove happened to be open, which is not a schedule.
 *
 * So this is a delegation, kept because every caller and the harness names it,
 * and because the gates below it are still the harness's way of asking whether
 * a sentence can reach a tool at all.
 */
export async function askGrove(
  history: Turn[],
  userText: string,
  context: GroveContext
): Promise<GroveReply> {
  return askWithTools(history, userText, context);
}

/**
 * A short name for a standing job, without a model.
 *
 * The fallback for when the cheap tier is unconfigured or declined to give one.
 * Strips the scheduling clause and the polite preamble, because "Also, every
 * day I'd like to go through on Google and find the..." is what someone says
 * and never what they would write on a card.
 */
export function titleFrom(text: string): string {
  // The schedule goes first. Stripping the preamble before it means a sentence
  // like "Also, every day I'd like to..." loses "Also," and then hits "every
  // day", so the politeness strip never fires and the title comes out as
  // "I'd like to go" — the words that carry the least meaning in the sentence.
  let t = ` ${text.trim()} `;

  t = t.replace(
    /\s(?:every|each)\s+(?:day|morning|evening|night|week|weekday|working day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\s/gi,
    ' '
  );
  t = t.replace(/\sat\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|half\s+\w+|quarter\s+(?:past|to)\s+\w+)\s/gi, ' ');
  t = t.replace(/\s(?:daily|weekly|hourly|every hour)\s/gi, ' ');

  // Then peel leading filler until nothing changes — one pass is not enough,
  // because "also" and "I'd like to" and "can you" stack up in real speech.
  const LEADERS = [
    /^\s*(?:also|and|so|ok(?:ay)?|hey|right|well|um|erm)[,\s]+/i,
    /^\s*(?:i(?:'d|’d| would)?\s+(?:like|want)(?:\s+you)?(?:\s+to)?)\s+/i,
    /^\s*(?:can|could|would)\s+you(?:\s+please)?\s+/i,
    /^\s*(?:please|i need(?:\s+you)?\s+to|set up|create|make me|give me)\s+/i,
  ];
  for (let pass = 0; pass < 4; pass++) {
    const before = t;
    for (const rule of LEADERS) t = t.replace(rule, '');
    if (t === before) break;
  }

  t = t.replace(/\s{2,}/g, ' ').replace(/^[,\s]+|[,.\s]+$/g, '');

  const words = t.split(/\s+/).filter(Boolean).slice(0, 4);
  const name = words.join(' ');
  if (!name) return 'Standing job';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The request with its scheduling clause removed.
 *
 * "Brief me on my watchlist every weekday at half four" is stored as "brief me
 * on my watchlist" — the schedule already lives on the trigger, and repeating
 * it inside the instruction means a spark that is edited to a new time still
 * reads as the old one.
 */
export function instructionFrom(text: string): string {
  let t = ` ${text.trim()} `;
  t = t.replace(
    /\s(?:every|each)\s+(?:day|morning|evening|night|week|weekday|working day|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\s/gi,
    ' '
  );
  t = t.replace(/\sat\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|half\s+\w+|quarter\s+(?:past|to)\s+\w+)\s/gi, ' ');
  t = t.replace(/\s(?:daily|weekly|hourly|every hour)\s/gi, ' ');
  t = t.replace(/^\s*(?:also|and|so|ok(?:ay)?|hey|right)[,\s]+/i, ' ');
  t = t.replace(/\s{2,}/g, ' ').trim().replace(/^[,\s]+|[,\s]+$/g, '');
  return t || text.trim();
}
