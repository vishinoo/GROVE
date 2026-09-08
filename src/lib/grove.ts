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
import { isLightModelConfigured, lightTurn, type LightMessage } from './lightModel';
import { activePreset, fallback, mannerDirective, type Persona } from './persona';
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
const BARE_MODE =
  /^\s*(?:back to\s+)?(?:focus|study|wind[-\s]?down|normal)(?:\s+mode)?\s*[.!]?\s*$/i;

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
const VERBS = String.raw`make|create|build|draft|write|plan|book|schedule|send|order|buy|find|check|update|add|put|move|cancel|remind|track|log|sync|generate|prepare|set up|play|read|brief|tell me about|email|text|message|call|switch to|switch into|go into|turn on|turn off|open|handle|push|reschedule|delay|shift|dim|start|stop|queue|skip|pause|resume|let .{2,20} know|give me|reply|respond|answer|forward|let'?s go|take me|drive me|directions|navigate|which way|delete|remove|take|summari[sz]e|catch me up|recap|digest`;

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
  /\b(calendar|schedule|diary|agenda|weather|forecast|temperature|rain|coat|umbrella|wear|traffic|how long|how far|eta|leave for|leave by|set off|get there|get home|which way|way to|route to|far is|my day|day looking|got on|of the day|first class|class|appointment|meeting|event|events|booked|flight|this week|anything with|anything on|on today|on tomorrow|next (?:thing|meeting|event)|free (?:at|on|today|tomorrow)|inbox|email|emails|mail|doc|docs|document|plan|notes|spreadsheet|drive|news|markets|happened|remind me (?:what|who|about)|supposed to|do i know about|did i say|what did i|anything from|say about|did .{2,20} say)\b/i;

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

  // Two gates, and the narrower one can only ever return a read. Whatever the
  // router suggested, a question cannot come out of here holding mail.send.
  const chosen = acting ? pick() : looking ? (pick()?.reads ? pick() : null) : null;

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
  if (fact && !acting && !schedule && !phrase) {
    return {
      text: `Noted — ${fact.value.replace(/^i /i, 'you ')}.`,
      args: {},
      fact,
    };
  }

  const settle = (text: string): GroveReply => {
    const usable = text.trim();
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
      // The model fills these normally. When it did not run, music is the one
      // ability whose argument can be read locally, and reading it is what stops
      // a named song turning into a shuffle.
      args: light?.args ?? (chosen?.id === 'music.play' ? { what: musicQueryFrom(userText) } : {}),
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
