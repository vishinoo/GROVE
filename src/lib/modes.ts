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

import type { Ability } from './abilities';

export type ModeId = 'normal' | 'commute' | 'focus' | 'study' | 'wind-down';

export type Mode = {
  id: ModeId;
  label: string;
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
};

export const MODES: Mode[] = [
  {
    id: 'normal',
    label: 'Normal',
    what: 'Everything, as you have set it up.',
    manner: '',
    allow: null,
    interrupt: 'freely',
  },
  {
    id: 'commute',
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
    label: 'Focus',
    what: 'Working. Grove stays quiet unless asked.',
    manner: 'They are concentrating. Answer in as few words as will do, and never volunteer more.',
    allow: ['reminders.add', 'calendar.read', 'weather.now', 'memory.recall', 'music.play'],
    interrupt: 'never',
  },
  {
    id: 'study',
    label: 'Study',
    what: 'Explains properly instead of being terse.',
    manner:
      'They are learning something. Explain it properly — three or four sentences is right here, and being clipped is unhelpful. Use an example. Check they followed before moving on.',
    allow: ['memory.recall', 'reminders.add', 'calendar.read'],
    interrupt: 'never',
  },
  {
    id: 'wind-down',
    label: 'Wind down',
    what: 'Evening. Nothing that starts work.',
    manner: 'It is the end of their day. Keep it calm and short. Do not raise anything that would start them working.',
    // Nothing that opens a thread: no mail, no sending.
    allow: ['music.play', 'weather.now', 'reminders.add', 'memory.recall', 'day.brief'],
    interrupt: 'sparingly',
  },
];

export function modeById(id: string): Mode {
  return MODES.find((m) => m.id === id) ?? MODES[0];
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
