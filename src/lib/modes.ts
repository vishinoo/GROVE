/**
 * Modes.
 *
 * A mode is not a feature. It is three things Grove already has, bundled: a
 * manner, a set of abilities it will reach for, and how freely it may speak
 * first. Nothing here is new machinery — which is exactly why it was worth
 * building, because the alternative reading of "modes" is a second product
 * hiding inside the first.
 *
 * WHAT A MODE ACTUALLY CHANGES
 *
 *   manner    goes into the system prompt, on top of the user's own words.
 *             Commute wants terse; study wants patient.
 *   abilities narrows what the router may pick. Driving is the case that
 *             matters: reading mail aloud at a junction is a worse idea than
 *             not having mail at all.
 *   speak     how readily Grove volunteers something unprompted. The setting
 *             that stops a proactive assistant becoming an irritating one.
 *
 * NOT A PERSONALITY
 *
 * Alfred, Jarvis and HAL used to live here and were moved out, because they are
 * ways of *speaking* rather than situations you are in — they belong to
 * persona.ts, which owns who Grove is, and they survive a mode change. Wind
 * down is a mode: it is a moment in your day, it dims the lights and puts
 * something on, and it would do that whichever voice were reading it out.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Ability } from './abilities';

export type ModeId = 'normal' | 'focus' | 'study' | 'wind-down';

export type Mode = {
  id: ModeId;
  label: string;
  /**
   * The mode's colour, drawn from the orb's spectrum so the two read as one
   * system. Used on the chip and on the orb, so which mode you are in is
   * something you see rather than something you remember.
   */
  tint: string;
  /**
   * The whole orb, not an accent.
   *
   * Tinting one lobe of five was too subtle to read at a glance — the orb still
   * looked like the default with a slightly odd edge. A mode gets its own
   * palette instead, so the thing you are looking at while you talk tells you
   * what state you are in without a label: focus is cold and quiet, wind down
   * is a sunset, study is ink and paper.
   */
  palette: string[];
  /** One line, shown under the name. */
  what: string;
  /**
   * Added to the system prompt beneath the user's own manner. Kept short: it
   * competes with everything else in there for the model's attention.
   */
  manner: string;
  /**
   * Ability ids this mode allows, or null for all of them. A narrow list is a
   * safety feature as much as a focus one.
   */
  allow: string[] | null;
  /**
   * How readily Grove speaks without being asked. Sparks respect this, which is
   * the whole reason it exists — an assistant that interrupts you during a
   * lecture stops being used at all.
   */
  interrupt: 'freely' | 'sparingly' | 'never';
  /**
   * What happens the moment you enter the mode, in your own words.
   *
   * This is what makes a mode conditional rather than cosmetic: "every time I'm
   * in commute mode, put on my driving playlist" is a standing instruction
   * attached to a situation instead of to a clock. Empty by default and edited
   * per person — a default that starts playing music unasked would be worse
   * than no feature.
   */
  onEnter?: string;
  /**
   * Said aloud when a turn is taking long enough that silence would read as a
   * crash — while a search is genuinely in flight.
   *
   * This is not the promise the prompt forbids. That rule exists because "let
   * me check" with nothing behind it ends the conversation with someone
   * waiting. Here the work is already running and the answer is guaranteed to
   * follow, so saying so is the honest thing rather than the dishonest one.
   *
   * Several per mode, picked at random: the same sentence every time is how you
   * notice it is a canned line rather than someone talking to you.
   */
  holding: string[];
  /** When the search came back with nothing worth saying. */
  empty: string;
  /** When nothing answered at all — no model, no network. */
  stuck: string;
};

const STORE = 'grove:modes:v1';

