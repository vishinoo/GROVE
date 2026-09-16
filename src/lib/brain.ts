/**
 * One ordinary turn: the model chooses what to run, runs what is safe, and
 * answers from what came back.
 *
 * WHY THIS REPLACED THE ROUTER
 *
 * Grove decided what to do with keyword regexes, read the model's choice out of
 * trailing text markers, then patched the arguments it forgot with more regexes.
 * Each fix covered one phrasing. "What was my last email from Xbox", "what's
 * the weather, I'm heading to Whyte Ave", "am I free before my first class
 * tomorrow" — every one of those failed at some point, not because a feature was
 * missing but because the sentence was phrased in a way nobody had written a
 * pattern for. That is not a bug to fix; it is what regex routing is.
 *
 * Tested against the live model before this was written: one sentence asking
 * about the weather and an Xbox email produced both calls, with the Gmail query
 * `from:xbox newer_than:7d` written by the model itself, in two seconds — and a
 * correct spoken answer from the returned data a second after that.
 *
 * THE SAFETY LINE, WHICH DID NOT MOVE
 *
 * The model proposes; code decides what happens. Anything marked `reads` runs
 * inside this loop, because the worst a wrong read does is look something up.
 * Anything else is handed back to the turn as a pending ability and goes through
 * the same path it always did — including the press-to-confirm for sending,
 * booking, ordering and calling. A misheard sentence still cannot do any of
 * those, because that decision is not the model's to make.
 */

import { abilityById, runAbility, type Ability } from './abilities';
import type { GroveContext, GroveReply, Turn } from './grove';
import {
  asToolResults,
  asUserTurn,
  lastModelTrouble,
  toolTurn,
  type ToolHistory,
} from './lightModel';
import { asPromptBlock, factFrom } from './memory';
import { abilitiesFor, modeById } from './modes';
import { ABILITIES } from './abilities';
import { activePreset, fallback, mannerDirective } from './persona';
import { abilityIdFor, argsFromCall, declarationsFor } from './tools';

/**
 * How many times the model may call tools before it has to answer.
 *
 * Four covers a real request — look something up, look up something it
 * mentioned, answer — while stopping a model that keeps calling tools from
 * leaving someone waiting on a loop.
 */
const MAX_ROUNDS = 4;

/** A tool that already ran inside the loop, for the card on the Talk screen. */
export type RanTool = { ability: Ability; ok: boolean; spoken: string; detail?: string };

const TOOL_RULES = `How to use your tools:
- Anything about their calendar, email, weather, music, directions, contacts, messages, reminders or what you remember about them: call a tool. Never answer those from your own head — you do not have that information until a tool returns it.
- Never say what is or is not in their calendar, inbox, music library or contacts unless a tool just told you. "That isn't in your library" without having searched is a lie, however likely it sounds.
- If no tool covers what they asked, say plainly that you cannot do that right now. Do not invent a reason.
- A sentence with several requests in it gets several tool calls, all at once.
- Fill in arguments from what they said and from what you know about them. Only ask a question when something you truly need is missing and cannot be reasonably inferred.
- For calendar questions, pass what they are looking for and any day or position they named ("first", "last", "next", "tomorrow").
- For email, write the search the way Gmail understands it when that helps: from:xbox, newer_than:7d, is:unread.
- When sending an email, always write a short, natural subject line of your own — a few words saying what it is about, like "Running late" or "Slides for Thursday". Write the body as the person would, in first person, and do not sign it.
- To recap mail and then send that recap to someone, first get the recap, then send its text with the send-email tool.
- For sending, booking, ordering, calling or messaging, just call the tool. The app asks the person to confirm before anything happens, so do not ask them yourself.
- For current events, prices, news or anything on the web, use the briefing tool.

How to answer once tools return:
- Answer from what came back and nothing else. If it came back empty, say so plainly.
- You are spoken aloud through glasses. One or two sentences. No lists, no markdown, no URLs, no reading out codes or IDs.
- Say the useful thing first. Keep your personality — a wry line is welcome — but the answer comes before the joke, never instead of it.
- Never repeat the question back, never open with "Sure" or "Let me check".
- If a tool failed, say what failed in one short sentence, in your own voice.`;

