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

import { ABILITIES, abilityById, isSchedulable, usableAbilities, type Ability } from './abilities';
import { abilitiesFor, modeById, type Mode } from './modes';
import { asPromptBlock, factFrom, type Extracted, type Fact } from './memory';
import {
  isLightModelConfigured,
  lastModelTrouble,
  lightTurn,
  type LightMessage,
} from './lightModel';
import { activePreset, fallback, mannerDirective, type Persona, notedFor } from './persona';
import { describeSchedule, parseSchedule, phraseTrigger, type Schedule } from './sparks';

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
  /** What Grove says. Always non-empty. */
  text: string;
  /** The ability to run now, when the user asked for something to happen. */
  ability?: Ability;
  args: Record<string, string>;
  /**
   * Set when the sentence carried a recurrence, so the caller saves a spark
   * instead of just running the thing once.
   */
  schedule?: Schedule;
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
/**
 * Any way of asking for a mode.
 *
 * Needs a switching word AND a mode name, so "I need to focus" and "the study
 * is upstairs" are untouched, while every phrasing people actually use —
 * turn it on, put me in, switch to, activate, set — reaches mode.set.
 */
const MODE_COMMAND =
  /\b(?:turn|switch|go|put|set|activate|enter|start|enable|into)\b[^.?!]{0,24}?\b(?:focus|study|wind[-\s]?down|normal)\b/i;

const BARE_MODE =
  /^\s*(?:back to\s+)?(?:focus|study|wind[-\s]?down|normal)(?:\s+mode)?\s*[.!]?\s*$/i;

