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

import {
  addReminder,
  ensureCalendarAccess,
  ensureRemindersAccess,
  eventsAhead,
  moveEvent,
  readWhen,
  sayWhen,
} from './deviceCalendar';
import { capabilities } from './capabilities';
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

type MailMessage = { from?: string; subject?: string; snippet?: string; body?: string };

/** "Priya Sharma <p@x.com>" is not how you say a name out loud. */
function saySender(from: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  return (named?.[1] ?? from.replace(/[<>]/g, '')).split('@')[0].trim();
}

const MAIL_READ: Ability = {
  id: 'mail.search',
  name: 'Mail',
  what: 'Finds mail from someone and tells you what it says.',
  where: 'server',
  wired: true,
  needs: ['email'],
  args: {
    from: { type: 'string', what: 'who it is from, if they named someone' },
    about: { type: 'string', what: 'what it is about' },
  },
  examples: ['anything from Priya', 'what did Sam say about the invoice', 'read me my mail'],
  run: async (args) => {
    const params = new URLSearchParams();
    if (args.from) params.set('from', args.from);
    if (args.about) params.set('q', args.about);
    params.set('limit', '3');

    const data = await fetchJson<{ messages?: MailMessage[] }>(
      `/api/grove/mail?${params.toString()}`
    );
    if (!data) {
      return { ok: false, spoken: 'Could not reach your mail. Is Google connected?' };
    }

    const messages = data.messages ?? [];
    const who = args.from ? ` from ${args.from}` : '';
    if (messages.length === 0) return { ok: true, spoken: `Nothing${who}.` };

    // Spoken, so the newest one in full and the rest as a count. A list of
    // subject lines recited into your ear is not something anyone can follow.
    const [first] = messages;
    const sender = saySender(first.from ?? '');
    const gist = (first.body || first.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 320);

    let line = `${sender} says: ${gist}`;
    if (messages.length > 1) line += ` And ${messages.length - 1} more.`;
    return { ok: true, spoken: line, detail: first.subject };
  },
};

const MAIL_SEND: Ability = {
  id: 'mail.send',
  name: 'Send mail',
  what: 'Sends a message you dictate.',
  where: 'server',
  wired: true,
  needs: ['email'],
  args: {
    to: { type: 'string', what: 'who it goes to — a name is fine, it will be looked up', required: true },
    subject: { type: 'string', what: 'the subject line' },
    body: { type: 'string', what: 'what it says', required: true },
  },
  examples: ['email Priya to say I am running late', 'send Sam the address'],
  run: async (args) => {
    const asked = (args.to || '').trim();
    const body = (args.body || '').trim();
    if (!asked || !body) return { ok: false, spoken: 'Who to, and saying what?' };

    // A name is what people say; an address is what mail needs. Looked up in
    // your contacts rather than demanded, because you obviously know who Priya
    // is and being asked for her address is the friction this exists to remove.
    let to = asked;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(asked)) {
      const found = await fetchJson<{ matches?: { name: string; email: string }[] }>(
        `/api/grove/contact?name=${encodeURIComponent(asked)}`
      );
      const matches = found?.matches ?? [];
      if (matches.length === 0) return { ok: false, spoken: `I have no address for ${asked}.` };
      // Two people with the same first name is a question, not a coin toss —
      // and mail is the one ability here that cannot be taken back.
      if (matches.length > 1) {
        return {
          ok: false,
          spoken: `I have ${matches.length} people called ${asked}. Which one?`,
          detail: matches.map((m) => `${m.name} — ${m.email}`).join('\n'),
        };
      }
      to = matches[0].email;
    }

    const data = await fetchJson<{ sent?: boolean }>('/api/grove/mail', {
      method: 'POST',
      body: { to, subject: args.subject || '', body },
    });
    return data?.sent
      ? { ok: true, spoken: asked === to ? 'Sent.' : `Sent to ${asked}.` }
      : { ok: false, spoken: 'That did not send.' };
  },
};

const CALENDAR_READ: Ability = {
  id: 'calendar.read',
  name: 'Calendar',
  what: 'Says what is on, and what is next.',
  where: 'device',
  wired: true,
  needs: ['calendar-permission'],
  args: { when: { type: 'string', what: 'the day, e.g. "today" or "Thursday"' } },
  examples: ["what's on today", 'when is my next thing', 'am I free at four'],
  run: async (args) => {
    if (!(await ensureCalendarAccess())) {
      return { ok: false, spoken: 'I need permission to see your calendar. It is in iOS Settings.' };
    }
    // "tomorrow" and "this week" are the two that need a different window;
    // everything else is the day in front of you.
    const asked = (args.when || '').toLowerCase();
    const hours = /\bweek\b/.test(asked) ? 24 * 7 : /\btomorrow\b/.test(asked) ? 48 : 24;

    const events = await eventsAhead(hours);
    if (events === null) return { ok: false, spoken: 'Could not read your calendar.' };
    if (events.length === 0) {
      return { ok: true, spoken: hours > 24 ? 'Nothing this week.' : 'Nothing on.' };
    }

    // Spoken, so the first two and a count — a read-out list is unusable in
    // your ear past about three items.
    const [first, second] = events;
    const rest = events.length - 2;
    let line = `${first.title} at ${sayWhen(first.start)}`;
    if (second) line += `, then ${second.title} at ${sayWhen(second.start)}`;
    if (rest > 0) line += `, and ${rest} more`;
    return { ok: true, spoken: `${line}.`, detail: `${events.length} in the next ${hours}h` };
  },
};

