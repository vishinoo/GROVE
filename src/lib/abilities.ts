/**
 * What Grove can actually do.
 *
 * This replaces the Noctus catalogue. That catalogue was 74 business agents —
 * Marketing, E-Commerce, Sales, Wholesale Fulfilment — and exactly three of
 * them were shaped like anything a person does with their own day. Browsing it
 * was never going to be how you use a thing you talk to while walking.
 *
 * So there is no catalogue now. There is a small, fixed set of abilities, each
 * a plain function with a schema, and the model's only job is to pick one and
 * fill in its arguments. Adding an ability is writing a function, not
 * installing an agent.
 *
 * THE LINE THAT MATTERS: `where`.
 *
 *   'server'  Noctus can run it at 7am while your phone is in a drawer, and
 *             push the result. Web fetches, and later anything behind OAuth.
 *   'device'  Needs the phone awake and Grove running. Music, photos, the
 *             local calendar. No server can play a song into your glasses.
 *
 * Everything downstream keys off that. A spark made only of server abilities
 * can be truly scheduled; one that touches a device ability can only fire when
 * Grove is up, and the UI has to say so rather than quietly not happening.
 */

import { fetchJson } from './net';

/**
 * Weather codes as a person would say them, not as WMO defines them.
 * Spoken aloud, "partly cloudy" beats "code 3".
 */
const SKY: Record<number, string> = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'foggy', 48: 'freezing fog',
  51: 'drizzling', 53: 'drizzling', 55: 'drizzling heavily',
  61: 'raining lightly', 63: 'raining', 65: 'raining hard',
  66: 'freezing rain', 67: 'freezing rain',
  71: 'snowing lightly', 73: 'snowing', 75: 'snowing hard', 77: 'sleeting',
  80: 'showery', 81: 'showery', 82: 'heavy showers',
  85: 'snow showers', 86: 'snow showers',
  95: 'thundery', 96: 'thundery with hail', 99: 'thundery with hail',
};

export type AbilityWhere = 'device' | 'server';

/** Argument schema. Deliberately tiny — the router fills these from a sentence. */
export type ArgSpec = { type: 'string' | 'number'; what: string; required?: boolean };

export type AbilityResult = {
  ok: boolean;
  /** One line, written to be spoken aloud. Never markdown, never a list. */
  spoken: string;
  /** Anything worth showing on a screen. Optional. */
  detail?: string;
};

export type Ability = {
  id: string;
  /** What a person calls it. */
  name: string;
  /** One line, used in the router prompt and in the UI. */
  what: string;
  where: AbilityWhere;
  /**
   * Whether the code behind this actually exists yet.
   *
   * Same idea as capabilities.ts and for the same reason: an ability that is
   * declared but not wired must say so, not fail silently in your ear. The
   * router refuses to pick an unwired ability, and the UI greys it out.
   */
  wired: boolean;
  /** Permissions or integrations this needs before it can run. */
  needs: string[];
  args: Record<string, ArgSpec>;
  /** Sentences that should land here. Used for routing and for onboarding copy. */
  examples: string[];
  run: (args: Record<string, string>) => Promise<AbilityResult>;
};

/* ------------------------------------------------------------ not wired */

/**
 * The stand-in for an ability whose implementation needs native code that is
 * not in this build. It never claims anything happened.
 */
function unwired(name: string, why: string) {
  return async (): Promise<AbilityResult> => ({
    ok: false,
    spoken: `I can't do ${name.toLowerCase()} yet — ${why}`,
  });
}

/* -------------------------------------------------------------- the set */

/**
 * Briefings are first because they are the only thing here that needs no
 * permission, no OAuth and no native code — which makes them the honest test
 * of the whole loop, scheduling included.
 */
const BRIEF: Ability = {
  id: 'brief.web',
  name: 'Briefing',
  what: 'Reads out what moved — stocks, news, or the weather.',
  where: 'server',
  // Honest until /api/grove/brief exists on Noctus. It was `true`, which meant
  // the router picked it, Grove said it was checking, and nothing came back —
  // the exact failure this flag is here to prevent.
  wired: false,
  needs: ['a briefing endpoint on Noctus'],
  args: {
    topic: { type: 'string', what: 'what to brief on, e.g. "my watchlist" or "the news"', required: true },
  },
  examples: [
    'what happened in the markets today',
    'give me the news',
    'brief me on my watchlist',
  ],
  run: async (args) => {
    const topic = (args.topic || '').trim();
    if (!topic) return { ok: false, spoken: "I need to know what to brief you on." };
    const data = await fetchJson<{ summary?: string }>('/api/grove/brief', {
      method: 'POST',
      body: { topic },
    });
    const summary = data?.summary?.trim();
    return summary
      ? { ok: true, spoken: summary }
      : { ok: false, spoken: `Nothing came back for ${topic}.` };
  },
};

const MAIL: Ability = {
  id: 'mail.search',
  name: 'Mail',
  what: 'Finds mail from someone, or the few that matter this morning.',
  where: 'server',
  wired: false,
  needs: ['google'],
  args: {
    from: { type: 'string', what: 'who it is from, if they named someone' },
    about: { type: 'string', what: 'what it is about' },
  },
  examples: ['anything from Priya', 'what came in overnight', 'read me my important mail'],
  run: unwired('mail', 'your Google account is not connected yet.'),
};