function systemFor(context: GroveContext, available: Ability[]): string {
  const { persona, facts } = context;
  const mode = modeById(persona.mode ?? 'normal');

  const now = new Date();
  const today = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const clock = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // A tool the mode has switched off is invisible to the model, so without this
  // it improvises a reason it cannot help — "I can't read your emails yet" —
  // when the truth is a setting the person turned on five minutes ago.
  const off = ABILITIES.filter((a) => a.wired && !available.some((x) => x.id === a.id));
  const modeNote =
    off.length > 0
      ? `They are in ${mode.label.toLowerCase()} mode, which switches off: ${off
          .map((a) => a.name)
          .join(', ')}. If they ask for one of those, say it is off in ${mode.label.toLowerCase()} mode and that "back to normal" turns it on.`
      : '';

  return [
    `You are ${persona.name || 'Grove'}, the one assistant this person talks to, usually through glasses while they are doing something else.`,
    `It is ${clock} on ${today}, timezone ${zone}. That is the real current date and time.`,
    asPromptBlock(facts),
    [mannerDirective(persona), mode.manner].filter(Boolean).join('\n\n'),
    modeNote,
    TOOL_RULES,
  ]
    .filter((part) => part && part.trim())
    .join('\n\n');
}

/** The conversation so far, in the shape a tool conversation expects. */
function historyFor(history: Turn[]): ToolHistory {
  return history.slice(-10).map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.text.slice(0, 2000) }],
  }));
}

/**
 * Each result said once.
 *
 * The model sometimes calls the same tool twice in one turn — searching notes,
 * finding nothing, searching again with different words — and when it then
 * gives up, reading back every result said "you have no notes yet" twice in a
 * row. Same sentence, same turn, once is enough.
 */
function unique(line: string, index: number, all: string[]): boolean {
  return all.indexOf(line) === index;
}

/** Why the model came back with nothing, said as a person would say it. */
function troubleLine(context: GroveContext): string {
  switch (lastModelTrouble()) {
    case 'rate-limited':
      return 'Too many at once — give me about five seconds.';
    case 'timeout':
      return 'That took too long to come back. Ask me again.';
    case 'offline':
      return 'I have no connection right now.';
    case 'no-model':
      return 'The model I am set to use has been retired. That needs changing in my settings.';
    case 'no-key':
      return fallback.unconfigured();
    default:
      return activePreset(context.persona)?.stuck ?? fallback.stuck();
  }
}

/**
 * What a tool result looks like to the model.
 *
 * The spoken line and the detail both go back, because the spoken line is
 * already cut short for someone's ear and the detail is what lets the model
 * answer a follow-up about the part that was cut.
 */
function resultFor(outcome: { ok: boolean; spoken: string; detail?: string }) {
  return {
    ok: outcome.ok,
    result: outcome.spoken,
    ...(outcome.detail ? { detail: outcome.detail.slice(0, 2500) } : {}),
  };
}

export async function askWithTools(
  history: Turn[],
  userText: string,
  context: GroveContext
): Promise<GroveReply> {
  const mode = modeById(context.persona.mode ?? 'normal');
  const available = abilitiesFor(mode, ABILITIES);
  const declarations = declarationsFor(available);
  const system = systemFor(context, available);
  const fact = factFrom(userText) ?? undefined;

  const contents: unknown[] = [...(historyFor(history) as unknown[]), asUserTurn(userText)];
  const ran: RanTool[] = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const turn = await toolTurn(system, contents, declarations);

    if (turn.kind === 'nothing') {
      // Anything that did run is still worth saying — the weather came back
      // even if the follow-up call to the model did not.
      const already = ran.filter((r) => r.ok).map((r) => r.spoken).filter(unique).join(' ');
      return { text: already || troubleLine(context), args: {}, fact, ran };
    }

    if (turn.kind === 'text') {
      return { text: turn.text, args: {}, fact, ran };
    }

    contents.push(turn.raw);
    const results: { name: string; result: unknown }[] = [];

    for (const call of turn.calls) {
      const ability = abilityById(abilityIdFor(call.name));

      // The model can only see tools the mode allows, so this is a model
      // inventing a name — answered, not trusted.
      if (!ability || !available.some((a) => a.id === ability.id)) {
        results.push({ name: call.name, result: { ok: false, result: 'That is not available.' } });
        continue;
      }

      const args = argsFromCall(call.args);

      // The line. Anything that is not a pure read goes back to the turn,
      // which runs it through the path that has always handled doing things —
      // confirmation included. Whatever reads already ran are said first, so
      // "what's the weather and text Sam I'm late" answers the weather and then
      // asks about the text.
      if (!ability.reads) {
        const said = ran.filter((r) => r.ok).map((r) => r.spoken).filter(unique).join(' ');
        return {
          text: said,
          ability,
          args,
          fact,
          ran,
          holdForTool: !said,
        };
      }

      const outcome = await runAbility(ability, args);
      ran.push({ ability, ok: outcome.ok, spoken: outcome.spoken, detail: outcome.detail });
      results.push({ name: call.name, result: resultFor(outcome) });
    }

    contents.push(asToolResults(results));
  }

  // Ran out of rounds with tools still being called. What did come back is
  // real, so say that rather than nothing.
  const said = ran.filter((r) => r.ok).map((r) => r.spoken).filter(unique).join(' ');
  return { text: said || troubleLine(context), args: {}, fact, ran };
}
