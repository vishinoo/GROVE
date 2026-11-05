/**
 * Reading something aloud, as a session rather than a reply.
 *
 * "Read me this" is not a question with an answer: it is a long piece of
 * somebody else's writing, and the person listening wants to stop it, say
 * something about the part they just heard, and carry on. A reply cannot do
 * that — it is one utterance, gone the moment it is interrupted, and the next
 * sentence has nothing to point "that" at.
 *
 * So the text is held here in short parts, with a place in it. A part is
 * spoken; when it finishes on its own the place moves on; when a press cuts
 * it off the place stays put, so "carry on" starts that part again and "write
 * a note on that" means the part they were hearing. The session rides in the
 * turn's context (`readingContext`), which is how every tool — a note, a
 * flashcard on Quizlet, a search — gets the passage without a special case.
 *
 * Kept in memory only, and for an hour: it is somebody's document.
 */

type Session = { title: string; parts: string[]; at: number; paused: boolean; touched: number };

let session: Session | null = null;
const KEEP_MS = 60 * 60_000;

/** Short enough to stop mid-thought, long enough to sound like reading: about two sentences. */
export function partsOf(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [clean];
  const parts: string[] = [];
  let part = '';
  for (const s of sentences) {
    if (part && (part + s).length > 320) {
      parts.push(part.trim());
      part = '';
    }
    part += s;
  }
  if (part.trim()) parts.push(part.trim());
  return parts.filter(Boolean);
}

export function startReading(title: string, text: string): string | null {
  const parts = partsOf(text);
  if (parts.length === 0) return null;
  session = { title: title.trim() || 'what is on your screen', parts, at: 0, paused: false, touched: Date.now() };
  return parts[0];
}

function live(): Session | null {
  if (session && Date.now() - session.touched > KEEP_MS) session = null;
  return session;
}

/** The part to say now, or null when there is nothing being read. */
export function currentPart(): string | null {
  const s = live();
  return s && !s.paused ? s.parts[s.at] ?? null : null;
}

/** Whether the part being said is the last one. */
export function isLastPart(): boolean {
  const s = live();
  return !s || s.at >= s.parts.length - 1;
}

/** The part finished on its own: on to the next. False when that was the last. */
export function advance(): boolean {
  const s = live();
  if (!s) return false;
  s.touched = Date.now();
  if (s.at + 1 >= s.parts.length) {
    s.paused = true;
    s.at = s.parts.length - 1;
    return false;
  }
  s.at += 1;
  return true;
}

/** A press cut it off. The place stays where it was. */
export function pause(): void {
  const s = live();
  if (s) {
    s.paused = true;
    s.touched = Date.now();
  }
}

/** Carry on, go back, or start again. Returns the part to say, or null when there is nothing to read. */
export function move(how: 'resume' | 'back' | 'restart' | 'next'): string | null {
  const s = live();
  if (!s) return null;
  if (how === 'back') s.at = Math.max(0, s.at - 1);
  if (how === 'restart') s.at = 0;
  if (how === 'next') s.at = Math.min(s.parts.length - 1, s.at + 1);
  s.paused = false;
  s.touched = Date.now();
  return s.parts[s.at] ?? null;
}

export function stopReading(): void {
  session = null;
}

/**
 * For the turn's context: what is being read, where it stopped, and the
 * passage "that" means. The part being heard and the one before it, because
 * a press usually lands a beat after the sentence somebody reacted to.
 */
export function readingContext(): string {
  const s = live();
  if (!s) return '';
  const here = s.parts[s.at] ?? '';
  const before = s.at > 0 ? s.parts[s.at - 1] : '';
  return [
    `Reading aloud to them: "${s.title.slice(0, 120)}", part ${s.at + 1} of ${s.parts.length}${s.paused ? ', stopped here' : ''}.`,
    `What they were just hearing (what "this" or "that" means): ${before ? `${before.slice(0, 400)} ` : ''}${here.slice(0, 500)}`,
  ].join('\n');
}