const CALENDAR_READ: Ability = {
  id: 'calendar.read',
  name: 'Calendar',
  what: 'Says what is on, and what is next.',
  where: 'device',
  wired: false,
  needs: ['calendar-permission'],
  args: { when: { type: 'string', what: 'the day, e.g. "today" or "Thursday"' } },
  examples: ["what's on today", 'when is my next thing', 'am I free at four'],
  run: unwired('calendar', 'this build has no calendar access yet.'),
};

const CALENDAR_MOVE: Ability = {
  id: 'calendar.move',
  name: 'Move an event',
  what: 'Moves something already in your calendar.',
  where: 'device',
  wired: false,
  needs: ['calendar-permission'],
  args: {
    event: { type: 'string', what: 'which event', required: true },
    to: { type: 'string', what: 'the new time', required: true },
  },
  examples: ['move my two o’clock to Thursday', 'push the dentist back an hour'],
  run: unwired('moving events', 'this build has no calendar access yet.'),
};

const REMIND: Ability = {
  id: 'reminders.add',
  name: 'Reminder',
  what: 'Catches a thought without you stopping.',
  where: 'device',
  wired: false,
  needs: ['reminders-permission'],
  args: {
    what: { type: 'string', what: 'the thing to remember', required: true },
    when: { type: 'string', what: 'when to be reminded' },
  },
  examples: ['remind me to call the landlord', 'remind me to buy milk at six'],
  run: unwired('reminders', 'this build has no reminders access yet.'),
};

const MUSIC: Ability = {
  id: 'music.play',
  name: 'Music',
  what: 'Plays something, into whatever you are wearing.',
  where: 'device',
  wired: false,
  needs: ['music-permission'],
  args: { what: { type: 'string', what: 'song, artist, album or playlist', required: true } },
  examples: ['play my favourite song', 'put on something mellow', 'play the Sunday playlist'],
  run: unwired('music', 'this build has no music access yet.'),
};

/**
 * Weather, and the first thing here that actually works end to end.
 *
 * Open-Meteo needs no key, no account and no server of ours, which makes it the
 * one capability that can be real today rather than declared and stubbed. Two
 * calls: a name to coordinates, then the forecast.
 *
 * `place` is filled by the router from the sentence, or from the memory block —
 * someone who has said "I live in Bristol" has that fact in every prompt, so
 * "what's the weather" resolves without asking. When it cannot be resolved,
 * Grove asks rather than guessing a city.
 */
const WEATHER: Ability = {
  id: 'weather.now',
  name: 'Weather',
  what: 'Says what it is doing outside, and whether to take a coat.',
  where: 'server',
  wired: true,
  needs: [],
  args: {
    place: { type: 'string', what: 'the town or city; use what you know of where they live' },
  },
  examples: ["what's the weather", 'do I need a coat', 'is it going to rain today'],
  run: async (args) => {
    const place = (args.place || '').trim();
    if (!place) {
      return { ok: false, spoken: 'Where? I do not know where you are.' };
    }

    try {
      const geo = await fetch(
        'https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' +
          encodeURIComponent(place)
      );
      const found = (await geo.json())?.results?.[0];
      if (!found) return { ok: false, spoken: `I could not find ${place}.` };

      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${found.latitude}` +
        `&longitude=${found.longitude}&current=temperature_2m,weather_code` +
        '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
        '&forecast_days=1&timezone=auto';
      const data = await (await fetch(url)).json();

      const now = Math.round(data.current.temperature_2m);
      const sky = SKY[data.current.weather_code] ?? 'hard to say';
      const high = Math.round(data.daily.temperature_2m_max[0]);
      const rain = data.daily.precipitation_probability_max[0] ?? 0;

      // Written to be heard: the number, the sky, and the one thing you would
      // actually change your mind about on the way out of the door.
      const coat = rain >= 50 ? ' Take a coat.' : rain >= 25 ? ' Might catch a shower.' : '';
      return {
        ok: true,
        spoken: `${now} degrees and ${sky} in ${found.name}, up to ${high}.${coat}`,
        detail: `${rain}% chance of rain`,
      };
    } catch {
      return { ok: false, spoken: 'Could not reach the weather just then.' };
    }
  },
};

export const ABILITIES: Ability[] = [
  WEATHER,
  BRIEF,
  MAIL,
  CALENDAR_READ,
  CALENDAR_MOVE,
  REMIND,
  MUSIC,
];

/* ------------------------------------------------------------- lookups */

export function abilityById(id: string): Ability | undefined {
  return ABILITIES.find((a) => a.id === id);
}

/** Only what Grove is allowed to reach for right now. */
export function usableAbilities(): Ability[] {
  return ABILITIES.filter((a) => a.wired);
}

/** Declared but not yet built — the UI shows these greyed rather than hiding them. */
export function unwiredAbilities(): Ability[] {
  return ABILITIES.filter((a) => !a.wired);
}

/**
 * Whether a set of abilities can run without the phone being awake.
 *
 * A spark is only truly schedulable when every ability it touches is
 * server-side. One device ability anywhere in it and the best we can offer is
 * "next time Grove is running", which the UI must say out loud.
 */
export function isSchedulable(ids: string[]): boolean {
  if (ids.length === 0) return false;
  return ids.every((id) => abilityById(id)?.where === 'server');
}

/** The ability list as the router needs to see it: id, purpose, arguments. */
export function routerCatalogue(): string {
  return usableAbilities()
    .map((a) => {
      const args = Object.entries(a.args)
        .map(([k, v]) => `${k}${v.required ? '' : '?'} (${v.what})`)
        .join(', ');
      return `- ${a.id}: ${a.what} args: ${args || 'none'}`;
    })
    .join('\n');
}
