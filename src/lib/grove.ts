/**
 * Grove's brain.
 *
 * The model runs on Noctus, not here. Noctus already holds the provider keys
 * and already knows the account's tools, connections and history, so Grove
 * sends the conversation there and gets a reply back. No LLM key ships in this
 * app — a mobile client cannot keep one secret.
 *
 * On top of that, this file owns the one decision Noctus has no opinion about
 * and that must never be delegated to a model: whether a sentence should cause
 * something to *happen*. Grove is talked to hands-free, often while the user is
 * doing something else and not looking at anything, so the gap between "what's
 * in my inbox" and "reply to that" is the difference between a useful
 * assistant and one that sends mail on your behalf because it misheard. That
 * rule is local, keyword-based and deliberately boring.
 */

import { isIndyBlocked, recordIndyResponse } from './indyBudget';
import { lightTurn, type LightMessage } from './lightModel';
import { fallback, mannerDirective, type Persona } from './persona';
import { getNoctusUrl, isDevSession, NoctusError } from './noctusApi';
import { DEV_TOKEN, getSession } from './noctusAuth';
import { pickTool, blockedToolFor, usableTools, type OutputStep, type Tool } from './tools';

export type TurnTool = {
  name: string;
  state: 'running' | 'done' | 'failed' | 'blocked';
  detail?: string;
  steps?: OutputStep[];
  /** Integrations to connect before this could work. */
  needs?: string[];
};

export type Turn = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Set when a tool ran for this turn. */
  tool?: TurnTool;
  createdAt: string;
};

