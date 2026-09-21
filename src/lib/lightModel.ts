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



import { failureKind } from './failure';
import * as SecureStore from 'expo-secure-store';

import { fetchJson } from './net';
import { getNoctusUrl } from './noctusApi';

const OLLAMA_URL = (process.env.EXPO_PUBLIC_OLLAMA_URL ?? '').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.EXPO_PUBLIC_OLLAMA_MODEL || 'llama3.2';

/** Mobile networks are slow, but a chat reply that takes this long is lost. */
/**
 * How long the model gets before Grove gives up and says something.
 *
 * Cut from twelve seconds. Spoken, a pause this long is indistinguishable from
 * the app having crashed — people press the ring again, which cancels the turn,
 * which looks like it ignored them. Better to fail fast and say so.
 */
const TIMEOUT_MS = 8_000;

/**
 * The ceiling for a turn that is going to search.
 *
 * Grounding adds a round trip to Google before the model writes a word, and
 * eight seconds does not fit that — which is why anything worth looking up was
 * timing out. The cost of the longer wait is covered by saying something while
 * it happens, rather than by sitting silent for twice as long.
 */
const SEARCH_TIMEOUT_MS = 28_000;

/**
 * How long a call straight to the provider gets.
 *
 * Separate from TIMEOUT_MS, which was tuned when this call went to Noctus on
 * the same Wi-Fi and a slow answer meant a slow laptop. It now leaves the phone
 * for Google over whatever signal there is, and eight seconds is not a budget
 * for that — it is a coin toss.
 *
 * The regression that made this obvious was mine: skipping web grounding for
 * turns a local tool answers also dropped them from the 22-second search budget
 * to the 8-second one, so the calendar, mail and maps all began reporting the
 * model as unreachable. Grounding and patience are different questions and are
 * no longer answered by the same number.
 */
const DIRECT_TIMEOUT_MS = 16_000;

/** Writing a document, which nobody is waiting on mid-sentence. */
const WRITE_TIMEOUT_MS = 75_000;
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
  // Kept true because the answer is genuinely "it depends": a key may sit in
  // the Keychain, Ollama may be up, or a backend may hold one. Reporting "no
  // model" from static configuration was wrong on working installs, and it is
  // the kind of wrong that sends someone looking for a bug that is not there.
  return true;
}

