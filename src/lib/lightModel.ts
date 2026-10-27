/**
 * Every call Grove makes to a model, and the only file that knows a provider.
 *
 * Two kinds of call live here. `toolTurn` is the ordinary turn: the model is
 * handed Grove's abilities as typed functions and chooses what to run (see
 * brain.ts). Everything else is one job per function — `lightEmail` writes an
 * email from a gist, `lightDocument` a document, `lightConsolidate` reads the
 * long memory's buffer, `lightBrief` answers from a web search — because one
 * prompt doing one thing is followed every time, and the same instruction
 * buried in the turn's prompt was followed one time in two.
 *
 * Where a call goes: Ollama on the LAN if one answers (free), then Gemini with
 * the device's own key, then a backend if one is configured. The order matters:
 * while the backend came first, every turn paid its timeout before falling
 * through.
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  THE KEY IS IN THE BUNDLE. `EXPO_PUBLIC_*` values are compiled into the
 *  JavaScript, so the Gemini key is extractable from any build by anyone who
 *  has one. That is an accepted trade for a personal build on a prepaid key.
 *  It stops being acceptable the day a build goes to anyone else: move the
 *  call behind a server that holds the key. Nothing outside this file knows
 *  which provider answers, so that is a change to this file alone.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { failureKind } from './failure';
import * as SecureStore from 'expo-secure-store';

import { fetchJson } from './net';
import { getNoctusUrl } from './noctusApi';

const OLLAMA_URL = (process.env.EXPO_PUBLIC_OLLAMA_URL ?? '').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.EXPO_PUBLIC_OLLAMA_MODEL || 'llama3.2';

/**
 * How long a local Ollama gets before Grove gives up and says something.
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

export function isLightModelConfigured(): boolean {
  // Kept true because the answer is genuinely "it depends": a key may sit in
  // the Keychain, Ollama may be up, or a backend may hold one. Reporting "no
  // model" from static configuration was wrong on working installs, and it is
  // the kind of wrong that sends someone looking for a bug that is not there.
  return true;
}

/** Whether this phone has a key of its own. Shown in Settings. */
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
 * A key the user typed in, kept on the device only.
 *
 * Entered in Settings and stored in the Keychain, so it lives on one phone
 * rather than in every build. When it is unset, the bundled key is used — see
 * the note at the top of this file.
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
  /**
   * The key works and the account has run out of money. A 402.
   *
   * Its own case because it is the one failure here that looks exactly like
   * every other one and has a completely different fix. Reported as a refusal,
   * it produced "nothing came back, ask me again" on every single turn —
   * indistinguishable from a bad patch or a flaky connection, and no amount of
   * asking again was ever going to help. The whole app goes quiet at once, so
   * the sentence has to name the reason.
   */
  | 'no-credit'
  | 'refused';

let modelTrouble: ModelTrouble = 'none';

export function lastModelTrouble(): ModelTrouble {
  return modelTrouble;
}

/**
 * Whether the last answer actually came from a search, and where from.
 *
 * Gemini says so and we were discarding it. When `google_search` is offered
 * and the model uses it, the reply carries `groundingMetadata` naming the
 * pages it read; when the model answers out of its own head instead, there is
 * no metadata at all. That is a **hard signal for an ungrounded answer**, and
 * it is the difference between a real restaurant and "Fox Burger".
 *
 * Asked for "burgers near me", the model named a place that does not exist,
 * and nothing downstream could tell — the sentence read exactly like a
 * sentence about a real place, which is what makes an invented local business
 * worse than most inventions: you can be sent to it.
 *
 * The URIs are better than the alternative for the same reason. Asking the
 * model to write its links out is asking the thing that invented the
 * restaurant to invent the address too; a grounding URI is a page that was
 * actually fetched.
 *
 * Module-level rather than threaded through every return, matching
 * `modelTrouble` above — `askDirect` returns a string, and widening it would
 * touch every caller for something only the search path asks about.
 */
export type Grounding = { searched: boolean; links: string[] };

let grounding: Grounding = { searched: false, links: [] };

