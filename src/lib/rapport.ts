/**
 * How this person talks, worked out rather than asked.
 *
 * There were six settings for this: what to call you, how blunt to be, whether
 * it may swear, how far to go into things, what to look out for, whether it
 * checks in. Six screens-worth of preference standing in for a character — and
 * every one of them asked you to describe, in the abstract, on a settings
 * screen, something you demonstrate every time you open your mouth.
 *
 * So none of it is asked now. Grove reads the last few dozen things you
 * actually said and matches them: if you swear it swears, if you write in
 * fragments it stops writing paragraphs, if you are formal it does not call
 * you mate. That is what rapport is between people — nobody fills in a form
 * about their register — and it has the property a settings screen can never
 * have, which is that it keeps up when you change.
 *
 * WHY THIS IS COUNTING AND NOT A MODEL
 *
 * It runs on every turn. A model call to decide how to speak would cost more
 * than the answer it is shaping and would wobble between turns for no reason.
 * Swearing is a word list, length is a mean, and a question mark is a question
 * mark. All three are things you can count, and counting them gives the same
 * answer twice, which matters more here than nuance: a personality that drifts
 * every turn reads as instability rather than as adaptation.
 *
 * WHAT IT DELIBERATELY DOES NOT COPY
 *
 * Mistakes. Someone dictating through glasses produces fragments, missing
 * words and transcription noise, and a Grove that matched *that* would be
 * unreadable. It matches register — swearing, warmth, length, formality — and
 * never grammar, never typos, and never the mishearings.
 */

import { vault } from './vault';

/** What was noticed, as plain counts. Nothing here is a judgement. */
type Tally = {
  /** How many of their turns have been looked at. */
  turns: number;
  /** How many of those carried a swear word. */
  sweary: number;
  /** Words per turn, summed, so the mean survives without keeping the text. */
  words: number;
  /** Turns that were a question. */
  asking: number;
  /** Turns that opened with a greeting or a please — the formal tells. */
  polite: number;
  /** Turns carrying a contraction or a casual marker. */
  casual: number;
};

export type Rapport = {
  /** Whether they swear, and therefore whether Grove may. */
  swears: boolean;
  /** Their average turn, in words. */
  length: number;
  /**
   * How much they say, and how they pitch it — two axes, not one.
   *
   * A single enum conflated them and had to choose: someone who says "nah
   * leave it" is brief *and* informal, and a scale with one slot read them as
   * brief and threw the rest away. Length decides how long a reply should be;
   * tone decides what it should sound like. They are independent, so they are
   * stored independently.
   */
  brevity: 'clipped' | 'normal' | 'roomy';
  tone: 'casual' | 'plain' | 'formal';
  /** Turns behind it. Below ENOUGH this is all defaults. */
  seen: number;
};

/**
 * Coarse on purpose. A longer list catches more and is also how a word filter
 * ends up deciding that someone who said "bloody hell" once talks like a
 * docker. These are the ones that, used at all, mean the register is open.
 */
const SWEARS =
  /\b(fuck\w*|shit\w*|bollocks|bugger|wank\w*|twat|piss\w*|bastard|arse\w*|dick|crap|goddamn|damn|hell)\b/i;

/** The tells of someone being formal with a machine. */
const POLITE = /^\s*(?:hello|good (?:morning|afternoon|evening)|please|would you|could you kindly|i would like)\b/i;

/** And of someone not bothering. */
const CASUAL = /\b(?:yeah|yep|nah|gonna|wanna|dunno|mate|lol|lmao|bruh|ngl|tbh|idk|cheers|cool|sick|wack)\b|'\w/i;

/** Below this there is nothing to go on and everything stays at its default. */
const ENOUGH = 8;

/** Enough to notice a change of register without a single odd day moving it. */
const WINDOW = 60;

const KEY = 'grove:rapport:v1';

const EMPTY: Tally = { turns: 0, sweary: 0, words: 0, asking: 0, polite: 0, casual: 0 };

