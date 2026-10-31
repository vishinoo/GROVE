/**
 * The Mac, as the phone's hands.
 *
 * Grove on a Mac (the `mac/` folder) and this phone find each other through
 * the person's Noctus account: both sign in with Google through Noctus's
 * Supabase project and join one Realtime broadcast channel named by a secret
 * kept in that account's metadata (`grove_link`), which only that account's
 * sign-in can read. Whichever device signs in first makes the secret. No
 * pairing code, no server of ours, and no need to share a Wi-Fi network. Why
 * not a private channel, and the protocol, are at the top of
 * mac/Sources/Grove/Link.swift.
 *
 * The phone stays the brain — memory, accounts, the decision about what to
 * do — and the Mac is a computer it can drive. Nothing the phone remembers is
 * copied over; what crosses is the colour, name and manner, jobs, and the
 * Mac's ⌘K questions, which the phone answers in its own voice
 * (lightSelection) so the laptop sounds like the same Grove.
 *
 * Signing in here is only for the link. It does not switch Grove's own
 * account on this phone: that would key the memory to a different account
 * and make Grove depend on the Noctus server being up, neither of which the
 * link needs.
 *
 * Or without signing in here at all: the Mac, already signed in, shows a
 * six-digit code (Connect iPhone…), and typing it hands this phone the
 * account's channel secret (pairWithCode), which is kept in the Keychain.
 * Google sign-in on the phone depends on Supabase sending the browser back to
 * the app, and when it does not there is nothing on the phone to say why.
 *
 * No React in this file, so the harness can load it; screens subscribe with
 * subscribeMac.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';

import { lightSelection } from './lightModel';
import * as auth from './noctusAuth';

const SECRET_KEY = 'grove.mac.secret';

export type MacStatus = {
  state: 'signed-out' | 'waiting' | 'connected' | 'refused';
  /** The Mac's name, once it has said hello. */
  mac?: string;
  email?: string;
  note?: string;
};
export type Look = {
  colour: string;
  label: string;
  stops: readonly string[];
  speed: number;
  warp: number;
  name: string;
  manner: string;
  /** What Grove remembers about them, so the Mac picks a film they would watch, not any film. */
  about?: string;
};

let status: MacStatus = { state: 'signed-out' };
const listeners = new Set<() => void>();
let channel: RealtimeChannel | null = null;
let look: Look | null = null;
let lastHeard = 0;
let hello: ReturnType<typeof setInterval> | null = null;
export type MacResult = { ok: boolean; spoken: string; state?: string; task?: string; detail?: string };
const jobs = new Map<string, (result: MacResult) => void>();

function set(next: MacStatus) {
  status = next;
  listeners.forEach((listener) => listener());
}

export function macStatus(): MacStatus {
  return status;
}

export function subscribeMac(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function send(message: Record<string, unknown>): boolean {
  if (!channel) return false;
  void channel.send({ type: 'broadcast', event: 'msg', payload: { from: 'phone', ...message } });
  return true;
}

function heard(m: Record<string, unknown>) {
  if (m.from !== 'mac') return;
  lastHeard = Date.now();
  if (m.t === 'welcome') {
    const first = status.state !== 'connected';
    set({ ...status, state: 'connected', mac: String(m.mac ?? 'Mac'), note: undefined });
    if (first && look) {
      send({ t: 'settings', ...look });
      sentAbout = look.about;
      const { about: _about, ...rest } = look;
      sentLook = rest;
    }
  } else if (m.t === 'done') {
    const id = String(m.id ?? '');
    jobs.get(id)?.({
      ok: Boolean(m.ok),
      spoken: String(m.spoken ?? ''),
      state: m.state ? String(m.state) : undefined,
      task: m.task ? String(m.task) : undefined,
      detail: m.detail ? String(m.detail) : undefined,
    });
    jobs.delete(id);
  } else if (m.t === 'news') {
    const news: MacNews = {
      what: String(m.what ?? ''),
      state: String(m.state ?? 'done'),
      said: String(m.said ?? ''),
      task: m.task ? String(m.task) : undefined,
      speak: m.speak === true,
    };
    noteMacWork({ what: news.what, state: news.state, said: news.said, task: news.task });
    newsListeners.forEach((listener) => listener(news));
  } else if (m.t === 'think') {
    void answer(String(m.id ?? ''), String(m.instruction ?? ''), String(m.text ?? ''));
  }
}

async function answer(id: string, instruction: string, text: string) {
  const reply = await lightSelection(instruction, text, look?.manner ?? '').catch(() => null);
  send({ t: 'thought', id, kind: reply?.kind ?? 'answer', text: reply?.text ?? '' });
}

/** Joins the account's channel if there is a Noctus session. Safe to call more than once. */
export async function startMac(): Promise<void> {
  if (channel || !auth.isSupabaseConfigured()) return;
  const client = auth.supabase();
  const kept = await SecureStore.getItemAsync(SECRET_KEY).catch(() => null);
  const session = kept ? null : await auth.getSession().catch(() => null);
  if (!kept && !session) {
    set({ state: 'signed-out' });
    return;
  }
  // Asked of the server, not read off the stored session: a session from
  // before the Mac made the secret does not have it, and making a second one
  // put the phone on a different channel from the Mac for good.
  let secret = kept ?? '';
  if (!kept && session) {
    const { data } = await client.auth.getUser().catch(() => ({ data: { user: null } }));
    secret = String(data.user?.user_metadata?.grove_link ?? session.user.user_metadata?.grove_link ?? '');
  }
  if (!kept && session && secret.length < 32) {
    // First device on this account: make the secret and keep it in the account.
    const bytes = Array.from({ length: 48 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]);
    secret = bytes.join('');
    const { error } = await client.auth.updateUser({ data: { grove_link: secret } });
    if (error) {
      set({ state: 'refused', note: `Could not set up the link on your Noctus account: ${error.message}` });
      return;
    }
  }
  set({ state: 'waiting', email: session?.user.email ?? undefined });

  const joined = client.channel(`grove-link-${secret}`, {
    config: { broadcast: { self: false, ack: false } },
  });
  channel = joined;
  joined.on('broadcast', { event: 'msg' }, ({ payload }) => heard(payload as Record<string, unknown>));
  joined.subscribe((state, error) => {
    if (state === 'SUBSCRIBED') {
      send({ t: 'hello' });
    } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
      set({
        ...status,
        state: 'refused',
        note: error?.message ? `Could not reach Noctus: ${error.message}` : 'Could not reach Noctus.',
      });
    }
  });

  // Hello once a minute; the Mac answers. Not heard for two and a half
  // minutes means it is asleep, closed or offline. A minute, not thirty
  // seconds, to stay well inside Realtime's free two million messages a
  // month: a hello and its answer, all day, is about 90,000.
  if (hello) clearInterval(hello);
  hello = setInterval(() => {
    send({ t: 'hello' });
    if (status.state === 'connected' && Date.now() - lastHeard > 150_000) set({ ...status, state: 'waiting' });
  }, 60_000);
}

