/**
 * What, out of everything Grove knows, bears on the sentence just said.
 *
 * Grove's memory was complete and inert. All forty facts rode in every prompt,
 * the entity roster with them, and the framing above the list said — in these
 * words — *"use a line ONLY when it is directly relevant to what they just
 * asked. Most turns need none of it."*
 *
 * That sentence was written to fix something real: without it the model
 * dragged a note about someone owing for lunch into a question about
 * software, which reads as an assistant that is not listening rather than one
 * that remembers. But it taught the model that memory is wallpaper. So Grove
 * knew somebody was trying to lose ten kilos, was asked where to get a
 * burger, and answered the question — because nothing in the prompt said that
 * knowing the goal was the point of having it.
 *
 * THE TWO HALVES, AND WHY THEY ARE SEPARATE
 *
 * Restraint about *facts* is correct. Nobody wants their lunch debt mentioned
 * in a conversation about work, and a model that works something in to prove
 * it remembered is worse than one that forgets.
 *
 * Restraint about *goals* is a bug. A goal is not trivia about someone, it is
 * the thing they asked Grove to help with. Those two were under one heading
 * and one instruction, and the instruction was written for the first.
 *
 * WHAT THIS FILE ADDS
 *
 * The facts were already in the prompt — what was missing was anything saying
 * which of them matter *now*. This picks those out in code, by overlapping
 * the words of the sentence against the memory, and puts them under a heading
 * that says what they are for. It costs no model call and a few dozen tokens,
 * because it is mostly repeating lines that were going to be sent anyway
 * under a better label.
 *
 * It also does the thing a flat list cannot: **kindred**. When the sentence
 * matches something Grove knows about, its nearest neighbours come too — the
 * other entities sharing the most words with it. That is what makes "you
 * liked that one, this other one is close to it" possible at all, and it is
 * general rather than a list of categories: nothing here knows what a book is.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * No model call, no embeddings, no topic map. A hand-written bridge from
 * "burger" to "losing weight" would be a keyword rail, and the model does not
 * need one — it has the goal in front of it and can see the conflict
 * perfectly well once told that noticing is part of the job. What it could
 * not do is spot the goal buried in forty lines of background under an
 * instruction to ignore them.
 */

import type { Life, Entity } from './life';
import type { Fact } from './memory';

/**
 * Words too common to mean anything, so an overlap on one is noise.
 *
 * Short rather than exhaustive. Everything under four letters is dropped
 * anyway, which removes most of the work a long list would do.
 */
