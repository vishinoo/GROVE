/**
 * Turning what happened into what is remembered.
 *
 * The write side of life.ts. Nothing here runs while anyone is waiting: a turn
 * only adds a line to a buffer, and the model call that reads that buffer
 * happens afterwards, in the background, once there is enough to be worth a
 * call. A finished voice note is the same job with a different source.
 *
 * The buffer is deleted once it has been read. That is deliberate and is the
 * privacy line this whole feature sits on: Grove is listening while you walk
 * around, and keeping a verbatim record of that is a liability. What it keeps
 * is the handful of things that were worth keeping, in a list you can read and
 * delete on the Sparks screen.
 */

import { lightCompact, lightConsolidate } from './lightModel';
import {
  absorb,
  addPending,
  applyCompaction,
  compactionBlock,
  current,
  mergeDuplicates,
  needsCompacting,
  loadLife,
  readyToConsolidate,
  updateLife,
  type Learned,
  type Life,
} from './life';
import type { Note } from './notes';

/**
 * What the model is told it already knows.
 *
 * Only the entities this material actually mentions, plus the few most recent,
 * because the point is to stop it inventing a second Jason — not to hand it the
 * whole archive. Capped tightly: this is prompt on every consolidation.
 */
export function knownBlock(life: Life, material: string): string {
  const haystack = ` ${material.toLowerCase()} `;
  const mentioned = life.entities.filter((e) =>
    [e.name, ...e.aliases].some((n) => n.length > 2 && haystack.includes(` ${n.toLowerCase()}`))
  );
  const recent = [...life.entities]
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, 8);
  const seen = new Set<string>();
  const pick = [...mentioned, ...recent].filter((e) => !seen.has(e.id) && seen.add(e.id)).slice(0, 14);

  return pick
    .map((e) => {
      const facts = current(e).slice(0, 6).map((f) => f.text).join('; ');
      return `- ${e.name}${e.relation ? ` (${e.relation})` : ''} [${e.kind}]${e.summary ? `: ${e.summary}` : ''}${facts ? ` | ${facts}` : ''}`;
    })
    .join('\n')
    .slice(0, 2500);
}

/** JSON out of a model, however it chose to wrap it. */
function parse(raw: string | null): Learned | null {
  if (!raw) return null;
  try {
    const clean = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(clean) as Learned;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities.slice(0, 20) : [],
      episodes: Array.isArray(parsed.episodes) ? parsed.episodes.slice(0, 20) : [],
    };
  } catch {
    return null;
  }
}

function todayLine(now = new Date()): string {
  return now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/**
 * Reads material into the long memory.
 *
 * 'failed' and 'nothing' are different outcomes and the buffer treats them
 * differently: nothing worth keeping is an answer, a call that never came back
 * is not — and clearing the buffer on both threw away every turn said while
 * the phone had no signal.
 */
async function learn(uid: string, material: string, source: string): Promise<'kept' | 'nothing' | 'failed'> {
  const life = await loadLife(uid);
  const learned = parse(await lightConsolidate(material, knownBlock(life, material), todayLine()));
  if (!learned) return 'failed';
  if ((learned.entities?.length ?? 0) === 0 && (learned.episodes?.length ?? 0) === 0) return 'nothing';
  await updateLife(uid, (now) => absorb(now, learned, source));
  return 'kept';
}

/** How long unread turns are kept for another try before being let go. */
const RETRY_FOR_MS = 48 * 3_600_000;

/** Consolidations between tidy-ups: roughly every thirty-odd turns. */
const COMPACT_EVERY = 3;

/**
 * Keeps the memory dense rather than merely long.
 *
 * Duplicates are merged locally first, because that needs no judgement. Then,
 * if any subject has collected enough overlapping facts to be worth it, one
 * call rewrites them into fewer, denser ones. Both are safe to fail: the
 * memory is left exactly as it was.
 */
export async function compact(uid: string): Promise<void> {
  const merged = await updateLife(uid, (life) => mergeDuplicates(life));
  const cluttered = needsCompacting(merged);
  if (cluttered.length === 0) {
    await updateLife(uid, (life) => ({ ...life, sinceCompacted: 0 }));
    return;
  }

  const raw = await lightCompact(compactionBlock(cluttered));
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as {
      subjects?: { name: string; summary?: string; facts?: string[] }[];
    };
    const subjects = Array.isArray(parsed.subjects) ? parsed.subjects : [];
    if (subjects.length === 0) return;
    await updateLife(uid, (life) => applyCompaction(life, subjects));
  } catch {
    // A tidy-up that cannot be read changes nothing.
  }
}

