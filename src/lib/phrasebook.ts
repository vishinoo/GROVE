/**
 * The things Grove says over and over, in its own words and never the same
 * twice running.
 *
 * "One second", "Cancelled.", "Okay, stopped.", "That one timed out" were fixed
 * strings, which is how an assistant comes to sound like a machine: the same
 * sentence, every time, whatever was going on. These are written by the model
 * in Grove's manner (`lightPhrasebook`), several of each, refreshed daily and
 * whenever the manner changes, and a line just used is not used again next.
 *
 * Never waits on the model: these are said at the moment something happens,
 * so the set is made in the background and a plain line stands in until it
 * exists, or if it never does.
 */

import { lightPhrasebook } from './lightModel';
import { vault } from './vault';

/** What each kind is for, which is what the model writes from. */
const KINDS: Record<string, string> = {
  holding: 'said while it works on something that is taking a few seconds; it is busy and an answer is coming',
  stopped: 'they told it to stop and it has stopped what it was doing',
  nevermind: 'they said never mind and nothing was going on; no harm done',
  cancelled: 'a yes it was waiting for has been cancelled',
  timedOut: 'what they asked took too long and gave up; they can ask again',
  lostThread: 'it lost track of what it was saying and needs them to say it again',
  noMic: 'the microphone would not open; they can try again',
  writing: 'it has started writing a document for them and it will take a moment',
};

/** Plain lines, for before the model has written any, or if it never does. */
const PLAIN: Record<string, string[]> = {
  holding: ['On it.', 'Looking now.'],
  stopped: ['Okay, stopped.'],
  nevermind: ['No worries.'],
  cancelled: ['Cancelled.'],
  timedOut: ['That one timed out. Ask me again.'],
  lostThread: ['I lost my train of thought there. Say that again?'],
  noMic: ["I couldn't open the microphone. Try me again."],
  writing: ['Writing it now.'],
};

export type Kind = keyof typeof PLAIN;

const KEY = 'grove.phrasebook';
const DAY = 24 * 60 * 60_000;
type Book = { manner: string; at: number; lines: Record<string, string[]> };
let book: Book | null = null;
let making = false;
const last: Record<string, string> = {};

/** Makes or refreshes the set in the background. Safe to call often. */
export async function refreshPhrasebook(manner: string): Promise<void> {
  if (!book) {
    const kept = await vault.getItem(KEY).catch(() => null);
    try {
      book = kept ? (JSON.parse(kept) as Book) : null;
    } catch {
      book = null;
    }
  }
  if (making || (book && book.manner === manner && Date.now() - book.at < DAY)) return;
  making = true;
  try {
    const raw = await lightPhrasebook(manner, KINDS).catch(() => null);
    const parsed = raw ? (JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim()) as Record<string, unknown>) : null;
    if (!parsed) return;
    const lines: Record<string, string[]> = {};
    for (const kind of Object.keys(KINDS)) {
      const got = Array.isArray(parsed[kind]) ? (parsed[kind] as unknown[]).map(String) : [];
      const clean = got.map((l) => l.trim()).filter((l) => l.length > 1 && l.length <= 90);
      if (clean.length >= 2) lines[kind] = clean;
    }
    if (Object.keys(lines).length === 0) return;
    book = { manner, at: Date.now(), lines };
    await vault.setItem(KEY, JSON.stringify(book)).catch(() => {});
  } catch {
    // A plain line is the fallback, not an error.
  } finally {
    making = false;
  }
}

/** One line of this kind, not the one said last time. */
export function phrase(kind: Kind): string {
  const pool = book?.lines[kind]?.length ? book.lines[kind] : PLAIN[kind];
  const choices = pool.length > 1 ? pool.filter((l) => l !== last[kind]) : pool;
  const line = choices[Math.floor(Math.random() * choices.length)] ?? PLAIN[kind][0];
  last[kind] = line;
  return line;
}
