/**
 * The Mac, as the phone's hands.
 *
 * Grove on a Mac (the `mac/` folder) listens on the local network, and this is
 * the phone's end of that conversation. The phone stays the brain — memory,
 * accounts, the decision about what to do — and the Mac is a computer it can
 * drive: music in Apple Music, a link or an app opened, and whatever comes
 * after. Nothing the phone remembers is copied over; what crosses is the
 * colour, name and manner, jobs, and the Mac's ⌘K questions, which the phone
 * answers in its own voice (lightSelection) so the laptop sounds like the same
 * Grove rather than a second one.
 *
 * No server. Pairing is a six-digit code shown by the Mac's menu bar icon, and
 * the Mac answers it with a token kept in the Keychain here, so every later
 * connection needs nothing typed. The same Wi-Fi is the one requirement; off
 * it, jobs say plainly that the Mac is not reachable.
 *
 * WebSocket, because React Native carries one and it needs no native code:
 * this works on a binary that predates it, given the address. Finding the Mac
 * without typing its name needs Bonjour, which is native, and comes later.
 */

import * as SecureStore from 'expo-secure-store';

import { lightSelection } from './lightModel';

const KEY = 'grove.mac.pairing';
const PORT = 47321;

type Pairing = { host: string; token: string; mac: string };
export type MacStatus = {
  state: 'unpaired' | 'connecting' | 'connected' | 'away' | 'refused';
  mac?: string;
  host?: string;
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
};

let status: MacStatus = { state: 'unpaired' };
const listeners = new Set<() => void>();
let socket: WebSocket | null = null;
let pairing: Pairing | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let backoff = 3000;
let look: Look | null = null;
const jobs = new Map<string, (result: { ok: boolean; spoken: string }) => void>();

function set(next: MacStatus) {
  status = next;
  listeners.forEach((listener) => listener());
}

export function macStatus(): MacStatus {
  return status;
}

/** For a screen that shows the status; see MacPanel. No React in here, so the harness can load it. */
export function subscribeMac(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** "vishnus-macbook-air" and "vishnus-macbook-air.local" both mean the same Mac. */
function normaliseHost(raw: string): string {
  let host = raw.trim().replace(/^wss?:\/\//i, '').replace(/[/:].*$/, '');
  if (host && !host.includes('.') && !/^\d+$/.test(host)) host += '.local';
  return host;
}

function send(message: Record<string, unknown>): boolean {
  if (!socket || socket.readyState !== 1) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function open(host: string, hello: Record<string, unknown>, onWelcome?: (token: string, mac: string) => void) {
  socket?.close();
  set({ ...status, state: 'connecting', host });
  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws://${host}:${PORT}`);
  } catch {
    set({ state: pairing ? 'away' : 'unpaired', host, note: 'That address did not work.' });
    return;
  }
  socket = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', device: 'iPhone', ...hello }));
  ws.onmessage = (event) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (m.t === 'welcome') {
      backoff = 3000;
      const mac = String(m.mac ?? 'Mac');
      onWelcome?.(String(m.token ?? ''), mac);
      set({ state: 'connected', mac, host });
      if (look) send({ t: 'settings', ...look });
    } else if (m.t === 'refused') {
      set({ state: 'refused', host, note: String(m.why ?? 'The Mac refused the code.') });
    } else if (m.t === 'done') {
      const id = String(m.id ?? '');
      jobs.get(id)?.({ ok: Boolean(m.ok), spoken: String(m.spoken ?? '') });
      jobs.delete(id);
    } else if (m.t === 'think') {
      void answer(String(m.id ?? ''), String(m.instruction ?? ''), String(m.text ?? ''));
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    jobs.forEach((resolve) => resolve({ ok: false, spoken: 'Your Mac stopped answering.' }));
    jobs.clear();
    if (status.state === 'refused') return;
    set({ state: pairing ? 'away' : 'unpaired', mac: status.mac, host });
    if (pairing) {
      // Keep trying, gently: the Mac asleep or off the Wi-Fi is the ordinary case.
      if (retry) clearTimeout(retry);
      retry = setTimeout(() => connect(), backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  };
}

async function answer(id: string, instruction: string, text: string) {
  const reply = await lightSelection(instruction, text, look?.manner ?? '').catch(() => null);
  send({ t: 'thought', id, kind: reply?.kind ?? 'answer', text: reply?.text ?? '' });
}

function connect() {
  if (!pairing) return;
  open(pairing.host, { token: pairing.token });
}

/** Reads the saved pairing and connects. Safe to call more than once. */
export async function startMac(): Promise<void> {
  if (pairing) {
    if (!socket) connect();
    return;
  }
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    pairing = raw ? (JSON.parse(raw) as Pairing) : null;
  } catch {
    pairing = null;
  }
  if (pairing) connect();
}

/** The first time: the Mac's name and the code it is showing. */
export function pairMac(rawHost: string, code: string): void {
  const host = normaliseHost(rawHost);
  if (!host || !/^\d{6}$/.test(code.trim())) {
    set({ state: 'unpaired', note: 'Enter the Mac’s name and the six-digit code it shows.' });
    return;
  }
  open(host, { code: code.trim() }, (token, mac) => {
    pairing = { host, token, mac };
    void SecureStore.setItemAsync(KEY, JSON.stringify(pairing)).catch(() => {});
  });
}

export async function forgetMac(): Promise<void> {
  pairing = null;
  if (retry) clearTimeout(retry);
  socket?.close();
  socket = null;
  await SecureStore.deleteItemAsync(KEY).catch(() => {});
  set({ state: 'unpaired' });
}

/** The phone's colour, name and manner, sent now and whenever they change. */
export function sendLook(next: Look): void {
  look = next;
  send({ t: 'settings', ...next });
}

/**
 * Something for the Mac to do. Resolves with what to say, including when the
 * Mac is not there — the caller always gets a sentence, never a hang.
 */
export function macJob(kind: string, args: Record<string, string>, timeoutMs = 20_000): Promise<{ ok: boolean; spoken: string }> {
  if (status.state !== 'connected') {
    return Promise.resolve({
      ok: false,
      spoken: pairing ? 'Your Mac isn’t reachable right now. It needs to be awake and on the same Wi-Fi.' : 'No Mac is paired yet. Settings, Your Mac.',
    });
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve) => {
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
