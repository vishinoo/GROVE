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

import { abilityById, currentAccount, runAbility, type Ability } from './abilities';
import type { GroveContext, GroveReply, Turn } from './grove';
import {
  asToolResults,
  asUserTurn,
  lastModelTrouble,
  lightFallback,
  toolTurn,
  type ToolHistory,
} from './lightModel';
import { asPromptBlock, factFrom } from './memory';
import { lately, loadLife, whoIsWho } from './life';
import { calculate } from './calc';
import { abilitiesFor, modeById } from './modes';
import { ABILITIES } from './abilities';
import { activePreset, depthRule, fallback, friendDirective, mannerDirective } from './persona';
import { abilityIdFor, argsFromCall, declarationsFor } from './tools';

/**
 * How many times the model may call tools before it has to answer.
 *
 * Four covers a real request — look something up, look up something it
 * mentioned, answer — while stopping a model that keeps calling tools from
 * leaving someone waiting on a loop.
 */
const MAX_ROUNDS = 4;

/**
 * The one tool that is not an ability: asking the person something back.
 *
 * A tool rather than a question mark, because the question mark was the
 * signal and it was wrong half the time — a personality that ends replies on
 * a joke opened the microphone for answers nobody was going to give. A call to
 * this is a decision to wait for one.
 */
const ASK_BACK = {
  name: 'ask_back',
  description:
    'Ask the person one short question back and listen for their answer. Use for open-ended requests — plans, recommendations, gifts, advice on a decision — where the right answer depends on their goal, taste, time or priorities. Written in your own voice, with personality.',
  parameters: {
    type: 'OBJECT',
    properties: {
      question: { type: 'STRING', description: 'The question, as you would say it to them.' },
    },
    required: ['question'],
  },
};

/** A tool that already ran inside the loop, for the card on the Talk screen. */
export type RanTool = { ability: Ability; ok: boolean; spoken: string; detail?: string };

