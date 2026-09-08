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

async function call<T>(
  url: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {}
): Promise<T | null> {
  const token = await googleToken();
  if (!token) return null;

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
    if (!response.ok) return null;
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- mail */

export type MailMessage = {
  id: string;
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
    return fromBase64Url(part.body.data)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ');
  }
  return '';
}

export async function searchMail(
  opts: { from?: string; about?: string; limit?: number } = {}
): Promise<MailMessage[] | null> {
  const terms: string[] = [];
  // Filtered before going into a query string, exactly as the server did: these
  // arrive from speech, and Gmail's query language has operators in it.
  if (opts.from) terms.push(`from:${opts.from.replace(/[^\w@.\- ]/g, '')}`);
  if (opts.about) terms.push(opts.about.replace(/[^\w@.\-' ]/g, ''));
  // Unread-first is the wrong default: "anything from Priya" means anything.
  const query = terms.join(' ') || 'newer_than:2d';
  const count = Math.min(Math.max(opts.limit ?? 3, 1), 10);

  const list = await call<{ messages?: { id: string }[] }>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${count}`
  );
  if (list === null) return null;

  const ids = (list.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return [];

  const full = await Promise.all(
    ids.map((id) =>
      call<{ payload?: GmailPart; snippet?: string }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`
      ).then((message) =>
        message
          ? {
              id,
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
