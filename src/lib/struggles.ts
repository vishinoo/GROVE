/**
 * The things you did not understand.
 *
 * Every other memory in Grove records what is true: who someone is, what
 * happened, what you decided. This one records a gap — a thing you were told
 * and did not get — which is the only kind of memory that is useful precisely
 * because it is about something you cannot yet do.
 *
 * It exists because the obvious version of an AI tutor is worthless. Anything
 * can explain integration by parts. The thing nobody else can do is remember
 * that *you* did not follow it on the fourth of October, that you asked again
 * two weeks later, and that you have still never got it right unprompted — and
 * then quiz you on that rather than on the syllabus.
 *
 * WHY A STRUGGLE IS NOT A FACT
 *
 * It could have gone in memory.ts as a fact with a flag, and that would have
 * been wrong in three ways. A struggle has a *state* that changes (open, got it
 * once, got it twice, closed), it has a count that matters (asked three times
 * is a different thing from asked once), and it is the input to a job — the
 * quiz — rather than context for a conversation. Facts ride in every prompt;
 * nothing here does, because "you don't understand the chain rule" in a prompt
 * about dinner is an insult.
 *
 * THE CLOSING RULE
 *
 * Two correct answers close it, not one. One correct answer to a question you
 * were just asked about a thing you just revised is a memory test. The second
 * one, days later, is understanding. A wrong answer reopens it and resets the
 * count, because this is the one memory in Grove where being optimistic costs
 * the person something real.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type Struggle = {
  id: string;
  /** The concept, in their own words where possible: "integration by parts". */
  what: string;
  /** What it belongs to — a course, a project, a topic. Lower-cased. */
  about: string;
  /** The sentence that revealed it, kept because the wording is a clue. */
  said?: string;
  firstAt: string;
  /** Bumped every time it comes up again. Three times is a real problem. */
  raised: number;
  lastAt: string;
  /** Correct answers in a row. Two closes it; see the note above. */
  right: number;
  /** Set when it is closed. Kept rather than deleted — the history is the point. */
  gotItAt?: string;
};

/** A quiz in progress. Lives across turns, like a focus session. */
export type Quiz = {
  questions: { q: string; a: string; struggleId: string }[];
  /** Which question they are on. */
  at: number;
  /** How many they have got right so far. */
  score: number;
  startedAt: string;
};

/** Plenty for years of one degree. */
const LIMIT = 200;

/** Closed and older than this is history nobody is quizzing on. */
const KEEP_CLOSED_FOR_MS = 180 * 86_400_000;

/** A quiz nobody finished is not hanging over them a day later. */
const QUIZ_EXPIRES_MS = 2 * 3_600_000;