const EMPTY = new Set([
  'about', 'after', 'again', 'also', 'and', 'another', 'any', 'anything', 'are', 'because',
  'been', 'being', 'both', 'but', 'can', 'could', 'did', 'does', 'doing', 'done', 'down',
  'each', 'even', 'ever', 'every', 'for', 'from', 'get', 'getting', 'going', 'got', 'had',
  'has', 'have', 'her', 'hers', 'here', 'him', 'his', 'how', 'into', 'its', 'just',
  'know', 'like', 'liked',
  'make', 'many', 'me', 'might', 'more', 'most', 'much', 'must', 'need', 'not', 'now',
  'off', 'once', 'one', 'only', 'other', 'our', 'out', 'over', 'own', 'really', 'said',
  'same', 'say', 'see', 'she', 'should', 'some', 'something', 'still', 'such', 'take',
  'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing',
  'things', 'think', 'this', 'those', 'through', 'time', 'too', 'under', 'until', 'use',
  'very', 'want', 'wanted', 'was', 'way', 'well', 'were', 'what', 'when', 'where',
  'which', 'while', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

/**
 * A word reduced to something two spellings of it share.
 *
 * Crude on purpose — "burgers" and "burger", "running" and "run". A real
 * stemmer would be a dependency and a model would be a round trip, and the
 * whole value here is being free enough to run on every single turn.
 */
function root(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 5 && w.endsWith('ing')) {
    const stem = w.slice(0, -3);
    // English doubles the final consonant before "ing": running, swimming,
    // setting. Without undoing that, "running" stems to "runn" and never
    // matches "run". Not for l, s or z, where the double is part of the word
    // — "falling" is "fall", not "fal".
    return /([bcdfgkmnprt])\1$/.test(stem) ? stem.slice(0, -1) : stem;
  }
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  /*
    "es" comes off only where English put it there.

    The first version stripped it from anything, which turned "notes" into
    "not" — a stopword — so "I need to send those notes" matched an open
    commitment about sending notes on exactly zero words. A plural ending in
    a sibilant takes "es" (boxes, dishes, churches); everything else takes a
    bare "s" and must keep its "e".
  */
  if (w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Subjects are stored lower-cased; a name reads badly that way on screen. */
function titled(subject: string): string {
  return subject.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** The content words of a sentence, as roots. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []) {
    if (EMPTY.has(raw)) continue;
    const stem = root(raw);
    if (stem.length >= 3 && !EMPTY.has(stem)) out.add(stem);
  }
  return out;
}

/**
 * How much a shared word is worth, which is not one each.
 *
 * Counting matches flat was the first version and it is wrong in both
 * directions at once. "Priya" shared with one entity out of seven says a
 * great deal; "lecture" shared with four says almost nothing; and under a
 * flat count a sentence needed two coincidences to beat one real signal, so
 * "what should I get Priya for her birthday" surfaced nothing about Priya.
 *
 * This is ordinary inverse document frequency, which is the scoring half of
 * BM25 — the same reasoning recorded in AGENTS.md for why lookup here is
 * keyword-based rather than vector-based. A word in everything scores near
 * nothing; a word in one thing scores well over the bar on its own.
 */
function rarity(documents: Set<string>[]): (word: string) => number {
  const seen = new Map<string, number>();
  for (const doc of documents) {
    for (const word of doc) seen.set(word, (seen.get(word) ?? 0) + 1);
  }
  const total = Math.max(1, documents.length);
  return (word) => Math.log(1 + total / (1 + (seen.get(word) ?? 0)));
}

function weigh(a: Set<string>, b: Set<string>, worth: (word: string) => number): number {
  let score = 0;
  for (const word of a) if (b.has(word)) score += worth(word);
  return score;
}

/** Everything written about one entity, as words. */
function entityWords(entity: Entity): Set<string> {
  return contentWords(
    [
      entity.name,
      ...entity.aliases,
      entity.relation ?? '',
      entity.summary,
      ...entity.facts.filter((f) => !f.stale).map((f) => f.text),
    ].join(' ')
  );
}

/**
 * How many lines may ride on a turn.
 *
 * Small, and the reason is the point of the whole file: a long list under a
 * heading saying "this is relevant" is the flat list again with a new label,
 * and the model goes back to ignoring it. Four things it should notice beats
 * twenty it might.
 */
const MOST_LINES = 4;

/** And how many neighbours, which are a nicety rather than the answer. */
const MOST_KINDRED = 2;

/**
 * The bar, in rarity units.
 *
 * Calibrated against the cases rather than picked. With seven things in
 * memory, a word in one of them scores about 1.5 and a word in all of them
 * about 0.6 — so one is enough as long as it is not ubiquitous. That is the
 * behaviour wanted: "Priya" on its own should surface Priya, and "lecture",
 * which half the entities mention, should not surface half the entities.
 */
const WORTH_SAYING = 1.0;

/** Two things sharing this much are near enough to mention side by side. */
const KINDRED_ENOUGH = 1.6;

export type Bearing = {
  /** The prompt block, or empty when nothing in memory touches this. */
  block: string;
  /** What was surfaced, for the harness and for the Memory screen. */
  named: string[];
};

/**
 * What bears on this sentence.
 *
 * Returns an empty block for most turns, which is correct — "what's the
 * weather" touches nothing anyone needs reminding of, and a block that
 * appears on every turn is one the model stops reading.
 */
export function bearingOn(said: string, life: Life, facts: Fact[]): Bearing {
  const asked = contentWords(said);
  if (asked.size === 0) return { block: '', named: [] };

  /* ------------------------------------------------- what they said touches */

  /*
    Rarity is measured across everything in memory, so "how informative is
    this word" is answered about this person's own life rather than about
    English. Someone whose every project mentions finance gets no signal from
    the word; someone who has said it once gets a lot.
  */
  const written = life.entities.map(entityWords);
  const worth = rarity([
    ...written,
    ...life.episodes.map((e) => contentWords(`${e.title} ${e.summary}`)),
    ...facts.map((f) => contentWords(`${f.subject} ${f.value}`)),
  ]);

  const scored = life.entities
    .map((entity, i) => {
      const words = written[i];
      let score = weigh(asked, words, worth);
      /*
        A name said outright beats any amount of coincidence.

        The first version demanded every word of the name, which for "Priya
        Shah" meant the surname — so asking what to get Priya for her
        birthday matched nothing about Priya. One distinctive word of
        somebody's name is how people refer to them.
      */
      for (const label of [entity.name, ...entity.aliases]) {
        const parts = [...contentWords(label)];
        if (parts.length === 0) continue;
        if (parts.every((w) => asked.has(w))) {
          score += 4;
          break;
        }
        // Or one word of it that is distinctive enough to be a name.
        if (parts.some((w) => asked.has(w) && worth(w) >= WORTH_SAYING)) {
          score += 2;
          break;
        }
      }
      return { entity, words, score };
    })
    .filter((row) => row.score >= WORTH_SAYING)
    .sort((a, b) => b.score - a.score || b.entity.mentions - a.entity.mentions);

  const direct = scored.slice(0, MOST_LINES);

  /* ----------------------------------------------------------- the kindred */

  /*
    The neighbours of what they named.

    "I liked that one" is only useful if Grove can also see what else is near
    it, and nothing here knows what a book is — nearness is shared words.
    Only ever computed from a direct hit, so a sentence that matched nothing
    produces no speculative neighbours.
  */
  const taken = new Set(direct.map((d) => d.entity.id));
  const kindred: { entity: Entity; like: string }[] = [];
  for (const hit of direct) {
    const near = life.entities
      .filter((e) => e.id !== hit.entity.id && !taken.has(e.id) && e.kind === hit.entity.kind)
      .map((e) => ({ e, n: weigh(hit.words, entityWords(e), worth) }))
      .filter((row) => row.n >= KINDRED_ENOUGH)
      .sort((a, b) => b.n - a.n)[0];
    if (!near) continue;
    taken.add(near.e.id);
    kindred.push({ entity: near.e, like: hit.entity.name });
    if (kindred.length >= MOST_KINDRED) break;
  }

  /* ------------------------------------------- facts and promises it touches */

  const relevant = facts
    .filter((f) => f.kind !== 'goal')
    .map((f) => ({ f, n: weigh(asked, contentWords(`${f.subject} ${f.value}`), worth) }))
    .filter((row) => row.n >= WORTH_SAYING)
    .sort((a, b) => b.n - a.n)
    .slice(0, MOST_LINES)
    .map((row) => row.f);

  const open = life.episodes
    .filter((e) => e.open)
    .map((e) => ({ e, n: weigh(asked, contentWords(`${e.title} ${e.summary}`), worth) }))
    .filter((row) => row.n >= WORTH_SAYING)
    .sort((a, b) => b.n - a.n)
    .slice(0, 2)
    .map((row) => row.e);

  /*
    The same thing said twice is worse than not saying it.

    A promise lives in two places by design — as a fact with `open` set and as
    an episode — so "owes Priya the lecture notes" and "Still open: Send Priya
    the lecture notes" both qualify, and printing both makes a short block
    look like padding and teaches the model that the block is padding. A line
    whose content words are mostly already present is dropped.
  */
  const lines: string[] = [];
  const emitted: Set<string>[] = [];
  const add = (line: string) => {
    const words = contentWords(line);
    if (words.size === 0) return;
    const already = emitted.some((seen) => {
      let shared = 0;
      for (const word of words) if (seen.has(word)) shared += 1;
      return shared / words.size >= 0.6;
    });
    if (already) return;
    emitted.push(words);
    lines.push(line);
  };

  for (const { entity } of direct) {
    const detail = entity.summary || entity.facts.find((f) => !f.stale)?.text || '';
    add(`- ${entity.name}${entity.relation ? ` (${entity.relation})` : ''}${detail ? `: ${detail}` : ''}`);
  }
  // Promises before background, because an open one is the thing most likely
  // to be worth saying and the cap is small.
  for (const episode of open) {
    add(`- Still open: ${episode.title}`);
  }
  for (const { entity, like } of kindred) {
    const detail = entity.summary || entity.facts.find((f) => !f.stale)?.text || '';
    // Labelled as the loose connection it is, so the model does not assert it
    // as something they said.
    add(`- Also in their life, close to ${like}: ${entity.name}${detail ? ` — ${detail}` : ''}`);
  }
  for (const fact of relevant) {
    const who = fact.subject === 'me' ? 'Them' : titled(fact.subject);
    add(`- ${who}: ${fact.value}${fact.open ? ' (still outstanding)' : ''}`);
  }

  if (lines.length === 0) return { block: '', named: [] };

  return {
    block: [
      'WHAT YOU ALREADY KNOW THAT BEARS ON THIS. Picked out because it overlaps what they just said:',
      lines.slice(0, MOST_LINES + MOST_KINDRED).join('\n'),
      // The job, stated. Without it this is the flat list again with a new
      // heading, and a heading changes nothing about whether the model acts
      // on what is under it.
      'Use it to give a better answer than you could without it — a connection they would not have made, a name they will recognise, the thing they already told you so they do not have to again. Never recite it, and never mention something from it just to show you remembered.',
    ].join('\n'),
    named: [
      ...direct.map((d) => d.entity.name),
      ...kindred.map((k) => k.entity.name),
    ],
  };
}