export function lastGrounding(): Grounding {
  return grounding;
}

/** The shape Gemini returns alongside a grounded answer. */
type GroundingMetadata = {
  groundingChunks?: { web?: { uri?: string; title?: string } }[];
  webSearchQueries?: string[];
};

/**
 * What the metadata says about whether a search happened.
 *
 * Its own function so it can be tested against the real response shapes
 * rather than grepped for. The interesting case is the **absent** one: no
 * metadata means the model answered out of its own head, which is the signal
 * everything downstream depends on, and "absent" arrives as undefined, as an
 * empty object and as an empty array depending on the day.
 */
export function groundingFrom(metadata: unknown): Grounding {
  const found = (metadata ?? {}) as GroundingMetadata;
  const chunks = Array.isArray(found.groundingChunks) ? found.groundingChunks : [];
  const queries = Array.isArray(found.webSearchQueries) ? found.webSearchQueries : [];
  const links = [
    ...new Set(
      chunks
        .map((chunk) => (typeof chunk?.web?.uri === 'string' ? chunk.web.uri : ''))
        .filter((uri) => /^https?:\/\//.test(uri))
    ),
  ].slice(0, 3);
  // A query it ran, or a page it read. Either is proof it looked; a URI that
  // is not a web address is proof of nothing and is dropped.
  return { searched: links.length > 0 || queries.length > 0, links };
}

/** Straight to Gemini with this device's key: the main path, no server. */
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
            : response.status === 402
              ? 'no-credit'
              : 'refused';
      return null;
    }
    const data = (await response.json()) as {
      candidates?: {
        content?: { parts?: { text?: string }[] };
        groundingMetadata?: GroundingMetadata;
      }[];
    };
    const text =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() || null;

    // Recorded on every call, so a later non-search answer cannot be read as
    // grounded because an earlier search was.
    grounding = groundingFrom(data.candidates?.[0]?.groundingMetadata);

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
  /*
    Groundedness starts false, every time.

    Only `askDirect` ever sets it, and it is not the only path here — Ollama
    runs locally with no web at all, and the server answers through its own
    key. Left over from the previous call, a local answer would have arrived
    carrying the last Gemini search's "searched: true" and its links, which
    is the exact failure this signal exists to catch, wearing a disguise: an
    unverified sentence with real-looking citations attached.

    Reset here rather than in each branch, so a path added later is honest by
    default and has to claim grounding on purpose.
  */
  grounding = { searched: false, links: [] };

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

