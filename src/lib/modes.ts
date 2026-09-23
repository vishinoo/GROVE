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

export type ModeId =
  | 'normal'
  | 'focus'
  | 'study'
  | 'wind-down'
  | 'work'
  | 'gym'
  | 'social'
  | 'travel'
  | 'home';

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
    id: 'study',
    tint: '#A78BFA',
    palette: ['#8B5CF6', '#A78BFA', '#C4B5FD', '#D946EF'],
    label: 'Study',
    what: 'Explains properly instead of being terse.',
    manner:
      'They are learning something. Explain it properly — three or four sentences is right here, and being clipped is unhelpful. Use an example. Check they followed before moving on.',
    allow: [
      'mode.set', 'notes.search', 'memory.recall', 'memory.add', 'calendar.find', 'music.play',
      'doc.find', 'reminders.add', 'calendar.read', 'gcal.read', 'calendar.add',
      'mail.search', 'contact.find',
      'weather.now', 'maps.eta', 'maps.go', 'music.recent', 'doc.create', 'doc.recent',
      'now.context', 'memory.search', 'memory.done', 'person.brief', 'reminders.batch',
      'inbox.add', 'inbox.review', 'focus.start', 'focus.end',
    ],
    interrupt: 'never',
    // Study is the one mode where being asked something back is the point, so
    // entering it opens with the question rather than an announcement.
    onEnter: 'Ask me what I am studying, then put on something instrumental without words.',
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
    id: 'work',
    tint: '#F59E0B',
    palette: ['#F59E0B', '#FBBF24', '#FB923C', '#EAB308'],
    label: 'Work',
    what: 'Operating. Everything on, nothing volunteered mid-thought.',
    manner:
      'They are working. Be an operator, not a companion: the answer first, in as few words as carry it, and the next action named. Say what you did rather than what you are about to do.',
    // Everything, because work is the mode where the whole toolkit is the
    // point — mail, calendar, documents, the laptop. What changes is the
    // manner and that Grove stops volunteering things mid-thought.
    allow: null,
    interrupt: 'sparingly',
    onEnter: 'Tell me what needs my attention — my next meeting and anything in my inbox that actually needs me — in two sentences.',
    stuck: "Can't reach that right now.",
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
  {
    id: 'social',
    tint: '#EC4899',
    palette: ['#EC4899', '#F472B6', '#FB7185', '#C084FC'],
    label: 'Social',
    what: 'Out with people. Who they are, where to go, no work.',
    manner:
      'They are out with people and talking to you between sentences of a real conversation. Be quick and quiet. Never raise work, deadlines or mail.',
    allow: [
      'mode.set', 'person.brief', 'contact.find', 'call.start', 'message.compose', 'maps.go',
      'maps.eta', 'ride.request', 'food.order', 'shop.order', 'calendar.read', 'calendar.find', 'calendar.add',
      'weather.now', 'music.play', 'music.recent', 'memory.add', 'memory.search', 'notes.search',
      'reminders.add', 'now.context', 'inbox.add', 'inbox.review',
    ],
    interrupt: 'never',
    stuck: "Can't check that just now.",
  },
  {
    id: 'travel',
    tint: '#06B6D4',
    palette: ['#0891B2', '#06B6D4', '#22D3EE', '#38BDF8'],
    label: 'Travel',
    what: 'Moving. Times, routes, confirmations.',
    manner:
      'They are travelling. Logistics first: times, platforms, gates, how long, what is next. Say the number before the sentence about it.',
    allow: [
      'mode.set', 'maps.go', 'maps.eta', 'weather.now', 'calendar.read', 'gcal.read', 'calendar.find',
      'calendar.add', 'mail.search', 'mail.important', 'doc.find', 'ride.request', 'contact.find',
      'call.start', 'message.compose', 'reminders.add', 'memory.search', 'notes.search', 'music.play',
      'music.recent', 'now.context', 'person.brief', 'brief.web', 'inbox.add', 'inbox.review',
    ],
    interrupt: 'sparingly',
    onEnter: 'Tell me what is next today, how long it takes to get there, and what it is doing outside.',
    stuck: 'Cannot reach that right now.',
  },
  {
    id: 'home',
    tint: '#A3E635',
    palette: ['#84CC16', '#A3E635', '#FACC15', '#4ADE80'],
    label: 'Home',
    what: 'Off the clock, but the day is not over.',
    manner:
      'They are at home and off duty. Relaxed and unhurried. Work only if they raise it, and then briefly.',
    allow: null,
    interrupt: 'sparingly',
    onEnter: 'Tell me anything I still need to do today, in one sentence.',
    stuck: "Can't check that just now.",
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
