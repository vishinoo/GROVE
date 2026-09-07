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
import { asPromptBlock, factFrom, type Fact } from './memory';
import { isLightModelConfigured, lightTurn, type LightMessage } from './lightModel';
import { fallback, mannerDirective, type Persona } from './persona';
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
  fact?: { key: string; value: string; subject: string; open: boolean };
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
const BARE_GO_AHEAD =
  /^\s*(?:(?:ok|okay|yes|yeah|yep|sure|right)[,.\s]+)?(?:please\s+)?(?:do it|do that|go ahead|go on|run it|sort it|handle it|get on with it|make it so|please do|go|now)[.!\s]*$/i;

/** "yes", "yeah", "ok", "yes please" — answering something Grove just offered. */
const BARE_YES =
  /^\s*(?:(?:ok|okay|yes|yeah|yep|sure)(?:[,\s]+please)?|please do)[.!\s]*$/i;

/** A verb of work aimed at Grove. */
const WORK_VERB =
  /\b(make|create|build|draft|write|plan|book|schedule|send|order|buy|find|check|update|add|put|move|cancel|remind|track|log|sync|generate|prepare|set up|play|read|brief|tell me about)\b/i;

/**
 * Whether the user wants something done, rather than discussed.
 *
 * This gates every ability run, so it errs toward "no".
 */
export function detectActIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // A bare go-ahead beats the question test, because it is the whole sentence.
  if (BARE_GO_AHEAD.test(t) || BARE_YES.test(t)) return true;
  if (QUESTION_OPENERS.test(t)) return false;
  if (t.endsWith('?')) return false;
  return WORK_VERB.test(t);
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
export function pickAbility(text: string): Ability | null {
  const haystack = text.toLowerCase();
  const words = new Set(
    haystack
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3)
      .slice(0, 24)
  );
  if (words.size === 0) return null;

  const scored = usableAbilities()
    .map((ability) => {
      const corpus = `${ability.name} ${ability.what} ${ability.examples.join(' ')}`.toLowerCase();
      let score = 0;
      for (const w of words) if (corpus.includes(w)) score += 1;
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
  });

  // The model sees the whole set and the sentence, so it beats keywords on
  // anything phrased indirectly. It also invents ids, so a pick matching no
  // real ability is discarded rather than trusted.
  const named = light?.abilityId ? abilityById(light.abilityId) : undefined;
  const allowed = (a: Ability | undefined) => Boolean(a && available.some((x) => x.id === a.id));
  // The keyword fallback has to respect the mode as well, or a narrowed mode is
  // only narrowed when the model happens to be reachable.
  const chosen = acting
    ? allowed(named) && named?.wired
      ? named
      : (() => {
          const guess = pickAbility(userText);
          return allowed(guess ?? undefined) ? guess : null;
        })()
    : null;

  // Something would fit, but it is not built or connected yet. Saying which is
  // the difference between a dead end and an instruction.
  const blocked = !chosen && acting && named && !named.wired ? named : null;

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
      text: usable || offlineLine(userText, { acting, ability: chosen, blocked, schedule, mode }),
      ability: chosen ?? undefined,
      args: light?.args ?? {},
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
  // In the mode's own voice. A stock line after a personality has been talking
  // to you for ten minutes is the moment the character drops, and that is
  // exactly when someone stops believing any of it.
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