const CALENDAR_MOVE: Ability = {
  id: 'calendar.move',
  name: 'Move an event',
  what: 'Moves something already in your calendar.',
  where: 'device',
  wired: true,
  needs: ['calendar-permission'],
  args: {
    event: { type: 'string', what: 'which event', required: true },
    to: { type: 'string', what: 'the new time', required: true },
  },
  examples: ['move my two o’clock to Thursday', 'push the dentist back an hour'],
  run: async (args) => {
    const which = (args.event || '').trim();
    const when = readWhen(args.to || '');
    if (!which) return { ok: false, spoken: 'Which one?' };
    // Refusing to guess is the point. A misread date moves a real appointment.
    if (!when) return { ok: false, spoken: 'When do you want it moved to?' };

    const result = await moveEvent(which, when);
    return result.ok
      ? { ok: true, spoken: `Moved ${result.title} to ${sayWhen(when)}.` }
      : { ok: false, spoken: `I could not find ${which} in your calendar.` };
  },
};

const REMIND: Ability = {
  id: 'reminders.add',
  name: 'Reminder',
  what: 'Catches a thought without you stopping.',
  where: 'device',
  wired: true,
  needs: ['reminders-permission'],
  args: {
    what: { type: 'string', what: 'the thing to remember', required: true },
    when: { type: 'string', what: 'when to be reminded' },
  },
  examples: ['remind me to call the landlord', 'remind me to buy milk at six'],
  run: async (args) => {
    const what = (args.what || '').trim().replace(/^to\s+/i, '');
    if (!what) return { ok: false, spoken: 'Remind you to do what?' };
    if (!(await ensureRemindersAccess())) {
      return { ok: false, spoken: 'I need permission for Reminders. It is in iOS Settings.' };
    }
    // A reminder with no time is still a useful reminder, unlike a moved event
    // with no time — so this one does not refuse.
    const due = args.when ? readWhen(args.when) : null;
    const saved = await addReminder(what, due);
    if (!saved) return { ok: false, spoken: 'Could not save that reminder.' };
    return { ok: true, spoken: due ? `Reminder set for ${sayWhen(due)}.` : 'Added to your reminders.' };
  },
};

/**
 * Music, through the system player.
 *
 * Needs the native module, so it is wired only on a development build — the
 * probe in capabilities.ts is what makes that honest rather than a crash. In
 * Expo Go it says so and does not pretend.
 */
const MUSIC: Ability = {
  id: 'music.play',
  name: 'Music',
  what: 'Plays something from your library, into whatever you are wearing.',
  where: 'device',
  wired: capabilities().remote,
  needs: ['music-permission'],
  args: { what: { type: 'string', what: 'song, artist, album or playlist', required: true } },
  examples: ['play my favourite song', 'put on something mellow', 'play the Sunday playlist'],
  run: async (args) => {
    const wanted = (args.what || '').trim();
    if (!wanted) return { ok: false, spoken: 'Play what?' };

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const remote = require('grove-remote') as typeof import('grove-remote');
    const result = await remote.playMusic(wanted);

    if (result.ok) {
      const artist = result.artist ? ` by ${result.artist}` : '';
      return { ok: true, spoken: `Playing ${result.title}${artist}.` };
    }
    if (result.reason === 'denied') {
      return { ok: false, spoken: 'I need permission for your music library. It is in iOS Settings.' };
    }
    if (result.reason === 'unavailable') {
      return { ok: false, spoken: 'Music needs a development build. This one cannot reach it.' };
    }
    return { ok: false, spoken: `I could not find ${wanted} in your library.` };
  },
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

/**
 * How long to get somewhere, and when to leave.
 *
 * MapKit, so no key and no account — the same engine that answers this on the
 * lock screen, which means Grove and the phone never disagree about the ETA.
 *
 * "Home" and "work" resolve through memory rather than here: where you live is
 * a fact about you, and memory.ts already carries it into every prompt, so the
 * router fills the real place in before this ever runs.
 */
const DIRECTIONS: Ability = {
  id: 'maps.eta',
  name: 'Maps',
  what: 'Says how long to somewhere, and when to leave.',
  where: 'device',
  wired: capabilities().remote,
  needs: ['location-permission'],
  args: {
    to: { type: 'string', what: 'where to — use what you know of where they live or work', required: true },
    how: { type: 'string', what: '"walking" if they said so, otherwise driving' },
  },
  examples: ['how long to get home', 'when should I leave for the office', 'how far is the station'],
  run: async (args) => {
    const to = (args.to || '').trim();
    if (!to) return { ok: false, spoken: 'Where to?' };

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const remote = require('grove-remote') as typeof import('grove-remote');
    const driving = !/walk|foot/i.test(args.how || '');
    const result = await remote.travelTime(to, driving);

    if (!result.ok) {
      if (result.reason === 'denied') {
        return { ok: false, spoken: 'I need location access. It is in iOS Settings.' };
      }
      if (result.reason === 'unavailable') {
        return { ok: false, spoken: 'Directions need a development build.' };
      }
      if (result.reason === 'notFound') return { ok: false, spoken: `I could not find ${to}.` };
      return { ok: false, spoken: `No route to ${to}.` };
    }

    const mins = Math.round((result.seconds ?? 0) / 60);
    const km = (result.metres ?? 0) / 1000;
    // Spoken, so minutes and one decimal at most — nobody acts on "23.4 minutes".
    const how = driving ? '' : ' on foot';
    return {
      ok: true,
      spoken: `${mins} minutes${how} to ${result.name ?? to}.`,
      detail: `${km.toFixed(1)} km`,
    };
  },
};

export const ABILITIES: Ability[] = [
  WEATHER,
  DIRECTIONS,
  MAIL_READ,
  MAIL_SEND,
  BRIEF,
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