/**
 * One read of the buffer at a time, per account.
 *
 * Opening the app and a turn filling the buffer can both start a read in the
 * same second. Two reads take the same turns, and the second one's cleanup
 * then removes turns that arrived in between, unread. The second caller now
 * waits for the first instead.
 */
const reading = new Map<string, Promise<void>>();

/**
 * Adds a finished exchange to the buffer, and reads the buffer when it is full.
 *
 * Returns without waiting on the model when there is nothing to read yet, which
 * is most turns.
 */
export async function afterTurn(uid: string, said: string, replied: string): Promise<void> {
  const life = await updateLife(uid, (now) => addPending(now, said, replied));
  if (!readyToConsolidate(life)) return;
  await consolidateNow(uid);
}

/**
 * Reads whatever is in the buffer, whether or not it is full.
 *
 * Called when Grove is opened, so a day that ended mid-buffer is still
 * remembered rather than sitting unread until the next dozen turns.
 */
export async function consolidateNow(uid: string): Promise<void> {
  const inFlight = reading.get(uid);
  if (inFlight) return inFlight;
  const run = readBuffer(uid).finally(() => reading.delete(uid));
  reading.set(uid, run);
  return run;
}

async function readBuffer(uid: string): Promise<void> {
  const life = await loadLife(uid);
  if (life.pending.length === 0) return;

  const material = life.pending
    .map((t) => `[${new Date(t.at).toLocaleString('en-GB')}]\nThem: ${t.said}\nGrove: ${t.replied}`)
    .join('\n\n');
  const taken = life.pending.length;
  const oldest = new Date(life.pending[0].at).getTime();

  const outcome = await learn(uid, material, 'conversation');

  // A failed read keeps the turns for the next one — unless they have been
  // waiting two days, at which point a call that keeps failing must not hold
  // the buffer for ever. Only the turns that were read are removed; any that
  // arrived meanwhile have not been looked at.
  if (outcome === 'failed' && Date.now() - oldest < RETRY_FOR_MS) return;
  const after = await updateLife(uid, (now) => ({
    ...now,
    pending: now.pending.slice(taken),
    lastConsolidated: new Date().toISOString(),
    sinceCompacted: (now.sinceCompacted ?? 0) + 1,
  }));

  // Tidying is the same job's second half, and it runs on the same schedule as
  // everything else here: in the background, with nobody waiting.
  if ((after.sinceCompacted ?? 0) >= COMPACT_EVERY) await compact(uid);
}

/** Reads a finished voice note or meeting log into the long memory. */
export async function rememberNote(uid: string, note: Note, id: string): Promise<void> {
  const material = [
    `A voice note taken on ${new Date(note.createdAt).toLocaleString('en-GB')}.`,
    note.people && note.people.length > 0 ? `Present: ${note.people.join(', ')}.` : '',
    `Title: ${note.title}`,
    note.summary,
    note.points.length ? `Points:\n${note.points.map((p) => `- ${p}`).join('\n')}` : '',
    note.actions.length ? `To do:\n${note.actions.map((a) => `- ${a}`).join('\n')}` : '',
    `What was said:\n${note.transcript.slice(0, 6000)}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  await learn(uid, material, id);
}