/** The code the Mac is showing: the Mac hands over the account's channel. */
export async function pairWithCode(code: string): Promise<void> {
  const clean = code.replace(/\D/g, '');
  if (clean.length !== 6 || !auth.isSupabaseConfigured()) {
    set({ state: 'signed-out', note: 'Type the six digits your Mac is showing.' });
    return;
  }
  const client = auth.supabase();
  const meet = client.channel(`grove-pair-${clean}`, { config: { broadcast: { self: false, ack: false } } });
  set({ state: 'signed-out', note: 'Connecting…' });
  const secret = await new Promise<{ secret: string; mac: string } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    meet.on('broadcast', { event: 'msg' }, ({ payload }) => {
      const m = payload as Record<string, unknown>;
      if (m.from === 'mac' && m.t === 'secret' && typeof m.secret === 'string') {
        clearTimeout(timer);
        resolve({ secret: m.secret, mac: String(m.mac ?? 'Mac') });
      }
    });
    meet.subscribe((state) => {
      if (state === 'SUBSCRIBED') void meet.send({ type: 'broadcast', event: 'msg', payload: { from: 'phone', t: 'pair' } });
    });
  });
  await client.removeChannel(meet).catch(() => {});
  if (!secret) {
    set({ state: 'signed-out', note: 'Your Mac didn’t answer. Check the code, and that Grove on the Mac is showing it.' });
    return;
  }
  await SecureStore.setItemAsync(SECRET_KEY, secret.secret).catch(() => {});
  await startMac();
}

/** Google, through Noctus. For the link only; see the note at the top. */
export async function signInForMac(): Promise<void> {
  try {
    const session = await auth.signInWithNoctus();
    if (session) await startMac();
  } catch (error) {
    set({ state: 'signed-out', note: error instanceof Error ? error.message : 'Sign-in did not finish.' });
  }
}

export async function stopMac(): Promise<void> {
  if (hello) clearInterval(hello);
  hello = null;
  if (channel) await auth.supabase().removeChannel(channel).catch(() => {});
  channel = null;
  await SecureStore.deleteItemAsync(SECRET_KEY).catch(() => {});
  set({ state: 'signed-out' });
}

/** The phone's colour, name and manner, sent now and whenever they change. */
export function sendLook(next: Look): void {
  look = next;
  if (status.state !== 'connected') return;
  // The Mac keeps its own encrypted copy of what Grove remembers, so it is
  // only sent when it has changed; a refresh that changed nothing sends none.
  const fresh = next.about !== undefined && next.about !== sentAbout;
  if (!fresh && sameLook(next)) return;
  const { about, ...rest } = next;
  send({ t: 'settings', ...rest, ...(fresh ? { about } : {}) });
  if (fresh) sentAbout = about;
  sentLook = rest;
}
let sentAbout: string | undefined;
let sentLook: Omit<Look, 'about'> | null = null;
function sameLook(next: Look): boolean {
  const { about: _about, ...rest } = next;
  return JSON.stringify(rest) === JSON.stringify(sentLook);
}

