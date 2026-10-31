/**
 * Grove's abilities, described so a model can call them directly.
 *
 * This replaces three layers that all existed to work around the same missing
 * thing: a keyword gate deciding whether a tool ran at all, a parser reading
 * the model's choice out of trailing `ABILITY:` lines, and a growing pile of
 * regexes recovering arguments the model had left out. Each was a reasonable
 * answer to "the model cannot tell us what it wants properly", and none of them
 * was true any more — the model can, in a typed schema, several at once.
 *
 * WHAT CHANGES BECAUSE OF THIS
 *
 *   Two things in one sentence both happen. A turn was one ability because the
 *   reply format had room for one name; a function-calling turn has room for as
 *   many as the sentence contains.
 *
 *   Arguments arrive filled in. `required` is enforced by the model rather than
 *   discovered as an empty string at the point of use, which is what made Grove
 *   ask "what am I looking for?" about a sentence that had just said.
 *
 *   The answer comes after the data. The model sees what the tool returned
 *   before it speaks, so it cannot invent a calendar entry — it has one.
 *
 * WHAT DOES NOT CHANGE
 *
 * Nothing irreversible is reachable by the model deciding it should be. An
 * ability that is not marked `reads` comes back as a proposal and stops at the
 * confirmation in `agent.tsx`, which is code and not a prompt. The guarantee
 * that mattered — a misheard sentence cannot send, book or buy — is enforced
 * exactly where it was before.
 */

import type { Ability, ArgSpec } from './abilities';

/**
 * Gemini's shape for a callable function.
 *
 * Declared here rather than imported because nothing in the app depends on a
 * provider SDK, and this is the only place that knows the wire format.
 */
export type FunctionDeclaration = {
  name: string;
  description: string;
  parameters: {
    type: 'OBJECT';
    properties: Record<string, { type: 'STRING' | 'NUMBER'; description: string }>;
    required?: string[];
  };
};

/**
 * Function names may not contain a dot, and ability ids are all dotted.
 *
 * Converted rather than renamed: `mail.search` is the id everywhere else in the
 * app — in modes, in connections, in the harness — and changing it to satisfy a
 * wire format would be the wire format deciding the domain model.
 */
export function toolNameFor(abilityId: string): string {
  // One underscore, not two. Declared as `brief__web`, the model called
  // `brief_web` back often enough to matter — three times out of three on
  // "any big news today" — which matched nothing, was answered "not
  // available", and was then explained to the person as the internet
  // "sulking". No ability id contains an underscore, so one is unambiguous.
  return abilityId.replace(/\./g, '_');
}

/** Letters and digits only, so every spelling of a name compares equal. */
function squash(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The ability a tool call meant, however the model spelled it.
 *
 * Exact first, then with separators ignored — `brief_web`, `brief__web`,
 * `briefWeb` and `brief.web` are all one tool. A name that matches nothing even
 * then really is unknown.
 */
export function abilityIdFor(toolName: string, ids: string[] = []): string {
  const dotted = toolName.replace(/__?/g, '.');
  if (ids.length === 0 || ids.includes(dotted)) return dotted;
  const wanted = squash(toolName);
  return ids.find((id) => squash(id) === wanted) ?? dotted;
}

/**
 * The argument the turn fills in itself after a person confirms.
 *
 * Never offered to the model: it exists so the confirmation can re-run the same
 * ability with the decision attached, and a model that could set it would be
 * able to confirm on the person's behalf.
 */
const NOT_THE_MODELS_TO_SET = new Set(['confirmed', 'draft', 'new_email']);

function describe(name: string, spec: ArgSpec): { type: 'STRING' | 'NUMBER'; description: string } {
  return {
    type: spec.type === 'number' ? 'NUMBER' : 'STRING',
    description: spec.what,
  };
}

/**
 * Their own words asking for it, on everything that changes something.
 *
 * A model that does not understand a sentence reaches for the nearest tool
 * rather than saying so: "goon session" became a calendar event, again and
 * again. A rule against guessing was in the prompt and did not hold. So
 * every action has to quote what asked for it, and the turn checks the quote
 * against what was actually said (`askedFor`): an action nobody's words ask
 * for is refused before it runs, and the model is told to ask instead.
 */
export const ASKED = 'asked';

export function askedFor(quote: string, said: string): boolean {
  const words = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1);
  const wanted = words(quote);
  if (wanted.length === 0) return false;
  const have = new Set(words(said));
  return wanted.filter((w) => have.has(w)).length / wanted.length >= 0.6;
}

/** One ability, as something the model can call. */
export function declarationFor(ability: Ability): FunctionDeclaration {
  const properties: FunctionDeclaration['parameters']['properties'] = {};
  const required: string[] = [];
  if (!ability.reads) {
    properties[ASKED] = {
      type: 'STRING',
      description: 'Their own words, copied exactly from what they said, that ask for this. If nothing they said asks for it, do not call this tool: ask_back what they meant.',
    };
    required.push(ASKED);
  }

  for (const [name, spec] of Object.entries(ability.args)) {
    if (NOT_THE_MODELS_TO_SET.has(name)) continue;
    properties[name] = describe(name, spec);
    if (spec.required) required.push(name);
  }

  // The examples go into the description because they are the phrasings this
  // ability is actually tested against — the same list the harness asserts
  // against, so what the model is told and what is verified cannot drift.
  const examples = ability.examples.slice(0, 4).map((e) => `"${e}"`).join(', ');

  return {
    name: toolNameFor(ability.id),
    description: examples ? `${ability.what} For example: ${examples}` : ability.what,
    parameters: {
      type: 'OBJECT',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

/** Everything the model may call this turn. */
export function declarationsFor(abilities: Ability[]): FunctionDeclaration[] {
  return abilities.filter((a) => a.wired).map(declarationFor);
}

/**
 * Arguments back from the model, as the abilities expect them.
 *
 * Abilities take strings throughout — they were written against a parser that
 * only ever produced strings — so a number arriving as a number would silently
 * fail every `(args.x || '').trim()` in the file.
 */
export function argsFromCall(raw: Record<string, unknown> | undefined): Record<string, string> {
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (NOT_THE_MODELS_TO_SET.has(key)) continue;
    if (value === null || value === undefined) continue;
    args[key] = typeof value === 'string' ? value : String(value);
  }
  return args;
}