export const MODES: Mode[] = [
  {
    id: 'normal',
    tint: '#7DD3FC',
    palette: ['#5EEAD4', '#7DD3FC', '#A5B4FC', '#86EFAC'],
    label: 'Normal',
    what: 'Everything, as you have set it up.',
    manner: '',
    allow: null,
    interrupt: 'freely',
    holding: ['One second.', 'Give me a moment.', 'Looking now.'],
    empty: "I couldn't find anything on that.",
    stuck: 'Nothing came back. Try me again in a second.',
  },
  {
    id: 'focus',
    tint: '#38BDF8',
    palette: ['#0EA5E9', '#38BDF8', '#6366F1', '#22D3EE'],
    label: 'Focus',
    what: 'Working. Grove stays quiet unless asked.',
    manner: 'They are concentrating. Answer in as few words as will do, and never volunteer more.',
    allow: ['mode.set', 'reminders.add', 'calendar.read', 'gcal.read', 'calendar.find', 'calendar.add', 'weather.now', 'memory.recall', 'music.play'],
    interrupt: 'never',
    holding: ['Moment.', 'Checking.'],
    empty: 'Nothing useful.',
    stuck: 'No answer right now.',
  },
  {
    id: 'study',
    tint: '#A78BFA',
    palette: ['#8B5CF6', '#A78BFA', '#C4B5FD', '#D946EF'],
    label: 'Study',
    what: 'Explains properly instead of being terse.',
    manner:
      'They are learning something. Explain it properly — three or four sentences is right here, and being clipped is unhelpful. Use an example. Check they followed before moving on.',
    allow: ['mode.set', 'memory.recall', 'reminders.add', 'calendar.read', 'gcal.read', 'calendar.find', 'calendar.add'],
    interrupt: 'never',
    holding: ['Let me look that up properly — one moment.', 'Good question. Give me a second to check rather than guess.'],
    empty: "I couldn't find a good source for that, so I'd rather not guess.",
    stuck: "I can't reach anything to check that with at the moment.",
  },
  {
    id: 'wind-down',
    tint: '#FB7185',
    palette: ['#F43F5E', '#FB923C', '#FBBF24', '#E879F9'],
    label: 'Wind down',
    what: 'Evening. Nothing that starts work.',
    manner: 'It is the end of their day. Keep it calm and short. Do not raise anything that would start them working.',
    // Nothing that opens a thread: no mail, no sending.
    allow: ['mode.set', 'music.play', 'weather.now', 'reminders.add', 'memory.recall', 'day.brief'],
    interrupt: 'sparingly',
    holding: ['One moment.', 'Just having a look.'],
    empty: 'Nothing on that one.',
    stuck: "Can't check that just now.",
  },
];

/** One of the mode's holding lines, at random. */
export function holdingLine(mode: Mode): string {
  const lines = mode.holding.length > 0 ? mode.holding : ['One second.'];
  return lines[Math.floor(Math.random() * lines.length)];
}

export function modeById(id: string): Mode {
  return MODES.find((m) => m.id === id) ?? MODES[0];
}

/* ------------------------------------------------- what you have taught it */

type Overrides = Record<string, { onEnter?: string }>;

/**
 * The parts of a mode the user has written themselves.
 *
 * Stored separately from MODES so the built-in definitions stay a constant and
 * an upgrade cannot silently discard what someone taught it.
 */
export async function loadOverrides(): Promise<Overrides> {
  try {
    const raw = await AsyncStorage.getItem(STORE);
    return raw ? (JSON.parse(raw) as Overrides) : {};
  } catch {
    return {};
  }
}

export async function setOnEnter(id: string, instruction: string): Promise<Overrides> {
  const all = await loadOverrides();
  const next: Overrides = { ...all, [id]: { onEnter: instruction.trim().slice(0, 300) } };
  try {
    await AsyncStorage.setItem(STORE, JSON.stringify(next));
  } catch {
    // A rule that fails to persist is a lost setting, not a broken mode.
  }
  return next;
}

/** A mode with whatever the user has taught it folded in. */
export function withOverrides(mode: Mode, overrides: Overrides): Mode {
  const own = overrides[mode.id];
  return own?.onEnter ? { ...mode, onEnter: own.onEnter } : mode;
}

/** The abilities a mode permits, out of those that work at all. */
export function abilitiesFor(mode: Mode, all: Ability[]): Ability[] {
  const wired = all.filter((a) => a.wired);
  if (!mode.allow) return wired;
  return wired.filter((a) => mode.allow!.includes(a.id));
}

/**
 * Whether a spark may speak up right now.
 *
 * The rate control the roadmap asks for, in the only place it can honestly
 * live. 'sparingly' is once an hour rather than a judgement call, because a
 * model deciding whether it is being annoying is not a check on anything.
 */
export function maySpeak(mode: Mode, lastSpokeAt: string | null, now = new Date()): boolean {
  if (mode.interrupt === 'never') return false;
  if (mode.interrupt === 'freely') return true;
  if (!lastSpokeAt) return true;
  const since = now.getTime() - new Date(lastSpokeAt).getTime();
  return Number.isFinite(since) ? since >= 3_600_000 : true;
}
