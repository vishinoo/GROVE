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

import { lightConsolidate } from './lightModel';
import {
  absorb,
  current,
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

async function learn(uid: string, material: string, source: string): Promise<Life | null> {
  const life = await loadLife(uid);
  const learned = parse(await lightConsolidate(material, knownBlock(life, material), todayLine()));
  if (!learned) return null;
  if ((learned.entities?.length ?? 0) === 0 && (learned.episodes?.length ?? 0) === 0) return null;
  return updateLife(uid, (now) => absorb(now, learned, source));
}

/**
 * Adds a finished exchange to the buffer, and reads the buffer when it is full.
 *
 * Returns without waiting on the model when there is nothing to read yet, which
 * is most turns.
 */
export async function afterTurn(uid: string, said: string, replied: string): Promise<void> {
  const life = await updateLife(uid, (now) => ({
    ...now,
    pending: [...now.pending, { at: new Date().toISOString(), said: said.slice(0, 500), replied: replied.slice(0, 500) }],
  }));
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
  const life = await loadLife(uid);
  if (life.pending.length === 0) return;

  const material = life.pending
    .map((t) => `[${new Date(t.at).toLocaleString('en-GB')}]\nThem: ${t.said}\nGrove: ${t.replied}`)
    .join('\n\n');
  const taken = life.pending.length;

  await learn(uid, material, 'conversation');

  // Cleared whether or not the model had anything to say, and only the turns
  // that were read: a failed call must not make the same turns be read again
  // for ever, and turns that arrived meanwhile have not been looked at.
  await updateLife(uid, (now) => ({
    ...now,
    pending: now.pending.slice(taken),
    lastConsolidated: new Date().toISOString(),
  }));
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
