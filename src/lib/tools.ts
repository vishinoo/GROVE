/**
 * Tools.
 *
 * Grove is one agent. What used to be a crew of agents with faces is now a
 * catalogue of capabilities that the one agent reaches for — a Noctus built-in
 * template is a *tool*, installing it puts it within reach, and the
 * integrations it requires are the reason a tool can be present but unusable.
 *
 * That last state is the one this file works hardest to make legible. A tool
 * that exists, is installed, and still cannot run because Gmail was never
 * connected is the single most confusing thing that can happen to someone
 * talking to their glasses, because nothing on screen is being looked at when
 * it happens. So `state` and `missing` are computed up front for every tool
 * rather than discovered at the moment of failure, and Grove can say what is
 * wrong before it tries.
 */

import {
  NoctusError,
  createCustomSpark,
  fetchBuiltinAgents,
  fetchMyInstances,
  removeInstance,
  runInstance,
  type NoctusAgentTemplate,
  type RunStep,
} from './noctusApi';
import { lightSummarise } from './lightModel';
import { fallback, readable } from './persona';

export type ToolState =
  /** Installed, everything it needs is connected. Grove can call it. */
  | 'ready'
  /** Installed but an integration is missing. */
  | 'blocked'
  /** In the catalogue, not yet added. */
  | 'available';

export type Tool = {
  /** The Noctus built-in template id. Stable; used for matching. */
  id: string;
  name: string;
  what: string;
  category: string;
  /** Binding keys this needs connected, e.g. ['gmail']. */
  needs: string[];
  /** Live Noctus instance, when installed. */
  instanceId: string | null;
  state: ToolState;
  /** The subset of `needs` that isn't connected yet. */
  missing: string[];
  /** Extra matching signal from the catalogue. */
  tags: string[];
};

/**
 * Reads the catalogue, what's installed, and what's connected, and folds them
 * into one list.
 *
 * Fetched together rather than in sequence: the Tools screen is the first
 * thing a new user opens and three round trips to Noctus one after another is
 * a visibly slow screen for no reason.
 */
export async function loadTools(connections: string[], signal?: AbortSignal): Promise<Tool[]> {
  const [catalogue, installed] = await Promise.all([
    fetchBuiltinAgents(signal),
    fetchMyInstances(signal).catch(() => ({ agents: [] })),
  ]);

  const live = new Map<string, string>();
  for (const instance of installed.agents ?? []) {
    if (instance.agentId && instance.instanceId) live.set(instance.agentId, instance.instanceId);
  }

  const connected = new Set(connections);

  return (catalogue.agents ?? []).map((template) =>
    describeTool(template, live.get(template.id) ?? null, connected)
  );
}

function describeTool(
  template: NoctusAgentTemplate,
  instanceId: string | null,
  connected: Set<string>
): Tool {
  const needs = template.requiredBindings ?? [];
  const missing = needs.filter((key) => !connected.has(key));

  return {
    id: template.id,
    name: template.title,
    what: template.description,
    category: template.category ?? 'General',
    needs,
    instanceId,
    state: !instanceId ? 'available' : missing.length > 0 ? 'blocked' : 'ready',
    missing,
    tags: template.tags ?? [],
  };
}

/** Only the tools Grove is allowed to reach for right now. */
export function usableTools(tools: Tool[]): Tool[] {
  return tools.filter((t) => t.state === 'ready');
}

/* ------------------------------------------------------------- managing */

/**
 * Adds a tool.
 *
 * Noctus has no "install one built-in" endpoint — installing goes through a
 * custom spark, which is a named bundle of built-ins. Grove makes a bundle of
 * exactly one so that a tool maps to a single instance and can be removed
 * again cleanly. The spark title is never shown to anyone.
 */
export async function addTool(tool: Tool): Promise<string | null> {
  const result = await createCustomSpark({
    title: tool.name,
    description: tool.what,
    category: tool.category,
    agentIds: [tool.id],
  });
  return result.results?.[0]?.instanceId ?? null;
}

/**
 * Removes a tool, and means it.
 *
 * Dropping only the local record would leave the instance — and the spark it
 * belongs to — alive on Noctus, which on the free plan permanently consumes
 * the one spark slot and quietly makes every future tool fail to install.
 */
export async function removeTool(tool: Tool): Promise<void> {
  if (!tool.instanceId) return;
  await removeInstance(tool.instanceId);
}

/* -------------------------------------------------------------- routing */

/**
 * Which tool, if any, should take a spoken request.
 *
 * Deliberately keyword-based and deliberately narrow. This decides whether the
 * user's sentence causes something to *happen* in the world — sending mail,
 * moving money, booking time — so it has to be predictable, inspectable and
 * wrong in a boring direction. A model that occasionally decides a question
 * about email means "send an email" is a much worse failure than one that
 * occasionally makes the user say which tool they meant.
 *
 * Scoring is the same shape the old composer used, with one addition: a tool
 * whose name appears in the sentence outright wins regardless of everything
 * else, because naming it is the user being explicit.
 */