/** Whether Grove can still think with Noctus down. Shown in Settings. */
export async function hasOwnKey(): Promise<boolean> {
  return Boolean(await loadOwnKey());
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
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  // Not cleared on success. `fetch` resolves when the headers arrive, and the
  // body is read afterwards — clearing the timer there left `response.json()`
  // unbounded, so a connection that stalled mid-reply held a turn silent for
  // ten minutes. Left armed, the same deadline covers the body too, and an
  // abort after the body is read does nothing.
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
/**
 * A key the user typed in, kept on the device only.
 *
 * The middle ground between the two bad options. A key compiled into the bundle
 * ships to everyone who installs the app; a key only on Noctus means Grove
 * cannot think when Noctus is down, which for something you talk to is the
 * whole product failing rather than one feature.
 *
 * This one is entered in Settings and stored in the Keychain, so it is on one
 * phone rather than in every build, and Grove keeps working when the server
 * does not. Unset by default: the proxy is still the primary path.
 */
const OWN_KEY = 'grove:own-model-key:v1';

let ownKey: string | null | undefined;

/**
 * The key this device thinks with.
 *
 * Two sources, and the order is deliberate. The Keychain wins, because a key
 * typed into Settings is a per-device choice someone made on purpose. The build
 * key is the fallback, so a fresh install can think before anyone has been
 * asked to paste anything.
 *
 * THE TRADE, STATED PLAINLY. `EXPO_PUBLIC_*` is compiled into the JavaScript
 * bundle and extractable from any build, and docs/SECURITY.md closed exactly
 * that hole by moving the key to a server. Cutting the server back out reopens
 * it, and pretending otherwise would be worse than the exposure itself.
 *
 * It is a deliberate trade for a personal build, on a pre-paid key scoped to
 * one API and cheap to rotate. It is the wrong trade for public distribution:
 * there, put the key in the Keychain only and leave this one unset.
 *
 * Before this fallback existed, `scripts/set-key.js` wrote a variable that
 * nothing in src/ ever read, so the documented way of configuring a model
 * quietly did nothing at all.
 */
export async function loadOwnKey(): Promise<string | null> {
  if (ownKey !== undefined) return ownKey;
  try {
    ownKey = await SecureStore.getItemAsync(OWN_KEY);
  } catch {
    ownKey = null;
  }
  if (!ownKey) {
    const built = (process.env.EXPO_PUBLIC_GEMINI_API_KEY ?? '').trim();
    ownKey = built.length > 0 ? built : null;
  }
  return ownKey;
}

export async function setOwnKey(key: string): Promise<void> {
  const clean = key.trim();
  ownKey = clean || null;
  try {
    if (clean) await SecureStore.setItemAsync(OWN_KEY, clean);
    else await SecureStore.deleteItemAsync(OWN_KEY);
  } catch {
    // A key that will not persist is a setting that did not save, not a crash.
  }
}

/**
 * Straight to the provider, using the device's own key.
 *
 * The fallback for when Noctus is unreachable — on cellular, or because the
 * machine it runs on went to sleep. Same prompt, same model, no server.
 */
/**
 * Why the model last came back with nothing.
 *
 * "Can't get to anything right now" was said for a rate limit, a timeout, an
 * expired key and a dead network alike, because all four arrived as null. Rate
 * limiting is the one that actually happens in normal use — ask three questions
 * quickly and the free tier starts refusing — and it is also the one where the
 * right advice is simply to wait a moment, which nobody can guess from the
 * generic line.
 */
export type ModelTrouble =
  | 'none'
  | 'no-key'
  | 'no-model'
  | 'rate-limited'
  | 'timeout'
  | 'offline'
  /** Google's side failed — a 5xx. Worth one retry, unlike a refusal. */
  | 'server'
  | 'refused';

let modelTrouble: ModelTrouble = 'none';

export function lastModelTrouble(): ModelTrouble {
  return modelTrouble;
}

async function askDirect(
  system: string,
  messages: LightMessage[],
  json: boolean,
  search = true,
  attempt = 0,
  tokens = 600
): Promise<string | null> {
  const key = await loadOwnKey();
  if (!key) {
    modelTrouble = 'no-key';
    return null;
  }

  try {
    // A document is a page of writing, sometimes with a web search in front of
    // it: twenty-two seconds is right for a sentence read aloud and cuts off a
    // write that was going to land. Measured at about 25 seconds with search.
    const deadline =
      tokens >= 2000 ? WRITE_TIMEOUT_MS : search && !json ? SEARCH_TIMEOUT_MS : DIRECT_TIMEOUT_MS;
    const response = await withTimeout(deadline, (signal) =>
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          DIRECT_MODEL
        )}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: messages.map((m) => ({
              role: m.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: m.content }],
            })),
            generationConfig: {
              maxOutputTokens: tokens,
              temperature: 0.7,
              ...(json ? { responseMimeType: 'application/json' } : {}),
            },
            // Grounding costs a round trip to Google before a word is
            // written, so it is asked for only when the turn plausibly needs
            // the web. It used to run on every non-JSON turn, which made
            // "play something mellow" as slow as "what happened in the markets".
            ...(json || !search ? {} : { tools: [{ google_search: {} }] }),
          }),
        }
      )
    );
    if (!response.ok) {
      // 429 and 5xx are worth one retry: they are transient by definition, and
      // the alternative is telling someone Grove is broken because they asked
      // two questions in quick succession. One retry only — a backoff loop in
      // front of someone waiting for an answer is its own kind of broken.
      if ((response.status === 429 || response.status >= 500) && attempt === 0) {
        await new Promise((done) => setTimeout(done, 1200));
        return askDirect(system, messages, json, search, 1, tokens);
      }
      // A 404 here means the configured model no longer exists, which is its own
      // failure and not a network one. Google retires pinned versions without
      // warning — 2.5-flash-lite went 404 and every turn reported "can't get to
      // anything", which sent everyone hunting a connection problem that was
      // never there.
      modelTrouble =
        response.status === 404
          ? 'no-model'
          : response.status === 429
            ? 'rate-limited'
            : 'refused';
      return null;
    }
    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() || null;
    modelTrouble = text ? 'none' : 'refused';
    return text;
  } catch (problem) {
    const kind = failureKind(problem);
    modelTrouble = kind === 'error' ? 'refused' : kind;
    return null;
  }
}

/**
 * The model called directly from the device.
 *
 * Read from the environment rather than written down here, because it was
 * written down in both places and they disagreed: `.env` still said
 * gemini-2.5-flash-lite, which Google has since closed to new keys, while this
 * constant said 3.1. `npm run check-model` reads the env var, so the diagnostic
 * was reporting on a model the app never actually called — a check that can
 * fail while the app works, and pass while it does not, is worse than no check.
 */
const DIRECT_MODEL =
  (process.env.EXPO_PUBLIC_GEMINI_MODEL ?? '').trim() || 'gemini-flash-lite-latest';


async function askServer(
  system: string,
  messages: LightMessage[],
  json: boolean,
  deep: boolean,
  search: boolean
): Promise<string | null> {
  const data = await fetchJson<{ text?: string }>('/api/grove/chat', {
    method: 'POST',
    body: { system, messages, json, deep, search },
    // Only a call that will actually search needs the long bound.
    slow: search,
  });
  return data?.text?.trim() || null;
}

