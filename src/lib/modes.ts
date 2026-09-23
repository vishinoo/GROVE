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

export type ModeId = 'normal' | 'focus' | 'gym' | 'wind-down';

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
    stuck: 'Nothing came back. Try me again in a second.',
  },
  {
    id: 'focus',
    tint: '#38BDF8',
    palette: ['#0EA5E9', '#38BDF8', '#6366F1', '#22D3EE'],
    label: 'Focus',
    what: 'Working. Grove stays quiet unless asked.',
    manner: 'They are concentrating. Answer in as few words as will do, and never volunteer more.',
    // Reading mail on request is not an interruption — asking for it is the
    // opposite of being interrupted by it. `interrupt: never` below is what
    // actually protects concentration. Sending stays off: composing mail is the
    // thing that pulls someone out of what they were doing.
    allow: [
      'mode.set', 'notes.search', 'reminders.add', 'calendar.read', 'gcal.read', 'calendar.find',
      'calendar.add', 'weather.now', 'memory.recall', 'memory.add', 'music.play', 'music.recent',
      'mail.search', 'mail.summarise', 'mail.important', 'contact.find',
      'now.context', 'memory.search', 'memory.done', 'person.brief', 'reminders.batch',
      'inbox.add', 'inbox.review', 'focus.start', 'focus.end',
    ],
    interrupt: 'never',
    // Something happens on the way in, rather than the mode being a label on a
    // manner. What it does is what focus actually needs: know what is coming so
    // it can stop guarding the clock, and something to work to.
    onEnter: 'Tell me what is left on my calendar today in one sentence, then put on something instrumental to work to.',
    stuck: 'No answer right now.',
  },
  {
    id: 'wind-down',
    tint: '#FB7185',
    palette: ['#F43F5E', '#FB923C', '#FBBF24', '#E879F9'],
    label: 'Wind down',
    what: 'Evening. Nothing that starts work.',
    manner: 'It is the end of their day. Keep it calm and short. Do not raise anything that would start them working.',
    // Nothing that opens a thread: no mail, no sending.
    // Reading is fine in the evening; starting a thread is not. No sending, no
    // replying, no calling — those are the ones that turn a wind-down into work.
    allow: [
      'mode.set', 'notes.search', 'music.play', 'music.recent', 'weather.now', 'reminders.add', 'memory.recall',
      'memory.add', 'day.brief', 'calendar.read', 'gcal.read', 'calendar.find',
      'mail.search', 'now.context', 'memory.search', 'memory.done', 'person.brief', 'reminders.batch',
      'inbox.add', 'inbox.review', 'focus.start', 'focus.end',
    ],
    interrupt: 'sparingly',
    // The evening version of a brief: what is coming tomorrow, said once, and
    // something quiet on. Nothing that opens a thread — no mail, no sending —
    // which is what the allow list above is for.
    onEnter: 'Tell me what is on tomorrow in one sentence, then put on something calm.',
    stuck: "Can't check that just now.",
  },
  {
    id: 'gym',
    tint: '#22C55E',
    palette: ['#16A34A', '#22C55E', '#4ADE80', '#A3E635'],
    label: 'Gym',
    what: 'Training. Music, timers and nothing that starts work.',
    manner:
      'They are training and out of breath. One short sentence, nothing to read, no lists. Never bring up work, mail or anything that needs a decision.',
    allow: [
      'mode.set', 'music.play', 'music.recent', 'weather.now', 'reminders.add', 'reminders.batch',
      'memory.add', 'memory.search', 'notes.search', 'calendar.read', 'calendar.find', 'now.context',
      'inbox.add', 'inbox.review', 'focus.start', 'focus.end',
    ],
    interrupt: 'never',
    onEnter: 'Put on something with energy to train to.',
    stuck: 'No answer right now.',
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
