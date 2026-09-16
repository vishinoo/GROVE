/**
 * Voice notes: things said at length, kept as something you can find again.
 *
 * Memory holds facts — "my sister is called Maya", "I live in Edmonton" — one
 * sentence each, sent whole into every prompt. A note is the other kind of
 * remembering: two minutes of thinking out loud about a project, a lecture, a
 * conversation that just happened. It is too long to put in every prompt and
 * too valuable to lose, so it is stored in full, summarised, and searched when
 * something asks about it.
 *
 * Kept on the phone, per account, like memory and the transcript. Nothing here
 * needs a server, which is the point: a memory service would bring back the
 * dependency Grove removed, to do something a search over a few hundred notes
 * does perfectly well.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type Note = {
  id: string;
  /** Short, as a person would label it. Written by the model. */
  title: string;
  /** Two or three sentences: what the note is about. */
  summary: string;
  /** The substance, one point each. */
  points: string[];
  /** Things someone said they, or somebody else, needs to do. */
  actions: string[];
  /** Everything that was heard, unedited, because a summary can be wrong. */
  transcript: string;
  createdAt: string;
  /** How long the person spoke for, in seconds. */
  seconds: number;
};

/**
 * Enough to be a real archive, and small enough that loading the list is never
 * the slow part of anything. Oldest go first.
 */
const LIMIT = 300;

const KEY = 'grove:notes:v1';

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

export async function loadNotes(uid: string): Promise<Note[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(uid));
    const parsed = raw ? (JSON.parse(raw) as Note[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // A corrupt archive is a lost list, not a broken app.
    return [];
  }
}

async function write(uid: string, notes: Note[]): Promise<void> {
  try {
    await AsyncStorage.setItem(storageKey(uid), JSON.stringify(notes));
  } catch {
    // Saving failed; the caller still has the note in hand and says so.
  }
}

export async function saveNote(uid: string, note: Omit<Note, 'id'>): Promise<Note[]> {
  const made: Note = {
    ...note,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
  };
  const next = [made, ...(await loadNotes(uid))].slice(0, LIMIT);
  await write(uid, next);
  return next;
}

export async function deleteNote(uid: string, id: string): Promise<Note[]> {
  const next = (await loadNotes(uid)).filter((n) => n.id !== id);
  await write(uid, next);
  return next;
}

/**
 * Notes that bear on a question, best first.
 *
 * Scored on words rather than matched on a phrase, because the question never
 * repeats what was said: a note about "the demo Jason wants on Friday" is found
 * by "what did I say about Jason's deadline". The title counts most, then the
 * summary and points, then the raw transcript, which is long and full of
 * everything and so earns the least per hit.
 */
const IGNORED = new Set([
  'what', 'did', 'say', 'said', 'about', 'the', 'and', 'for', 'that', 'this',
  'with', 'was', 'were', 'have', 'has', 'you', 'tell', 'note', 'notes', 'my',
  'from', 'when', 'where', 'which', 'any', 'anything', 'remember', 'again',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/'s$/, ''))
    .filter((w) => w.length > 2 && !IGNORED.has(w));
}

export function searchNotes(notes: Note[], query: string): Note[] {
  const wanted = [...new Set(words(query))];
  if (wanted.length === 0) return notes.slice(0, 5);

  return notes
    .map((note) => {
      const title = words(note.title);
      const body = words(`${note.summary} ${note.points.join(' ')} ${note.actions.join(' ')}`);
      const heard = words(note.transcript);
      let score = 0;
      for (const w of wanted) {
        if (title.includes(w)) score += 4;
        if (body.includes(w)) score += 2;
        if (heard.includes(w)) score += 1;
      }
      return { note, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || b.note.createdAt.localeCompare(a.note.createdAt))
    .slice(0, 5)
    .map((m) => m.note);
}

/**
 * Whether a sentence is asking Grove to start taking notes.
 *
 * Decided on the phone rather than by the model, for timing: people start
 * talking the instant they have said "listen to this", and a round trip to the
 * model before the microphone reopens loses the first sentence of the note —
 * usually the one that says what it is about.
 *
 * Anchored and whole, so "I need to listen to this podcast" is not a memo.
 */
const START_PHRASES =
  /^\s*(?:(?:hey|ok|okay)\s+)?(?:[a-z]{2,14},?\s+)?(?:please\s+)?(?:listen to this|listen up|take (?:a )?notes?|take this down|start (?:a )?(?:memo|note|voice note)|record (?:this|a note|a memo)|write this down|note this down|voice (?:memo|note))\s*[.!]?\s*$/i;

export function isStartingNote(text: string): boolean {
  return START_PHRASES.test(text);
}

/**
 * The words that end a note, when said at the end of it.
 *
 * No bare "done": "and then the report is done", said before a pause, would
 * end the note in the middle of a thought. Pressing is the main way to finish;
 * these are for when a hand is not free.
 *
 * Only at the end, so "that's it, the whole plan hinges on Friday" is kept as
 * content. Returned with the phrase removed, since "stop listening" is not part
 * of anything anyone meant to write down.
 */
const END_PHRASES =
  /[\s,]*(?:ok(?:ay)?[\s,]+)?(?:that'?s it|that is it|stop listening|end (?:the )?(?:note|memo)|stop (?:the )?(?:note|memo|recording)|finish(?:ed)? (?:the )?(?:note|memo))[\s.!]*$/i;

export function endsNote(text: string): { ended: boolean; kept: string } {
  const match = END_PHRASES.exec(text);
  if (!match) return { ended: false, kept: text };
  return { ended: true, kept: text.slice(0, match.index).trim() };
}
