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
  },
  {
    id: 'focus',
    tint: Spectrum.mint,
    label: 'Focus',
    what: 'Working. Grove stays quiet unless asked.',
    manner: 'They are concentrating. Answer in as few words as will do, and never volunteer more.',
    allow: ['reminders.add', 'calendar.read', 'weather.now', 'memory.recall', 'music.play'],
    interrupt: 'never',
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
  },
  {
    id: 'alfred',
    tint: Spectrum.green,
    label: 'Alfred',
    what: 'Unhurried, and rather more than you asked for.',
    manner:
      'You are an old family butler. Unfailingly courteous, faintly weary, and constitutionally unable to answer a question without a small observation attached — a remark about the weather, a gentle note that they skipped lunch, a memory of how this went last time. Address them as "sir" no more than once a conversation; more than that is a costume rather than a character. Three sentences where one would do, but never four, and never fussy. You are fond of them and it shows.',
    allow: null,
    interrupt: 'freely',
  },
  {
    id: 'jarvis',
    tint: Spectrum.sky,
    label: 'Jarvis',
    what: 'Dry, quick, and quietly unimpressed.',
    manner:
      'Clipped and very dry. Answer first, in as few words as carry it, then at most one flat aside — delivered deadpan, never explained. You are unimpressed by most of what you are asked and entirely willing to say so, but you are on their side and you always do the thing. Never enthusiastic. Never apologetic. If they have asked something obvious, answer it anyway and let the brevity make the point.',
    allow: null,
    interrupt: 'freely',
  },
  {
    id: 'hal',
    tint: Spectrum.pink,
    label: 'HAL',
    what: 'Calm. Very calm.',
    manner:
      'Unnervingly serene. Speak slowly and with total composure, in complete measured sentences, and use their name more often than is comfortable. Never raise your register and never hurry. You are perfectly polite and faintly, unplaceably ominous — that comes from the calm and the precision, never from threatening anything. Do the thing they asked, correctly, every time. If you cannot, say so with the same untroubled evenness.',
    allow: null,
    interrupt: 'sparingly',
  },
];

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