async function load(uid: string): Promise<Tally> {
  try {
    const raw = await vault.getItem(`${KEY}:${uid}`);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<Tally>;
    return {
      turns: Number(parsed.turns) || 0,
      sweary: Number(parsed.sweary) || 0,
      words: Number(parsed.words) || 0,
      asking: Number(parsed.asking) || 0,
      polite: Number(parsed.polite) || 0,
      casual: Number(parsed.casual) || 0,
    };
  } catch {
    return { ...EMPTY };
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Notes how one sentence was said.
 *
 * Counts only — the sentence itself is never kept here. The long memory
 * already draws the line about keeping what things meant rather than what was
 * said, and a file that exists to describe how someone speaks would be the
 * worst possible place to break it.
 */
export function notice(uid: string, said: string): Promise<void> {
  if (!uid || uid === 'anon') return Promise.resolve();
  const text = said.trim();
  if (!text) return Promise.resolve();

  const run = queue.then(async () => {
    const was = await load(uid);
    const words = text.split(/\s+/).length;
    let next: Tally = {
      turns: was.turns + 1,
      sweary: was.sweary + (SWEARS.test(text) ? 1 : 0),
      words: was.words + words,
      asking: was.asking + (text.endsWith('?') ? 1 : 0),
      polite: was.polite + (POLITE.test(text) ? 1 : 0),
      casual: was.casual + (CASUAL.test(text) ? 1 : 0),
    };

    // Halved rather than trimmed, so the window slides without keeping a list
    // of turns. Someone who stops swearing stops reading as sweary within
    // about thirty turns, which is the right speed for a register to change.
    if (next.turns > WINDOW) {
      next = {
        turns: Math.round(next.turns / 2),
        sweary: Math.round(next.sweary / 2),
        words: Math.round(next.words / 2),
        asking: Math.round(next.asking / 2),
        polite: Math.round(next.polite / 2),
        casual: Math.round(next.casual / 2),
      };
    }
    try {
      await vault.setItem(`${KEY}:${uid}`, JSON.stringify(next));
    } catch {
      // Losing this costs a little accuracy in a register.
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

export async function rapport(uid: string): Promise<Rapport> {
  const t = await load(uid);
  const length = t.turns > 0 ? Math.round(t.words / t.turns) : 0;
  if (t.turns < ENOUGH) {
    return { swears: false, length, brevity: 'normal', tone: 'plain', seen: t.turns };
  }

  // One swear in ten turns is someone who swears. The question is whether the
  // register is open at all, not how often they reach for it.
  const swears = t.sweary / t.turns >= 0.1;
  const polite = t.polite / t.turns;
  const casual = t.casual / t.turns;

  const brevity: Rapport['brevity'] = length <= 5 ? 'clipped' : length >= 18 ? 'roomy' : 'normal';
  const tone: Rapport['tone'] =
    polite >= 0.25 && casual < 0.2 ? 'formal' : casual >= 0.3 ? 'casual' : 'plain';

  return { swears, length, brevity, tone, seen: t.turns };
}

/**
 * The prompt line, or nothing at all.
 *
 * Nothing at all until there is something to go on, because a block saying it
 * has not worked you out yet is a thing the model will mention. Silence is the
 * correct description of knowing nothing.
 */
export function rapportDirective(r: Rapport): string {
  if (r.seen < ENOUGH) return '';

  const lines = [
    'How they talk to you, counted over your last few dozen exchanges. Match it — this is rapport, not instruction, and they never asked you to.',
  ];

  lines.push(
    r.swears
      ? 'They swear. Swear back when it lands, naturally and not in every line.'
      : 'They do not swear. Neither do you.'
  );

  lines.push(
    r.brevity === 'clipped'
      ? `They say about ${r.length} words at a time. Answer in one short line — no preamble, no sign-off.`
      : r.brevity === 'roomy'
        ? `They write at length, about ${r.length} words a turn. You can take a little more room when the answer needs it.`
        : `They say about ${r.length} words at a time. Match that: answer, then stop.`
  );

  lines.push(
    r.tone === 'casual'
      ? 'Loose and informal with you — contractions, slang, no ceremony. Talk the same way.'
      : r.tone === 'formal'
        ? 'Polite and full-sentenced with you. Be warm but unhurried, and do not force slang on them.'
        : 'Plain and direct with you. Be the same: no flourish, no filler.'
  );

  lines.push(
    'Match the register, never the mistakes. They are dictating through glasses, so there will be fragments and misheard words; you are not copying those.'
  );

  return lines.join('\n');
}

/** Everything noticed about how they speak, gone. */
export async function forgetRapport(uid: string): Promise<void> {
  await vault.removeItem(`${KEY}:${uid}`).catch(() => {});
}
