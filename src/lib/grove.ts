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

import { abilityById, isSchedulable, usableAbilities, type Ability } from './abilities';
import { asPromptBlock, factFrom, type Fact } from './memory';
import { lightTurn, type LightMessage } from './lightModel';
import { fallback, mannerDirective, type Persona } from './persona';
import { describeSchedule, parseSchedule, type Schedule } from './sparks';

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
  /** An ability that fits but is not built or connected yet. */
  blocked?: Ability;
  /** A fact worth keeping, pulled locally from what was said. */
  fact?: { key: string; value: string };
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

  // Tier 1. Answers, and names the ability that fits.
  const light = await lightTurn(toLightHistory(history), userText, {
    abilities: usableAbilities().map((a) => ({ id: a.id, what: a.what })),
    manner: mannerDirective(persona),
    memory: asPromptBlock(facts),
  });

  // The model sees the whole set and the sentence, so it beats keywords on
  // anything phrased indirectly. It also invents ids, so a pick matching no
  // real ability is discarded rather than trusted.
  const named = light?.abilityId ? abilityById(light.abilityId) : undefined;
  const chosen = acting ? (named?.wired ? named : pickAbility(userText)) : null;

  // Something would fit, but it is not built or connected yet. Saying which is
  // the difference between a dead end and an instruction.
  const blocked = !chosen && acting && named && !named.wired ? named : null;

  const fact = factFrom(userText) ?? undefined;

  const settle = (text: string): GroveReply => {
    const usable = text.trim();
    return {
      text: usable || offlineLine(userText, { acting, ability: chosen, blocked, schedule }),
      ability: chosen ?? undefined,
      args: light?.args ?? {},
      schedule: schedule ?? undefined,
      blocked: blocked ?? undefined,
      fact,
    };
  };

  // A recurrence is worth confirming out loud, because it is the one thing
  // here that keeps happening after the conversation ends.
  if (schedule && chosen) {
    const when = describeSchedule(schedule);
    const caveat = isSchedulable([chosen.id])
      ? ''
      : ' It needs Grove running, so it will catch up when you next pick me up.';
    return settle(`${when}. I'll tell you what comes back.${caveat}`);
  }

  if (light?.text) return settle(light.text);
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
  return fallback.stuck();
}

function readableNeeds(keys: string[]): string {
  const words = keys.map((k) => k.replace(/[_-]/g, ' '));
  if (words.length <= 1) return words[0] ?? 'something connected';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The request as an activity row should label it: one trimmed sentence. */
export function shortTask(text: string): string {
  const t = text.trim().replace(/[.?!]+$/, '');
  const capped = t.length > 120 ? `${t.slice(0, 117)}…` : t;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}
