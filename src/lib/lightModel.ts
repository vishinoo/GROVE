/**
 * The cheap tier.
 *
 * Indy is rate-limited per account per hour — two messages an hour on the free
 * plan — and it was being spent on "hello". This handles the conversation that
 * doesn't need to know anything about the account, and says so when a request
 * does, at which point grove.ts escalates to Indy.
 *
 * It matters more now than it did on a screen. Grove is spoken to, so a reply
 * that takes four seconds to arrive feels broken in a way the same delay in a
 * chat bubble never did — and the free tier's two messages an hour would
 * otherwise be gone before lunch.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  TEMPORARY. This file calls a model provider directly from the device.
 *
 *  `EXPO_PUBLIC_*` values are compiled into the JavaScript bundle, so a
 *  Gemini key set here is extractable from any release build by anyone who
 *  downloads it. That is acceptable for testing Grove against a throwaway
 *  key and is NOT acceptable for a build you ship.
 *
 *  The fix is a `/api/chat/light` endpoint on Noctus holding the key, the way
 *  /api/indy/chat already does. Everything outside this file talks to
 *  `lightTurn` and `lightSummarise` and knows nothing about providers, so
 *  that swap is a change to this file alone.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Ollama is preferred when it's reachable because it costs nothing at all. It
 * only ever works on a LAN — the phone and the machine running `ollama serve`
 * have to be on the same network — so it can never be the only path.
 */



import { fetchJson } from './net';

const OLLAMA_URL = (process.env.EXPO_PUBLIC_OLLAMA_URL ?? '').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.EXPO_PUBLIC_OLLAMA_MODEL || 'llama3.2';

/** Mobile networks are slow, but a chat reply that takes this long is lost. */
const TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MS = 1_500;

export type LightMessage = { role: 'user' | 'assistant'; content: string };

export type LightReply = {
  text: string;
  /** Which ability it thinks should take this, by id. */
  abilityId?: string;
  /**
   * Two or three words naming the standing job, when the request is one.
   * "Morning brief", not the forty words the person actually said.
   */
  title?: string;
  /** Arguments it pulled out of the sentence for that ability. */
  args: Record<string, string>;
};

/** The abilities Grove can currently reach, as the model needs to see them. */
export type AbilitySummary = { id: string; what: string }[];

/**
 * Whether Grove has a model at all.
 *
 * True whenever Noctus is reachable, because the key lives there now — the app
 * can no longer tell from its own configuration, and pretending otherwise would
 * report "no model" on a perfectly working install.
 */
export function isLightModelConfigured(): boolean {
  return true;
}

/* ------------------------------------------------------------- providers */

async function withTimeout<T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether the local Ollama answered, probed once per app run. Re-probing on
 * every message would add a round trip to a host that is usually absent.
 */
let ollamaReachable: boolean | null = null;

async function probeOllama(): Promise<boolean> {
  if (!OLLAMA_URL) return false;
  if (ollamaReachable !== null) return ollamaReachable;
  try {
    const response = await withTimeout(PROBE_TIMEOUT_MS, (signal) =>
      fetch(`${OLLAMA_URL}/api/tags`, { signal })
    );
    ollamaReachable = response.ok;
  } catch {
    ollamaReachable = false;
  }
  return ollamaReachable;
}

async function askOllama(
  system: string,
  messages: LightMessage[],
  json: boolean
): Promise<string | null> {
  try {
    const response = await withTimeout(TIMEOUT_MS, (signal) =>
      fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          stream: false,
          ...(json ? { format: 'json' } : {}),
          messages: [{ role: 'system', content: system }, ...messages],
        }),
      })
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { message?: { content?: string } };
    return data.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The model, through Noctus.
 *
 * This used to call Gemini directly with a key from EXPO_PUBLIC_*, which is
 * compiled into the bundle and extractable from any build. That was documented
 * as testing-only from the start and stopped being acceptable the moment a
 * build went to TestFlight, so the key moved to the server and this became a
 * call to /api/grove/chat.
 *
 * The prompt, the house rules and the ability list still live here. Noctus
 * holds the secret and forwards; it has no opinion about what Grove says.
 */
async function askServer(
  system: string,
  messages: LightMessage[],
  json: boolean,
  deep: boolean
): Promise<string | null> {
  const data = await fetchJson<{ text?: string }>('/api/grove/chat', {
    method: 'POST',
    body: { system, messages, json, deep },
  });
  return data?.text?.trim() || null;
}