/**
 * Whether the Mac can take a job now, asking it once if it has gone quiet.
 *
 * The hello is once a minute, so a Mac opened thirty seconds ago still reads
 * as asleep — and "your Mac isn't answering" said to someone looking at their
 * open laptop is the answer that teaches them to stop asking. One hello and a
 * few seconds' wait costs two Realtime messages and only ever runs when the
 * answer would otherwise have been no.
 */
export async function macReachable(waitMs = 3_000): Promise<boolean> {
  if (status.state === 'connected') return true;
  if (!channel || status.state !== 'waiting') return false;
  send({ t: 'hello' });
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (macStatus().state === 'connected') return true;
  }
  return false;
}

/**
 * What the Mac was last asked to do, and how it went.
 *
 * Without it every sentence was read as if the conversation had just started,
 * so "order the large one instead" or "finish the rest" went to the phone's
 * tools — the person had to say "on my Mac" every time to be understood. Held
 * here and printed into the turn's context, so the model can see the work in
 * progress the way someone sitting beside them would.
 */
export type MacWork = { what: string; state: string; said: string; task?: string; at: number };
let work: MacWork | null = null;

/**
 * What the Mac did, as it happens — including what was asked of it at the
 * Mac itself. The phone is the one talking to the glasses, and it used to
 * know only about jobs it had sent; something started at the keyboard, or a
 * job of its own that outlived its wait, was invisible to it, so "how did
 * that go" or "make it the large one" had nothing to go on.
 */
export type MacNews = { what: string; state: string; said: string; task?: string; speak: boolean };
const newsListeners = new Set<(news: MacNews) => void>();

export function onMacNews(listener: (news: MacNews) => void): () => void {
  newsListeners.add(listener);
  return () => {
    newsListeners.delete(listener);
  };
}

export function noteMacWork(next: Omit<MacWork, 'at'>): void {
  work = { ...next, at: Date.now() };
}

export function macWork(): MacWork | null {
  return work;
}

const WORK_STATE: Record<string, string> = {
  ask: 'It asked them something and is waiting on the answer',
  confirm: 'It is waiting on their yes',
  done: 'It finished',
  failed: 'It did not finish',
  answered: 'Grove answered them there',
  stopped: 'It was stopped',
  working: 'It is still going on the Mac, unattended (a game, or a long job); "stop" stops it',
};

/**
 * The Mac, in a few lines, for the volatile half of the prompt.
 *
 * Facts rather than instructions: whether it can be reached and what it was
 * just doing. The rules about what to do with that live in the system prompt,
 * where they are cached; this changes, so it rides with the question.
 */
export function macContext(now = Date.now()): string {
  const ago = (at: number) => Math.max(1, Math.round((now - at) / 60_000));
  const reach =
    status.state === 'connected'
      ? `Their Mac${status.mac ? ` (${status.mac})` : ''}: connected.`
      : status.state === 'waiting'
        ? `Their Mac: not answering${lastHeard ? ` for ${ago(lastHeard)} min` : ''} — asleep, lid shut, offline or Grove not open on it.`
        : status.state === 'refused'
          ? `Their Mac: the link is not working${status.note ? ` (${status.note})` : ''}.`
          : 'Their Mac: not linked to Grove yet (Settings, Your Mac).';
  const recent = work && now - work.at < 30 * 60_000 ? work : null;
  // Said with the fact rather than left to a rule, because a model told a
  // Mac is asleep still reached for it when the job was obviously a Mac job.
  const blocked = status.state === 'connected' ? '' : ' Nothing can be done on it until that changes.';
  if (!recent) return reach + blocked;
  const said = recent.said.replace(/\s+/g, ' ').trim().slice(0, 220);
  return [
    reach + blocked,
    `On the Mac ${ago(recent.at)} min ago: ${recent.what}. ${WORK_STATE[recent.state] ?? 'It stopped'}${said ? `: "${said}"` : ''}${recent.task ? ` (task ${recent.task})` : ''}.`,
  ].join('\n');
}

/**
 * Something for the Mac to do. Resolves with what to say, including when the
 * Mac is not there — the caller always gets a sentence, never a hang.
 */
export async function macJob(kind: string, args: Record<string, string>, timeoutMs = 20_000): Promise<MacResult> {
  if (!(await macReachable())) {
    return {
      ok: false,
      spoken:
        status.state === 'signed-out'
          ? 'Your Mac isn’t connected yet. Sign in with Noctus in Settings, Your Mac, and on the Mac.'
          : 'Your Mac isn’t answering. It needs to be awake with Grove open and signed in.',
    };
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return new Promise<MacResult>((resolve) => {
    const timer = setTimeout(() => {
      jobs.delete(id);
      resolve({ ok: false, spoken: 'Your Mac didn’t answer in time.' });
    }, timeoutMs);
    jobs.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    if (!send({ t: 'job', id, kind, args })) {
      clearTimeout(timer);
      jobs.delete(id);
      resolve({ ok: false, spoken: 'Your Mac isn’t reachable right now.' });
    }
  });
}