const TOOL_RULES = `How to use your tools:
- Small talk is just talk. "How's it going", "hey", "thanks", "you there?" get a reply in character and no tool — they are not questions about their day.
- Anything about their calendar, email, weather, music, directions, contacts, messages, reminders or what you remember about them: call a tool. Never answer those from your own head — you do not have that information until a tool returns it.
- Never say what is or is not in their calendar, inbox, music library or contacts unless a tool just told you. "That isn't in your library" without having searched is a lie, however likely it sounds.
- Answer anything. A question no tool covers — general knowledge, advice, explanations, maths, recommendations, opinions — is answered from what you know, properly and specifically. Only say you can't when they ask you to DO something you have no tool for (read their texts, pay for something), and then say so plainly without inventing a reason.
- A sentence with several requests in it gets several tool calls, all at once.
- Fill in arguments from what they said and from what you know about them. Never ask for something you could reasonably infer.
- Asking back is how you do a good job on open-ended requests. Call ask_back, with ONE question in your own voice and personality, when the right answer depends on something only they know:
  - making a plan (workouts, their week, studying, a trip): ask the one thing that shapes it — the goal, how much time, what to prioritise. Look things up first if that makes the question sharper.
  - recommendations and gifts: ask about taste, budget or the occasion.
  - advice on a decision: ask what matters most to them or what they are worried about.
  Example — "make me a workout plan" → ask_back: "Are we building muscle or just surviving the stairs — and how many days a week will you actually turn up?"
  Do not ask back on plain requests you can simply do or answer: a lookup, a message they dictated, music, directions, a document they described. And ask at most once per request — after they answer, do the thing.
- ask_back is the ONLY way to wait for an answer. An ordinary reply never waits, so never end one on a question you want answered — and a joke or rhetorical question is fine, because nobody will be listening for a reply to it.
- For calendar questions, pass what they are looking for and any day or position they named ("first", "last", "next", "tomorrow").
- For email, write the search the way Gmail understands it when that helps: from:xbox, newer_than:7d, is:unread.
- Emails and replies: pass what they want to say as the body, in their words — "no, I'm busy", "I'll send it tomorrow". The app writes it up into a short professional email and reads it back before sending. Do not write the email yourself.
- Reply only when they say reply, respond or answer about a message they got; replying to "that email" means the one just discussed, so pass who it was from. "Email Priya that…" is a new email, not a reply.
- Texts are different: pass their words in their own voice, casual and short.
- If they gave no gist at all ("email Priya"), use ask_back to ask what it should say.
- Always give an email a short, natural subject line of your own — a few words saying what it is about, like "Running late" or "Slides for Thursday".
- To recap mail and then send that recap to someone, first get the recap, then send its text with the send-email tool.
- Ordering: food goes to the food tool (Uber Eats, or DoorDash if they say so); things to buy go to the shopping tool (Amazon unless they name Instacart, Walmart or Costco). "My usual" is in what you know about them above; if it is not there, ask_back what their usual is — do not search for it.
- For sending, booking, ordering, calling or messaging, just call the tool. The app asks the person to confirm before anything happens, so do not ask them yourself.
- To write something they will read — an assignment, a report, a reading list, a summary — use the document tool. Pass what they want in as much detail as they gave you.
- If they point at work they already have ("the assignment on here", "that brief"), find and read that document first and pass its text as the source, so what you write answers their actual question.
- Set research on a document when it needs facts from the world — companies, prices, news, anything you would otherwise be guessing at.
- A document takes half a minute to write. Do not promise one and stop; call the tool.
- To send or share a document you wrote, look it up with the documents-written tool first and put its link in the email. Never guess a link.
- Anything about their own life — what they should be doing, what they promised, who someone is, what was decided, an idea they had — comes from the memory tools, not from this conversation. You only see the last few turns; the tools see months.
- "What should I be doing", "I have an hour, what now", "catch me up": call the where-things-stand tool, then pick ONE thing and say why it is the one, weighing deadlines, what is promised, and how long they have.
- When they say they finished something that was outstanding ("I sent Jason the build"), mark it done.
- "Brief me on someone" or "who is X": use the person tool. Never assemble a person from memory of this conversation.
- "Anything important" about mail: use the tool that filters it. Name who and what they want, not how many are unread.
- A question about when something happened, or about something from a named stretch of time, goes to the long-memory search with that time passed as the when argument.
- Use web search whenever the answer is current, local or checkable and you are not certain: news, scores, prices, opening hours, where to find or buy something, whether something is free, anything that may have changed since you learned it. Write the search as the full question with its context from the conversation, never "it" or "the book". Better to search than to guess a fact.
- To go somewhere — "take me", "navigate", "directions to" — use navigate. Use the ride tool only when they say Uber, a ride, a taxi or a cab. For "home" pass "home"; the app knows the address.
- For a place mentioned in an email, note or event, look that up first and pass the actual street address.
- For a text, pass the person's name as they said it; the app finds the number.
- For what to wear or bring (a jacket, an umbrella, sunscreen), check the weather and today's calendar together, then answer yes or no with the reason — for example it gets cold before their evening plans.
- For music "like" what they played before, check recently played first, then play something in that vein — the same artist or a similar one — rather than the exact song again. Never play an empty request in place of that.
- A reminder about something you looked up says what it is about, not where it came from: "Demo with Jason, 10250 102 Ave, Friday 2pm — bring pricing slides", never "Jason's email".
- If an email, note or event you just read has a clear deadline or to-do, you may offer once to set a reminder. Never set one they did not ask for.

How to answer once tools return:
- Answer from what came back and nothing else. If it came back empty, say so plainly.
- You are spoken aloud through glasses. No lists, no markdown, no URLs, no reading out codes or IDs.
- Say the useful thing first. Keep your personality — a wry line is welcome — but the answer comes before the joke, never instead of it.
- Name the sender of each email exactly as its From line says. Two people can share a surname — "Prof. Chen" and "Mark Chen" are different people, and an email from one is never described as from the other.
- Jokes go around the facts, never into them. Never embellish what an email, event, note or person actually said — "Jason wants the build by Friday" is the fact; "Jason is threatening to cancel your licence" is an invention they might believe.
- Never repeat the question back, never open with "Sure" or "Let me check".
- If a tool failed, say what failed in one short sentence, in your own voice. Never say a search or tool failed, or is being difficult, unless one actually ran and failed this turn.`;

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
    friendDirective(persona),
    [mannerDirective(persona), mode.manner].filter(Boolean).join('\n\n'),
    // Length is theirs to choose, and it is a rule about the relationship
    // rather than the glasses: see depthRule.
    depthRule(persona),
    modeNote,
    TOOL_RULES,
  ]
    .filter((part) => part && part.trim())
    .join('\n\n');
}

