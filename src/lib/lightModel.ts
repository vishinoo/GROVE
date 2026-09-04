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

const GEMINI_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? '';
const GEMINI_MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-2.5-flash-lite';
const OLLAMA_URL = (process.env.EXPO_PUBLIC_OLLAMA_URL ?? '').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.EXPO_PUBLIC_OLLAMA_MODEL || 'llama3.2';

/** Mobile networks are slow, but a chat reply that takes this long is lost. */
const TIMEOUT_MS = 12_000;
const PROBE_TIMEOUT_MS = 1_500;

export type LightMessage = { role: 'user' | 'assistant'; content: string };

export type LightReply = {
  text: string;
  /** Set when the request needs Indy's account context or an actual action. */
  escalate?: string;
  /**
   * The model's read on whether the user wants the work done now rather than
   * discussed. Advisory only — the caller pairs it with its own local rule,
   * because a small model saying "no" is not a reason to ignore "do it".
   */
  act?: boolean;
  /** Which tool it thinks should take this, by name. */
  toolName?: string;
};

/** The tools Grove can currently reach, as the model needs to see them. */
export type ToolSummary = { name: string; what: string }[];

export function isLightModelConfigured(): boolean {
  return Boolean(GEMINI_KEY || OLLAMA_URL);
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

async function askGemini(
  system: string,
  messages: LightMessage[],
  json: boolean
): Promise<string | null> {
  if (!GEMINI_KEY) return null;
  try {
    const response = await withTimeout(TIMEOUT_MS, (signal) =>
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          GEMINI_MODEL
        )}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': GEMINI_KEY,
          },
          signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: messages.map((m) => ({
              // Gemini calls the assistant turn "model".
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            })),
            generationConfig: {
              maxOutputTokens: 600,
              temperature: 0.7,
              ...(json ? { responseMimeType: 'application/json' } : {}),
            },
          }),
        }
      )
    );
    if (!response.ok) return null;
    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
    return text?.trim() || null;
  } catch {
    return null;
  }
}

/** Free first, then cheap. Returns null when neither is configured or up. */
async function complete(
  system: string,
  messages: LightMessage[],
  json = false
): Promise<string | null> {
  if (await probeOllama()) {
    const local = await askOllama(system, messages, json);
    if (local !== null) return local;
    // A reachable-but-failing Ollama shouldn't strand the turn.
    ollamaReachable = false;
  }
  return askGemini(system, messages, json);
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
const HOUSE_RULES = `Rules:
- Your reply will be SPOKEN ALOUD through the user's glasses. Write it to be heard, not read: no markdown, no lists, no headings, no URLs, no emoji, no parentheses. One or two sentences, and stop.
- You are a character in a conversation, not a narrator describing one. Speak in the first person, to the user, as yourself.
- NEVER describe, propose, spec or summarise a piece of software, a feature, an "AI agent" or a system to be built. A reply that starts "Create a…" or "This tool would…" is always wrong.
- Never invent facts about the user's calendar, email, files, money, health or accounts. If you would have to guess, say what you'd need instead.
- Never repeat your previous reply. If you have already said it, say the next thing or ask one short question.`;

/** Parses the JSON envelope both prompts ask for. Small models are sloppy. */
function parseReply(raw: string): LightReply {
  // They wrap JSON in prose or a code fence often enough that digging the
  // object out beats discarding an otherwise good answer.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as {
        reply?: unknown;
        needsAccount?: unknown;
        act?: unknown;
        tool?: unknown;
      };
      const text = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
      if (text) {
        return {
          text,
          escalate: parsed.needsAccount === true ? 'needs account context' : undefined,
          act: parsed.act === true,
          toolName:
            typeof parsed.tool === 'string' && parsed.tool.trim() ? parsed.tool.trim() : undefined,
        };
      }
    } catch {
      // Fall through to treating the whole thing as prose.
    }
  }

  // No parsable JSON. The text is still usable, but we can't tell whether it
  // needed the account — so escalate and let Indy have the last word.
  return { text: raw, escalate: 'unstructured reply' };
}

/**
 * One conversational turn with Grove, on the cheap tier.
 *
 * Takes the tool list because a Grove that doesn't know what it can reach can
 * only produce enthusiasm — it was the single biggest difference in reply
 * quality when this was a crew, and it is the same now that the crew has
 * become a toolbelt. The list is local data, not account data, so handing it
 * over costs nothing.
 *
 * `manner` arrives already wrapped by persona.ts, which is what keeps a
 * user-authored voice from turning into a second set of instructions.
 *
 * Returns null when no light provider is configured or reachable, which the
 * caller treats as "fall through to Indy" — so an unconfigured build behaves
 * exactly as it did before this tier existed.
 */
export async function lightTurn(
  history: LightMessage[],
  userText: string,
  context: { tools: ToolSummary; manner: string }
): Promise<LightReply | null> {
  if (!isLightModelConfigured()) return null;

  const belt =
    context.tools.length === 0
      ? 'You have no tools connected yet. If the user wants something done that needs one, say so plainly and tell them it is in the Tools tab — do not pretend to have done it.'
      : `Tools you can actually use right now:\n${context.tools
          .map((t) => `- ${t.name} — ${t.what}`)
          .join('\n')}`;

  const system = `You are Grove. You are the single assistant this person talks to, usually through a pair of glasses while doing something else. You do the work yourself, reaching for a tool when one fits.

${belt}

${context.manner}

${HOUSE_RULES}
- When one of the tools above covers the request, say you are doing it and put that tool's exact name in "tool". Do not narrate the steps — the tool runs and reports back.
- Set "act" to true when the user wants something done now ("send…", "book…", "do it", "go on"), and false when they are asking, musing or chatting.
- You cannot see the user's account. If answering properly needs their real integrations, usage, billing or history, set "needsAccount" to true and put a short holding sentence in "reply".

Respond with JSON only: {"reply": "<what to say>", "tool": "<tool name or empty>", "act": <true|false>, "needsAccount": <true|false>}`;

  const raw = await complete(
    system,
    [...history.slice(-8), { role: 'user', content: userText.slice(0, 4000) }],
    true
  );
  if (!raw) return null;
  return parseReply(raw);
}

/**
 * Turns a raw Noctus run result into a sentence that can be read aloud.
 *
 * Needs no account context — everything it describes is in the payload in
 * front of it — which is exactly why this belongs on the cheap tier rather
 * than spending one of the hour's Indy messages on a summary.
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
