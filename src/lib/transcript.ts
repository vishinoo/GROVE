/**
 * What Grove did, kept on the phone.
 *
 * A voice assistant with no record is unusable in a specific way: everything
 * it does happens while you are looking at something else, so the only
 * evidence any of it happened is a sentence you half-heard on a walk. This is
 * the receipt — what you said, what Grove said back, and which tool ran.
 *
 * It stays local. Noctus already logs its own runs against the account and
 * that is where the authoritative record lives; duplicating transcripts of
 * spoken conversation onto a server is a privacy cost with no product benefit.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { TurnTool } from './grove';

export type Entry = {
  id: string;
  /** ISO timestamp. */
  at: string;
  /** What the user said, as the recogniser settled it. */
  said: string;
  /** What Grove replied. */
  replied: string;
  /** Set when a tool ran as part of this exchange. */
  tool?: TurnTool;
};

/**
 * Older entries are dropped rather than kept forever.
 *
 * Two hundred exchanges is weeks of ordinary use and a few hundred kilobytes;
 * an unbounded log on a device is a slow leak that eventually makes the
 * Activity list janky and the app slower to start.
 */
const LIMIT = 200;

function key(uid: string): string {
  return `grove:activity:v1:${uid}`;
}

export async function loadActivity(uid: string): Promise<Entry[]> {
  try {
    const raw = await AsyncStorage.getItem(key(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Entry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt log is not worth failing the app over — it is a history list.
    return [];
  }
}

/** Adds one exchange and returns the new list, newest first. */
export async function record(
  uid: string,
  entry: Omit<Entry, 'id' | 'at'>
): Promise<Entry[]> {
  const existing = await loadActivity(uid);
  const next: Entry[] = [
    {
      ...entry,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      at: new Date().toISOString(),
    },
    ...existing,
  ].slice(0, LIMIT);

  await write(uid, next);
  return next;
}

/**
 * Attaches a tool result to the most recent entry.
 *
 * Tools finish after Grove has already spoken — the reply goes out first so
 * the user is not left in silence while a Noctus run takes eight seconds — so
 * the outcome has to find its way back to a row that already exists.
 */
export async function attachTool(uid: string, entryId: string, tool: TurnTool): Promise<Entry[]> {
  const existing = await loadActivity(uid);
  const next = existing.map((e) => (e.id === entryId ? { ...e, tool } : e));
  await write(uid, next);
  return next;
}

export async function clearActivity(uid: string): Promise<Entry[]> {
  try {
    await AsyncStorage.removeItem(key(uid));
  } catch {
    // Nothing to remove is the desired end state anyway.
  }
  return [];
}

async function write(uid: string, entries: Entry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key(uid), JSON.stringify(entries));
  } catch {
    // Losing a history write costs a row, not the conversation.
  }
}

/** "2m ago", "Yesterday" — enough to place an exchange without a full date. */
export function when(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 172800) return 'yesterday';
  return `${Math.floor(seconds / 86400)}d ago`;
}