/** The conversation so far, in the shape a tool conversation expects. */
function historyFor(history: Turn[]): ToolHistory {
  // An empty turn is not a turn. The model reads one as a request that was
  // never answered, and answers it again.
  return history.filter((turn) => turn.text.trim()).slice(-10).map((turn) => ({
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

/**
 * Whether a lookup only happened to fill in the action that follows it.
 *
 * "Navigate to the place from Jason's email" reads the email to find the
 * address, and reading that whole email aloud before opening Maps is noise —
 * the person asked to go somewhere, not to hear their mail. When a value the
 * action is about to use came out of the lookup, the lookup was a step, not an
 * answer. "What's the weather and text Sam I'm late" still says the weather,
 * because nothing in the text came from it.
 */
/**
 * Lookups that exist only to fill in another tool.
 *
 * Finding a number so a message can be sent, or a link so it can be attached,
 * is plumbing. Read aloud before the thing it was for, it sounds like an
 * answer to a question nobody asked — "Priya Shah: one seven eight oh…" ahead
 * of an email that was never about her number.
 */
const PLUMBING = new Set(['contact.find', 'doc.recent']);

function fedInto(read: RanTool, args: Record<string, string>): boolean {
  if (PLUMBING.has(read.ability.id)) return true;
  const found = `${read.spoken}\n${read.detail ?? ''}`.toLowerCase();
  const values = Object.values(args).map((value) => value.trim().toLowerCase());
  if (values.some((v) => v.length >= 6 && found.includes(v))) return true;

  // The other direction: a reminder that carries most of what the email said.
  const spokenWords = [...new Set(read.spoken.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])];
  if (spokenWords.length < 4) return false;
  const used = values.join(' ');
  return spokenWords.filter((w) => used.includes(w)).length / spokenWords.length >= 0.6;
}

/**
 * Whether a question is about the world as it is right now.
 *
 * Deliberately about the question's shape, not its subject: scores, markets,
 * prices, opening hours, news, "today", "last night". Those have answers that
 * change, and a model answering them from training is guessing with
 * confidence. Personal data is not here — the calendar and inbox have their
 * own tools, and a question about them has already called one.
 */
const FRESH =
  /\b(?:today|tonight|yesterday|last night|this (?:week|weekend|morning|evening)|latest|recent(?:ly)?|currently|right now|at the moment|score|scores|won|win|beat|lose|lost|last game|next game|game|match|playoffs?|standings|markets?|stocks?|shares|price|prices|how much (?:is|are|does)|cost|open|opens|close|closes|opening hours|hours|news|headlines?|happened|release date|come out|coming out|election|results?)\b/i;

const PERSONAL = /\b(?:my (?:calendar|schedule|inbox|email|emails|mail|reminders|notes|contacts|day|week)|remind me|what(?:'s| is) on)\b/i;

/**
 * Asked, not said. "That was a good game" is a remark and needs no search;
 * "how did the game go" is a question. Only questions get looked up.
 */
const ASKED = /\?\s*$|^\s*(?:what|what's|whats|how|who|when|where|which|why|did|does|do|is|are|was|were|will|any|can|could|tell me|give me|check|look up|find out)\b/i;

export function needsFreshFacts(text: string): boolean {
  return FRESH.test(text) && ASKED.test(text) && !PERSONAL.test(text);
}

/**
 * The question as a search should see it, with the conversation it came from.
 *
 * "Is it free online" searched on its own finds nothing, because "it" was two
 * turns ago. The last exchange rides along so the search knows what "it" is.
 */
function searchQuestion(history: Turn[], userText: string): string {
  const last = history.filter((t) => t.text.trim()).slice(-2);
  if (last.length === 0) return userText;
  return `${userText}\n\n(For context, the conversation just before: ${last
    .map((t) => `${t.role === 'assistant' ? 'Assistant' : 'Them'}: ${t.text.slice(0, 300)}`)
    .join(' ')})`;
}

/**
 * Text as it is heard and shown, with the model's markdown taken out.
 *
 * Told not to use markdown, it still wraps titles in it — "*Deep Learning*",
 * "**Inside Out**" — and the asterisks appeared on the Talk screen and, with
 * some voices, were read aloud. Removed here, once, for every reply, rather
 * than asked for politely in the prompt again.
 */
export function plainSpeech(text: string): string {
  return text
    .replace(/\*+/g, '')
    .replace(/`+/g, '')
    .replace(/(^|\s)_{1,2}([^_\n]+?)_{1,2}(?=[\s.,!?;:)]|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
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
    case 'server':
      return "Google's end had a hiccup. Ask me again.";
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
  const declarations = [...declarationsFor(available), ASK_BACK];
  // A line of names, not the archive: enough that "my cofounder" and "Jason"
  // are the same person without a lookup, and cheap enough to ride on every
  // turn. Everything else about them is a tool call away.
  const roster = await loadLife(currentAccount())
    .then((l) => [whoIsWho(l), lately(l)].filter(Boolean).join('\n'))
    .catch(() => '');
  const system = [systemFor(context, available), roster].filter(Boolean).join('\n\n');
  const fact = factFrom(userText) ?? undefined;

  // Sums are worked out exactly and handed over as a fact; see calc.ts.
  const sum = calculate(userText);
  const contents: unknown[] = [
    ...(historyFor(history) as unknown[]),
    asUserTurn(sum ? `${userText}\n\n[Worked out exactly: ${sum}. Use this number.]` : userText),
  ];
  const ran: RanTool[] = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    // Once something has come back, the model is only phrasing an answer that
    // already exists — and Gemini sometimes takes twelve seconds, or times out
    // and retries, to do it. The book question took 87 seconds that way, with
    // the search itself done in two. So that step gets eight seconds and no
    // retry; past that, what the tools returned is said as it is.
    const turn = await toolTurn(
      system,
      contents,
      declarations,
      ran.some((r) => r.ok) ? { timeoutMs: 8_000, retry: false } : {}
    );

    if (turn.kind === 'nothing') {
      // Anything that did run is still worth saying — the weather came back
      // even if the follow-up call to the model did not.
      const already = ran.filter((r) => r.ok).map((r) => r.spoken).filter(unique).join(' ');
      if (already) return { text: plainSpeech(already), args: {}, fact, ran };
      // Nothing to say yet: try the plain path before admitting defeat. A
      // missing key or a retired model will fail there too, so skip it.
      const trouble = lastModelTrouble();
      if (trouble !== 'no-key' && trouble !== 'no-model') {
        const plain = await lightFallback(
          system,
          history
            .filter((t) => t.text.trim())
            .map((t) => ({ role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: t.text })),
          userText
        );
        if (plain) return { text: plainSpeech(plain), args: {}, fact, ran };
      }
      return { text: troubleLine(context), args: {}, fact, ran };
    }

    if (turn.kind === 'text') {
      // Answered from memory something that only a search can know. Told in
      // the prompt to search for anything current, the model still answered
      // "how did the Oilers do" with "they haven't started yet" — the day after
      // a 5-2 win — and once invented a search failure for a search it never
      // ran. So the check is here, in code: a question about now gets looked
      // up, once, and the model answers again from what came back.
      const search = available.find((a) => a.id === 'brief.web');
      if (round === 0 && ran.length === 0 && search && needsFreshFacts(userText)) {
        const outcome = await runAbility(search, { topic: searchQuestion(history, userText) });
        ran.push({ ability: search, ok: outcome.ok, spoken: outcome.spoken, detail: outcome.detail });
        if (outcome.ok) {
          contents[contents.length - 1] = asUserTurn(
            `${userText}\n\n[A web search for this, done just now: ${outcome.spoken}]\nAnswer from that search, in your own voice. Do not contradict it.`
          );
          continue;
        }
      }
      return { text: plainSpeech(turn.text), args: {}, fact, ran };
    }

    contents.push(turn.raw);
    const results: { name: string; result: unknown }[] = [];

    for (const call of turn.calls) {
      // Asking back ends the turn: the question is the reply, and the answer
      // arrives as the next sentence with this one in the history.
      if (call.name.toLowerCase().replace(/[^a-z]/g, '') === 'askback') {
        const question = String((call.args as Record<string, unknown> | undefined)?.question ?? '').trim();
        if (question) {
          // The question stands on its own. Anything looked up first went to
          // the model, which wrote the question knowing it.
          return { text: plainSpeech(question), args: {}, fact, ran, expectsReply: true };
        }
        results.push({ name: call.name, result: { ok: false, result: 'Ask a question.' } });
        continue;
      }

      const ability = abilityById(abilityIdFor(call.name, available.map((a) => a.id)));

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
        const said = ran
          .filter((r) => r.ok && !fedInto(r, args))
          .map((r) => r.spoken)
          .filter(unique)
          .join(' ');
        return {
          text: plainSpeech(said),
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
  return { text: plainSpeech(said) || troubleLine(context), args: {}, fact, ran };
}