export async function lightBrief(
  topic: string,
  place?: string | null
): Promise<{ spoken: string; detail: string; grounded: boolean } | null> {
  /*
    A search needs a where and a when, and had neither.
  
    "When's the next bus" is not a question anybody can answer without both,
    and the model was being handed the five words on their own — so it
    searched, found a timetable for somewhere, and read out a departure. The
    same gap made "what's open", "is it busy" and "how much is a ticket"
    unreliable in the same way: the search was fine, the question was
    incomplete.
  
    Both are free. The clock is local arithmetic and the town is a fact
    already in memory, so this costs nothing per turn and is the single
    largest thing separating a consistent answer from a plausible one.
  */
  const now = new Date();
  const today = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const clock = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const where = (place ?? '').trim();

  const text = await complete(
    // A question, not only a briefing. Written for "what happened in the
    // markets", this prompt answered "where can I get this book, is it free"
    // with a summary of news about the book — the search was right and the
    // answer was to a different question.
    'You answer a question out loud, using web search. Answer exactly what was asked, in one to three sentences, leading with the answer: the specific names, numbers, places, prices, dates, or where to get something and whether it is free. For news or markets, lead with what changed, with numbers. Spoken aloud, so no markdown, no bullet points, no preamble. If search genuinely finds nothing, say so plainly rather than guessing.\n\n' +
      // Asked for, and kept out of the spoken half below. Links used to be
      // forbidden here and then stripped for good measure, which made it
      // impossible for Grove to ever send anyone anything it had found: the
      // thing you actually want after "where can I get that book" is the
      // address, and it had been deleted before the turn ever saw it.
      // The instruction that was missing, and the reason "Fox Burger" was
      // said about a city that has no Fox Burger. A named business is the
      // worst thing to invent in this app, because the person can be sent to
      // it — and an invented one reads exactly like a real one.
      'NEVER name a shop, restaurant, venue, product, person or price that the search did not actually return. If you did not find a specific one, say that plainly — "I could not find a specific one" — and stop. A wrong name is far worse here than no name, because they will go there. The same goes for an address, a phone number or an opening time: found, or not said.\n\n' +
      'After your answer, on its own last line, you may write LINKS: followed by one or two web addresses you actually read, separated by spaces. Leave the line out if you have none. The addresses are never spoken — they are for sending to the person — so do not refer to them in your sentences.\n\n' +
      `It is ${clock} on ${today}, timezone ${zone}. That is the real current date and time — search as of now, and never answer a question about today from what you already knew.` +
      (where
        ? `\nThey are in ${where}. Anything local — transport, departures, opening times, shops, what is nearby, prices in a shop — means there unless they name somewhere else. Search for that place by name; do not answer about a different city with the same question.`
        : '\nYou do not know where they are. If the answer depends on where they are standing, say which place you looked up rather than implying it is theirs.') +
      '\nFor a timetable, a departure or an opening time, say the actual time and name the day. "Soon" is not an answer.',
    [{ role: 'user', content: topic }],
    false,
    false,
    true
  );
  /*
    Two halves, because they are for two different things.

    `spoken` goes in an ear, so it cannot contain a web address — read aloud,
    one arrives as a minute of letters and slashes. `detail` goes to the
    model, which is how Grove can be asked to send you the link afterwards.

    Stripping the addresses out of both was the old behaviour and it quietly
    made "can you send me that" impossible to honour: by the time anything
    could be asked, the address no longer existed anywhere in the app. The
    rule in AGENTS.md was already right — `spoken` is shortened for an ear and
    the full data goes in `detail` — it simply was not being followed here.
  */
  const whole = (text ?? '').replace(/[*`]+/g, '').trim();
  if (!whole) return null;

  /*
    Real pages first, the model's own writing second.

    `lastGrounding()` holds the URIs Gemini says it actually read. Those
    cannot be invented. A `LINKS:` line the model typed can be, by exactly
    the same faculty that invented the restaurant — so it is only used when
    there is no grounding to use instead.
  */
  const found = lastGrounding();
  const written = /^\s*LINKS:\s*(.+)$/im.exec(whole);
  const links =
    found.links.length > 0
      ? found.links
      : (written?.[1] ?? '')
          .split(/\s+/)
          .map((url) => url.replace(/[.,;)\]]+$/, '').trim())
          .filter((url) => /^https?:\/\/\S+$/.test(url))
          .slice(0, 3);

  const said = whole
    .replace(/^\s*LINKS:.*$/im, '')
    // Any address the model wrote into its prose anyway. Told not to, it
    // still does — the same reason plainSpeech exists. Named rather than
    // deleted, because deleting it leaves the sentence around it: "you can
    // get it at for twenty dollars".
    .replace(/\bhttps?:\/\/\S+/g, 'their website')
    .replace(/\b[\w-]+(?:\.[\w-]+)+\/[\w./-]*/g, 'their website')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!said) return null;

  return {
    spoken: said,
    // The links are named as links so the model can pass one to a tool, and
    // only ever reach a person through something that was offered and agreed
    // to.
    detail: links.length > 0 ? `${said}\n\nLinks: ${links.join(' ')}` : said,
    /*
      Said out loud so the turn can be honest about it.

      An answer the model produced without searching is a recollection, and
      the one thing it must not do is arrive looking like a fact that was
      just checked. The turn is told which it has — see TOOL_RULES — and the
      right move on an ungrounded local question is to offer the app that
      knows rather than to name a guess.
    */
    grounded: found.searched,
  };
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

export type ToolCall = { name: string; args: Record<string, unknown> };

export type ToolTurn =
  /**
   * `text` is whatever the model said alongside the calls, which is usually
   * the reply it intends to give once they have run.
   *
   * It was dropped here for a long time, and that single omission is why an
   * action turn sounded like a receipt: the model wrote "Right, half
   * marathon's on the list", the parser kept the function call and threw the
   * sentence away, and the app then paid for a second model call to ask what
   * it had just been told.
   */
  | { kind: 'calls'; calls: ToolCall[]; text: string; raw: unknown }
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
        modelTrouble =
          response.status === 404
            ? 'no-model'
            : response.status === 402
              ? 'no-credit'
              : 'refused';
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
    const text = parts.map((p) => p.text ?? '').join('').trim();
    if (calls.length > 0) {
      modelTrouble = 'none';
      return { kind: 'calls', calls, text, raw: content };
    }

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
  /**
   * How it should read.
   *
   * Professional is the default and the right one: it is what "write this up
   * properly" means, and it is never actively wrong — a friend reading a
   * composed sentence thinks nothing of it, where a professor reading "yeah
   * no worries" notices. Casual is set when Grove actually knows the
   * recipient is a friend, or when the person said so.
   */
  register?: 'professional' | 'casual';
}): Promise<string | null> {
  const gist = input.gist.trim();
  if (!gist) return null;
  const casual = input.register === 'casual';
  const text = await complete(
    `You turn what someone wants to say into the email they would send. Output only the email body.
${
  casual
    ? '- This one goes to someone they know well. Keep it light and natural — how they would actually text them, tidied up into sentences. No formality, no "I hope this finds you well", no stiffness.'
    : '- Keep it professional and clean: composed, courteous, the way a capable adult writes at work. Never stiff or padded.'
}

- Start with "Hi" and how the recipient is addressed: their first name, or title and surname for a professor, doctor or anyone formal ("Hi Professor Chen,").
- Then their point in one to three short sentences, clear and warm but not gushing.${
  casual ? '' : ' Rephrase it the way a composed professional would write it — never copy their casual words as they are.'
}
- Answer what the other person actually asked. A one-word "no" to a request for work is "I won't be able to get that to you by Friday"; a "no" to an invitation is a polite decline; a "yes" to a question is an answer to that question. Read their message and reply to it.
- Never add a refusal, an excuse or a "but" clause they did not say. "Thursday works better" is "Thursday would work better for me, if that suits" — not "I can't do Friday, but Thursday works".
- A question becomes a proper sentence: "what time?" is "Could you let me know what time suits you?"
- When agreeing, you may name what you are agreeing to, but only with facts from their message — never a new date, amount or promise of your own.
- Vary the opening. Only thank them for something they actually did — sending an invitation, sharing notes, giving an extension. Never open with thanks when they were chasing you for something.
- Say exactly what they meant and NOTHING more. Never add a reason, date, time, place, apology, offer, suggestion or promise they did not give. "No, I'm busy" means they are not available — not an excuse, and not "maybe next week".
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
 * Memory, made denser.
 *
 * Facts arrive one sentence at a time — "interested in a job at Meta" on
 * Monday, "interested in a job at Palantir" on Thursday — and a memory that
 * only ever appends ends up with twelve overlapping lines about the same
 * thing. That costs prompt on every lookup and, worse, reads as a list of
 * fragments rather than something known: "interested in jobs at Meta and
 * Palantir" is one fact, and it is the one a friend would have.
 *
 * Runs rarely — every third consolidation, or when a subject has collected
 * enough facts to be worth tidying — so it is a fraction of a call per day.
 * It may merge and drop restatements; it may never invent, and it must keep
 * every specific it was given.
 */
export async function lightCompact(block: string): Promise<string | null> {
  const text = block.trim();
  if (!text) return null;
  return complete(
    `You keep someone's long-term memory tidy. You are given what is known about a few subjects, as lists of separate facts.

Merge them. For each subject return the same knowledge in as few facts as it honestly takes:
- Combine facts about the same thing into one denser fact — "interested in a job at Meta" plus "interested in a job at Palantir" becomes "interested in jobs at Meta and Palantir".
- Keep every specific: names, numbers, dates, places, amounts, who said what.
- Drop exact duplicates, and drop a fact that is only a weaker restatement of another.
- Never invent anything, never generalise away a detail, and never drop something that is still true and specific.
- Rewrite the summary to one sentence that fits the merged facts.

Return JSON: {"subjects": [{"name": "<exactly as given>", "summary": "...", "facts": ["...", "..."]}]}`,
    [{ role: 'user', content: text.slice(0, 12_000) }],
    true,
    false,
    false,
    1500
  );
}

/**
 * Saying what just happened, like a person rather than a receipt.
 *
 * An ability's `spoken` line is written to be correct and short, which is what
 * it has to be — it is the only thing said when a model call fails, and it has
 * to work read into an ear on a street. What it is not is a reply. "Focus mode."
 * and "Added to your goals: run a half marathon." are log entries read aloud,
 * and hearing them back is the moment Grove stops sounding like something you
 * talk to.
 *
 * So once the thing has actually happened, this says it in the person's own
 * assistant's voice, with whatever it now knows — what else is on their list,
 * what a mode just stopped them seeing, what the next one is. One line, bounded
 * hard, and the canned line stands in if it does not come back: this must never
 * be the difference between an answer and silence.
 *
 * Deliberately after the fact rather than before it. The model could say "done"
 * in the same breath as calling the tool, and would then be announcing an
 * outcome it does not have — which is a lie the moment anything fails.
 */
export async function lightAfterAction(
  voice: string,
  said: string,
  happened: string,
  context: string
): Promise<string | null> {
  return complete(
    `${voice}

Something just happened because they asked for it, and it worked. Say so, the way you talk.

- Never read the outcome back as a label. "Goal logged: run a half marathon" is a receipt; "Right, half marathon's on the list" is a reply.
- Do not repeat their own words back to them. They know what they just said.
- Where there is something genuinely useful to add — what else is waiting, what this leaves — add it in the same breath, in a few words. Where there is not, stop after the first sentence.
- Never invent anything that is not in what you are given, and never promise to do something afterwards. Never restate a time, date, amount or name differently from how you were given it — say it exactly, or refer to it loosely ("tomorrow morning") and let the detail stand. If you were told nothing about what else is waiting, say nothing about it — no invented emails, lists, deadlines or people. A quip about the thing that just happened is always available and is never wrong.

- This lands in the middle of someone's day, between them putting their phone down and walking off. Judge the length by that, the way you would judge it out loud. It is a reply to something that just happened, never a lesson about it — if they wanted teaching they will ask.
- Never end on a question you want answered. Nothing is listening after this line, so a question goes unanswered and makes Grove look broken. A rhetorical one is fine; "want to try one now?" is not.
- Do not use their name. It is a greeting, and this is not a greeting.

One paragraph, no line breaks, no markdown, no lists, no emoji. It is going to be spoken aloud.`,
    [
      {
        role: 'user',
        content: `They said: ${said}\n\nWhat happened: ${happened}\n\n${context || '(nothing else worth knowing)'}`,
      },
    ],
    false,
    false,
    false,
    160
  );
}

export async function lightSelf(text: string): Promise<string | null> {
  const said = text.trim();
  if (!said) return null;
  return complete(
    `Someone is describing their own life to their new assistant. Pull out what is true about THEM — not about the other people they mention.

Return JSON with exactly these keys:
- "facts": array of short sentences that are true about them now. Write each in the second person, as the assistant would hold it: "You are studying finance at UAlberta", "You live in Edmonton". Only what they actually said.
- "goals": array of things they are working towards rather than things that are already true, same wording: "You want to land a summer internship in private equity".

Keep both lists short — at most six facts and four goals. Skip anything about another person, anything you would have to guess, and anything that will be untrue in a month. If they said nothing about themselves, return {"facts":[],"goals":[]}.`,
    [{ role: 'user', content: said.slice(0, 6000) }],
    true,
    false,
    false,
    700
  );
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