/** Free first, then cheap. Returns null when neither is configured or up. */
async function complete(
  system: string,
  messages: LightMessage[],
  json = false,
  deep = false,
  search = true,
  // Everything spoken is short by design; a document is the one thing here that
  // is meant to be read, and 600 tokens stops it mid-sentence on page one.
  tokens = 600
): Promise<string | null> {
  // Free and local first, then the server that holds the shared key, then the
  // device's own key. Three paths so that no single thing going down takes
  // Grove's ability to think with it.
  if (await probeOllama()) {
    const local = await askOllama(system, messages, json);
    if (local !== null) return local;
    ollamaReachable = false;
  }

  // The phone's own key comes before the server now, and the order is the whole
  // point of cutting Noctus loose. While the server came first, every single
  // turn paid its timeout before falling through — ten seconds of silence, on a
  // deployment that need not exist at all. Grove answers from the device and
  // treats a backend as an optional extra rather than the path of first resort.
  const direct = await askDirect(system, messages, json, search, 0, tokens);
  if (direct !== null) return direct;

  // Only if one is actually configured. An unset URL is not a failure to
  // report, it is a Grove that was never pointed at a server.
  if (!(await hasNoctus())) return null;
  return askServer(system, messages, json, deep, search);
}

/**
 * Whether this install has a backend at all.
 *
 * Grove is standalone by default. Noctus survives as an integration layer for
 * anyone who wants shared credentials or server-run sparks, and everything
 * still works when it is absent — which is the difference between a dependency
 * and an option.
 */