const KEY = 'grove:struggles:v1';
const QUIZ_KEY = 'grove:quiz:v1';

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function loadStruggles(uid: string): Promise<Struggle[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Struggle[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let queue: Promise<unknown> = Promise.resolve();

function update(uid: string, change: (list: Struggle[]) => Struggle[]): Promise<Struggle[]> {
  const run = queue.then(async () => {
    const next = tidy(change(await loadStruggles(uid)));
    try {
      await AsyncStorage.setItem(storageKey(uid), JSON.stringify(next));
    } catch {
      // Losing one costs a quiz question.
    }
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

function tidy(list: Struggle[]): Struggle[] {
  const cutoff = Date.now() - KEEP_CLOSED_FOR_MS;
  return list
    .filter((s) => !s.gotItAt || new Date(s.gotItAt).getTime() > cutoff)
    // Open first, then whatever came up most recently: a quiz should reach for
    // the live problems before the historical ones.
    .sort((a, b) => Number(Boolean(a.gotItAt)) - Number(Boolean(b.gotItAt)) || b.lastAt.localeCompare(a.lastAt))
    .slice(0, LIMIT);
}

/**
 * Something the same, however it was worded.
 *
 * "I don't get integration by parts" and "integration by parts still isn't
 * clicking" are one struggle raised twice, and recording them separately is
 * how a quiz ends up asking the same question four ways. Matched on
 * containment either direction, which is loose on purpose: a false merge costs
 * a shared counter, and a false split costs the whole point of counting.
 */
export function same(list: Struggle[], what: string): Struggle | undefined {
  const target = norm(what);
  if (target.length < 3) return undefined;
  return list.find((s) => {
    const theirs = norm(s.what);
    return theirs === target || theirs.includes(target) || target.includes(theirs);
  });
}

/** Records a gap, or counts an existing one again. */
export async function note(
  uid: string,
  what: string,
  about: string,
  said?: string
): Promise<{ list: Struggle[]; again: boolean }> {
  const clean = what.trim().slice(0, 140);
  if (!clean) return { list: await loadStruggles(uid), again: false };
  const stamp = new Date().toISOString();
  let again = false;

  const list = await update(uid, (current) => {
    const known = same(current, clean);
    if (!known) {
      return [
        {
          id: newId(),
          what: clean,
          about: about.trim().toLowerCase().slice(0, 60),
          ...(said ? { said: said.trim().slice(0, 240) } : {}),
          firstAt: stamp,
          raised: 1,
          lastAt: stamp,
          right: 0,
        },
        ...current,
      ];
    }
    again = true;
    return current.map((s) =>
      s.id === known.id
        ? {
            ...s,
            // Asking again after thinking you had it is the same gap reopening.
            raised: s.raised + 1,
            lastAt: stamp,
            right: 0,
            about: s.about || about.trim().toLowerCase().slice(0, 60),
            gotItAt: undefined,
          }
        : s
    );
  });
  return { list, again };
}

/** Still unresolved, hardest first — raised most, then most recent. */
export function open(list: Struggle[]): Struggle[] {
  return list
    .filter((s) => !s.gotItAt)
    .sort((a, b) => b.raised - a.raised || b.lastAt.localeCompare(a.lastAt));
}

/** Unresolved and raised inside the window, for "this week". */
export function openSince(list: Struggle[], days: number): Struggle[] {
  const cutoff = Date.now() - days * 86_400_000;
  return open(list).filter((s) => new Date(s.lastAt).getTime() >= cutoff);
}

/** Narrowed to a course or topic, when they named one. */
export function about(list: Struggle[], subject: string): Struggle[] {
  const target = norm(subject);
  if (!target) return open(list);
  return open(list).filter((s) => norm(s.about).includes(target) || norm(s.what).includes(target));
}

/**
 * Marks an answer. Two in a row closes it; a wrong one resets the count.
 *
 * Returns whether that answer closed it, so the quiz can say so — "that's it
 * twice now, I'll stop asking" is the only moment in this whole feature where
 * the person gets to hear that they have finished something.
 */
export async function mark(uid: string, id: string, right: boolean): Promise<boolean> {
  let closed = false;
  await update(uid, (list) =>
    list.map((s) => {
      if (s.id !== id) return s;
      if (!right) return { ...s, right: 0, gotItAt: undefined, lastAt: new Date().toISOString() };
      const count = s.right + 1;
      closed = count >= 2;
      return {
        ...s,
        right: count,
        ...(closed ? { gotItAt: new Date().toISOString() } : {}),
        lastAt: new Date().toISOString(),
      };
    })
  );
  return closed;
}

/** Told outright that they have it — "I get the chain rule now". */
export async function gotIt(uid: string, id: string): Promise<Struggle[]> {
  return update(uid, (list) =>
    list.map((s) => (s.id === id ? { ...s, right: 2, gotItAt: new Date().toISOString() } : s))
  );
}

export async function forget(uid: string, id: string): Promise<Struggle[]> {
  return update(uid, (list) => list.filter((s) => s.id !== id));
}

/** What a model needs to write questions: the gap, the subject, the wording. */
export function studyBlock(list: Struggle[]): string {
  return list
    .map(
      (s, i) =>
        `${i + 1}. ${s.what}${s.about ? ` (${s.about})` : ''} — raised ${s.raised} time${s.raised === 1 ? '' : 's'}${s.said ? `, originally: "${s.said}"` : ''}`
    )
    .join('\n');
}

/* ----------------------------------------------------------------- quiz */

export async function loadQuiz(uid: string): Promise<Quiz | null> {
  try {
    const raw = await AsyncStorage.getItem(`${QUIZ_KEY}:${uid}`);
    if (!raw) return null;
    const quiz = JSON.parse(raw) as Quiz;
    if (!quiz || !Array.isArray(quiz.questions)) return null;
    // An abandoned quiz is not still running two hours later. Picking one up
    // mid-sentence the next morning is worse than starting again.
    if (Date.now() - new Date(quiz.startedAt).getTime() > QUIZ_EXPIRES_MS) {
      await setQuiz(uid, null);
      return null;
    }
    return quiz;
  } catch {
    return null;
  }
}

export async function setQuiz(uid: string, quiz: Quiz | null): Promise<void> {
  try {
    if (quiz) await AsyncStorage.setItem(`${QUIZ_KEY}:${uid}`, JSON.stringify(quiz));
    else await AsyncStorage.removeItem(`${QUIZ_KEY}:${uid}`);
  } catch {
    // A lost quiz is a quiz that has to be restarted.
  }
}

/** The question they are on, or null when the quiz has run out. */
export function current(quiz: Quiz): { q: string; a: string; struggleId: string } | null {
  return quiz.questions[quiz.at] ?? null;
}

/**
 * How the turn's prompt is told a quiz is running.
 *
 * The answer key goes in deliberately. Marking is the one job here a model is
 * genuinely good at — it can tell that "you swap which one you differentiate"
 * is the right answer to a question about integration by parts even though it
 * matches no string — and it cannot do that without knowing the answer.
 */
export function quizDirective(quiz: Quiz): string {
  const q = current(quiz);
  if (!q) return '';
  return [
    `You are quizzing them on things they have told you they did not understand. This is question ${quiz.at + 1} of ${quiz.questions.length}.`,
    `The question you asked: ${q.q}`,
    `What a right answer amounts to: ${q.a}`,
    'Their next message is their answer. Mark it in one short line — say plainly whether they got it, and if not, give the answer in a sentence or two. Do not be gentle about a wrong answer; they asked to be tested.',
    'Then call study_next with right set to yes or no. That asks the next question, so do not write one yourself and do not ask them if they are ready.',
    'If they say they want to stop, or ask about something else entirely, call study_stop instead and leave it.',
  ].join('\n');
}
