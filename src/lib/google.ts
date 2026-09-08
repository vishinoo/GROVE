/**
 * Google's APIs, called straight from the phone.
 *
 * Every one of these was a hop through Noctus, which existed to hold a client
 * secret. An installed-app OAuth client has no secret (see googleAuth.ts), so
 * the hop bought nothing and cost a deployment that had to stay alive for the
 * calendar to be readable.
 *
 * These are plain HTTPS requests with a bearer token. The phone has the token,
 * so the phone makes the call.
 *
 * NOT CONNECTED IS NOT AN ERROR. Every function returns null when Google has
 * not been connected, so the ability above can say the one useful sentence —
 * connect Google — rather than reporting a failure the person cannot act on.
 */

import { googleToken } from './googleAuth';

/* ------------------------------------------------------------ base64url */

/**
 * Node's Buffer does not exist here, and Gmail speaks base64url throughout.
 *
 * Written out rather than pulled from a package because it is twenty lines and
 * a dependency that ships a polyfill for a global the runtime already has is a
 * dependency that will one day conflict with it.
 */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis
    .btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(data: string): string {
  try {
    const padded = data.replace(/-/g, '+').replace(/_/g, '/');
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    // A body that will not decode is worth skipping, not worth failing a whole
    // mail search over.
    return '';
  }
}

/* ------------------------------------------------------------- the call */

/**
 * Why the last call failed.
 *
 * Null used to mean all of these at once — not connected, token expired, API
 * not switched on in the console, rate limited, timed out, no signal — and
 * every caller reported the first one. So a Gmail request that timed out told
 * someone their mail was not hooked up, while they were looking at it working
 * a minute earlier. Being told a confident, wrong reason is worse than being
 * told it broke, because it sends you to fix something that was never wrong.
 */
export type Reason =
  | 'none'
  | 'not-connected'
  | 'auth-expired'
  | 'api-disabled'
  | 'missing-scope'
  | 'rate-limited'
  | 'timeout'
  | 'offline'
  | 'server';

let lastReason: Reason = 'none';

/** The failure, as a sentence to say out loud. */
export function explain(what = 'that'): string {
  switch (lastReason) {
    case 'none':
      // Nothing failed at the network level, so the call simply came back with
      // nothing useful. Saying "not connected" here is the false alarm.
      return `Google gave me nothing back on ${what}.`;
    case 'auth-expired':
      return 'My Google sign-in has expired. Reconnect Google in Connections.';
    case 'api-disabled':
      return `Google is refusing ${what} — that API is not switched on for this project yet.`;
    case 'missing-scope':
      return `I am signed in to Google but was never given permission for ${what}. Disconnect and reconnect Google in Connections, and allow everything on the consent screen.`;
    case 'rate-limited':
      return 'Google is rate-limiting me. Give it a few seconds.';
    case 'timeout':
      return `Google took too long over ${what}. Try me again.`;
    case 'offline':
      return 'I cannot reach Google right now — no signal.';
    case 'server':
      return 'Google had an error on that one.';
    default:
      return 'Google is not connected. You can do that in Connections.';
  }
}