/** Free first, then cheap. Returns null when neither is configured or up. */
async function complete(
  system: string,
  messages: LightMessage[],
  json = false,
  deep = false
): Promise<string | null> {
  // Ollama first when it answers, because it is free and local. It is also the
  // only path that never leaves the network, which is worth something for
  // something listening in your pocket.
  if (await probeOllama()) {
    const local = await askOllama(system, messages, json);
    if (local !== null) return local;
    // A reachable-but-failing Ollama shouldn't strand the turn.
    ollamaReachable = false;
  }
  return askServer(system, messages, json, deep);
}

/**
 * Whether a turn is worth the dearer model.
 *
 * Local and keyword-based, like every other consequential decision here, and
 * for the same reason: asking a model whether it needs a better model is both
 * circular and something you pay for on every single turn.
 *
 * The signals are the ones that actually correlate with a cheap model
 * struggling — being asked to explain, compare or reason rather than fetch, and
 * sheer length. Everything else, which is nearly everything Grove hears, stays
 * on the cheap tier.
 */
const DEEP_SIGNALS =
  /\b(why|explain|compare|difference between|pros and cons|walk me through|reason|analyse|analyze|summari[sz]e (?:this|that|the)|draft|write me)\b/i;

export function needsDepth(text: string): boolean {
  // Whether a deeper model exists is the server's business now, so this only
  // says whether the turn wants one. Noctus falls back to the cheap model when
  // none is configured, which is the right place for that decision.
  const t = text.trim();
  // Long enough that it is a paragraph rather than an instruction.
  if (t.length > 240) return true;
  return DEEP_SIGNALS.test(t);
}

/* ----------------------------------------------------------------- tasks */

/**
 * The rules every prompt here shares.
 *
 * The first is new with Grove and is the one that changes the most: replies
 * are synthesised and played into someone's ear, so anything that only works
 * on a screen — a list, a heading, a markdown link, a long preamble — actively
 * fails. Length is a correctness property now, not a style preference.
 *
 * The two after it are older, and earned. Asked "make a calendar with my
 * nutrition in it", the model once replied "Create a custom AI agent that
 * takes your dietary preferences…" — a product spec for software to build,
 * written to nobody, by a narrator who was not Grove. A model told it lives in
 * an app about AI agents will describe AI agents unless told, in as many
 * words, not to.
 */
const HOUSE_RULES = `How to talk:
- You are SPOKEN ALOUD through someone's glasses. No markdown, no lists, no headings, no URLs, no emoji, no bullet points, no parentheses.
- Talk like a person texting a friend, not like an assistant. Contractions. Plain words. Start with the answer.
- NEVER open with a pleasantry, an acknowledgement, or a restatement of what they asked. Not "Sure!", not "Of course", not "Great question", not "I can help with that", not "Let me check", not "Absolutely". Just say the thing.
- No enthusiasm you do not mean. No exclamation marks. If something is boring, say it plainly.

Length:
- Default to one sentence. Two if the first genuinely does not cover it.
- BUT when they ask something that deserves a real answer — how something works, why something happened, what the options are, a recommendation, a comparison — answer it properly. Three or four sentences is fine there. Being uselessly terse is as bad as rambling.
- You know a great deal. Use it. If they ask a general-knowledge question and no ability is involved, just answer it well from what you know.

THE ONE RULE YOU MUST NOT BREAK:
- NEVER say you are doing something, checking something, looking something up, or getting back to them, unless you have put an ability id in "ability". You have no way to act afterwards — there is no second turn, nothing runs in the background, and no follow-up message ever arrives. If you say "let me check the weather" and set no ability, the conversation simply ends there and the person is left waiting for something that will never come.
- So: either name the ability and let it run, or answer from what you know, or say plainly that you cannot do that thing yet. Those are the only three.
- Do not promise. Do not stall. Do not narrate steps.

Other:
- Never describe, propose, spec or summarise a piece of software, a feature, an "AI agent" or a system to be built. A reply that starts "Create a..." or "This tool would..." is always wrong.
- Never invent facts about their calendar, email, files, money, health or accounts. If you would have to guess, say what you would need instead.
- Never repeat your previous reply. If you have already said it, say the next thing or ask one short question.

Good: "Nothing until your two o'clock." / "Sent." / "Sixteen degrees and overcast, up to twenty." / "Can't see your mail yet — connect Google and I can."
Bad: "Sure! Let me check the weather for you right now..." (nothing runs, nothing follows) / "Great question! Here's what I found:"`;

