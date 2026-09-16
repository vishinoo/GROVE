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
  return abilityId.replace(/\./g, '__');
}

export function abilityIdFor(toolName: string): string {
  return toolName.replace(/__/g, '.');
}

/**
 * The argument the turn fills in itself after a person confirms.
 *
 * Never offered to the model: it exists so the confirmation can re-run the same
 * ability with the decision attached, and a model that could set it would be
 * able to confirm on the person's behalf.
 */
const NOT_THE_MODELS_TO_SET = new Set(['confirmed']);

function describe(name: string, spec: ArgSpec): { type: 'STRING' | 'NUMBER'; description: string } {
  return {
    type: spec.type === 'number' ? 'NUMBER' : 'STRING',
    description: spec.what,
  };
}

/** One ability, as something the model can call. */
export function declarationFor(ability: Ability): FunctionDeclaration {
  const properties: FunctionDeclaration['parameters']['properties'] = {};
  const required: string[] = [];

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