async function call<T>(
  url: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<T | null> {
  const token = await googleToken();
  if (!token) {
    lastReason = 'not-connected';
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      // 403 means two quite different things and they have opposite fixes: the
      // API is switched off in the console, or the token was granted without
      // the scope this call needs. Reading mail worked while sending returned
      // 403, which can only be the second — and being told to go and enable an
      // API that is demonstrably already on wastes real time. Google says which
      // in the body, so ask it rather than guess.
      if (response.status === 403) {
        const body = await response.text().catch(() => '');
        lastReason = /insufficient|scope|ACCESS_TOKEN_SCOPE/i.test(body)
          ? 'missing-scope'
          : 'api-disabled';
        return null;
      }
      lastReason =
        response.status === 401
          ? 'auth-expired'
          : response.status === 429
            ? 'rate-limited'
            : 'server';
      return null;
    }
    // Cleared on success, or it lies about the next failure.
    //
    // This is module state, and nothing reset it: one genuine "not connected"
    // early on made every later failure — a timeout, an empty result, a
    // mistyped search — report that Grove could not reach the inbox, long after
    // it plainly could. A stale reason is worse than no reason, because it is
    // specific and confident and sends you to fix something that is not broken.
    lastReason = 'none';
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch (problem) {
    lastReason = problem instanceof Error && problem.name === 'AbortError' ? 'timeout' : 'offline';
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- mail */

export type MailMessage = {
  id: string;
  /**
   * Gmail's thread. Sending a reply without it starts a new conversation that
   * merely quotes the old one, which is how a reply ends up somewhere nobody is
   * looking.
   */
  threadId: string;
  /** The RFC822 Message-Id, which is what In-Reply-To has to point at. */
  messageId: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  body: string;
};

type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
  headers?: { name: string; value: string }[];
};

function header(payload: GmailPart | undefined, name: string): string {
  const found = (payload?.headers ?? []).find(
    (h) => h.name.toLowerCase() === name.toLowerCase()
  );
  return found?.value ?? '';
}

/** The readable part of a multipart message, plain text preferred. */
function bodyOf(part: GmailPart | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return fromBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const found = bodyOf(child);
    if (found) return found;
  }
  if (part.mimeType === 'text/html' && part.body?.data) {
    // Style and script blocks have to go BEFORE the tags do. Stripping tags
    // first leaves the CSS behind as ordinary text, which is how an AliExpress
    // receipt came out as "outlook a { padding:0; } body { margin:0;padding:0;
    // -webkit-text-size-adjust:100%" — read aloud, in full.
    return fromBase64Url(part.body.data)
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      // Anything still shaped like a rule is left-over CSS, not prose.
      .replace(/[.#@a-z-]*\s*\{[^{}]*\}/gi, ' ')
      .replace(/&[a-z]+;|&#\d+;/gi, ' ')
      .replace(/\s{2,}/g, ' ');
  }
  return '';
}

export async function searchMail(
  opts: {
    from?: string;
    about?: string;
    limit?: number;
    since?: string;
    category?: string;
  } = {}
): Promise<MailMessage[] | null> {
  const terms: string[] = [];
  // "this morning", "today", "this week" — Gmail understands a relative window
  // natively, so the spoken phrase maps to a query term rather than to
  // client-side filtering of a page we might not have fetched.
  if (opts.since) {
    const said = opts.since.toLowerCase();
    if (/week/.test(said)) terms.push('newer_than:7d');
    else if (/yesterday/.test(said)) terms.push('newer_than:2d');
    else if (/month/.test(said)) terms.push('newer_than:30d');
    else if (/(today|morning|afternoon|tonight|evening)/.test(said)) terms.push('newer_than:1d');
  }
  // Filtered before going into a query string, exactly as the server did: these
  // arrive from speech, and Gmail's query language has operators in it.
  if (opts.from) {
    // Quoted, because Gmail splits on spaces: from:Ali Express is read as
    // from:Ali AND the word Express, which matches almost nothing. Any sender
    // with two words in their name searched for the wrong thing entirely.
    const who = opts.from.replace(/[^\w@.\- ]/g, '').trim();
    if (who) terms.push(who.includes(' ') ? `from:"${who}"` : `from:${who}`);
  }
  if (opts.about) terms.push(opts.about.replace(/[^\w@.\-' ]/g, ''));
  // Categories, because "any unread" and "anything important" are how people
  // narrow an inbox out loud, and Gmail already understands both. Without this
  // every question got the same answer — the newest message and a count.
  if (opts.category) {
    const c = opts.category.toLowerCase();
    if (/unread|new|unopened/.test(c)) terms.push('is:unread');
    else if (/important|urgent|priority/.test(c)) terms.push('is:important');
    else if (/starred|flagged/.test(c)) terms.push('is:starred');
    else if (/attach/.test(c)) terms.push('has:attachment');
    // The inbox proper, not promotions and social — which is what someone
    // means by "real" or "actual" mail.
    else if (/real|actual|personal|primary/.test(c)) terms.push('category:primary');
  }
  // Unread-first is the wrong default: "anything from Priya" means anything.
  const query = terms.join(' ') || 'newer_than:2d';
  const count = Math.min(Math.max(opts.limit ?? 3, 1), 10);

  const list = await call<{ messages?: { id: string; threadId?: string }[] }>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${count}`
  );
  if (list === null) return null;

  const ids = (list.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return [];

  const full = await Promise.all(
    ids.map((id) =>
      call<{ payload?: GmailPart; snippet?: string; threadId?: string }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`
      ).then((message) =>
        message
          ? {
              id,
              threadId: message.threadId ?? '',
              messageId: header(message.payload, 'Message-Id'),
              from: header(message.payload, 'From'),
              subject: header(message.payload, 'Subject'),
              date: header(message.payload, 'Date'),
              snippet: message.snippet ?? '',
              body: bodyOf(message.payload).slice(0, 1500),
            }
          : null
      )
    )
  );
  return full.filter((m): m is MailMessage => m !== null);
}

export async function sendMail(to: string, subject: string, body: string): Promise<boolean> {
  const raw = toBase64Url(
    [
      `To: ${to}`,
      `Subject: ${subject || '(no subject)'}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      body,
    ].join('\r\n')
  );
  const sent = await call<{ id?: string }>(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    { method: 'POST', body: { raw } }
  );
  return sent !== null;
}

/**
 * Replies to a message, in its own thread.
 *
 * Three things have to line up or Gmail files it as a new conversation: the
 * threadId on the request, In-Reply-To pointing at the original Message-Id, and
 * a subject that keeps the original with one "Re:". Getting any of them wrong
 * produces a reply the recipient sees as an unrelated mail — which is worse
 * than failing, because it looks like it worked.
 */
export async function replyTo(message: MailMessage, body: string): Promise<boolean> {
  const to = message.from;
  if (!to) return false;

  const subject = /^re:/i.test(message.subject)
    ? message.subject
    : `Re: ${message.subject || '(no subject)'}`;

  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (message.messageId) {
    headers.push(`In-Reply-To: ${message.messageId}`, `References: ${message.messageId}`);
  }

  const sent = await call<{ id?: string }>(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      body: {
        raw: toBase64Url([...headers, '', body].join('\r\n')),
        ...(message.threadId ? { threadId: message.threadId } : {}),
      },
    }
  );
  return sent !== null;
}

/**
 * The address Grove is signed in as.
 *
 * "Send it to me" is the one recipient that needs no contact lookup and cannot
 * be got wrong, so it is worth resolving properly rather than asking someone
 * for their own email address.
 */
let ownAddress: string | null | undefined;
export async function me(): Promise<string | null> {
  if (ownAddress !== undefined) return ownAddress;
  const profile = await call<{ emailAddress?: string }>(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile'
  );
  ownAddress = profile?.emailAddress ?? null;
  return ownAddress;
}

/* ------------------------------------------------------------ contacts */

export type Contact = { name: string; email: string };

/**
 * A name to an address.
 *
 * Returns every match rather than picking one: two people called Priya is a
 * question for the user, not something to resolve by guessing.
 */
export async function findContact(name: string): Promise<Contact[] | null> {
  const clean = name.replace(/[^\w@.\- ]/g, '').trim();
  if (!clean) return [];
  const found = await call<{
    results?: { person?: { names?: { displayName?: string }[]; emailAddresses?: { value?: string }[] } }[];
  }>(
    `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(clean)}&readMask=names,emailAddresses`
  );
  if (found === null) return null;
  return (found.results ?? [])
    .map((r) => ({
      name: r.person?.names?.[0]?.displayName ?? clean,
      email: r.person?.emailAddresses?.[0]?.value ?? '',
    }))
    .filter((c) => c.email);
}

/* ------------------------------------------------------------ calendar */

export type CalendarEvent = {
  id: string;
  title: string;
  start: string;
  allDay: boolean;
  location: string;
};

type RawEvent = {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  attendees?: { self?: boolean; responseStatus?: string }[];
  start?: { dateTime?: string; date?: string };
};

export async function readCalendar(days = 1): Promise<CalendarEvent[] | null> {
  // Clamped: a fortnight is the longest horizon any Grove question has, and an
  // unbounded window is a slow call that gets spoken into someone's ear.
  const window = Math.min(Math.max(days, 1), 14);
  const from = new Date();
  const to = new Date(from.getTime() + window * 86_400_000);

  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '20',
  });
  const data = await call<{ items?: RawEvent[] }>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`
  );
  if (data === null) return null;

  return (data.items ?? [])
    // A declined invitation is not on your calendar in any sense a person
    // means, and reading them out is how a free day sounds busy.
    .filter((e) => e.status !== 'cancelled')
    .filter((e) => !(e.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined'))
    .map((e) => ({
      id: e.id ?? '',
      title: e.summary || 'Untitled',
      start: e.start?.dateTime || e.start?.date || '',
      allDay: Boolean(e.start?.date && !e.start?.dateTime),
      location: e.location ?? '',
    }))
    .filter((e) => e.start);
}

/**
 * Creating, moving and deleting on the Google calendar.
 *
 * Reads consulted Google and writes went to EventKit, which is worse than
 * either alone: Grove read your real calendar and wrote to a different one. It
 * would say "added, today at 15:45" and nothing would ever appear in Google
 * Calendar, and "move my two o'clock" would fail to find an event it had read
 * out a moment earlier.
 *
 * Times are sent as full ISO strings with an offset. Google reads a bare local
 * time against the calendar's own timezone, which silently lands an event an
 * hour or a day out when the two disagree — the classic calendar bug, and the
 * kind nobody notices until they miss something.
 */
export async function createCalendarEvent(
  title: string,
  start: Date,
  minutes = 60
): Promise<boolean> {
  const end = new Date(start.getTime() + Math.max(minutes, 5) * 60_000);
  const made = await call<{ id?: string }>(
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    {
      method: 'POST',
      body: {
        summary: title.slice(0, 200),
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
      },
    }
  );
  return made !== null;
}

export async function moveCalendarEvent(
  id: string,
  start: Date,
  minutes = 60
): Promise<boolean> {
  const end = new Date(start.getTime() + Math.max(minutes, 5) * 60_000);
  const moved = await call<{ id?: string }>(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: { start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } },
    }
  );
  return moved !== null;
}

/**
 * Deleting returns an empty body on success, which `call` reports as null —
 * the same value it uses for failure. So this one checks the response itself
 * rather than going through call(), or every successful delete would be
 * reported as a failure.
 */
export async function deleteCalendarEvent(id: string): Promise<boolean> {
  const token = await googleToken();
  if (!token) {
    lastReason = 'not-connected';
    return false;
  }
  try {
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
    );
    // 410 is "already gone", which is the outcome that was asked for.
    if (response.ok || response.status === 410) return true;
    lastReason = response.status === 401 ? 'auth-expired' : 'server';
    return false;
  } catch {
    lastReason = 'offline';
    return false;
  }
}

/* ---------------------------------------------------------------- docs */

export type DocResult = {
  files: { id: string; name: string }[];
  match?: { id: string; name: string };
  text: string;
};

/**
 * Finds a document by describing it, then reads it.
 *
 * Two calls because they are two questions: Drive knows which file you mean,
 * Docs knows what it says.
 */
export async function findDoc(query: string): Promise<DocResult | null> {
  const wanted = query.replace(/[^\w.\-' ]/g, '').trim();
  if (!wanted) return { files: [], text: '' };

  const search = new URLSearchParams({
    q: `name contains '${wanted.replace(/'/g, '')}' and trashed = false`,
    fields: 'files(id,name,mimeType,modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: '5',
  });
  const found = await call<{ files?: { id: string; name: string; mimeType: string }[] }>(
    `https://www.googleapis.com/drive/v3/files?${search.toString()}`
  );
  if (found === null) return null;

  const files = found.files ?? [];
  if (files.length === 0) return { files: [], text: '' };

  const doc = files.find((f) => f.mimeType === 'application/vnd.google-apps.document') ?? files[0];

  let text = '';
  if (doc.mimeType === 'application/vnd.google-apps.document') {
    const body = await call<{
      body?: { content?: { paragraph?: { elements?: { textRun?: { content?: string } }[] } }[] };
    }>(`https://docs.googleapis.com/v1/documents/${doc.id}`, { timeoutMs: 20_000 });
    text = (body?.body?.content ?? [])
      .flatMap((el) => el.paragraph?.elements ?? [])
      .map((el) => el.textRun?.content ?? '')
      .join('')
      .replace(/\n{2,}/g, '\n')
      .trim()
      .slice(0, 4000);
  }

  return {
    files: files.map((f) => ({ id: f.id, name: f.name })),
    match: { id: doc.id, name: doc.name },
    text,
  };
}