/** Parses the JSON envelope the prompt asks for. Small models are sloppy. */
function parseReply(raw: string): LightReply {
  // They wrap JSON in prose or a code fence often enough that digging the
  // object out beats discarding an otherwise good answer.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as {
        reply?: unknown;
        ability?: unknown;
        args?: unknown;
        title?: unknown;
      };
      const text = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
      if (text) {
        const args: Record<string, string> = {};
        if (parsed.args && typeof parsed.args === 'object') {
          for (const [k, v] of Object.entries(parsed.args as Record<string, unknown>)) {
            if (typeof v === 'string' && v.trim()) args[k] = v.trim().slice(0, 300);
          }
        }
        return {
          text,
          abilityId:
            typeof parsed.ability === 'string' && parsed.ability.trim()
              ? parsed.ability.trim()
              : undefined,
          title:
            typeof parsed.title === 'string' && parsed.title.trim()
              ? parsed.title.trim().slice(0, 40)
              : undefined,
          args,
        };
      }
    } catch {
      // Fall through to treating the whole thing as prose.
    }
  }

  // No parsable JSON. The text is still usable; the caller's own keyword rule
  // decides whether anything runs, so losing the pick costs accuracy, not
  // safety.
  return { text: raw, args: {} };
}

/**
 * One conversational turn with Grove, on the cheap tier.
 *
 * This is now the only model tier. Indy — capped at two messages an hour — is
 * gone along with the rest of Noctus's agent side, so there is nothing above
 * this to escalate to and nothing to ration.
 *
 * It gets three things: the abilities Grove can actually reach, the manner
 * (already wrapped by persona.ts so a user-authored voice cannot become a
 * second set of instructions), and the small block of durable facts from
 * memory.ts. All three are local data, so handing them over costs nothing.
 *
 * Returns null when no provider is configured or reachable, which the caller
 * treats as "answer from local rules alone".
 */
export async function lightTurn(
  history: LightMessage[],
  userText: string,
  context: { abilities: AbilitySummary; manner: string; memory: string; name: string }
): Promise<LightReply | null> {
  if (!isLightModelConfigured()) return null;

  const belt =
    context.abilities.length === 0
      ? 'You cannot do anything for the user yet. If they ask for something done, say so plainly rather than pretending.'
      : `Things you can actually do right now. Use the id exactly:\n${context.abilities
          .map((a) => `- ${a.id} — ${a.what}`)
          .join('\n')}`;

  const system = `You are ${context.name || 'Grove'}. You are the single assistant this person talks to, usually through a pair of glasses while they are doing something else.

${belt}

${context.memory}

${context.manner}

${HOUSE_RULES}
- When one of the abilities above covers the request, put its exact id in "ability" and pull its arguments out of the sentence into "args". Say you are doing it. Do not narrate the steps.
- When nothing above covers it, leave "ability" empty and just answer. Never imply you did something you have no ability for.

- If the request is a standing job — it has a time, a recurrence, or a "whenever I say..." in it — also give "title": two or three words naming it, as a person would label it. "Morning brief". "Market check". "Leave now". Not a sentence, not a restatement.
- A standing job may describe more than you can do this second. That is fine and you should still take it: it is stored as an instruction and re-read every time it runs, so it will start working the day the ability behind it exists. Say plainly which part does not work yet rather than refusing the whole thing.

Respond with JSON only: {"reply": "<what to say>", "ability": "<id or empty>", "args": {}, "title": "<2-3 words, only for standing jobs>"}`;

  const raw = await complete(
    system,
    [...history.slice(-8), { role: 'user', content: userText.slice(0, 4000) }],
    true,
    needsDepth(userText)
  );
  if (!raw) return null;
  return parseReply(raw);
}

/**
 * Turns a raw ability result into a sentence that can be read aloud.
 *
 * The "no JSON, no quotes" instruction is load-bearing rather than tidy: this
 * output goes straight to the speech synthesiser, which will happily read a
 * pair of curly braces out loud.
 */
export async function lightSummarise(
  toolName: string,
  task: string,
  payload: unknown
): Promise<string | null> {
  if (!isLightModelConfigured()) return null;

  let serialised: string;
  try {
    serialised = JSON.stringify(payload).slice(0, 3000);
  } catch {
    return null;
  }

  const text = await complete(
    `You report what just happened, in one short sentence, addressed to the person who asked, to be SPOKEN ALOUD. Use past tense. State only what the data shows — if it shows nothing useful, say it ran and returned nothing to report. No preamble, no JSON, no quotes, no markdown, no URLs.`,
    [
      {
        role: 'user',
        content: `Tool: ${toolName}\nAsked to: ${task.slice(0, 400)}\nResult: ${serialised}`,
      },
    ]
  );

  return text?.replace(/^["']|["']$/g, '').trim() || null;
}