export type GroveReply = {
  /** What Grove says. Always non-empty. */
  text: string;
  /** The tool that should run, when the user asked for something to happen. */
  tool?: Tool;
  /** A tool that fits but can't run yet, so the UI can offer the fix. */
  blocked?: Tool;
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
 * pick a tool and run it. Those are questions. A gate that fires on a question
 * is the exact failure this file exists to prevent, so nothing counts unless
 * the user said only the go-ahead and nothing else.
 */
const BARE_GO_AHEAD =
  /^\s*(?:(?:ok|okay|yes|yeah|yep|sure|right)[,.\s]+)?(?:please\s+)?(?:do it|do that|go ahead|go on|run it|sort it|handle it|get on with it|make it so|please do|go|now)[.!\s]*$/i;

/** "yes", "yeah", "ok", "yes please" — answering something Grove just offered. */
const BARE_YES =
  /^\s*(?:(?:ok|okay|yes|yeah|yep|sure)(?:[,\s]+please)?|please do)[.!\s]*$/i;

// A verb of work aimed at Grove.
const WORK_VERB =
  /\b(make|create|build|draft|write|plan|book|schedule|send|order|buy|find|check|update|add|put|move|cancel|remind|track|log|sync|generate|prepare|set up)\b/i;

/**
 * Whether the user wants something done, rather than discussed.
 *
 * This gates every tool run, so it errs toward "no". A false negative costs
 * the user one more sentence; a false positive sends an email.
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

/* ------------------------------------------------------------- the model */

type IndyResponse = {
  reply?: string;
  actions?: unknown[];
  rateLimited?: boolean;
  remaining?: number;
};

export type IndyReply = {
  text: string;
  /**
   * True when the cap was hit. The endpoint answers 200 with the "you've used
   * all N messages this hour" notice in `reply`, so without this flag that
   * notice gets spoken aloud as though Grove said it.
   */
  rateLimited: boolean;
};

async function token(): Promise<string> {
  if (await isDevSession()) return DEV_TOKEN;
  const session = await getSession();
  if (!session) throw new NoctusError('Not signed in to Noctus.', 401);
  return session.access_token;
}

/**
 * Sends the conversation to Noctus and returns its reply. History is trimmed
 * to the last dozen turns, which is what the endpoint keeps anyway.
 */
export async function askNoctus(history: Turn[], userText: string): Promise<IndyReply> {
  const base = await getNoctusUrl();
  const messages = [...history, newTurn('user', userText)]
    .slice(-12)
    .map((t) => ({ role: t.role, content: t.text.slice(0, 4000) }));

  const response = await fetch(`${base}/api/indy/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${await token()}`,
    },
    body: JSON.stringify({ messages }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    let parsed: { error?: string } | null = null;
    try {
      parsed = JSON.parse(detail);
    } catch {
      parsed = null;
    }
    throw new NoctusError(
      parsed?.error || `Grove couldn't answer (${response.status})`,
      response.status
    );
  }

  const data = (await response.json()) as IndyResponse;
  await recordIndyResponse(data);
  return { text: (data.reply || '').trim(), rateLimited: data.rateLimited === true };
}

/** The shape the cheap tier wants: role and content, oldest first. */
function toLightHistory(history: Turn[]): LightMessage[] {
  return history.map((t) => ({ role: t.role, content: t.text.slice(0, 4000) }));
}

export type GroveContext = {
  tools: Tool[];
  persona: Persona;
};

/**
 * One turn of conversation with Grove.
 *
 * Three tiers, cheapest first, because Indy is capped per hour and was being
 * spent on small talk:
 *
 *   0  local rules   free      whether this is an instruction; which tool
 *   1  light model   ~free     the conversation itself
 *   2  Indy          capped    anything needing the real account
 *
 * A turn only climbs when the tier below genuinely can't serve it, and every
 * tier fails downward — an unconfigured or unreachable light model behaves
 * exactly as if it were not there.
 */
export async function askGrove(
  history: Turn[],
  userText: string,
  context: GroveContext
): Promise<GroveReply> {
  const { tools, persona } = context;

  // Tier 0. Whether anything is allowed to run. Never a model's call.
  const acting = detectActIntent(userText);
  const manner = mannerDirective(persona);

  // Tier 1. Also the router: it answers, it names the tool that fits, or it
  // says the request needs the account — the only thing worth spending Indy on.
  const light = await lightTurn(toLightHistory(history), userText, {
    tools: usableTools(tools).map((t) => ({ name: t.name, what: t.what })),
    manner,
  });

  // The model sees the whole belt and the sentence, so it beats keywords on
  // anything phrased indirectly. It also invents names, so a pick matching no
  // real tool is discarded rather than trusted.
  const named = light?.toolName
    ? usableTools(tools).find((t) => t.name.toLowerCase() === light.toolName!.toLowerCase())
    : undefined;

  const tool = acting ? named ?? pickTool(userText, tools) : undefined;

  // Nothing usable fits, but something *would* if it were connected. Saying
  // which one is the difference between a dead end and an instruction — and it
  // is the single most common confusion when there is no screen being looked at.
  const blocked = !tool && acting ? blockedToolFor(userText, tools) : null;

  const settle = (text: string): GroveReply => {
    const usable = text.trim();
    return {
      // An empty reply is never acceptable: Grove is speaking, and silence
      // reads as a crash. Whatever else failed, it says something true.
      text: usable || offlineLine(userText, { acting, tool, blocked }),
      tool: tool ?? undefined,
      blocked: blocked ?? undefined,
    };
  };

  if (light && !light.escalate) return settle(light.text);

  // Tier 2. Skipped outright once the cap is known to be spent — another
  // request would only come back with the same notice.
  if (await isIndyBlocked()) {
    if (light) return settle(light.text);
    // With a tool on the job, the cap is irrelevant to what was asked: the run
    // happens on Noctus either way. Only mention it when it is the real reason
    // there is no answer.
    if (tool) return settle('');
    return settle(
      "You've used this hour's messages, so I can't check your account right now."
    );
  }

  try {
    const indy = await askNoctus(history, userText);

    // Capped mid-flight. The endpoint's own text explains the cap, which is
    // worth saying only when there is nothing better to say.
    if (indy.rateLimited) {
      if (light) return settle(light.text);
      return tool ? settle('') : settle(indy.text);
    }
    if (indy.text) return settle(indy.text);
    if (light) return settle(light.text);
    return settle('');
  } catch (error) {
    if (error instanceof NoctusError && error.status === 401) throw error;

    // Indy is unreachable. The cheap tier may already have an answer, and the
    // tools still exist either way — say so plainly rather than inventing one.
    if (light) return settle(light.text);
    return settle('');
  }
}

/**
 * What Grove says when no model answered at all.
 *
 * Reached on an unconfigured build, a dead network or a spent budget — exactly
 * when silence would be read as a crash. Every branch is written to be true
 * whatever went wrong: none of them claims that anything ran.
 */
function offlineLine(
  userText: string,
  context: { acting: boolean; tool?: Tool | null; blocked?: Tool | null }
): string {
  if (context.blocked) {
    return `${context.blocked.name} would cover that, but it needs ${readableNeeds(
      context.blocked.missing
    )} connected first.`;
  }
  if (context.tool) return fallback.onIt(userText);
  if (context.acting) return fallback.onIt(userText);
  return fallback.stuck();
}

function readableNeeds(keys: string[]): string {
  const words = keys.map((k) => k.replace(/_/g, ' '));
  if (words.length <= 1) return words[0] ?? 'an integration';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** The request as an activity row should label it: one trimmed sentence. */
export function shortTask(text: string): string {
  const t = text.trim().replace(/[.?!]+$/, '');
  const capped = t.length > 120 ? `${t.slice(0, 117)}…` : t;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}
