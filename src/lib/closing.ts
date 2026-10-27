/**
 * "Enough."
 *
 * Every reply ends with a window you can talk into, and the window shuts
 * itself. That is right nearly always, and wrong in one case: when you already
 * know you are finished. Then the window is a second or three of a microphone
 * you did not want, and the only way to close it early is to say nothing and
 * wait for it.
 *
 * So there is a word. Said on its own it closes the microphone and Grove does
 * not reply at all — there is nothing to reply to, and "sure, done" after
 * "enough" is the exact noise being asked for less of. Said at the end of a
 * real sentence it means "answer this, then stop": the sentence is handled
 * normally and the window after it never opens.
 *
 * WHY IT IS NOT JUST A WORD LIST
 *
 * "Enough" is a common English word and most of its uses are not this one.
 * Three rules keep it honest, and all three exist because the alternative
 * swallows a real sentence:
 *
 *   A QUESTION IS NEVER A CLOSE. "Can you text Priya, that's all?" is asking
 *   something. Stated outright at the top, and also true of the patterns
 *   below, whose tails do not admit a question mark — either would do on its
 *   own, and the explicit one is there because the implicit one is a
 *   character missing from a character class and would be lost in an edit
 *   without anything looking wrong.
 *
 *   THE WHOLE MESSAGE COUNTS FOR MORE THAN THE END OF ONE. On its own,
 *   "enough" cannot mean anything else. Buried at the end of a sentence it
 *   easily can — "that's good enough", "I've had enough", "late enough" — so
 *   the bare words need a break in front of them (a comma, a full stop, or an
 *   "and") before they are read as an instruction. None of those three
 *   phrases has one.
 *
 *   THE MATCH IS EXACT, NOT CONTAINED. Which is what makes a negation safe
 *   for free: "no, that's not enough" has the break and ends in the word, but
 *   the tail is "that's not enough", which is not in the list, so it is a
 *   sentence like any other. A test for *containing* "enough" would have
 *   needed a rule about "not", and then a rule about "hardly", and so on.
 *
 * Phrases that cannot be said by accident — "that's all", "nothing else",
 * "stop listening" — do not need the break, because there is no ordinary
 * sentence that ends in them and means something else.
 */

/** Said on their own, these mean stop and nothing else. */
const ALONE = new Set([
  'enough',
  "that's enough",
  "that's all",
  "that's it",
  "that's everything",
  "that's all for now",
  'nothing else',
  'no more',
  "we're done",
  "i'm done",
  'done',
  'all done',
  'finished',
  'stop listening',
]);

/** At the end of a sentence, these are unmistakable on their own. */
const FREE = ["that's all", "that's it", "that's everything", "that's all for now", 'nothing else', 'stop listening'];

/** At the end of a sentence, these need a break in front of them. */
const NEEDS_BREAK = [
  'enough',
  "that's enough",
  'no more',
  "we're done",
  "i'm done",
  'done',
  'all done',
  'finished',
];

/**
 * Words that can sit in front of the real thing without changing it.
 *
 * "ok that's all" and "and enough" are the same instruction as the bare
 * phrase. Deliberately short: every word added here is a word that can reduce
 * some other sentence to a stop phrase it never was.
 */
const FILLER = ['ok', 'okay', 'right', 'alright', 'cool', 'thanks', 'thank you', 'ta', 'cheers', 'yeah', 'yep', 'and', 'so', 'then', 'well', 'please'];

export type Closing = {
  /** What is left to answer. Empty means the message was only the instruction. */
  text: string;
  /** Whether to leave the microphone shut after this turn. */
  closed: boolean;
};

const escape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anyOf = (list: string[]) => list.map(escape).join('|');

/** A comma, a full stop, a dash, or a word that starts a new clause. */
const BREAK = String.raw`(?:[,;:—–]|\s-\s|\.|\b(?:and|then|ok|okay|so)\b)`;
const PRE = `(?:(?:${anyOf(FILLER)})\\b[\\s,]*)*`;
const TAIL = String.raw`[\s.!,…]*$`;

const AFTER_BREAK = new RegExp(`${BREAK}\\s*${PRE}(?:${anyOf(NEEDS_BREAK)})${TAIL}`, 'i');
const AT_END = new RegExp(`[\\s,;:—–]+${PRE}(?:${anyOf(FREE)})${TAIL}`, 'i');

/** Straight apostrophes and single spaces, with every index preserved. */
function plain(said: string): string {
  return said.replace(/[‘’]/g, "'").toLowerCase();
}

function withoutFiller(text: string): string {
  const pattern = new RegExp(`^(?:${anyOf(FILLER)})\\b[\\s,]*`, 'i');
  let out = text.trim();
  for (;;) {
    const next = out.replace(pattern, '').trim();
    if (next === out) return out;
    out = next;
  }
}

/**
 * Split a heard sentence into what to answer and whether to stay shut after.
 *
 * Returns the sentence unchanged, and `closed: false`, for everything that is
 * not one of these — which is nearly everything.
 */
export function closing(said: string): Closing {
  const text = said.trim();
  // A question is being asked, whatever words it ends in.
  if (!text || /\?$/.test(text)) return { text, closed: false };

  const lower = plain(text);
  if (ALONE.has(withoutFiller(lower).replace(/[.!…]+$/, '').trim())) return { text: '', closed: true };

  for (const pattern of [AFTER_BREAK, AT_END]) {
    const hit = pattern.exec(lower);
    // Only when something is actually left to answer. A message that reduces
    // to nothing here was really the bare instruction, and the whole-message
    // test above has already had its go at it.
    if (!hit) continue;
    const rest = text.slice(0, hit.index).replace(/[\s,;:—–.]+$/, '').trim();
    if (rest) return { text: rest, closed: true };
  }

  return { text, closed: false };
}