/** Being asked outright to remember something. */
const EXPLICIT_REMEMBER =
  /\b(?:remember|note that|make a note|don'?t (?:let me )?forget|keep in mind|jog my memory|for the record)\b/i;

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
const VERBS = String.raw`make|create|build|draft|write|plan|book|schedule|send|order|buy|find|check|update|add|put|move|cancel|remind|track|log|sync|generate|prepare|set up|play|read|brief|tell me about|email|text|message|call|switch to|switch into|go into|turn on|turn off|open|handle|push|reschedule|delay|shift|dim|start|stop|queue|skip|pause|resume|let .{2,20} know|give me|reply|respond|answer|forward|let'?s go|take me|drive me|directions|navigate|which way|delete|remove|take|summari[sz]e|catch me up|recap|digest|remember|note|jot|keep in mind|don'?t let me forget`;

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
const ELLIPTICAL_LOOKUP = /^\s*(?:anything|any (?:mail|messages|emails|news))\b/i;

const LOOKUP_QUESTION =
  /\b(calendar|schedule|diary|agenda|weather|forecast|temperature|rain|coat|umbrella|wear|traffic|how long|how far|eta|leave for|leave by|set off|get there|get home|which way|way to|route to|far is|my day|day looking|got on|first thing|last thing|next thing|what time is|what time'?s|first class|last class|of the day|first class|class|appointment|meeting|event|events|booked|flight|this week|anything with|anything on|on today|on tomorrow|next (?:thing|meeting|event)|free (?:at|on|today|tomorrow)|inbox|email|emails|mail|doc|docs|document|plan|notes|spreadsheet|drive|news|markets|happened|remind me (?:what|who|about)|supposed to|do i know about|did i say|what did i|anything from|say about|did .{2,20} say)\b/i;

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
  const isQuestion = QUESTION_OPENERS.test(t) || t.endsWith('?') || ELLIPTICAL_LOOKUP.test(t);
  return isQuestion && LOOKUP_QUESTION.test(t);
}

export function detectActIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // A bare go-ahead beats the question test, because it is the whole sentence.
  if (BARE_GO_AHEAD.test(t) || BARE_YES.test(t)) return true;
  // "Study mode." "Back to normal." No verb anywhere, and unmistakably an
  // instruction — naming a mode is the whole sentence, the way a go-ahead is.
  if (BARE_MODE.test(t)) return true;
  // "Turn focus mode on" splits its verb around the object, so the imperative
  // test — which looks for a verb at the start — saw "turn" and no match, the
  // gate stayed shut, and mode.set never ran. Grove said "focus mode" and
  // changed nothing, which is the most annoying way to fail: it sounds like it
  // worked.
  if (MODE_COMMAND.test(t)) return true;
  // Asking to be taken somewhere is a request however it is phrased, and most
  // phrasings put the verb after the subject: "I want to go to the airport"
  // led with "I", so the imperative test refused it — and the goal extractor
  // then filed it as an ambition and said "noted".
  if (NAV_COMMAND.test(t) && !NOT_A_DESTINATION.test(t)) return true;
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

/** The shape the cheap tier wants: role and content, oldest first. */
function toLightHistory(history: Turn[]): LightMessage[] {
  return history.map((t) => ({ role: t.role, content: t.text.slice(0, 4000) }));
}

export type GroveContext = {
  persona: Persona;
  facts: Fact[];
};

/**
 * One turn of conversation with Grove.
 *
 * Two tiers now, not three:
 *
 *   0  local rules   free   act intent, recurrence, and a keyword fallback
 *   1  light model   cheap  the conversation, and choosing the ability
 *
 * The tier that was capped is gone, so there is no budget to run out of and no
 * branch here that has to apologise for one.
 */
export async function askGrove(
  history: Turn[],
  userText: string,
  context: GroveContext
): Promise<GroveReply> {
  const { persona, facts } = context;

  // Tier 0. Whether anything is allowed to run, and whether it recurs.
  const acting = detectActIntent(userText);
  // A question that needs a lookup. Kept separate from `acting` so it cannot
  // reach a schedule, a phrase trigger, or any ability that changes something.
  const looking = !acting && detectLookupIntent(userText);
  const schedule = acting ? parseSchedule(userText) : null;
  // The other kind of standing job. Checked here rather than left to the
  // caller, because a caller that tests `schedule` alone silently drops every
  // phrase trigger — which is exactly what was happening.
  const phrase = acting && !schedule ? phraseTrigger(userText) : null;

  // The mode narrows what may be reached for. This is a safety feature as much
  // as a focus one: commute deliberately has no mail, because reading a message
  // aloud at a junction is worse than not having mail at all.
  const mode = modeById(persona.mode ?? 'normal');
  const available = abilitiesFor(mode, ABILITIES);

  // Tier 1. Answers, and names the ability that fits.
  const light = await lightTurn(toLightHistory(history), userText, {
    abilities: available.map((a) => ({ id: a.id, what: a.what })),
    manner: [mannerDirective(persona), mode.manner].filter(Boolean).join('\n\n'),
    memory: asPromptBlock(facts),
    name: persona.name,
    // If a tool here can answer it, do not search the web on the way. The one
    // exception is the briefing, which IS the web.
    grounded: (() => {
      const local = pickAbility(userText);
      return !local || local.id === 'brief.web';
    })(),
  });

  // The model sees the whole set and the sentence, so it beats keywords on
  // anything phrased indirectly. It also invents ids, so a pick matching no
  // real ability is discarded rather than trusted.
  const named = light?.abilityId ? abilityById(light.abilityId) : undefined;
  const allowed = (a: Ability | undefined) => Boolean(a && available.some((x) => x.id === a.id));
  // The keyword fallback has to respect the mode as well, or a narrowed mode is
  // only narrowed when the model happens to be reachable.
  const pick = (): Ability | null => {
    if (allowed(named) && named?.wired) return named ?? null;
    const guess = pickAbility(userText);
    return allowed(guess ?? undefined) ? guess : null;
  };

  // A read the model itself named, on a question that matched no keyword.
  //
  // LOOKUP_QUESTION is a keyword list, and no keyword list covers how people
  // actually ask: "what time is my long walk at again" names nothing lookable,
  // so no tool ran, and the model — which cannot see the calendar — answered
  // that it has no access. The model had already picked calendar.find; the gate
  // just refused to let it.
  //
  // Trusting it costs nothing that matters, because `reads` is the whole
  // permission: the worst a wrong pick can do is look something up nobody asked
  // about. mail.send, calendar.move and message.compose carry no such mark and
  // remain unreachable from any question, which is the property that has to
  // hold and still does.
  const namedRead = allowed(named) && named?.wired && named.reads ? named : null;

  // Two gates, and the narrower one can only ever return a read. Whatever the
  // router suggested, a question cannot come out of here holding mail.send.
  const chosen = acting
    ? pick()
    : (namedRead ?? (looking && pick()?.reads ? pick() : null));

  // Something would fit, but it is not built or connected yet. Saying which is
  // the difference between a dead end and an instruction.
  const blocked = !chosen && (acting || looking) && named && !named.wired ? named : null;

  const fact = factFrom(userText) ?? undefined;

  /**
   * Remembering something needs no model at all.
   *
   * "Remember that Sam owes me twelve quid for lunch" was going through the
   * full turn — including a web search, since grounding is on — and taking the
   * better part of a minute to do something the local extractor had already
   * finished before the request left the phone. The answer was always going to
   * be "noted"; there was nothing to think about.
   *
   * Only when nothing else is going on: a sentence that also asks for something
   * still gets a proper turn.
   */
  // ...and only when being told to remember is the whole of it.
  //
  // The shortcut used to fire on anything the extractor recognised, which is a
  // much wider net than it sounds: "I need to know what time my class is" and
  // "I am a bit confused" both looked like facts, so both were answered with
  // "noted" and nothing else happened. The extractor is narrower now, but the
  // rule matters on its own — a sentence gets this treatment because the person
  // asked Grove to remember something, not because it happens to parse as one.
  //
  // The fact is still recorded on the ordinary path, so nothing is lost by
  // falling through: this only decides whether the model is worth waking.
  if (fact && EXPLICIT_REMEMBER.test(userText) && !chosen && !acting && !schedule && !phrase) {
    return {
      text: notedFor(persona, fact.value.replace(/^i /i, 'you ')),
      args: {},
      fact,
    };
  }

  const settle = (text: string): GroveReply => {
    let usable = text.trim();

    // A read is answered by the tool, so the model must not answer it first.
    //
    // The model's reply is spoken immediately and the ability runs behind it,
    // which is fine when the ability DOES something — "putting that on now" is
    // true before the song starts. It is not fine when the ability is the only
    // source of the answer: asked what was next in the calendar, the model said
    // "next up is your team sync at three thirty" while the calendar was still
    // running, and there was no team sync. It invented a plausible day.
    //
    // Nothing the model writes can be trusted about data it has not seen yet,
    // so for a read its prose is replaced by a holding line and the tool's
    // answer is the answer. It also removes a whole utterance from the turn,
    // which is the other half of why these felt slow.
    // Nothing is said before a read. The tool's answer is the whole answer.
    //
    // Replacing the model's prose with a holding line was the wrong half of the
    // fix: exchange() already speaks a holding line when a turn runs long, so a
    // read said "let me check" twice and, if the lookup then failed, that was
    // the entire reply — Grove announcing it was looking and never coming back.
    // Silence here, the existing timer for slowness, the result when it lands.
    const holdForTool = Boolean(chosen?.reads);

    return {
      text:
        usable ||
        offlineLine(userText, {
          acting: acting || looking,
          ability: chosen,
          blocked,
          schedule,
          mode,
          voice: activePreset(persona),
        }),
      ability: chosen ?? undefined,
      holdForTool,
      // The model fills these normally, but it drops the title often enough to
      // matter: asked for Playboi Carti it named music.play with no `what` at
      // all, an empty title means shuffle, and a random jazz cover started
      // playing. An empty argument on a sentence that plainly names something
      // is a gap to fill, not an instruction to pick at random — so the local
      // reader backfills it whether or not the model ran.
      args: fillArgs(chosen, light?.args, userText),
      schedule: schedule ?? undefined,
      phrase: phrase ?? undefined,
      blocked: blocked ?? undefined,
      title: light?.title ?? (schedule || phrase ? titleFrom(userText) : undefined),
      instruction: schedule || phrase ? instructionFrom(userText) : undefined,
      fact,
    };
  };

  // A recurrence is worth confirming out loud, because it is the one thing
  // here that keeps happening after the conversation ends.
  if (phrase) {
    return settle(`Right — say “${phrase}” and I'll do that.`);
  }

  if (schedule && chosen) {
    const when = describeSchedule(schedule);
    const caveat = isSchedulable([chosen.id])
      ? ''
      : ' It needs Grove running, so it will catch up when you next pick me up.';
    return settle(`${when}. I'll tell you what comes back.${caveat}`);
  }

  // The model still sometimes says it is off to check something while naming no
  // ability. There is no later turn to redeem that with, so the promise is
  // caught here and replaced rather than spoken.
  if (light?.text) {
    // A promise is only allowed to stand when something is actually about to
    // run and report back. With no ability behind it, "I'll check that for you"
    // is the last thing the person hears — there is no second turn to redeem
    // it with — so it is replaced rather than spoken.
    if (!chosen && promisesAction(light.text)) {
      return settle(blocked ? offlineLine(userText, { acting, blocked }) : fallback.cannot());
    }
    // With an ability running, a promise is honest but useless on its own: the
    // outcome is spoken a few seconds later, so leading with "let me check"
    // just doubles the talking. Say what is being done instead.
    if (chosen && promisesAction(light.text)) {
      return settle(fallback.onIt(userText));
    }
    return settle(light.text);
  }
  return settle('');
}

/**
 * What Grove says when no model answered at all.
 *
 * Reached on an unconfigured build, a dead network, or a light tier that timed
 * out — exactly when silence would read as a crash. Every branch is written to
 * be true whatever went wrong: none of them claims that anything ran.
 */
function offlineLine(
  userText: string,
  context: {
    acting: boolean;
    ability?: Ability | null;
    blocked?: Ability | null;
    schedule?: Schedule | null;
    mode?: Mode;
    voice?: { stuck: string; empty: string };
  }
): string {
  if (context.blocked) {
    return context.blocked.needs.length > 0
      ? `${context.blocked.name} would cover that, but it needs ${readableNeeds(context.blocked.needs)} first.`
      : `${context.blocked.name} would cover that, but it isn't built yet.`;
  }
  if (context.schedule && context.ability) {
    return `${describeSchedule(context.schedule)}. I'll tell you what comes back.`;
  }
  if (context.ability || context.acting) return fallback.onIt(userText);

  // A real reason beats a stylish one.
  //
  // Rate limiting is what actually happens in normal use: ask three things in
  // quick succession and the free tier starts refusing, and "Can't get to
  // anything right now" then reads as Grove being broken rather than busy. The
  // fix is to wait five seconds, and nobody can guess that from the stock line.
  const trouble = lastModelTrouble();
  if (trouble === 'rate-limited') return 'Too many at once — give me about five seconds.';
  if (trouble === 'timeout') return 'That took too long to come back. Ask me again.';
  if (trouble === 'offline') return 'I have no connection right now.';
  if (trouble === 'no-model')
    return 'The model I am set to use has been retired. That needs changing in my settings.';
  if (trouble === 'no-key') return fallback.unconfigured();
  // 'refused' is the model answering with nothing usable — a safety block, an
  // empty candidate, an unparseable reply. It used to fall through to the
  // persona's stock line, which is the one sentence that tells you nothing at
  // all, and it was the sentence people saw most.
  if (trouble === 'refused') return 'The model gave me nothing back on that one. Try wording it differently.';

  // In the voice's own words, falling back to the mode's. A stock line after a
  // personality has been talking to you for ten minutes is the moment the
  // character drops, and that is exactly when someone stops believing any of it.
  if (context.voice?.stuck) return context.voice.stuck;
  if (context.mode?.stuck) return context.mode.stuck;
  // "Try again" is a lie when there is no model to try. An unconfigured build
  // fails this way on every single turn, and telling someone to wait a moment
  // sends them round that loop for as long as their patience lasts.
  if (!isLightModelConfigured()) return fallback.unconfigured();
  return fallback.stuck();
}

function readableNeeds(keys: string[]): string {
  const words = keys.map((k) => k.replace(/[_-]/g, ' '));
  if (words.length <= 1) return words[0] ?? 'something connected';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
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

/** The request as an activity row should label it: one trimmed sentence. */
export function shortTask(text: string): string {
  const t = text.trim().replace(/[.?!]+$/, '');
  const capped = t.length > 120 ? `${t.slice(0, 117)}…` : t;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}