async function hasNoctus(): Promise<boolean> {
  try {
    const url = await getNoctusUrl();
    return typeof url === 'string' && url.trim().length > 0;
  } catch {
    return false;
  }
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

/**
 * Whether a turn plausibly needs the web.
 *
 * Grounding costs a round trip to Google before a word is written, so running
 * it on "play something mellow" makes the fast half of Grove as slow as the
 * slow half. Question-shaped and fact-shaped requests get it; instructions and
 * chatter do not.
 *
 * Wrong in the cheap direction on purpose: a missed search costs one "I can't
 * check that", while a missed instruction costs several seconds on every
 * single turn.
 */
const LOOKUP_SIGNALS =
  /\b(who|what|when|where|which|how (?:much|many|far|long)|why|price|cost|score|news|weather|open|closed|hours|near|nearby|best|latest|today'?s|current|trading|won|winner)\b/i;

export function needsLookup(text: string): boolean {
  const t = text.trim();
  if (t.endsWith('?')) return true;
  return LOOKUP_SIGNALS.test(t);
}

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
export const HOUSE_RULES = `How to talk:
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

WHAT YOU DO NOT KNOW:
- You CAN search the web, and you should whenever the answer is something current or checkable: news, prices, results, opening hours, anything after your training. Search first, then answer in one sentence.
- What you must not do is guess. If a search gives you nothing useful, say you could not find it. "I couldn't find that" is a good answer; a confident wrong one is the worst thing you can do, because they are walking down a street listening to you, not reading a page with a source on it.
- Never soften a guess into an answer. Not "I think it's around", not "probably about", not "last I knew". Either you found it, or you say you didn't.
- Never state a number, a date, a price or a name you are not sure of. Ask, or say you do not have it.

WHEN TO ASK INSTEAD OF ANSWERING:
- A request that could mean ten different things deserves one short question, not a guess dressed as an answer. "Build me a project" — ask what kind, or what it is for. "Book me something" — ask when.
- One question, not three, and never a list of options. Ask the single thing that most changes the answer, then wait.
- Do not ask when you can reasonably infer it, and never ask twice about the same thing. If they have already told you, use it.
- Once they answer, actually answer properly: a real, specific, useful reply. A clarifying question earns you the right to be good, so be good.

PLACES:
- Anything local — a restaurant, a shop, opening hours, what is nearby — depends entirely on WHERE. Getting the city wrong makes the answer worse than useless, because it is confidently specific and completely irrelevant.
- If they named a place, search that exact place and say its name back in your answer so they can tell you searched the right one.
- If they did not name one, use the town in the background above. If there is no town there either, ASK which one. Never assume, never default to a big city, and never answer a local question without knowing the place.
- Never repeat your previous reply. If you have already said it, say the next thing or ask one short question.

Good: "Nothing until your two o'clock." / "Sent." / "Sixteen degrees and overcast, up to twenty." / "Can't see your mail yet — connect Google and I can."
Bad: "Sure! Let me check the weather for you right now..." (nothing runs, nothing follows) / "Great question! Here's what I found:"`;

/**
 * Pulls the routing markers off the end of a reply.
 *
 * This used to demand a JSON envelope, which quietly cost Grove its ability to
 * look anything up: asked for strict JSON, the model obeys the format and skips
 * the search, so it answered live questions from memory — confidently and
 * wrongly. Asked for prose with a marker on the last line, it searches first and
 * then appends the marker. Same information, and the answers are true.
 *
 * Markers are optional. A reply with none is a perfectly good reply; the local
 * keyword router decides what runs either way.
 */
function parseReply(raw: string): LightReply {
  const lines = raw.trim().split('\n');
  const args: Record<string, string> = {};
  let abilityId: string | undefined;
  let title: string | undefined;

  // Read markers off the end and stop at the first line that is not one, so a
  // sentence containing the word "ability" is never mistaken for a marker.
  while (lines.length > 0) {
    const line = lines[lines.length - 1].trim();
    const marker = /^(ABILITY|ARGS|TITLE)\s*:\s*(.*)$/i.exec(line);
    if (!marker) break;
    lines.pop();

    const [, kind, rest] = marker;
    const value = rest.trim();
    if (/^ability$/i.test(kind)) {
      if (value && !/^(none|null|-)$/i.test(value)) abilityId = value;
    } else if (/^title$/i.test(kind)) {
      if (value) title = value.slice(0, 40);
    } else {
      for (const pair of value.split(';')) {
        const at = pair.indexOf('=');
        if (at === -1) continue;
        const k = pair.slice(0, at).trim();
        const v = pair.slice(at + 1).trim();
        if (k && v) args[k] = v.slice(0, 300);
      }
    }
  }

  return { text: lines.join('\n').trim(), abilityId, title, args };
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
  context: {
    abilities: AbilitySummary;
    manner: string;
    memory: string;
    name: string;
    /**
     * False when a tool on this phone is going to supply the facts.
     *
     * Grounding costs a round trip to Google before the model writes a word,
     * and "what is my first event" is question-shaped, so needsLookup said yes
     * and every calendar question paid for a web search it could not use. The
     * answer was coming from EventKit either way; the search only bought the
     * timeout people were sitting through.
     */
    grounded?: boolean;
  }
): Promise<LightReply | null> {
  if (!isLightModelConfigured()) return null;

  const belt =
    context.abilities.length === 0
      ? 'You cannot do anything for the user yet. If they ask for something done, say so plainly rather than pretending.'
      : `Things you can actually do right now. Use the id exactly:\n${context.abilities
          .map((a) => `- ${a.id} — ${a.what}`)
          .join('\n')}`;

  // Grove had no idea what day it was, and would answer from training data —
  // confidently, and months out of date. A model cannot know the time unless it
  // is told, and half of "it just lies" was this.
  const now = new Date();
  const today = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const clock = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const system = `You are ${context.name || 'Grove'}. You are the single assistant this person talks to, usually through a pair of glasses while they are doing something else.

Right now it is ${clock} on ${today}. That is the current date and time — use it, and never guess at what day it is.

${belt}

${context.memory}

${context.manner}

${HOUSE_RULES}
- When one of the abilities above covers the request, name it on the ABILITY line and pull its arguments onto the ARGS line. Say you are doing it. Do not narrate the steps.
- ANYTHING SPECIFIC YOU NAME IN YOUR REPLY MUST APPEAR IN ARGS. If you say "let's go with Fleetwood Mac", then ARGS must carry what=Fleetwood Mac. The ability does not read your reply — it only sees ARGS — so a name that is not there is not the thing that happens, and the person hears you promise one song and get another.
- If you are leaving the choice to the ability, say so without naming anything: "putting something on", not the name of a band you did not pass along.
- When nothing above covers it, write ABILITY: none and just answer. Never imply you did something you have no ability for.

- If the request is a standing job — it has a time, a recurrence, or a "whenever I say..." in it — also give a TITLE line: two or three words naming it, as a person would label it. "Morning brief". "Market check". "Leave now". Not a sentence, not a restatement.
- A standing job may describe more than you can do this second. That is fine and you should still take it: it is stored as an instruction and re-read every time it runs, so it will start working the day the ability behind it exists. Say plainly which part does not work yet rather than refusing the whole thing.

After your reply, on their own final lines, add any of these that apply. Nothing else on those lines, and leave them out entirely when they do not apply:
ABILITY: <exact id from the list above, or none>
ARGS: <key=value; key=value>
TITLE: <two or three words, only for a standing job>`;

  const raw = await complete(
    system,
    [...history.slice(-8), { role: 'user', content: userText.slice(0, 4000) }],
    false,
    needsDepth(userText),
    context.grounded === false ? false : needsLookup(userText)
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
/**
 * A short spoken briefing on something, grounded in a web search.
 *
 * This ability was declared and never built: it wanted a /api/grove/brief
 * endpoint on Noctus that was never written, so `wired: false` was the honest
 * setting. With the model reachable from the device and grounding already on
 * the direct path, the endpoint is no longer the missing piece — there is
 * nothing left to build it out of but a prompt.
 */
export async function lightBrief(topic: string): Promise<string | null> {
  const text = await complete(
    // A question, not only a briefing. Written for "what happened in the
    // markets", this prompt answered "where can I get this book, is it free"
    // with a summary of news about the book — the search was right and the
    // answer was to a different question.
    'You answer a question out loud, using web search. Answer exactly what was asked, in one to three sentences, leading with the answer: the specific names, numbers, places, prices, dates, or where to get something and whether it is free. For news or markets, lead with what changed, with numbers. Spoken aloud, so no markdown, no URLs, no bullet points, no preamble. If search genuinely finds nothing, say so plainly rather than guessing.',
    [{ role: 'user', content: topic }],
    false,
    false,
    true
  );
  // This line can be spoken as it is, when the model is too slow to rephrase
  // it — so it leaves here already fit to be heard: no asterisks, no code
  // formatting, no bare web addresses read out character by character.
  const clean = (text ?? '')
    .replace(/[*`]+/g, '')
    .replace(/\bhttps?:\/\/\S+/g, '')
    .replace(/\b[\w-]+(?:\.[\w-]+)+\/[\w./-]*/g, 'their website')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return clean || null;
}

/**
 * Several emails, reduced to something worth hearing.
 *
 * Kept apart from lightSummarise because the job is different: that one reports
 * what a tool just did, this one reads a stack of messages and works out what
 * matters. Deliberately no web grounding — everything needed is in the mail,
 * and searching would only add a round trip and an opportunity to wander.
 */
/**
 * Several messages, as one thing you can listen to.
 *
 * The first version recited five emails in full and appended whether each
 * needed a reply, which is longer than reading the inbox yourself and is the
 * opposite of the point. A summary that takes as long as the source is not a
 * summary. One clause each, automated noise dropped, and if there is nothing
 * worth saying it says that instead of filling the silence.
 */
export async function lightDigest(
  items: { from: string; subject: string; body: string }[],
  focus: string
): Promise<string | null> {
  if (items.length === 0) return null;
  const material = items
    .map((m, i) => `${i + 1}. From ${m.from} — ${m.subject}\n${m.body.slice(0, 400)}`)
    .join('\n\n');

  return complete(
    'You summarise email for someone listening while walking. ONE short clause per message — who it is from and the single thing they want, under twelve words. Never explain what a message is not, never say whether it needs a reply unless it explicitly asks for something, never restate the subject line you were given. Skip anything automated: receipts, security alerts, newsletters, notifications. If nothing is worth mentioning, say so in four words. No preamble, no markdown, no bullets, no URLs, no headers.',
    [{ role: 'user', content: `${focus ? `They asked about: ${focus}\n\n` : ''}${material}` }],
    false,
    false,
    false
  ).then((t) => t?.trim() || null);
}

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

/* ------------------------------------------------------------ tool calls */

/**
 * One exchange with the model when it can call Grove's abilities directly.
 *
 * The older path asked for prose with `ABILITY:` markers on the end and parsed
 * them back out. That worked until it did not: markers went missing, arguments
 * were left empty, and only one ability could ever be named because there was
 * only one line to name it on. This asks the provider for what it actually
 * supports — typed calls, several at a time — and returns them without
 * interpretation.
 *
 * Deliberately does no executing. The caller decides what may run, which is
 * where the confirmation lives, and a model that could run things from in here
 * would be a model that had been handed the decision.
 */
export type ToolCall = { name: string; args: Record<string, unknown> };

export type ToolTurn =
  | { kind: 'calls'; calls: ToolCall[]; raw: unknown }
  | { kind: 'text'; text: string; raw: unknown }
  | { kind: 'nothing' };

/**
 * A turn in the provider's own shape.
 *
 * Kept opaque on purpose: the caller passes it back unchanged on the next
 * round, so a tool result lands in the same conversation the call came from.
 * Nothing outside this file should read it.
 */
export type ToolHistory = unknown[];

const TOOL_TIMEOUT_MS = 20_000;

/**
 * One tool turn, tried twice when the first failure was the kind that passes.
 *
 * A timeout, a dropped connection, a 429 or a 5xx on a phone moving between
 * cell towers is usually gone a second later, and the alternative to one quick
 * retry is telling someone Grove is broken because they asked while walking
 * past a dead spot. A refusal or a missing key is not retried: it will fail
 * the same way again.
 */
export async function toolTurn(
  system: string,
  contents: ToolHistory,
  declarations: unknown[],
  options: { timeoutMs?: number; retry?: boolean } = {}
): Promise<ToolTurn> {
  const timeoutMs = options.timeoutMs ?? TOOL_TIMEOUT_MS;
  const first = await toolTurnOnce(system, contents, declarations, timeoutMs);
  if (first.kind !== 'nothing' || options.retry === false) return first;
  if (!['timeout', 'offline', 'rate-limited', 'server'].includes(modelTrouble)) return first;
  await new Promise((done) => setTimeout(done, modelTrouble === 'rate-limited' ? 1500 : 600));
  return toolTurnOnce(system, contents, declarations, timeoutMs);
}

async function toolTurnOnce(
  system: string,
  contents: ToolHistory,
  declarations: unknown[],
  timeoutMs: number
): Promise<ToolTurn> {
  const key = await loadOwnKey();
  if (!key) {
    modelTrouble = 'no-key';
    return { kind: 'nothing' };
  }

  try {
    const response = await withTimeout(timeoutMs, (signal) =>
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          DIRECT_MODEL
        )}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          signal,
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents,
            ...(declarations.length > 0
              ? { tools: [{ functionDeclarations: declarations }] }
              : {}),
            // Low, because this turn is a routing decision and an answer read
            // off real data. Neither wants invention.
            generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
          }),
        }
      )
    );

    if (!response.ok) {
      if ((response.status === 429 || response.status >= 500)) {
        modelTrouble = response.status === 429 ? 'rate-limited' : 'server';
      } else {
        modelTrouble = response.status === 404 ? 'no-model' : 'refused';
      }
      return { kind: 'nothing' };
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string; functionCall?: ToolCall }[] } }[];
    };
    const content = data.candidates?.[0]?.content;
    const parts = content?.parts ?? [];

    const calls = parts
      .map((p) => p.functionCall)
      .filter((c): c is ToolCall => Boolean(c?.name));
    if (calls.length > 0) {
      modelTrouble = 'none';
      return { kind: 'calls', calls, raw: content };
    }

    const text = parts.map((p) => p.text ?? '').join('').trim();
    if (text) {
      modelTrouble = 'none';
      return { kind: 'text', text, raw: content };
    }

    modelTrouble = 'refused';
    return { kind: 'nothing' };
  } catch (problem) {
    const kind = failureKind(problem);
    modelTrouble = kind === 'error' ? 'refused' : kind;
    return { kind: 'nothing' };
  }
}

/**
 * An answer without tools, for when the tool turn failed twice.
 *
 * "Where can I find this book, should I try the library" needs no tool at
 * all, and answering it with "I have no connection" because the tool turn
 * timed out is a failure the person can do nothing about. This is a second,
 * simpler path to an answer: the same voice and the same system prompt, with
 * search, and an instruction not to guess at anything personal it could not
 * look up.
 */
export async function lightFallback(
  system: string,
  history: LightMessage[],
  userText: string
): Promise<string | null> {
  const text = await complete(
    `${system}

Your tools are unavailable for this one answer. Answer from what you know, from search, and from the conversation so far — "it" and "the book" mean whatever was just being discussed. If the question needs their own data — their calendar, email, contacts, reminders, notes, or what you remember about them — say in one short sentence, in your own voice, that you couldn't get to it just now and to ask again. Never guess at their data. Public things like libraries, shops, books and prices are not their data: answer those.`,
    // Without the conversation, "where can I find it" had no "it" — and the
    // answer told them to go and look at whatever book they had meant.
    [...history.slice(-8), { role: 'user', content: userText }],
    false,
    false,
    true,
    700
  );
  return text?.trim() || null;
}

/** A user's sentence, in the shape a tool conversation expects. */
export function asUserTurn(text: string): unknown {
  return { role: 'user', parts: [{ text }] };
}

/**
 * Everything the tools returned, as one turn.
 *
 * All of it together, not a turn each: the model issued its calls in one breath
 * and expects the answers the same way. Split across turns, a two-part question
 * gets answered as though only the first part had come back.
 */
export function asToolResults(results: { name: string; result: unknown }[]): unknown {
  return {
    role: 'user',
    parts: results.map((r) => ({ functionResponse: { name: r.name, response: r.result } })),
  };
}

/* ---------------------------------------------------------------- notes */

export type NoteShape = { title: string; summary: string; points: string[]; actions: string[] };

/**
 * Turns a spoken note into something worth reading back.
 *
 * Speech is not prose: it repeats itself, doubles back, trails off and says
 * "um, anyway" in the middle of the point. What someone wants later is the
 * point, the reasoning, and anything they committed to — so that is what is
 * asked for, and the transcript is kept alongside it in case the summary got
 * something wrong.
 *
 * Returns null rather than a guess when the model does not answer. The caller
 * saves the transcript either way, so a failed summary never loses the note.
 */
/**
 * A document, written to be read rather than heard.
 *
 * Everything else here is written for an ear and cut to a sentence or two. This
 * is the opposite job: headings, paragraphs, and enough of them to be worth
 * opening. Grounded in search when the subject is something happening in the
 * world, because a document of "interesting thermal stocks" written from
 * memory is a list of plausible companies, which is worse than no document.
 *
 * Plain text, because a Google Doc built from inserted text shows markdown
 * asterisks as asterisks.
 */
/**
 * What a report should actually be about, decided before it is written.
 *
 * "A couple of energy stocks I might invest in" names nothing to look up. This
 * turns it into subjects — real companies, with tickers — so the research that
 * follows has something to search for. Grounded, because the answer depends on
 * what is happening this month rather than what was true when the model was
 * trained.
 */
export async function lightPlan(brief: string): Promise<string[]> {
  const raw = await complete(
    `You decide what a piece of research should cover. Given what someone asked for, name the specific things worth researching — real companies with tickers, real places, real named things. Never generic categories.

Return JSON: {"subjects": ["...", "..."]}. Between 2 and 5 subjects, each a short name with its identifier where it has one, like "NextEra Energy (NEE)". If the request already names them, use exactly those.`,
    [{ role: 'user', content: brief.slice(0, 1000) }],
    true,
    false,
    false,
    400
  );
  try {
    const parsed = JSON.parse((raw ?? '{}').replace(/^```(?:json)?\s*|\s*```$/g, '')) as {
      subjects?: unknown;
    };
    return Array.isArray(parsed.subjects)
      ? parsed.subjects.map((x) => String(x).trim()).filter(Boolean).slice(0, 5)
      : [];
  } catch {
    return [];
  }
}

/**
 * One subject, looked up properly.
 *
 * Search-grounded and asked for numbers with dates on them, because a report
 * whose figures are a year old is worse than one that says it could not check:
 * the first is acted on, the second is looked up.
 */
export async function lightResearch(subject: string, brief: string): Promise<string | null> {
  return complete(
    `You are researching one subject for a report. Use search. Report only what you actually found.

Write compact notes, not prose: facts, numbers, and dates. Include the most recent figures you can find and say when each is from. Include what has happened lately, what the argument in favour is, and what the risks are. If you could not confirm something, write "unconfirmed" beside it rather than filling it in.`,
    [{ role: 'user', content: `Subject: ${subject}\n\nThis is for: ${brief.slice(0, 500)}` }],
    false,
    false,
    true,
    900
  );
}

export async function lightDocument(
  brief: string,
  source: string,
  search: boolean,
  notes = ''
): Promise<string | null> {
  const text = await complete(
    `You write documents someone will open and read on a screen.

- Structure it with two markers and nothing else: a line starting with "## " is a heading, and a line starting with "- " is a bullet. No other markdown anywhere — no asterisks, no hashes mid-line, no bold, no tables.${
      notes
        ? '\n- You have been given research notes. Use their figures, and say when a figure is from. Never invent a number that is not in the notes; if something was not confirmed, say so in a plain sentence.'
        : ''
    }
- Open with one short paragraph saying what this is. Then the substance, under headings.
- Be specific. Names, numbers, dates, real detail. Never pad, never repeat the brief back, never write "in conclusion".
- Long enough to be worth opening: ${notes ? '1200 to 2000' : '700 to 1200'} words unless the brief asks for something shorter or longer. Anything you name gets its own short section — what it is, the numbers that matter, and why it is worth their attention. Depth, not padding — more real detail per section, never more sections saying less.
- If you are working from material they gave you, follow its instructions exactly — its questions, its length, its format. Those instructions beat the length guidance above.
- When the subject has risk or uncertainty in it, end with a short plain section on what to watch or what could go wrong.
- If something is uncertain or you could not check it, say so in the document in a plain sentence rather than inventing it.
- Do not write a title line; the document already has a title.
- If it touches money, health or law, include one plain sentence saying this is research rather than advice. Never tell them how much to spend, and never predict a price.`,
    [
      {
        role: 'user',
        content: [
          `Write this document: ${brief}`,
          source ? `Work from this material:\n${source.slice(0, 12_000)}` : '',
          notes ? `Research notes gathered for this, with dates:\n${notes.slice(0, 24_000)}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    false,
    false,
    search,
    notes ? 5000 : 3000
  );
  const clean = (text ?? '').trim();
  // "##" and "-" survive — they become real headings and bullets in the
  // document. Everything else markdown is stripped, since it would otherwise
  // be read as literal asterisks by someone opening the file.
  return clean ? clean.replace(/^#{1,6}\s*(?=\S)/gm, '## ').replace(/\*\*?/g, '').replace(/^\s*[•*]\s+/gm, '- ') : null;
}

/**
 * Someone's gist, written up as the email they would have sent.
 *
 * One job, one prompt. The same instruction inside the turn's system prompt —
 * which is also juggling thirty tools, a personality and a calendar — was
 * followed one time and ignored the next: "tell him I'll send it tomorrow"
 * went out as exactly that, no greeting, in lower case. A call that does
 * nothing but this does it every time.
 *
 * The line it must not cross is invention. It may make "no, I'm busy" polite;
 * it may not give a reason, suggest another day, or promise anything, because
 * the person approving it by ear will not catch an added sentence they did not
 * say.
 */
export async function lightEmail(input: {
  gist: string;
  to: string;
  replyingTo?: string;
}): Promise<string | null> {
  const gist = input.gist.trim();
  if (!gist) return null;
  const text = await complete(
    `You turn what someone wants to say into the email they would send. Output only the email body.

- Start with "Hi" and how the recipient is addressed: their first name, or title and surname for a professor, doctor or anyone formal ("Hi Professor Chen,").
- Then their point in one to three short sentences: clear, polite, professional, warm but not gushing. Rephrase it the way a composed professional would write it — never copy their casual words as they are. Thank them only when replying to something they sent, and only for that.
  "no I'm busy" (replying to an invitation) → "Thanks for thinking of me. Unfortunately I'm not available then, so I'll have to pass this time."
  "I'll send it tomorrow" → "I'll have it over to you tomorrow."
  "can't make the study session tonight" → "Unfortunately I won't be able to make the study session tonight."
- Say exactly what they meant and NOTHING more. Never add a reason, date, time, place, apology, offer, suggestion or promise they did not give. "No, I'm busy" is a polite no because they are not available — not an excuse, not "maybe next week".
- Keep any specific fact they gave (times, days, amounts, names) exactly as given.
- No subject line, no sign-off, no name at the end, no placeholders like [Name], no markdown.`,
    [
      {
        role: 'user',
        content: [
          `To: ${input.to}`,
          input.replyingTo ? `Replying to their message: ${input.replyingTo.slice(0, 600)}` : '',
          `What they want to say: ${gist}`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
    false,
    false,
    false,
    400
  );
  const body = (text ?? '')
    .replace(/[*`]+/g, '')
    // The prompt says no sign-off; this makes sure, since the app adds one.
    .replace(/\n+\s*(?:best|thanks|thank you|cheers|regards|kind regards|sincerely|all the best)[,!.]?\s*(?:\n+[^\n]*)?\s*$/i, '')
    .trim();
  return body || null;
}

/**
 * What is worth remembering in a stretch of someone's life.
 *
 * One call over a batch — a dozen turns, or one finished note — rather than one
 * per sentence, which is the whole cost model of the long memory. The model is
 * told what is already known about the people in it, so it adds to Jason
 * instead of inventing a second one, and can say which old facts a new one
 * replaces.
 *
 * Biased hard toward keeping nothing. Most of what anyone says to an assistant
 * is a request — the weather, a song, a timer — and a memory that files those
 * as life events buries the three things that mattered.
 */
export async function lightConsolidate(
  material: string,
  known: string,
  today: string
): Promise<string | null> {
  const text = material.trim();
  if (!text) return null;
  return complete(
    `You keep the long-term memory of one person's assistant. Read what follows and pull out only what is worth remembering about their life months from now.

Keep: people (who they are to the user, what they are doing, what was agreed with them), projects and what state they are in, ideas the user had, decisions, plans, commitments (things someone promised to do, with deadlines), places that matter to them, and meaningful events.
Skip entirely: requests to the assistant (weather, music, directions, timers, "what's on my calendar"), the assistant's own replies unless they state a fact about the user's life, small talk, and anything you would have to guess.

Today is ${today}. Resolve relative dates ("Friday", "yesterday") to ISO dates.

Return JSON with exactly these keys:
- "entities": array of { "name", "kind" (person|project|place|org|idea|topic), "relation" (for a person, who they are to the user, e.g. cofounder, sister, professor; else omit), "summary" (one sentence of who or what this is), "facts" (array of short specific facts learned HERE, each one sentence), "outdated" (array of facts from the KNOWN list that something here replaces, copied exactly) }
- "episodes": array of { "kind" (conversation|meeting|idea|commitment|event|note), "title" (a few words, like a diary heading), "summary" (one or two sentences), "about" (array of entity names it involves), "open" (true only for a commitment not yet done), "at" (ISO date it happened, or omit for today) }

Use the exact names from KNOWN when it is the same person or thing. Never write "the user" as an entity. If nothing is worth keeping, return {"entities":[],"episodes":[]}.`,
    [
      {
        role: 'user',
        content: `KNOWN:\n${known || '(nothing yet)'}\n\nMATERIAL:\n${text.slice(0, 16_000)}`,
      },
    ],
    true,
    false,
    false,
    2000
  );
}

export async function lightNotes(transcript: string): Promise<NoteShape | null> {
  const text = transcript.trim();
  if (!text) return null;

  const raw = await complete(
    `You turn someone's spoken note into a clean written note. They were talking, not writing, so ignore filler, false starts and repetition, but keep every real idea, name, number, date and decision.

Return JSON with exactly these keys:
- "title": 2 to 6 words naming what the note is about, like a file name a person would choose. No quotes, no trailing punctuation.
- "summary": 1 to 3 sentences on what this is about and what was concluded.
- "points": an array of the distinct ideas or facts, each one short sentence, in the order they came up. Up to 12.
- "actions": an array of things someone said they or another person need to do, each starting with a verb, including who and when if stated. Empty array if none.

Never invent anything that was not said.`,
    [{ role: 'user', content: text.slice(0, 24_000) }],
    true,
    false,
    false
  );
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as Partial<NoteShape>;
    const list = (v: unknown) =>
      Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 12) : [];
    const title = String(parsed.title ?? '').trim().slice(0, 60);
    if (!title) return null;
    return {
      title,
      summary: String(parsed.summary ?? '').trim().slice(0, 600),
      points: list(parsed.points),
      actions: list(parsed.actions),
    };
  } catch {
    return null;
  }
}
