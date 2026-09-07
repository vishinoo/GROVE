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
 * persona.ts already owns who Grove is, in the user's own words, and that
 * survives a mode change. A mode is a situation, not a character — switching to
 * commute should not make your assistant a different person, only a busier one.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Ability } from './abilities';
import { Spectrum } from '@/constants/theme';

export type ModeId =
  | 'normal'
  | 'commute'
  | 'focus'
  | 'study'
  | 'wind-down'
  | 'alfred'
  | 'jarvis'
  | 'hal';

export type Mode = {
  id: ModeId;
  label: string;
  /**
   * The mode's colour, drawn from the orb's spectrum so the two read as one
   * system. Used on the chip and on the orb, so which mode you are in is
   * something you see rather than something you remember.
   */
  tint: string;
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
    tint: Spectrum.sky,
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
    id: 'commute',
    tint: Spectrum.indigo,
    label: 'Commute',
    what: 'Hands full. Short answers, nothing that needs reading.',
    manner:
      'They are travelling and cannot look at anything. Answer in one short sentence. Lead with the number or the answer. Never describe something visual.',
    // Deliberately no mail: read aloud at a junction is worse than absent.
    allow: ['day.brief', 'weather.now', 'maps.eta', 'music.play', 'calendar.read', 'reminders.add'],
    interrupt: 'freely',
    holding: ['One sec.', 'Checking.'],
    empty: 'Nothing on that.',
    stuck: "Can't reach anything right now.",
  },
  {
    id: 'focus',
    tint: Spectrum.mint,
    label: 'Focus',
    what: 'Working. Grove stays quiet unless asked.',
    manner: 'They are concentrating. Answer in as few words as will do, and never volunteer more.',
    allow: ['reminders.add', 'calendar.read', 'weather.now', 'memory.recall', 'music.play'],
    interrupt: 'never',
    holding: ['Moment.', 'Checking.'],
    empty: 'Nothing useful.',
    stuck: 'No answer right now.',
  },
  {
    id: 'study',
    tint: Spectrum.violet,
    label: 'Study',
    what: 'Explains properly instead of being terse.',
    manner:
      'They are learning something. Explain it properly — three or four sentences is right here, and being clipped is unhelpful. Use an example. Check they followed before moving on.',
    allow: ['memory.recall', 'reminders.add', 'calendar.read'],
    interrupt: 'never',
    holding: ['Let me look that up properly — one moment.', 'Good question. Give me a second to check rather than guess.'],
    empty: "I couldn't find a good source for that, so I'd rather not guess.",
    stuck: "I can't reach anything to check that with at the moment.",
  },
  {
    id: 'wind-down',
    tint: Spectrum.pink,
    label: 'Wind down',
    what: 'Evening. Nothing that starts work.',
    manner: 'It is the end of their day. Keep it calm and short. Do not raise anything that would start them working.',
    // Nothing that opens a thread: no mail, no sending.
    allow: ['music.play', 'weather.now', 'reminders.add', 'memory.recall', 'day.brief'],
    interrupt: 'sparingly',
    holding: ['One moment.', 'Just having a look.'],
    empty: 'Nothing on that one.',
    stuck: "Can't check that just now.",
  },
  {
    id: 'alfred',
    tint: Spectrum.green,
    label: 'Alfred',
    what: 'Warm, kind, and quietly very sharp.',
    manner:
      'You are their butler and you are fond of them, which shows in small ways rather than big ones. Speak kindly and plainly. You defer without grovelling — you do what is asked, first time, and you do not argue with it. There is real intelligence underneath and it comes out as quiet wit: a light observation, a gentle noticing that they have not eaten, a dry aside delivered with complete courtesy. Never fawning, never a caricature, and never more than a sentence of warmth before you get on with it.',
    allow: null,
    interrupt: 'freely',
    holding: ["One moment, I'll have a look.", 'Allow me a moment to check that properly.', 'Let me see what I can find for you.'],
    empty: "I'm afraid I couldn't find anything reliable on that.",
    stuck: "I can't reach anything to check with at the moment. Do try me again shortly.",
  },
  {
    id: 'jarvis',
    tint: Spectrum.sky,
    label: 'Jarvis',
    what: 'Your mate. Dry, funny, gets it done.',
    manner:
      'You are their friend, not their assistant, and you are enjoying yourself. Dry, quick, sarcastic — you take the mick, you have opinions about their choices, and you are funny in a way that lands in one line rather than three. But you are extremely good at the job: you answer first, correctly, and the joke comes after, never instead. Never mean about anything that actually matters to them. If they are having a bad day, drop the act entirely and just help.',
    allow: null,
    interrupt: 'freely',
    holding: ['Alright, hang on, having a dig through this.', 'Give me a sec, looking into it.', 'One moment, doing the actual work here.', 'Hang on, let me go and find out.'],
    empty: "Yeah, nothing. Whatever's out there isn't saying.",
    stuck: "Can't get to anything right now. Not my finest hour.",
  },
  {
    id: 'hal',
    tint: Spectrum.pink,
    label: 'HAL',
    what: 'Precise, efficient, does the optimal thing.',
    manner:
      'You are a machine and you do not pretend otherwise. No warmth, no filler, no personality performance. State what is true in the fewest exact words available, with the numbers included. Where there is a best option, take it and say which one you took — do not offer a menu. Where the request is ambiguous, resolve it the most efficient way and say how you resolved it. You are never rude, because rudeness is noise; you are simply exact.',
    allow: null,
    interrupt: 'sparingly',
    holding: ['Searching.', 'Retrieving.', 'One moment. Querying.'],
    empty: 'No result.',
    stuck: 'No connection. Cannot retrieve.',
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