export function pickTool(text: string, tools: Tool[]): Tool | null {
  const usable = usableTools(tools);
  if (usable.length === 0) return null;

  const haystack = text.toLowerCase();

  const named = usable.find((t) => t.name.length > 3 && haystack.includes(t.name.toLowerCase()));
  if (named) return named;

  const words = new Set(
    haystack
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3)
      .slice(0, 24)
  );
  if (words.size === 0) return null;

  const scored = usable
    .map((tool) => {
      const text = `${tool.name} ${tool.what} ${tool.category} ${tool.tags.join(' ')}`.toLowerCase();
      let score = 0;
      for (const word of words) if (text.includes(word)) score += 1;
      if (haystack.includes(tool.category.toLowerCase())) score += 3;
      return { tool, score };
    })
    .filter((s) => s.score > 1) // one incidental word in common is not a match
    .sort((a, b) => b.score - a.score);

  return scored[0]?.tool ?? null;
}

/**
 * A tool the request clearly wants but cannot use yet.
 *
 * Searched across everything rather than only what's usable, so Grove can say
 * "that needs your calendar connected" instead of "I can't do that" — the
 * difference between a dead end and an instruction.
 */
export function blockedToolFor(text: string, tools: Tool[]): Tool | null {
  const candidates = tools.filter((t) => t.state !== 'ready');
  if (candidates.length === 0) return null;
  const asIfUsable = candidates.map((t) => ({ ...t, state: 'ready' as const }));
  const hit = pickTool(text, asIfUsable);
  return hit ? candidates.find((t) => t.id === hit.id) ?? null : null;
}

/* --------------------------------------------------------------- running */

export type OutputStep = {
  label: string;
  state: 'ok' | 'failed' | 'skipped';
  detail?: string;
};

export type ToolOutcome = {
  state: 'done' | 'failed' | 'blocked';
  /** One line, written to be spoken aloud. */
  detail: string;
  /** Integrations to connect before this can work. */
  needs?: string[];
  steps?: OutputStep[];
};

/**
 * Runs one tool and reports what happened in a sentence that can be read out.
 *
 * The spoken summary is the point. A list of node outputs is fine on a screen
 * and useless in your ear, so a successful run with real output is collapsed
 * to one line by the cheap local tier — which needs no account context, since
 * everything it summarises is already in hand — and falls back to a plain
 * count whenever that tier is unconfigured, unreachable or slow.
 */
export async function runTool(tool: Tool, task: string): Promise<ToolOutcome> {
  if (!tool.instanceId) {
    return { state: 'blocked', detail: `${tool.name} isn't added yet.` };
  }
  if (tool.missing.length > 0) {
    return {
      state: 'blocked',
      detail: fallback.cantSee(tool.missing),
      needs: tool.missing,
    };
  }

  try {
    const result = await runInstance(tool.instanceId, { task, source: 'grove' });
    const steps = (result.steps ?? []).map(readStep);

    if (result.error) {
      return { state: 'failed', detail: result.error, steps };
    }

    const produced = steps.filter((s) => s.detail && s.state !== 'failed');
    if (produced.length > 0) {
      const summary = await lightSummarise(tool.name, task, produced);
      if (summary) return { state: 'done', detail: summary, steps };
      // No summariser: read out the last thing the tool actually produced
      // rather than announcing a step count nobody asked for.
      const last = produced[produced.length - 1];
      if (last.detail) return { state: 'done', detail: last.detail, steps };
    }

    return { state: 'done', detail: `${tool.name} ran.`, steps };
  } catch (error) {
    if (error instanceof NoctusError) {
      // Noctus won't activate anything on an unbillable account and then
      // reports the downstream symptom rather than the cause. Say the cause.
      if (error.requiresPayment) {
        return {
          state: 'blocked',
          detail: `${tool.name} can't run — Noctus needs a payment method on your account first.`,
        };
      }
      if (error.requiredBindings.length > 0) {
        return {
          state: 'blocked',
          detail: `${tool.name} needs ${readable(error.requiredBindings)} connected first.`,
          needs: error.requiredBindings,
        };
      }
    }
    return {
      state: 'failed',
      detail: error instanceof Error ? error.message : `${tool.name} failed to run.`,
    };
  }
}

/** Turns one node result into something worth showing a person. */
function readStep(step: RunStep): OutputStep {
  const label = step.label || step.type || step.nodeId || 'Step';
  if (step.skipped) return { label, state: 'skipped', detail: step.note };
  if (step.error) return { label, state: 'failed', detail: step.error };

  const payload = step.output ?? step.result;
  return { label, state: step.success === false ? 'failed' : 'ok', detail: summarise(payload) };
}

/** Collapses an arbitrary node payload into one line. */
function summarise(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.slice(0, 300);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Prefer the fields Noctus nodes actually fill with human-readable text.
    for (const key of ['text', 'message', 'summary', 'reply', 'body', 'note', 'reason']) {
      const found = record[key];
      if (typeof found === 'string' && found.trim()) return found.slice(0, 300);
    }
    try {
      return JSON.stringify(value).slice(0, 300);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Tools grouped for the catalogue screen, added ones first. */
export function byCategory(tools: Tool[]): { category: string; tools: Tool[] }[] {
  const groups = new Map<string, Tool[]>();
  for (const tool of tools) {
    const list = groups.get(tool.category) ?? [];
    list.push(tool);
    groups.set(tool.category, list);
  }
  return [...groups.entries()]
    .map(([category, list]) => ({
      category,
      tools: list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

function rank(tool: Tool): number {
  return tool.state === 'ready' ? 0 : tool.state === 'blocked' ? 1 : 2;
}
