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
  openReminders,
  ensureRemindersAccess,
  createEvent,
  removeEvent,
  moveEvent,
  readWhen,
  sayWhen,
} from './deviceCalendar';
import { Linking, Platform } from 'react-native';

import { capabilities } from './capabilities';
import { loadFacts, recall,
  remember,
} from './memory';
import { loadNotes, searchNotes } from './notes';
import { loadPlayed, playedLines, recordPlayed } from './listening';
import { loadDocs, rememberDoc } from './docs';
import * as inbox from './inbox';
import { rhythmLines, rhythms } from './rhythms';
import { loadFocus } from './inbox';
import {
  closeEpisode,
  entityLines,
  episodeLines,
  findEntity,
  loadLife,
  openCommitments,
  searchLife,
  updateLife,
} from './life';
import { shortDate, windowFor, within as inWindow } from './when';
import { MODES } from './modes';
import * as google from './google';
import { isGoogleConnected } from './googleAuth';
import { lightBrief, lightDigest, lightDocument, lightEmail, lightPlan, lightResearch } from './lightModel';

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

/**
 * Which account abilities read per-user state for.
 *
 * Set by the agent when a session loads. An ability signature takes only its
 * arguments — deliberately, so abilities stay plain functions that can be
 * tested without a React tree — so the one piece of ambient context they need
 * is set here rather than threaded through every call.
 */
let CURRENT_UID = 'anon';

/**
 * How an ability changes something React owns.
 *
 * Abilities are plain functions on purpose — they take arguments and return a
 * sentence, so they can be tested without a component tree. The few that need
 * to reach back into app state do it through a handler the provider registers,
 * rather than by growing a dependency on React.
 */
let onModeChange: ((mode: string) => Promise<void>) | null = null;

export function setModeHandler(fn: (mode: string) => Promise<void>): void {
  onModeChange = fn;
}

/** Whose memory and notes are being read. Set by the provider on sign-in. */
export function currentAccount(): string {
  return CURRENT_UID;
}

export function setCurrentAccount(uid: string): void {
  CURRENT_UID = uid || 'anon';
}

/**
 * NOTHING HERE SPENDS MONEY, AND THAT IS A RULE RATHER THAN AN ACCIDENT.
 *
 * No ability buys, orders, books, or authorises a payment, and none should be
 * added that does so without the person seeing the amount and confirming it in
 * that moment. A misheard word costing a sentence is the trade this whole file
 * is built around; a misheard word costing money is not the same bet, and
 * "confirm before paying" has to be a property of the code rather than a habit
 * of whoever is writing the prompt.
 *
 * The two abilities that touch the outside world irreversibly — mail.send and
 * call.start — already work this way for the same reason: mail asks when a name
 * is ambiguous, and iOS puts its own confirmation in front of every call.
 */

export type AbilityWhere = 'device' | 'server';

/** Argument schema. Deliberately tiny — the router fills these from a sentence. */
export type ArgSpec = { type: 'string' | 'number'; what: string; required?: boolean };

export type AbilityResult = {
  ok: boolean;
  /** One line, written to be spoken aloud. Never markdown, never a list. */
  spoken: string;
  /** Anything worth showing on a screen. Optional. */
  detail?: string;
  /**
   * This did not happen yet — it needs saying yes to first.
   *
   * The ability has done everything up to the irreversible part: worked out the
   * recipient, the amount, the thing being bought, and stopped. `spoken` states
   * what is about to happen, and the turn asks for a press. Saying yes re-runs
   * the same ability with `confirmed` set, so the decision and the doing live in
   * one place and there is no half-finished action parked in memory waiting for
   * an answer that may never come.
   *
   * Anything that spends money must return this. See the note at the top of
   * this file: that is a rule about the code, not a habit of whoever writes the
   * next ability.
   */
  needsConfirming?: boolean;
  /**
   * The arguments the confirmation should re-run with, when they differ from
   * the ones the turn started with.
   *
   * An email written by Grove is drafted before the press and read aloud; the
   * press must send that draft, not a new one written a second time. The draft
   * travels here so "yes" means yes to the words that were heard.
   */
  confirmArgs?: Record<string, string>;
  /**
   * Start the music only once Grove has stopped talking.
   *
   * Playback and speech share one output, so starting a song and then
   * announcing it means a few seconds of music, an interruption, and a song
   * that has already lost its opening. The ability queues the track and leaves
   * it paused; the turn resumes it when the last word is out.
   */
  resumeMusicWhenQuiet?: boolean;
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
  /**
   * True when running this only reads. Nothing is sent, booked, moved, bought
   * or written to anyone else.
   *
   * This is what lets a question reach a tool at all. detectActIntent refuses
   * every question by design — "a false positive sends an email" — and the cost
   * of that was Grove answering "what's on my calendar" out of its own head and
   * saying the day was empty, which is a lie told confidently to someone
   * looking at their own calendar. Reads carry none of that risk, so questions
   * may run these and only these.
   *
   * Default is false. A new ability is assumed to have consequences until
   * someone says otherwise, which is the safe direction to be wrong in.
   */
  reads?: boolean;
  /**
   * Writing takes longer than looking up.
   *
   * Everything else here answers inside the twenty seconds `runAbility` allows,
   * because it is one API call. Writing a document is a model composing several
   * pages, sometimes with a web search first, and cutting that off at twenty
   * seconds fails a job that was about to succeed.
   */
  slow?: boolean;
  /**
   * Its own time limit, when the default twenty seconds is wrong for it.
   *
   * A web search is given longer than an API lookup and far less than writing
   * a document. Its own deadline was twenty-two seconds while every tool was
   * cut off at twenty, so a search about to succeed was thrown away.
   */
  timeoutMs?: number;
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
  name: 'Web search',
  what: 'Searches the web and answers. For anything current or checkable you are not certain of: news, markets, scores, prices, opening hours, where to find or buy something, whether something is free, facts that may have changed.',
  // On the device, like everything else now: the model call goes straight to
  // the provider, so there is no server left for this to run on.
  where: 'device',
  wired: true,
  needs: [],
  reads: true,
  // Searching takes longer than an API lookup; see `timeoutMs` on Ability.
  timeoutMs: 30_000,
  args: {
    topic: {
      type: 'string',
      what: 'the question to look up, written out in full with whatever context the conversation gave it — "where to find Murphy\'s Probabilistic Machine Learning book and whether it is free online", not "the book"',
      required: true,
    },
  },
  examples: [
    'what happened in the markets today',
    'give me the news',
    'brief me on my watchlist',
    'how did the Oilers do last night',
    'is that book free online',
    'what time does the library close',
  ],
  run: async (args) => {
    const topic = (args.topic || '').trim();
    if (!topic) return { ok: false, spoken: "I need to know what to brief you on." };
    const summary = (await lightBrief(topic))?.trim();
    return summary
      ? { ok: true, spoken: summary }
      : { ok: false, spoken: `Nothing came back for ${topic}.` };
  },
};

/**
 * An email body, reduced to something a person can listen to.
 *
 * Mail is written to be looked at. Read aloud verbatim it arrives as "[image:
 * Google] You allowed Noctus access to some of your Google Account data" —
 * alt-text, tracking links, unsubscribe footers and legal boilerplate, spoken
 * in full, which is why a working mail lookup sounded broken.
 *
 * Everything stripped here carries no meaning in speech: it either cannot be
 * heard (an image), cannot be acted on (a URL), or is the same on every message
 * ever sent (a footer).
 */
function readable(text: string): string {
  return text
    .replace(/\[(?:image|cid|inline)[^\]]*\]/gi, ' ')
    .replace(/<https?:\/\/[^>]*>|https?:\/\/\S+/gi, ' ')
    .replace(/\S+@\S+\.\S+/g, ' ')
    // Everything from the unsubscribe line down is machinery, not message.
    .split(/\b(?:unsubscribe|view (?:this|it) in your browser|manage your preferences|sent from my)\b/i)[0]
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/[*_#|>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first sentence or two — the part that answers "what does it say". */
function gistOf(text: string, max = 220): string {
  const clean = readable(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return (stop > 60 ? cut.slice(0, stop + 1) : cut).trim();
}

/**
 * The messages as the model's working copy: who, when, what, and the gist.
 *
 * Spoken replies are shaped for an ear, so they drop dates and bodies. The model
 * answers follow-ups — "what did Priya actually say", "when did that arrive" —
 * and can only do that from what it was given.
 */
function messageLines(messages: { from?: string; subject?: string; date?: string; snippet?: string; body?: string }[]): string {
  return messages
    .slice(0, 8)
    .map((m) => {
      const gist = gistOf(m.body || m.snippet || '', 200);
      return `From ${saySender(m.from ?? '')} — "${readable(m.subject ?? '')}"${m.date ? ` — ${m.date}` : ''}${gist ? ` — ${gist}` : ''}`;
    })
    .join('\n');
}

/**
 * Whether a From header belongs to the person someone named.
 *
 * Titles are dropped, because people say "Prof Chen" and headers say "Wei
 * Chen". Any remaining word of the name appearing in the header counts — which
 * is lenient on purpose for one name, and still refuses a message from someone
 * who shares none of it.
 */
function isFrom(header: string | undefined, name: string): boolean {
  const from = (header ?? '').toLowerCase();
  const words = name
    .toLowerCase()
    .replace(/\b(?:prof(?:essor)?|dr|mr|mrs|ms|miss|sir)\.?\s+/g, '')
    .split(/[^a-z0-9@.]+/)
    .filter((w) => w.length > 1);
  return words.length > 0 && words.some((w) => from.includes(w));
}

/** "Priya Sharma <p@x.com>" is not how you say a name out loud. */
function saySender(from: string): string {
  const named = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  return (named?.[1] ?? from.replace(/[<>]/g, '')).split('@')[0].trim();
}

/**
 * The Google calendar, as opposed to the phone's.
 *
 * These are genuinely two different calendars until someone adds the account in
 * iOS Settings, and the difference is invisible from inside the app: connecting
 * Google succeeds, grants this server access, and puts nothing on the phone.
 * EventKit then honestly reports an empty day. Reading Google directly is the
 * only way to answer the question that was actually asked.
 */
const GCAL_READ: Ability = {
  id: 'gcal.read',
  name: 'Google Calendar',
  what: 'Reads your Google calendar, which is not always the one on your phone.',
  where: 'server',
  wired: true,
  needs: ['email'],
  reads: true,
  args: { when: { type: 'string', what: 'the day, e.g. "today", "tomorrow" or "this week"' } },
  examples: [
    'what is on my google calendar',
    'what is on my google calendar tomorrow',
    'check my google calendar for this week',
  ],
  run: async (args) => {
    const asked = (args.when || '').toLowerCase();
    const days = /\bweek\b/.test(asked) ? 7 : /\btomorrow\b/.test(asked) ? 2 : 1;

    const events = await google.readCalendar(days);
    if (events === null) {
      return { ok: false, spoken: google.explain('your calendar') };
    }
    if (events.length === 0) {
      return { ok: true, spoken: days > 1 ? 'Nothing on your Google calendar.' : 'Nothing on it today.' };
    }

    // Two and a count, like the phone calendar: a read-out list is unusable in
    // your ear past about three items.
    const [first, second] = events;
    const rest = events.length - 2;
    let line = `${first.title} ${sayWhen(new Date(first.start))}`;
    if (second) line += `, then ${second.title} ${sayWhen(new Date(second.start))}`;
    if (rest > 0) line += `, and ${saidCount(rest)} more`;
    return { ok: true, spoken: `${line}.`, detail: `${events.length} from Google` };
  },
};

/**
 * A document, found by describing it and then read.
 *
 * Answers out of the text rather than handing back a link, because a link is
 * useless to someone wearing glasses and walking.
 */
const DOC_FIND: Ability = {
  id: 'doc.find',
  name: 'Docs',
  what: 'Finds one of your Google Docs and tells you what is in it.',
  where: 'server',
  wired: true,
  needs: ['email'],
  reads: true,
  args: { what: { type: 'string', what: 'the document, by name or description', required: true } },
  examples: ['what does the quarterly plan say', 'find my notes from the offsite', 'open the roadmap doc'],
  run: async (args) => {
    const wanted = (args.what || '').trim();
    if (!wanted) return { ok: false, spoken: 'Which document?' };

    const data = await google.findDoc(wanted);
    if (!data) return { ok: false, spoken: google.explain('that document') };
    if (data.files.length === 0) {
      return { ok: false, spoken: `I could not find a document called ${wanted}.` };
    }

    const name = data.match?.name ?? data.files[0].name;
    const text = data.text.trim();
    if (!text) {
      // A spreadsheet or a PDF matched. Saying which is more use than silence.
      return { ok: true, spoken: `I found ${name}, but it is not a document I can read out.` };
    }
    // Handed to the model as detail rather than spoken whole: four thousand
    // characters read aloud is not an answer.
    return { ok: true, spoken: `From ${name}: ${text.slice(0, 400)}`, detail: text };
  },
};

/**
 * "Write me a document about X", and "do this assignment for me".
 *
 * A new document every time. Grove never writes into something you already
 * have, because the failure mode there is losing work you cannot get back —
 * and a draft beside the original is what you wanted anyway.
 *
 * The model writes the body with a real token budget and, when the subject is
 * something happening in the world, with search behind it. `source` is how the
 * assignment case works: the instructions are read out of your own document
 * first and handed here, so what comes back answers the actual question rather
 * than the model's idea of it.
 */
const DOC_CREATE: Ability = {
  id: 'doc.create',
  name: 'Write a document',
  what: 'Writes a document and puts it in your Google Drive. Use for "write me a document", "make me a doc", or doing written work.',
  where: 'server',
  wired: true,
  needs: ['email'],
  slow: true,
  args: {
    title: { type: 'string', what: 'what to call it, a few words', required: true },
    about: {
      type: 'string',
      what: 'what it should cover, in as much detail as they gave you — the question to answer, the angle, the length',
      required: true,
    },
    source: {
      type: 'string',
      what: 'material to work from, if you looked any up — assignment instructions, an email, notes',
    },
    research: {
      type: 'string',
      what: '"yes" when it needs current facts from the world — companies, prices, news, anything you would otherwise be guessing at. Say yes for any report on real things happening now.',
    },
  },
  examples: [
    'write me a document about interesting thermal stocks',
    'give me a detailed report on a couple of energy stocks I might invest in',
    'make me a doc on the housing market',
    'I have an assignment due, can you do it for me',
    'write up my notes into a document',
  ],
  run: async (args) => {
    const title = (args.title || '').trim();
    const about = (args.about || '').trim();
    if (!about) return { ok: false, spoken: 'What should the document be about?' };
    if (!(await google.allowed('writing documents'))) {
      return { ok: false, spoken: google.explain('writing documents') };
    }

    const wantsResearch = /yes|true/i.test(args.research || '');

    // A report is three steps, not one. Asked for "a couple of energy stocks",
    // a single call names companies from memory and writes confident figures
    // that were true a year ago. So: decide the subjects, look each one up
    // against the web in parallel, then write from what came back. The parallel
    // part matters — four subjects one after another is a minute of silence.
    let notes = '';
    if (wantsResearch) {
      const subjects = await lightPlan(`${title}. ${about}`);
      if (subjects.length > 0) {
        const found = await Promise.all(subjects.map((subject) => lightResearch(subject, about)));
        notes = subjects
          .map((subject, i) => (found[i] ? `Subject: ${subject}\n${found[i]}` : ''))
          .filter(Boolean)
          .join('\n\n---\n\n');
      }
    }

    const text = await lightDocument(about, (args.source || '').trim(), wantsResearch, notes);
    if (!text) return { ok: false, spoken: 'I could not get that written just then.' };

    const made = await google.createDoc(title || about.split(/\s+/).slice(0, 6).join(' '), text);
    if (!made) {
      const link = google.activationLink();
      return {
        ok: false,
        spoken: google.explain('writing that document'),
        detail: link ? `Turn it on here, then ask again:\n${link}` : undefined,
      };
    }

    await rememberDoc(CURRENT_UID, title || about.slice(0, 60), made.url);

    const words = text.split(/\s+/).filter(Boolean).length;
    return {
      ok: true,
      // No URL out loud — it is unusable in an ear. The card carries the link.
      spoken: `Written. ${title || 'It'} is in your Drive, about ${Math.round(words / 50) * 50} words.`,
      detail: `${made.url}\n\n${text.slice(0, 2000)}`,
    };
  },
};

/**
 * Adding to a document that already exists.
 *
 * Confirmed, unlike making a new one: this changes something you wrote, and a
 * misheard sentence appended to the wrong document is work to undo rather than
 * a file to delete.
 */
/**
 * What Grove has written lately, with the links.
 *
 * A read, so it runs inside the loop — which is the point: "send Jason that
 * report" needs the link in the same turn as the email being composed, and
 * writing the document happened in a different one.
 */
const DOC_RECENT: Ability = {
  id: 'doc.recent',
  name: 'Documents written',
  what: 'The documents Grove has written for them, newest first, with their links. Use before sending or sharing one.',
  where: 'device',
  wired: true,
  needs: [],
  reads: true,
  args: {},
  examples: ['what documents have you written for me', 'send Jason that report', 'share the report with Priya'],
  run: async () => {
    const docs = await loadDocs(CURRENT_UID);
    if (docs.length === 0) return { ok: true, spoken: 'I have not written any documents for you yet.' };
    return {
      ok: true,
      spoken: `The last one was ${docs[0].title}.`,
      detail: docs
        .slice(0, 10)
        .map((d) => `- ${shortDate(d.at)}: ${d.title} — ${d.url}`)
        .join('\n'),
    };
  },
};

const DOC_APPEND: Ability = {
  id: 'doc.append',
  name: 'Add to a document',
  what: 'Adds to the end of a Google Doc you already have.',
  where: 'server',
  wired: true,
  needs: ['email'],
  slow: true,
  args: {
    which: { type: 'string', what: 'the document, by name', required: true },
    text: { type: 'string', what: 'what to add, in their words', required: true },
    confirmed: { type: 'string', what: 'never set this; the turn sets it after they say yes' },
  },
  examples: ['add this to my reading list doc', 'put that at the end of the project brief'],
  run: async (args) => {
    const which = (args.which || '').trim();
    const text = (args.text || '').trim();
    if (!which || !text) return { ok: false, spoken: 'Add what, and to which document?' };
    if (!(await google.allowed('writing documents'))) {
      return { ok: false, spoken: google.explain('writing documents') };
    }

    const found = await google.findDoc(which);
    if (!found) return { ok: false, spoken: google.explain('that document') };
    if (!found.match) return { ok: false, spoken: `I could not find a document called ${which}.` };

    if (!/^(yes|confirmed?)$/i.test((args.confirmed || '').trim())) {
      return {
        ok: false,
        needsConfirming: true,
        spoken: `Adding that to ${found.match.name}`,
        detail: `${found.match.name}\n\n${text}`,
      };
    }

    const done = await google.appendDoc(found.match.id, text);
    return done
      ? { ok: true, spoken: `Added to ${found.match.name}.` }
      : { ok: false, spoken: google.explain('that document') };
  },
};

const MAIL_READ: Ability = {
  id: 'mail.search',
  name: 'Mail',
  what: 'Reads your email — finds mail from someone and says what it says.',
  where: 'server',
  wired: true,
  needs: ['email'],
  reads: true,
  args: {
    from: { type: 'string', what: 'who it is from, if they named someone' },
    about: { type: 'string', what: 'what it is about' },
    when: { type: 'string', what: 'a window if they named one: "today", "this week"' },
    which: { type: 'string', what: 'a position if they named one: "last", "most recent", "first"' },
    category: {
      type: 'string',
      what: 'a kind if they named one: unread, important, starred, has attachment',
    },
  },
  // "email" earns its place here twice over: it is the word people actually
  // use, and this list is both the router's corpus and what the model is shown.
  // Without it, "check my email" matched no ability at all and the model
  // reached for the calendar instead — which then said "Nothing on".
  examples: [
    'anything from Priya',
    'what did Sam say about the invoice',
    'read me my mail',
    'check my email',
    'what was my most recent email',
    'any new emails',
    'any unread emails',
    'what was my last email from Xbox',
    'read me the most recent one from Priya',
    'anything important in my inbox',
    'what emails did I get today',
  ],
  run: async (args) => {
    const params = new URLSearchParams();
    if (args.from) params.set('from', args.from);
    if (args.about) params.set('q', args.about);
    params.set('limit', '3');

    const messages = await google.searchMail({
      from: args.from,
      about: args.about,
      since: args.when,
      category: args.category,
      // Enough to answer "which of them" rather than only "the newest one".
      limit: 5,
    });
    if (messages === null) {
      return { ok: false, spoken: google.explain('your mail') };
    }
    const who = args.from ? ` from ${args.from}` : '';
    if (messages.length === 0) return { ok: true, spoken: `Nothing${who}.` };

    const [first] = messages;
    const sender = saySender(first.from ?? '');
    const subject = readable(first.subject ?? '').slice(0, 90);

    // "What was my last email from Xbox" names one message, not a list.
    //
    // Gmail returns newest first, so the newest is already in hand — the only
    // thing missing was noticing that the question asked for one. Answering a
    // singular question with three subjects and a count reads as not having
    // listened.
    const wants = positionIn(`${args.which || ''} ${args.about || ''}`);
    if (wants && messages.length > 0) {
      const pick = wants === 'first' ? messages[messages.length - 1] : messages[0];
      const gist = gistOf(pick.body || pick.snippet || '');
      const who = saySender(pick.from ?? '');
      const what = readable(pick.subject ?? '').slice(0, 90);
      return {
        ok: true,
        spoken: what ? `${who}, ${what}. ${gist}`.trim() : `${who} wrote. ${gist}`.trim(),
        detail: messageLines([pick]),
      };
    }

    // One message gets read; several get named.
    //
    // Every question produced the same shape — the newest mail in full, then
    // "and two more" — which answers "what is my most recent email" and nothing
    // else. Asked which messages arrived, or for anything from one person, the
    // useful answer is who and about what, so the person can pick one to hear.
    if (messages.length === 1) {
      const gist = gistOf(first.body || first.snippet || '');
      let line = subject ? `${sender}, ${subject}.` : `${sender} wrote.`;
      if (gist && !subject.toLowerCase().includes(gist.slice(0, 24).toLowerCase())) {
        line += ` ${gist}`;
      }
      return { ok: true, spoken: line, detail: messageLines([first]) };
    }

    // Subjects, not a headcount.
    //
    // Leading with "5 messages from Xbox" answers a question nobody asked: the
    // number is the least useful thing about an inbox, and hearing it first
    // makes the reply sound like a report rather than an answer. Asking about
    // one sender already means you know roughly how many — what you want is
    // what they said.
    const asked = args.from ? saySender(args.from) : '';
    const subjects = messages
      .slice(0, 3)
      .map((m) => readable(m.subject ?? '').slice(0, 60) || saySender(m.from ?? ''))
      .filter(Boolean);
    const more = messages.length > 3 ? `, and ${saidCount(messages.length - 3)} more` : '';

    // When they named the sender, saying it back on every line is noise; when
    // they did not, it is the only thing that tells the messages apart.
    const body = asked
      ? `${asked}: ${saidList(subjects)}${more}.`
      : `${messages
          .slice(0, 3)
          .map((m) => {
            const who = saySender(m.from ?? '');
            const what = readable(m.subject ?? '').slice(0, 60);
            return what ? `${who} about ${what}` : who;
          })
          .filter(Boolean)
          .reduce<string[]>((all, one) => [...all, one], [])
          .join(', ')}${more}.`;

    return {
      ok: true,
      spoken: `${body} Want me to read one?`,
      detail: messageLines(messages),
    };
  },
};

/**
 * An email body with their sign-off on it.
 *
 * Added here rather than written by the model, because the model does not
 * reliably know their name and invents one when it doesn't — and a reply
 * signed "Alex" from someone called something else is worse than unsigned.
 * Left alone when the body already ends with a sign-off.
 */
async function signed(body: string): Promise<string> {
  const text = body.trim();
  if (/\n\s*(?:best|thanks|thank you|cheers|regards|kind regards|sincerely|all the best)[,!.]?\s*\n?\s*[A-Z][\w'-]*\s*$/i.test(text)) {
    return text;
  }
  // A sign-off is a nicety; it must never be the reason an email did not go.
  let name: string | null = null;
  try {
    name = await google.myFirstName();
  } catch {
    name = null;
  }
  return name ? `${text}\n\nBest,\n${name}` : text;
}

/**
 * The draft, as it is read back before the press.
 *
 * Read whole when it is short enough to hear — which a concise email is — so
 * the thing being agreed to is the thing that will be sent. The words are
 * Grove's now, not theirs, and a confirmation of words you have not heard is
 * not a confirmation. A long one is named by its opening instead, cut at a
 * sentence rather than mid-word.
 */
function readBack(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= 420) return `"${text}"`;
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text];
  return `"${sentences.slice(0, 2).join(' ').trim()}" — and a bit more, on the card`;
}

const MAIL_SEND: Ability = {
  id: 'mail.send',
  name: 'Send mail',
  what: 'Sends a message you dictate.',
  where: 'server',
  wired: true,
  needs: ['email'],
  args: {
    to: { type: 'string', what: 'who it goes to — a name is fine, it will be looked up', required: true },
    confirmed: { type: 'string', what: 'never set this; the turn sets it after the person says yes' },
    subject: { type: 'string', what: 'the subject line' },
    body: {
      type: 'string',
      what: 'what they want to say, in their own words — the app writes it up as a proper email',
      required: true,
    },
  },
  examples: ['email Priya to say I am running late', 'email Sam the address'],
  run: async (args) => {
    const asked = (args.to || '').trim();
    const body = (args.body || '').trim();
    if (!asked || !body) return { ok: false, spoken: 'Who to, and saying what?' };

    // A name is what people say; an address is what mail needs. Looked up in
    // your contacts rather than demanded, because you obviously know who Priya
    // is and being asked for her address is the friction this exists to remove.
    let to = asked;
    // "Send it to me" is the one address that needs no lookup and cannot be
    // guessed wrong. mail.summarise already understood it; sending did not, so
    // the same words worked in one place and failed in the other.
    const toSelf = /^(me|myself|my ?self|my own|my email|my inbox)$/i.test(asked);
    if (toSelf) {
      const own = await google.me();
      if (!own) return { ok: false, spoken: 'I could not work out your own address.' };
      to = own;
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(asked)) {
      const matches = await google.findContact(asked);
      if (matches === null) {
        return { ok: false, spoken: google.explain('sending that') };
      }
      if (matches.length === 0) {
        // Not in contacts is not the same as unknown. Someone who emailed you
        // yesterday has an address in your inbox, and answering "I have no
        // address for Mark" with his message sitting there is absurd. Only a
        // sender whose name actually matches counts, and only one of them.
        const recent = (await google.searchMail({ from: asked, limit: 5 })) ?? [];
        const senders = [
          ...new Map(
            recent
              .filter((m) => isFrom(m.from, asked))
              // "Mark Chen <mark@x.com>" or a bare "mark@x.com": both are an
              // address, and keying only on the bracketed form threw the bare
              // one away — the exact case this lookup was added for.
              .map(
                (m) =>
                  [
                    (/<([^>]+)>/.exec(m.from)?.[1] ?? /[^\s<>"]+@[^\s<>"]+/.exec(m.from)?.[0] ?? '').toLowerCase(),
                    m.from,
                  ] as const
              )
              .filter(([address]) => address.includes('@'))
          ).entries(),
        ];
        if (senders.length === 1) {
          matches.push({ name: saySender(senders[0][1]), email: senders[0][0] });
        } else if (senders.length > 1) {
          return {
            ok: false,
            spoken: `I have mail from ${senders.length} people called ${asked}. Which one?`,
            detail: senders.map(([address, from]) => `${saySender(from)} — ${address}`).join('\n'),
          };
        } else {
          return { ok: false, spoken: `I have no address for ${asked}.` };
        }
      }
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

    // Dictated by voice, sent to a name Grove looked up, and unrecallable. One
    // press is a small price for the one ability here that cannot be undone.
    // A subject from the message itself when none was given. "(no subject)" is
    // the mark of mail sent by something that did not care, and the person on
    // the other end sees it before they see a word of what was said.
    const subject =
      (args.subject || '').trim() ||
      body.split(/\s+/).slice(0, 7).join(' ').replace(/[.,;:!?]+$/, '');

    // Asked before the press, not after it. Discovering the permission is
    // missing once someone has already confirmed is the shape this failed in:
    // a message they thought was gone, and a fix they were told about too late.
    if (!(await google.allowed('sending mail'))) {
      return { ok: false, spoken: google.explain('sending mail') };
    }

    // Their words become an email here, in one call that does nothing else —
    // not in the turn's prompt, where the same instruction was followed one
    // time and ignored the next. A note to themselves is left as they said it.
    const draft =
      (args.draft || '').trim() ||
      (toSelf ? body : ((await lightEmail({ gist: body, to: asked })) ?? body));

    if (!/^(yes|confirmed?)$/i.test((args.confirmed || '').trim())) {
      // Short mail is read out whole, because the words are what is being
      // agreed to. Long mail is named by its subject instead: a body cut off
      // at a character count ends mid-word, and "Prof. Chen grante" is not
      // something anyone can make a decision about. The whole message is on
      // the card either way.
      return {
        ok: false,
        needsConfirming: true,
        spoken: `Here's the email to ${toSelf ? 'yourself' : asked}: ${readBack(draft)}`,
        detail: `To ${to}\nSubject: ${subject}\n\n${toSelf ? draft : await signed(draft)}`,
        confirmArgs: { ...args, draft },
      };
    }
    // A note to yourself is not signed: "Best, Vishnu" at the bottom of your own
    // reminder is the tell of something written by a machine.
    const sent = await google.sendMail(to, subject, toSelf ? draft : await signed(draft));
    // The reason matters most here. "That did not send" covered an expired
    // sign-in, a missing scope and a dead network alike — and sending is the
    // one thing where knowing which is the difference between fixing it in ten
    // seconds and assuming Grove is broken.
    return sent
      ? { ok: true, spoken: asked === to ? 'Sent.' : `Sent to ${asked}.` }
      : { ok: false, spoken: google.explain('sending that') };
  },
};

/**
 * Google's events, in the same shape the phone's come back in.
 *
 * Null means Google could not be reached or is not connected — which is a
 * different answer from an empty day, and the caller depends on telling them
 * apart.
 */
/**
 * An event, and which calendar it actually lives in.
 *
 * The source is what makes writing possible. Without it, "move my two o'clock"
 * had to guess, guessed the phone, and failed on an event Grove had just read
 * out of Google — because Google events cannot be touched through EventKit and
 * never appear there at all.
 */
type Dated = { id: string; title: string; start: Date; allDay: boolean; source: 'google' | 'phone' };

/**
 * A Google start or end, as a local time.
 *
 * An all-day event arrives as "2026-09-23" with no timezone, and `new Date()`
 * reads that as UTC midnight — which in Edmonton is 6pm the evening before.
 * Today's all-day events were filtered out of "what's on today" entirely, and
 * tomorrow's were announced as happening now.
 */
function localTime(value: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!dateOnly) return new Date(value);
  return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
}

async function readGoogleCalendar(days: number): Promise<Dated[] | null> {
  const events = await google.readCalendar(days);
  if (events === null) return null;
  return events
    .map((e) => ({
      id: e.id,
      title: e.title,
      start: localTime(e.start),
      allDay: e.allDay,
      source: 'google' as const,
    }))
    .filter((e) => !Number.isNaN(e.start.getTime()))
    // Sorted here rather than trusted. "My first thing" is only as right as the
    // order of this list, and an order that depends on how a request happened
    // to be phrased upstream is not an order to build an answer on.
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Everything upcoming, from both calendars, in time order.
 *
 * calendar.read learned to fall back to Google; calendar.find never did, so it
 * searched the phone's EventKit calendar alone. On a phone whose events all
 * live in Google that calendar is empty, which produced the sequence people
 * actually hit: Grove lists your week correctly, you ask about one of the
 * things it just listed, and it says there is nothing matching. Contradicting
 * itself one turn apart is worse than either answer alone.
 */
async function allEvents(days: number): Promise<Dated[] | null> {
  // Google only, deliberately.
  //
  // Merging EventKit in produced a calendar nobody has: iOS ships Birthdays and
  // Siri Suggestions, so the phone contributed entries that are not appointments
  // while the real diary lived in Google. Answers came out padded with things
  // the person had never put in a calendar, and "my first thing" was often one
  // of them.
  return readGoogleCalendar(days);
}

/**
 * The day someone named, as a window.
 *
 * Widening the search to two days is not the same as asking about tomorrow.
 * "My first class tomorrow" was answered with the first class in the next two
 * days, which is today's — right by the letter of the query and wrong by every
 * other measure. A named day is a filter, not a horizon.
 */
function dayWindow(text: string): { from: Date; to: Date } | null {
  const t = text.toLowerCase();
  const midnight = (offset: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d;
  };
  if (/\btomorrow\b/.test(t)) return { from: midnight(1), to: midnight(2) };
  if (/\b(today|tonight|this (?:morning|afternoon|evening))\b/.test(t)) {
    return { from: midnight(0), to: midnight(1) };
  }
  return null;
}

/**
 * The search term, with the framing words taken out.
 *
 * "My first class tomorrow" describes one event called "class"; first and
 * tomorrow say which one, and no event is titled either. Left in, they matched
 * nothing and took the real term down with them.
 */
function cleanTerm(query: string): string {
  return query
    .toLowerCase()
    .replace(/\b(?:first|last|next|final|latest|earliest|upcoming)\b/g, ' ')
    .replace(/\b(?:today|tomorrow|tonight|this morning|this afternoon|this evening)\b/g, ' ')
    .replace(/^(?:my|the|a)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Only the events falling inside a named day. */
function within(events: Dated[], window: { from: Date; to: Date } | null): Dated[] {
  if (!window) return events;
  return events.filter(
    (e) => e.start >= window.from && e.start < window.to
  );
}

/**
 * Which one of them the question is actually about.
 *
 * "My first class", "my last meeting", "what's next" all name a position, and
 * answering them by reading the whole list out and letting the person count is
 * what made the calendar feel like it could only do one thing. Returns null
 * when no position was named, which means the list is the answer.
 */
function positionIn(text: string): 'first' | 'last' | 'next' | null {
  const t = text.toLowerCase();
  if (/\b(last|final|latest|end of (?:the|my) day)\b/.test(t)) return 'last';
  if (/\b(first|earliest|start of (?:the|my) day|kick ?off)\b/.test(t)) return 'first';
  if (/\b(next|after (?:this|that)|coming up|upcoming)\b/.test(t)) return 'next';
  return null;
}

/** One event, said properly, with the position named so it sounds answered. */
function sayOne(event: Dated, position: 'first' | 'last' | 'next' | null): string {
  const lead =
    position === 'last' ? 'Last is ' : position === 'next' ? 'Next is ' : position === 'first' ? 'First is ' : '';
  return `${lead}${event.title}, ${sayWhen(event.start)}.`;
}

/** The same substring match findEvents uses, over both calendars. */
/**
 * Words that say how you are asking, not what you are asking for.
 *
 * "Look for mark 312" was searched verbatim, so "look" and "for" went into the
 * match — and "for" is three letters, which was the bar for being significant,
 * so it matched the substring in "Information Session" and anything else
 * containing it. The question's scaffolding has to come out before the search
 * starts.
 */
const NOT_A_SEARCH_TERM = new Set([
  'look', 'find', 'search', 'check', 'show', 'tell', 'what', 'when', 'where',
  'which', 'whats', 'have', 'has', 'got', 'any', 'all', 'the', 'for', 'and',
  'about', 'with', 'from', 'that', 'this', 'there', 'thing', 'things', 'event',
  'events', 'calendar', 'schedule', 'time', 'again', 'please', 'anything',
]);

/**
 * Kinds of thing, so a category finds its members.
 *
 * "What are my classes" should find MARK 312 Lecture, and it never would by
 * substring — nothing in that title contains the word "class". These are the
 * groupings people actually ask by, and each expands to the words that appear
 * in real calendar entries.
 */
const KINDS: Record<string, string[]> = {
  class: ['class', 'lecture', 'lab', 'seminar', 'tutorial', 'course', 'lesson'],
  meeting: ['meeting', 'sync', 'standup', 'stand-up', 'call', '1:1', 'one on one', 'catch up'],
  appointment: ['appointment', 'appt', 'consult', 'checkup', 'check-up'],
  workout: ['gym', 'workout', 'training', 'run', 'yoga', 'climb', 'swim'],
  exam: ['exam', 'midterm', 'final', 'test', 'quiz'],
  interview: ['interview', 'screening'],
  flight: ['flight', 'departure', 'boarding'],
};

/** "classes" and "class" are the same search. */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** The terms a query is really made of, category words expanded. */
function searchTerms(query: string): string[] {
  const words = cleanTerm(query)
    .split(/[^a-z0-9:]+/i)
    .map((w) => w.trim())
    .filter((w) => w.length > 1 && !NOT_A_SEARCH_TERM.has(w));

  const terms = new Set<string>();
  for (const word of words) {
    const root = singular(word);
    terms.add(root);
    for (const spellings of Object.values(KINDS)) {
      if (spellings.includes(root)) spellings.forEach((k) => terms.add(k));
    }
  }
  return [...terms];
}

/**
 * Events matching a description, best first.
 *
 * Scored rather than filtered. A course code is two tokens — "mark" and "312" —
 * and an event matching both is a better answer than one matching either, which
 * a boolean filter cannot express: it returned everything containing any word,
 * in time order, so the exactly-right event sat behind three near-misses.
 *
 * Ties keep calendar order, so among equally good matches the earliest wins,
 * which is what "my first" then means.
 */
async function findAcrossCalendars(query: string, days = 60): Promise<Dated[] | null> {
  const upcoming = await allEvents(days);
  if (upcoming === null) return null;

  const needle = cleanTerm(query);
  if (!needle) return upcoming;
  const terms = searchTerms(query);
  if (terms.length === 0) return upcoming;

  const scored = upcoming
    .map((event, order) => {
      const title = event.title.toLowerCase();
      const words = title.split(/[^a-z0-9:]+/i).map(singular);
      let score = 0;
      for (const term of terms) {
        // A whole word beats a substring: "mark" should match MARK 312 more
        // strongly than it matches "Denmark trip".
        if (words.includes(term)) score += 3;
        else if (title.includes(term)) score += 1;
      }
      // The whole phrase, if it survived cleaning, is the strongest signal.
      if (needle.length > 3 && title.includes(needle)) score += 4;
      return { event, score, order };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);

  // Only the best tier. A query matching one event on three tokens should not
  // come back with the four that matched on one.
  const best = scored[0]?.score ?? 0;
  return scored.filter((m) => m.score === best).map((m) => m.event);
}

/**
 * A list, said the way a person says one.
 *
 * Semicolons are a reading convention and they do not survive being spoken:
 * "Xbox: order confirmed; shipping update; renewal" arrives as one long run
 * with no shape to it. An "and" before the last item is what tells a listener
 * the list is ending, which is the only cue speech has.
 */
function saidList(items: string[]): string {
  const clean = items.map((i) => i.trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? '';
  return `${clean.slice(0, -1).join(', ')} and ${clean[clean.length - 1]}`;
}

/**
 * Small numbers as words.
 *
 * "3 messages" is read out by the synthesiser as a digit and lands like a
 * counter rather than a sentence. Past twelve, words are worse than the number.
 */
const SPOKEN_NUMBER = [
  'no', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
];

function saidCount(n: number): string {
  return SPOKEN_NUMBER[n] ?? String(n);
}

/**
 * Every event, as the model's working copy.
 *
 * The spoken line is cut to two events because that is what an ear can hold.
 * The model was being handed that cut line as the whole answer, so asked for
 * the first thing tomorrow it picked from two entries it happened to be shown
 * and said the school review — when the gym was at seven. Speech is shortened
 * for people; the model gets everything.
 */
function eventLines(events: { title: string; start: Date }[]): string {
  return events
    .map((e) => `${e.title} — ${e.start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })} at ${clockOnly(e.start)}`)
    .join('\n');
}

/** Two or three events and a count — a read-out list is unusable past that. */
/** Just the clock, for events already placed on a day. */
function clockOnly(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * A day, said the way a person would say it.
 *
 * "School review today at 18:30, then free time today at 19:15, and 10 more"
 * repeats the day for every entry and buries the only number that helps — how
 * many there are. The count leads, the day is said once, and the rest are
 * times, which is how anyone reading a diary out loud does it.
 */
function sayEvents(events: { title: string; start: Date }[], lead = ''): string {
  const [first, second] = events;
  if (!first) return `${lead}Nothing on.`;

  // One event needs no count and no scaffolding.
  if (events.length === 1) return `${lead}${first.title}, ${sayWhen(first.start)}.`;

  const sameDay = !second || first.start.toDateString() === second.start.toDateString();
  const opening = `${saidCount(events.length)} on today. ${first.title} ${sayWhen(first.start)}`;
  let line = opening;
  if (second) {
    line += sameDay
      ? `, then ${second.title} at ${clockOnly(second.start)}`
      : `, then ${second.title} ${sayWhen(second.start)}`;
  }
  const rest = events.length - 2;
  if (rest > 0) line += `, and ${saidCount(rest)} more`;
  return `${lead}${line}.`;
}

/**
 * Replying to something already in the inbox.
 *
 * Deliberately separate from mail.send. Sending needs an address and gets it
 * from contacts; replying needs a *message*, and picking the wrong one sends
 * your words to a stranger in a thread you were not thinking about. So this
 * finds the message first, and when the description matches more than one
 * plausible thread it asks rather than guesses — the same rule mail.send
 * already applies to two people with the same first name.
 */
/**
 * A stack of mail, reduced to what matters — and optionally sent on.
 *
 * Five is the cap, and it is a product decision rather than a technical one:
 * beyond about five messages a spoken summary stops being a summary and becomes
 * a list you cannot hold in your head. Asking for "everything from this week"
 * gets the five most recent and says so, which is more honest than quietly
 * truncating twenty.
 *
 * `send_to` is what makes this useful rather than merely clever: the summary is
 * most wanted at the moment you cannot read it, and forwarding it to yourself
 * or to someone else is the thing you would otherwise do by hand later.
 */
const MAIL_DIGEST: Ability = {
  id: 'mail.summarise',
  name: 'Summarise mail',
  // Read-only for real. It used to take `send_to` and email the summary
  // itself, while marked `reads` — and a read runs without asking, so the model
  // could send mail on someone's behalf with no press at all. Sending a
  // summary is now two steps the tool loop does in one turn: summarise here,
  // then mail.send with the summary as its body, which stops at a confirmation
  // like every other email.
  what: 'Recaps recent email: who wrote, what they want, what needs a reply. To send a recap to someone, use this first and then send its result with the send-email tool.',
  where: 'server',
  wired: true,
  needs: ['email'],
  reads: true,
  args: {
    from: { type: 'string', what: 'only mail from this person, if they named one' },
    about: { type: 'string', what: 'only mail about this, if they named a topic' },
    when: { type: 'string', what: 'the window, e.g. "this morning", "today", "this week"' },
  },
  examples: [
    'summarise my emails from this morning',
    'summarise everything from Priya',
    'catch me up on my email',
    'recap my inbox today',
  ],
  run: async (args) => {
    const messages = await google.searchMail({
      from: args.from,
      about: args.about,
      since: args.when,
      // Five, capped deliberately. See above.
      limit: 5,
    });
    if (messages === null) {
      return { ok: false, spoken: google.explain('your mail') };
    }

    const scope = args.from ? ` from ${args.from}` : args.when ? ` from ${args.when}` : '';
    if (messages.length === 0) return { ok: true, spoken: `Nothing${scope}.` };

    const digest = await lightDigest(
      messages.map((m) => ({
        from: saySender(m.from),
        subject: readable(m.subject ?? ''),
        body: readable(m.body || m.snippet || ''),
      })),
      [args.from, args.about, args.when].filter(Boolean).join(' ')
    );

    // The full messages go back either way, so the model can recap from them
    // itself if the digest step failed — or answer "what did Priya say" next.
    const detail = messageLines(messages);
    if (!digest) {
      return { ok: true, spoken: `${messages.length} messages${scope}.`, detail };
    }
    return { ok: true, spoken: digest, detail };
  },
};

const MAIL_REPLY: Ability = {
  id: 'mail.reply',
  name: 'Reply',
  what: 'Replies to an email you have had, in its own thread.',
  where: 'server',
  wired: true,
  needs: ['email'],
  args: {
    to: { type: 'string', what: 'who the message was from' },
    about: { type: 'string', what: 'what the message was about' },
    body: {
      type: 'string',
      what: 'what they want to say back, in their own words — the app writes it up as a proper reply',
      required: true,
    },
    confirmed: { type: 'string', what: 'never set this; the turn sets it after they say yes' },
  },
  examples: [
    'reply to Priya saying that works for me',
    'respond to that email and say I will be there',
    'respond to that email and tell them no, I am busy',
    'answer Sam that I am running late',
  ],
  run: async (args) => {
    const body = (args.body || '').trim();
    if (!body) return { ok: false, spoken: 'What should the reply say?' };
    if (!(await google.allowed('sending mail'))) {
      return { ok: false, spoken: google.explain('sending mail') };
    }

    // Already decided to be a new email before the press: go straight there.
    // Without this the confirmed run searched again, found something, and sent
    // a threaded "Re:" reply instead of the new email that was read out and
    // agreed to — the one case where a press does something it did not say.
    if (/^yes$/i.test((args.new_email || '').trim())) return asNewEmail(args, body);

    const pronoun = /^(?:him|her|them|they|it|that|this|he|she|the sender|that guy|that one)$/i.test(
      (args.to || '').trim()
    );
    const found = await google.searchMail({
      from: pronoun ? undefined : args.to,
      about: args.about,
      limit: 3,
    });
    if (found === null) {
      return { ok: false, spoken: google.explain('that reply') };
    }
    // Nothing from them to reply to, but a person was named: they want to say
    // this to that person, and a new email does it. "Email Priya that…" routed
    // here and stopped at "I could not find the message from Priya", which is
    // true and useless. Same draft, same read-back, same press.
    if (found.length === 0 && !pronoun && (args.to || '').trim()) {
      return asNewEmail(args, body);
    }
    if (found.length === 0) {
      const which = args.about ? ` about ${args.about}` : '';
      return { ok: false, spoken: `I could not find the message${which} to reply to.` };
    }

    // Naming neither the sender nor the subject leaves "that email" meaning
    // whatever happens to be newest, and a reply is not something to send on a
    // guess. One clear candidate is fine; an unqualified pick from several is
    // not.
    if (found.length > 1 && !args.to && !args.about) {
      return {
        ok: false,
        spoken: `I have ${found.length} recent messages. Which one — who was it from?`,
        detail: found.map((m) => `${saySender(m.from)} — ${m.subject}`).join('\n'),
      };
    }

    // The message has to be from the person named, not merely the first result.
    //
    // "Reply to Prof Chen" chose Priya's email and would have sent the reply to
    // her: the search is a relevance match, and its first result is whatever
    // Gmail ranked highest, not a guarantee about the sender. When a name was
    // given, only a message actually from that person qualifies, and none is
    // an answer rather than a reason to fall back to the top of the list.
    // "Respond to him and say no": a pronoun is not a name. Left in, it
    // matches no sender, and the fallback then hunts the contacts for someone
    // called "him". Treated as unsaid, so the message just read wins.
    const asked = (args.to || '').trim();
    const named = /^(?:him|her|them|they|it|that|this|he|she|the sender|that guy|that one)$/i.test(asked)
      ? ''
      : asked;
    const target = named ? found.find((m) => isFrom(m.from, named)) : found[0];
    if (!target) return asNewEmail({ ...args, to: named }, body);

    // A reply is sent mail, and sent mail is not taken back. mail.send always
    // asked; this did not, which was survivable while a keyword gate stood in
    // front of it and is not now that the model chooses what runs.
    const draft =
      (args.draft || '').trim() ||
      ((await lightEmail({
        gist: body,
        to: saySender(target.from),
        replyingTo: `${target.subject}: ${target.snippet}`,
      })) ?? body);

    if (!/^(yes|confirmed?)$/i.test((args.confirmed || '').trim())) {
      return {
        ok: false,
        needsConfirming: true,
        spoken: `Here's the reply to ${saySender(target.from)}: ${readBack(draft)}`,
        detail: `${/^re:/i.test(target.subject) ? target.subject : `Re: ${target.subject}`}\n\n${await signed(draft)}`,
        confirmArgs: { ...args, draft },
      };
    }

    const sent = await google.replyTo(target, await signed(draft));
    return sent
      ? { ok: true, spoken: `Replied to ${saySender(target.from)}.`, detail: target.subject }
      : { ok: false, spoken: google.explain('that reply') };
  },
};

/**
 * Putting something in the calendar.
 *
 * Grove could read a calendar and move things around it and had no way to add
 * anything, so "add an event today at 9:30" went to the closest ability that
 * existed — moving one — which searched for an event that was never there and
 * answered "which one?". A missing ability does not fail cleanly; it gets
 * mistaken for a broken one.
 */
/**
 * A reply with nothing to reply to, sent as a new email instead.
 *
 * The decision travels with the confirmation (`new_email`), so the press sends
 * what was read back rather than re-deciding from a fresh search.
 */
async function asNewEmail(args: Record<string, string>, body: string): Promise<AbilityResult> {
  const outcome = await MAIL_SEND.run({
    to: args.to ?? '',
    body,
    ...(args.subject ? { subject: args.subject } : {}),
    ...(args.draft ? { draft: args.draft } : {}),
    ...(args.confirmed ? { confirmed: args.confirmed } : {}),
  });
  return outcome.confirmArgs
    ? { ...outcome, confirmArgs: { ...args, ...outcome.confirmArgs, new_email: 'yes' } }
    : outcome;
}

const CALENDAR_ADD: Ability = {
  id: 'calendar.add',
  name: 'Add to calendar',
  what: 'Puts a new event in your calendar.',
  where: 'device',
  wired: true,
  needs: ['calendar-permission'],
  args: {
    what: { type: 'string', what: 'what the event is called', required: true },
    when: { type: 'string', what: 'when it starts, e.g. "today at 9:30" or "Thursday at 2"', required: true },
    minutes: { type: 'number', what: 'how long it lasts in minutes, if said' },
  },
  examples: [
    'add an event to my calendar today at 9:30',
    'put lunch with Sam in my calendar on Friday at one',
    'book gym tomorrow at seven',
    'schedule a call with Priya Thursday at 2',
  ],
  run: async (args) => {
    const title = (args.what || '').trim();
    if (!title) return { ok: false, spoken: 'What should I call it?' };

    const when = readWhen(args.when || '');
    // Never guessed. An event at a time nobody chose is worse than a question.
    if (!when) return { ok: false, spoken: `When is ${title}?` };

    const minutes = Number(args.minutes);
    const length = Number.isFinite(minutes) && minutes > 0 ? minutes : 60;

    // Google first when it is connected, because that is where the events the
    // person can actually see live. Writing to EventKit while reading from
    // Google was the worst of both: Grove said "added" and nothing appeared in
    // the calendar app they were looking at.
    if (await isGoogleLinked()) {
      const made = await google.createCalendarEvent(title, when, length);
      if (made) return { ok: true, spoken: `Added ${title}, ${sayWhen(when)}.` };
      return { ok: false, spoken: google.explain(`adding ${title}`) };
    }

    const result = await createEvent(title, when, length);
    if (result.ok) return { ok: true, spoken: `Added ${title}, ${sayWhen(when)}.` };
    if (result.reason === 'no-calendar') {
      return {
        ok: false,
        spoken:
          'There is no calendar on this phone I am allowed to write to. Add your account in iOS Settings under Calendar.',
      };
    }
    if (result.reason === 'no-access') {
      return { ok: false, spoken: 'I need permission to change your calendar. It is in iOS Settings.' };
    }
    return { ok: false, spoken: `I could not add ${title}.` };
  },
};

/** Taking something out again. Names what it removed rather than going quiet. */
const CALENDAR_REMOVE: Ability = {
  id: 'calendar.remove',
  name: 'Remove from calendar',
  what: 'Deletes an event from your calendar.',
  where: 'device',
  wired: true,
  needs: ['calendar-permission'],
  args: {
    which: { type: 'string', what: 'which event', required: true },
    confirmed: { type: 'string', what: 'never set this; the turn sets it after they say yes' },
  },
  examples: [
    'cancel my dentist appointment',
    'delete the gym event tomorrow',
    'take the 3pm meeting off my calendar',
  ],
  run: async (args) => {
    const which = (args.which || '').trim();
    if (!which) return { ok: false, spoken: 'Which event?' };
    const picked = await oneEvent(which);
    if ('problem' in picked) return { ok: false, spoken: picked.problem };

    // Named in the question so the press is a decision about THIS event. A
    // deleted appointment does not come back, and the wrong match is exactly
    // the mistake a confirmation exists to catch.
    if (!/^(yes|confirmed?)$/i.test((args.confirmed || '').trim())) {
      return {
        ok: false,
        needsConfirming: true,
        spoken: `Removing ${picked.event.title}, ${sayWhen(picked.event.start)}`,
      };
    }

    const gone =
      picked.event.source === 'google'
        ? await google.deleteCalendarEvent(picked.event.id)
        : (await removeEvent(which)).ok;

    return gone
      ? { ok: true, spoken: `Removed ${picked.event.title}.` }
      : { ok: false, spoken: `I found ${picked.event.title} but could not remove it.` };
  },
};

/**
 * Asking about one thing rather than the whole day.
 *
 * "When is my dentist appointment" was answered by reading today out and
 * hoping, which is why the calendar felt like it could not be asked anything
 * specific. Searches a couple of months out, because the thing you ask the date
 * of is usually the thing that is not today.
 */
const CALENDAR_FIND: Ability = {
  id: 'calendar.find',
  name: 'Find in calendar',
  what: 'Finds a particular thing in your calendar and says when it is.',
  where: 'device',
  wired: true,
  needs: ['calendar-permission'],
  reads: true,
  args: { which: { type: 'string', what: 'what to look for', required: true } },
  examples: [
    'when is my dentist appointment',
    'what is my first class of the day',
    'do I have anything with Sam this week',
    'when is the flight',
    'what time is dinner',
    'what time is my meeting with Sam',
    'when is my last class',
  ],
  run: async (args) => {
    const which = (args.which || '').trim();
    if (!which) return { ok: false, spoken: 'What am I looking for?' };

    const matches = await findAcrossCalendars(which);
    if (matches === null) return { ok: false, spoken: google.explain('your calendar') };

    // "My first class tomorrow" names a thing, a position and a day, and all
    // three have to be honoured or the answer is confidently about the wrong
    // event.
    const window = dayWindow(which);
    const found = within(matches, window);
    if (found.length === 0) {
      const when = window ? ` ${/tomorrow/i.test(which) ? 'tomorrow' : 'today'}` : '';
      return { ok: true, spoken: `Nothing matching ${cleanTerm(which)}${when}.` };
    }

    // "My last class" names both a thing and a position, and answering with a
    // list leaves the person to work out which one they asked for.
    const position = positionIn(which);
    if (position === 'last' || found.length === 1) {
      return {
        ok: true,
        spoken: sayOne(found[found.length - 1], position),
        detail: eventLines(found),
      };
    }
    if (position === 'first') {
      return { ok: true, spoken: sayOne(found[0], 'first'), detail: eventLines(found) };
    }
    if (position === 'next') {
      const now = Date.now();
      const upcoming = found.find((e) => e.start.getTime() > now) ?? found[0];
      return { ok: true, spoken: sayOne(upcoming, 'next'), detail: eventLines(found) };
    }

    const [first, second] = found;
    let line = `${first.title} ${sayWhen(first.start)}`;
    if (second) line += `, then ${second.title} ${sayWhen(second.start)}`;
    if (found.length > 2) line += `, and ${saidCount(found.length - 2)} more`;
    return { ok: true, spoken: `${line}.`, detail: eventLines(found) };
  },
};

/** Whether Google is signed in on this device. */
async function isGoogleLinked(): Promise<boolean> {
  try {
    return await isGoogleConnected();
  } catch {
    return false;
  }
}

/**
 * The one event a phrase means, or a reason it cannot be settled.
 *
 * Changing the wrong appointment is worse than changing none, so several
 * matches is a question rather than a coin toss — the same rule mail.send
 * already applies to two people with the same first name.
 */
async function oneEvent(
  which: string
): Promise<{ event: Dated } | { problem: string }> {
  const found = await findAcrossCalendars(which);
  if (found === null) {
    return {
      problem:
        'I cannot see a calendar. Allow calendar access in iOS Settings, or connect Google Workspace.',
    };
  }
  if (found.length === 0) return { problem: `I could not find ${which} in your calendar.` };
  if (found.length > 1) {
    const soonest = found[0];
    // One clearly-soonest match is not ambiguous in the way that matters: it is
    // what a person means by "my dentist" when there are two of them months
    // apart. Same day is a genuine question.
    const sameDay =
      found[1].start.toDateString() === soonest.start.toDateString();
    if (sameDay) {
      return {
        problem: `I have ${found.length} that match ${which} today. Which one — what time?`,
      };
    }
  }
  return { event: found[0] };
}

const CALENDAR_READ: Ability = {
  id: 'calendar.read',
  name: 'Calendar',
  what: 'Reads your Google calendar — what is on, what is next, your first or last thing.',
  where: 'server',
  wired: true,
  needs: ['email'],
  reads: true,
  args: {
    when: { type: 'string', what: 'the day, e.g. "today", "tomorrow" or "this week"' },
    which: {
      type: 'string',
      what: 'a position if they named one: "first", "last" or "next"',
    },
  },
  examples: [
    "what's on today",
    'when is my next thing',
    'what have I got on tomorrow',
    'what is my last thing today',
    'am I free at four',
  ],
  run: async (args) => {
    const asked = `${args.when || ''} ${args.which || ''}`.toLowerCase();
    const days = /\bweek\b/.test(asked) ? 7 : /\btomorrow\b/.test(asked) ? 2 : 1;
    const position = positionIn(asked);

    const all = await readGoogleCalendar(days);
    if (all === null) return { ok: false, spoken: google.explain('your calendar') };

    // A named day narrows the list before anything else looks at it, or "first
    // thing tomorrow" answers with the first thing today.
    const events = within(all, dayWindow(asked));

    if (events.length > 0) {
      // A named position gets one event, not a list. "What is my first class"
      // was answered with the whole day and a count, which is the question
      // restated rather than answered.
      if (position === 'first') return { ok: true, spoken: sayOne(events[0], 'first'), detail: eventLines(events) };
      if (position === 'last') {
        return { ok: true, spoken: sayOne(events[events.length - 1], 'last'), detail: eventLines(events) };
      }
      if (position === 'next') {
        const now = Date.now();
        const upcoming = events.find((e) => e.start.getTime() > now) ?? events[0];
        return { ok: true, spoken: sayOne(upcoming, 'next'), detail: eventLines(events) };
      }
      return { ok: true, spoken: sayEvents(events), detail: eventLines(events) };
    }

    // Empty in the window asked about is rarely the answer wanted: look further
    // out and say when the next thing actually is.
    const ahead = (await readGoogleCalendar(14)) ?? [];
    if (ahead.length > 0) {
      const when = days > 1 ? 'this week' : 'left today';
      return { ok: true, spoken: `Nothing ${when}. ${sayOne(ahead[0], 'next')}`, detail: eventLines(ahead) };
    }
    return { ok: true, spoken: days > 1 ? 'Nothing this week.' : 'Nothing on.' };
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
    confirmed: { type: 'string', what: 'never set this; the turn sets it after they say yes' },
  },
  examples: ['move my two o’clock to Thursday', 'push the dentist back an hour'],
  run: async (args) => {
    const which = (args.event || '').trim();
    const when = readWhen(args.to || '');
    if (!which) return { ok: false, spoken: 'Which one?' };
    // Refusing to guess is the point. A misread date moves a real appointment.
    if (!when) return { ok: false, spoken: 'When do you want it moved to?' };

    // Routed by where the event actually lives. A Google event cannot be
    // touched through EventKit and never appears there, so the old code found
    // nothing and reported the event missing — one turn after reading it out.
    const picked = await oneEvent(which);
    if ('problem' in picked) return { ok: false, spoken: picked.problem };

    // Both halves are spoken — which event and to when — because either one
    // misheard moves a real appointment somewhere nobody chose.
    if (!/^(yes|confirmed?)$/i.test((args.confirmed || '').trim())) {
      return {
        ok: false,
        needsConfirming: true,
        spoken: `Moving ${picked.event.title} to ${sayWhen(when)}`,
      };
    }

    const moved =
      picked.event.source === 'google'
        ? await google.moveCalendarEvent(picked.event.id, when)
        : (await moveEvent(which, when)).ok;

    return moved
      ? { ok: true, spoken: `Moved ${picked.event.title} to ${sayWhen(when)}.` }
      : { ok: false, spoken: `I found ${picked.event.title} but could not move it.` };
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
    if (!saved.ok) return { ok: false, spoken: 'Could not save that reminder.' };
    // Naming the list makes the claim checkable. "Added to your reminders" is
    // true of a reminder saved somewhere nobody looks.
    const where = saved.list ? ` in ${saved.list}` : '';
    return {
      ok: true,
      spoken: due ? `Reminder set for ${sayWhen(due)}${where}.` : `Added${where}.`,
      detail: saved.list,
    };
  },
};

/**
 * Music, through the system player.
 *
 * Needs the native module, so it is wired only on a development build — the
 * probe in capabilities.ts is what makes that honest rather than a crash. In
 * Expo Go it says so and does not pretend.
 */
/**
 * Moods, as things that might actually be written in a library.
 *
 * iOS only lets an app match text — titles, artists, albums, playlists — so
 * "play something sad" can never be answered by understanding the music. What
 * it can do is try the words people name that music with: a playlist called
 * Sad, a genre in an album title, an artist known for it. Each mood is a list
 * of attempts rather than one guess, because which of them exists is different
 * in every library.
 *
 * Deliberately shallow. This is a better-than-nothing feature and it should not
 * pretend otherwise: if none of the words are anywhere in the library, saying so
 * is the honest end of it.
 */
/**
 * Roughly where the phone is, without asking and without a permission prompt.
 *
 * The weather kept asking which town, which is the one question an assistant
 * should never need to ask twice — and it asked it of people who had already
 * answered, because the only source was a stored fact and the only way to store
 * one was to say a particular sentence.
 *
 * This is the fallback beneath that: the network Grove is on knows which city
 * it is in. Coarse by nature — it is the exit point of the connection, so a VPN
 * or a phone network can put it a city out — which is why it sits BELOW what
 * the person actually told us and is never written to memory. A guess is fine
 * to answer with and wrong to remember.
 *
 * Cached for the session, because it does not change while you are standing
 * still and a lookup on every question is latency for nothing.
 */
let guessedCity: string | null | undefined;

async function cityFromNetwork(): Promise<string | null> {
  if (guessedCity !== undefined) return guessedCity;
  try {
    const response = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(4000) });
    const data = (await response.json()) as { success?: boolean; city?: string };
    guessedCity = data.success !== false && data.city ? data.city : null;
  } catch {
    guessedCity = null;
  }
  return guessedCity;
}

/**
 * Where the person lives, from memory rather than from the model.
 *
 * "I live in Edmonton" is stored under the key `home`, and reading it directly
 * is a lookup; leaving it to the model to notice the line in its prompt is a
 * hope. The weather asked where you were often enough to prove which of those
 * you get.
 */
async function homeTown(): Promise<string | null> {
  try {
    const facts = await loadFacts(CURRENT_UID);
    const home = facts.find((f) => f.key === 'home');
    if (!home) return null;
    // Stored as the sentence that was said — "I live in Edmonton" — so the
    // town is what follows the preposition.
    // Matches however the fact was phrased — "I live in Edmonton", "I'm in
    // Edmonton", "I'm from Toronto" all store the sentence, not the town.
    const named = /\b(?:live in|living in|based in|here in|'m in|am in|from)\s+(.+)$/i.exec(
      home.value
    );
    return (named?.[1] ?? home.value).replace(/[.?!]+$/, '').trim() || null;
  } catch {
    return null;
  }
}

const MOODS: Record<string, string[]> = {
  sad: ['sad', 'melancholy', 'blues', 'ballad', 'slow', 'acoustic', 'rain'],
  happy: ['happy', 'feel good', 'summer', 'pop', 'dance', 'party', 'upbeat'],
  calm: ['calm', 'chill', 'ambient', 'lo-fi', 'lofi', 'piano', 'sleep'],
  angry: ['rage', 'metal', 'hardcore', 'punk', 'heavy'],
  focus: ['focus', 'study', 'instrumental', 'classical', 'piano', 'ambient'],
  hype: ['hype', 'workout', 'gym', 'rap', 'trap', 'bangers', 'pump'],
  romantic: ['love', 'romance', 'slow jams', 'r&b', 'soul'],
};

/** The mood named in a request, if any, as the words worth trying. */
function moodTerms(query: string): string[] {
  const t = query.toLowerCase();
  const named: string[] = [];
  const say = (key: string, ...words: string[]) => {
    if (words.some((w) => new RegExp(`\\b${w}\\b`).test(t))) named.push(...MOODS[key]);
  };
  say('sad', 'sad', 'melancholy', 'down', 'heartbroken', 'moody');
  say('happy', 'happy', 'cheerful', 'upbeat', 'good mood', 'fun');
  say('calm', 'calm', 'chill', 'relaxing', 'mellow', 'quiet', 'sleepy');
  say('angry', 'angry', 'aggressive', 'heavy', 'rage');
  say('focus', 'focus', 'concentrate', 'study', 'work');
  say('hype', 'hype', 'pumped', 'energetic', 'workout', 'gym');
  say('romantic', 'romantic', 'love songs', 'slow jams');
  return [...new Set(named)];
}

const MUSIC: Ability = {
  id: 'music.play',
  name: 'Music',
  what: 'Plays something from your library, into whatever you are wearing.',
  where: 'device',
  wired: capabilities().remote,
  needs: ['music-permission'],
  args: { what: { type: 'string', what: 'song, artist, album or playlist — leave empty to shuffle' } },
  examples: [
    'play my favourite song',
    'put on something mellow',
    'play the Sunday playlist',
    'play a song',
    'play something sad',
    'put on something happy',
    'play something to work out to',
  ],
  run: async (args) => {
    // No title is not a missing argument. "Play a song", "put some music on"
    // and "play something" are whole instructions that hand Grove the choice —
    // and answering them with "Play what?" after saying "playing something" is
    // the contradiction that made this feel broken.
    const wanted = (args.what || '').trim();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const remote = require('grove-remote') as typeof import('grove-remote');

    // Narrow the search rather than give up on it.
    //
    // The library is matched on a substring, so one wrong word sinks the whole
    // query: speech hears "a song over by Playboi Carti", the full phrase
    // matches no title, artist or album, and Grove reports a song missing from
    // a library that contains it. Trying the individual words after the whole
    // phrase costs nothing — a failed match plays nothing — and recovers every
    // case where the extra words were the problem rather than the song.
    //
    // Longest first, because the distinctive word is usually the long one:
    // "Carti" identifies the artist, "song" identifies nothing.
    // The phrase, then its own words, then whatever the mood suggests. A mood
    // only contributes when the literal request found nothing, so naming a real
    // artist is never overridden by a word that happens to sound like a feeling.
    const attempts = wanted
      ? [
          wanted,
          ...wanted
            .split(/\s+/)
            .filter((w) => w.length > 3)
            .sort((a, b) => b.length - a.length),
          ...moodTerms(wanted),
        ]
      : [''];

    const tried = new Set<string>();
    let result = await remote.playMusic(attempts[0]);
    tried.add(attempts[0].toLowerCase());
    for (let i = 1; i < attempts.length && !result.ok && result.reason === 'notFound'; i += 1) {
      const next = attempts[i].toLowerCase();
      if (tried.has(next)) continue;
      tried.add(next);
      result = await remote.playMusic(attempts[i]);
    }

    if (result.ok) {
      // Queued, not playing. Held here so the announcement lands before the
      // song rather than across it.
      await remote.controlMusic('pause');
      if (result.title) await recordPlayed(CURRENT_UID, result.title, result.artist);
      const artist = result.artist ? ` by ${result.artist}` : '';
      return {
        ok: true,
        spoken: `Playing ${result.title}${artist}.`,
        resumeMusicWhenQuiet: true,
      };
    }
    if (result.reason === 'denied') {
      return { ok: false, spoken: 'I need permission for your music library. It is in iOS Settings.' };
    }
    if (result.reason === 'unavailable') {
      return { ok: false, spoken: 'Music needs a development build. This one cannot reach it.' };
    }
    if (result.reason === 'emptyLibrary') {
      return {
        ok: false,
        spoken:
          'There is nothing in your music library on this phone. Apple Music streams do not count unless they are downloaded.',
      };
    }
    return {
      ok: false,
      // Names the likeliest cause rather than leaving it a mystery. iOS only
      // exposes the local library to a third-party app, so an Apple Music track
      // that has never been downloaded is genuinely invisible here — no amount
      // of searching finds it, and "not in your library" sounds like a lie to
      // someone looking at it in the Music app.
      spoken: wanted
        ? `I could not find ${wanted}. I can only see downloaded music — Apple Music tracks that stream are invisible to me.`
        : 'I could not get your library to play.',
    };
  },
};

/**
 * "Play something like what I listened to yesterday."
 *
 * A read, so the model can look before it chooses: it gets the dated list, picks
 * an artist or mood from it, and calls music.play with that. Only songs Grove
 * put on are here — the spoken line says so when the list is empty, rather than
 * pretending there was nothing played at all.
 */
const MUSIC_RECENT: Ability = {
  id: 'music.recent',
  name: 'Recently played',
  what: 'Lists the songs Grove has played for them, with dates. Use before playing "something like" what they listened to before.',
  where: 'device',
  wired: capabilities().remote,
  needs: ['music-permission'],
  reads: true,
  args: {},
  examples: ['what did I listen to yesterday', 'play something like what I listened to yesterday'],
  run: async () => {
    const played = await loadPlayed(CURRENT_UID);
    if (played.length === 0) {
      return {
        ok: true,
        spoken: "I haven't played anything for you yet, so I've got nothing to go on. Name an artist or a mood.",
      };
    }
    const latest = played[0];
    return {
      ok: true,
      spoken: `Last thing I played was ${latest.title}${latest.artist ? ` by ${latest.artist}` : ''}.`,
      detail: `Only songs Grove played, newest first:\n${playedLines(played.slice(0, 60))}`,
    };
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
/**
 * Somewhere's coordinates, remembered.
 *
 * The geocoder is a second network call before a word of weather is written,
 * and on a phone leaving a pocket it is the one that blips — which came out as
 * "I can't reach the weather" for a town Grove has looked up fifty times.
 * Places do not move.
 */
const placeCache = new Map<string, { latitude: number; longitude: number; name: string }>();

/** The last answer, so a blip repeats yesterday's minute rather than failing. */
let lastWeather: { at: number; place: string; spoken: string; detail: string } | null = null;

/** A fetch that gets a second go at a network that dropped the first. */
async function fetchTwice(url: string, timeoutMs = 8000): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return response;
    } catch {
      // Falls through to the retry, then to null.
    }
    if (attempt === 0) await new Promise((done) => setTimeout(done, 400));
  }
  return null;
}

const WEATHER: Ability = {
  id: 'weather.now',
  name: 'Weather',
  what: 'Says what it is doing outside today. For whether to take a jacket, umbrella or sunscreen, also check today\'s calendar in the same turn, so the answer covers when they will be out.',
  where: 'server',
  wired: true,
  needs: [],
  reads: true,
  args: {
    place: { type: 'string', what: 'the town or city; use what you know of where they live' },
  },
  examples: ["what's the weather", 'do I need a coat', 'is it going to rain today'],
  run: async (args) => {
    // The argument, then what Grove already knows. Relying on the model to fill
    // this from the memory block was the whole mechanism, and when it did not,
    // Grove asked where you were — of someone who had told it months ago.
    const asked = (args.place || '').trim();
    // What they said, then what they told us once, then where the phone is.
    // Asking is the last resort rather than the first, which is the whole
    // difference between an assistant and a form.
    let place = asked;
    if (!place) place = (await homeTown()) ?? '';
    if (!place) place = (await cityFromNetwork()) ?? '';
    if (!place) {
      return { ok: false, spoken: 'Which town am I checking?' };
    }

    try {
      // Bounded even though runAbility bounds the whole run: failing at 8
      // seconds with a usable sentence beats failing at 20 with a generic one.
      let found = placeCache.get(place.toLowerCase());
      if (!found) {
        const geo = await fetchTwice(
          'https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=' +
            encodeURIComponent(place)
        );
        const hit = geo ? (await geo.json())?.results?.[0] : null;
        if (!hit) {
          // A geocoder that will not answer is not the same as a town that
          // does not exist, and saying the second when it is the first sends
          // someone looking for a typo in a place they have used for months.
          return geo
            ? { ok: false, spoken: `I could not find ${place}.` }
            : { ok: false, spoken: 'The weather service is not answering. Try me again in a moment.' };
        }
        found = { latitude: hit.latitude, longitude: hit.longitude, name: hit.name };
        placeCache.set(place.toLowerCase(), found);
      }

      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${found.latitude}` +
        `&longitude=${found.longitude}&current=temperature_2m,weather_code` +
        '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
        '&forecast_days=1&timezone=auto';
      const response = await fetchTwice(url);
      if (!response) {
        // Ten minutes old and honest about it beats nothing at all: the
        // temperature outside has not moved much, and the alternative is the
        // answer people were getting, which was no answer.
        if (lastWeather && Date.now() - lastWeather.at < 30 * 60_000 && lastWeather.place === place) {
          return { ok: true, spoken: `${lastWeather.spoken} (from a few minutes ago)`, detail: lastWeather.detail };
        }
        return { ok: false, spoken: 'The weather service is not answering. Try me again in a moment.' };
      }
      const data = await response.json();

      // Kept only once the geocoder has confirmed it is a real place, so a
      // misheard word never becomes where Grove thinks you live. This is what
      // makes "tell me once" true rather than a form of words.
      if (asked && !(await homeTown())) {
        await remember(CURRENT_UID, {
          key: 'home',
          value: `I live in ${found.name}`,
          source: 'told',
          subject: 'me',
        });
      }

      const now = Math.round(data.current.temperature_2m);
      const sky = SKY[data.current.weather_code] ?? 'hard to say';
      const high = Math.round(data.daily.temperature_2m_max[0]);
      const rain = data.daily.precipitation_probability_max[0] ?? 0;

      // Written to be heard: the number, the sky, and the one thing you would
      // actually change your mind about on the way out of the door.
      const coat = rain >= 50 ? ' Take a coat.' : rain >= 25 ? ' Might catch a shower.' : '';
      const spoken = `${now} degrees and ${sky} in ${found.name}, up to ${high}.${coat}`;
      const detail = `${rain}% chance of rain`;
      lastWeather = { at: Date.now(), place, spoken, detail };
      return { ok: true, spoken, detail };
    } catch {
      // Same reasoning as the fetch above: a recent answer beats none.
      if (lastWeather && Date.now() - lastWeather.at < 30 * 60_000 && lastWeather.place === place) {
        return { ok: true, spoken: `${lastWeather.spoken} (from a few minutes ago)`, detail: lastWeather.detail };
      }
      return { ok: false, spoken: 'Could not reach the weather just then. Ask me again.' };
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
  what: 'Says how long it takes to get somewhere. Only for "how long" and "how far" — to go somewhere, use navigate.',
  where: 'device',
  wired: capabilities().remote,
  needs: ['location-permission'],
  reads: true,
  args: {
    to: { type: 'string', what: 'a street address or place name; "home" for their home', required: true },
    home_address: { type: 'string', what: 'only when they have just told you their home address' },
    how: { type: 'string', what: '"walking" if they said so, otherwise driving' },
  },
  // These are the words people actually use to ask for a route. Without them
  // the keyword fallback matched nothing, so a request only worked while the
  // model was reachable.
  examples: [
    'how long to get home',
    'when should I leave for the office',
    'how far is the station',
    'how long will it take to walk to the gym',
    'how far away is the mall',
  ],
  run: async (args) => {
    let to = (args.to || '').trim();
    // "How long to get home" is a route to an address, not to the word "home".
    const told = realAddress(args.home_address);
    if (told) {
      await remember(CURRENT_UID, { key: 'home-address', value: `My home address is ${told}`, source: 'told', subject: 'me' });
    }
    if (HOME.test(to) || (!to && told)) {
      const address = told || (await homeAddress());
      if (!address) return { ok: false, spoken: "What's your home address? I'll keep it for next time." };
      to = address;
    }
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

/**
 * Where "home" actually is, as an address rather than a town.
 *
 * Kept apart from the `home` fact on purpose. That one is "I live in Edmonton",
 * which is exactly right for the weather and useless for a route: Apple Maps
 * given "Edmonton" drives you to the middle of the city.
 */
async function homeAddress(): Promise<string | null> {
  try {
    const facts = await loadFacts(CURRENT_UID);
    const found = facts.find((f) => f.key === 'home-address' && f.subject === 'me');
    if (!found) return null;
    return found.value.replace(/^my home address is\s+/i, '').replace(/[.]+$/, '').trim() || null;
  } catch {
    return null;
  }
}

const HOME = /^(?:my\s+)?(?:home|house|place|apartment|flat)$/i;

/**
 * An address someone actually told Grove, or nothing.
 *
 * The model fills `home_address` with "home" often enough to matter, and saving
 * that would send every later trip home to a pin labelled Home somewhere in the
 * world. A real address has a number or at least a few words in it.
 */
function realAddress(value: string | undefined): string {
  const told = (value || '').trim();
  if (!told || HOME.test(told)) return '';
  return /\d/.test(told) || told.split(/\s+/).length >= 3 ? told : '';
}

/**
 * "Take me home." Opens Apple Maps with the route started.
 *
 * Not a confirmation: opening Maps with the wrong destination is something you
 * look at and close, and nothing has been sent, spent or booked. Driving
 * directions are what "take me" means; a ride only happens when someone says
 * Uber, which is a different tool that does ask first.
 */
const NAVIGATE: Ability = {
  id: 'maps.go',
  name: 'Navigate',
  what: 'Opens Apple Maps with directions to somewhere, ready to go. For "take me", "navigate", "directions to".',
  where: 'device',
  wired: true,
  needs: [],
  args: {
    to: {
      type: 'string',
      what: 'a street address or place name. Use "home" for their home — never a town name in place of an address',
      required: true,
    },
    // Listed before `how` so that when Grove asks for the address, the answer
    // lands here and not in the travel mode.
    home_address: { type: 'string', what: 'only when they have just told you their home address' },
    how: { type: 'string', what: '"walking" or "transit" if they said so, otherwise driving' },
  },
  examples: [
    'take me home',
    'navigate to work',
    'directions to the airport',
    'take me to the place from that email',
    'get me to West Edmonton Mall',
  ],
  run: async (args) => {
    let to = (args.to || '').trim();
    const told = realAddress(args.home_address);

    if (told) {
      await remember(CURRENT_UID, {
        key: 'home-address',
        value: `My home address is ${told}`,
        source: 'told',
        subject: 'me',
      });
    }

    const wantsHome = HOME.test(to) || (!to && !!told);
    if (wantsHome) {
      const address = told || (await homeAddress());
      if (!address) {
        return { ok: false, spoken: "What's your home address? I'll keep it for next time." };
      }
      to = address;
    }
    if (!to) return { ok: false, spoken: 'Where to?' };

    const flag = /walk|foot/i.test(args.how || '') ? 'w' : /transit|bus|train/i.test(args.how || '') ? 'r' : 'd';
    const url = `maps://?daddr=${encodeURIComponent(to)}&dirflg=${flag}`;
    const web = `https://maps.apple.com/?daddr=${encodeURIComponent(to)}&dirflg=${flag}`;
    const opened = await Linking.openURL(url).then(
      () => true,
      () => Linking.openURL(web).then(() => true, () => false)
    );

    return opened
      ? { ok: true, spoken: wantsHome ? 'Maps is taking you home.' : `Maps is open with directions to ${to}.` }
      : { ok: false, spoken: 'I could not open Maps.' };
  },
};

/**
 * "Handle my morning."
 *
 * The first ability that composes others rather than wrapping one API, and the
 * shape most of the interesting ones will take: a person asking about their day
 * is not asking about their calendar, and answering with a list of events is a
 * database query read aloud.
 *
 * Runs its parts together rather than in sequence — this is spoken while
 * someone is putting their shoes on, and two round trips one after the other is
 * a noticeable pause for no reason. A part that fails is left out rather than
 * announced: "I couldn't get the weather" is not what you want first thing.
 */
const DAY: Ability = {
  id: 'day.brief',
  name: 'The day',
  what: 'Your day in one go — what is on, and what it is doing outside.',
  where: 'device',
  wired: true,
  needs: [],
  reads: true,
  args: {
    place: { type: 'string', what: 'only if they named somewhere; otherwise leave empty' },
  },
  examples: ['handle my morning', "how's my day looking", 'what have I got on today'],
  run: async (args) => {
    // Google, like every other calendar read. This one was missed when the
    // calendar moved: it kept reading the phone's own calendar, which is empty
    // for anyone whose diary lives in Google, and answered "nothing in the
    // diary" with a full day ahead — the exact lie the move was made to end.
    const [upcoming, sky] = await Promise.all([
      allEvents(2).catch(() => null),
      // The weather finds its own place — memory, then the network — when none
      // was given, so it no longer needs the model to supply one.
      WEATHER.run({ place: args.place ?? '' }).catch(() => null),
    ]);

    const now = Date.now();
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today = (upcoming ?? []).filter((e) =>
      e.allDay
        ? e.start.getTime() >= startOfDay.getTime() && e.start.getTime() <= endOfDay.getTime()
        : e.start.getTime() >= now - 30 * 60_000 && e.start.getTime() <= endOfDay.getTime()
    );

    const parts: string[] = [];
    if (upcoming === null) {
      // Distinguished from "nothing on", which is a different fact entirely.
      parts.push(google.explain('your calendar'));
    } else if (today.length === 0) {
      parts.push('Nothing else on today.');
    } else {
      const [first, second] = today;
      let line = `${today.length} thing${today.length === 1 ? '' : 's'} left today — ${first.title}${first.allDay ? ', all day' : ` at ${clockOnly(first.start)}`}`;
      if (second) line += `, then ${second.title}`;
      parts.push(`${line}.`);
    }
    if (sky?.ok) parts.push(sky.spoken);

    return {
      ok: upcoming !== null,
      spoken: parts.join(' '),
      detail: upcoming && upcoming.length > 0 ? `Today and tomorrow:\n${eventLines(upcoming)}` : undefined,
    };
  },
};

/**
 * What Grove knows about someone.
 *
 * The ability that the flat memory could not support. "Remind me what I was
 * supposed to ask Sarah about" is not a search for the word Sarah — it is a
 * request for everything filed under her, which needs facts to have a subject.
 * They do now.
 *
 * Reads memory directly rather than relying on the prompt block. The block is
 * capped and summarised for cost; this is the one place where being complete
 * matters more than being brief, because the whole question is "what am I
 * forgetting".
 */
/**
 * Being told to remember something, on purpose.
 *
 * Extraction from ordinary speech is deliberately narrow — it has to be, or a
 * memory fills with misheard fragments — and the cost of that narrowness is
 * that "add this to my goals" did nothing at all. Asking outright should always
 * work, whatever the patterns think of the wording.
 *
 * Goals and facts are stored separately (see memory.ts) because a goal must
 * outlive the cap: an intention set months ago is exactly what you want kept,
 * and recency is the wrong measure for it.
 */



/* ------------------------------------------------------------- contacts */

const CONTACT_FIND: Ability = {
  id: 'contact.find',
  name: 'Contacts',
  what: "Looks up someone's number or email.",
  where: 'server',
  wired: true,
  needs: ['email'],
  reads: true,
  args: { who: { type: 'string', what: 'the person', required: true } },
  examples: ["what's John's number", 'what is Priya\'s email', 'find me Sam\'s number'],
  run: async (args) => {
    const who = (args.who || '').trim();
    if (!who) return { ok: false, spoken: 'Who?' };
    const found = await google.findContact(who);
    if (found === null) return { ok: false, spoken: google.explain('your contacts') };
    if (found.length === 0) return { ok: true, spoken: `I have no contact for ${who}.` };

    const one = found[0];
    // Numbers are read digit by digit or they are useless — "four one two" is
    // followable, "four hundred and twelve" is not.
    const number = one.phone ? one.phone.replace(/\D/g, '').split('').join(' ') : '';
    const parts = [
      number ? `${one.name}: ${number}` : '',
      !number && one.email ? `${one.name}: ${one.email}` : '',
    ].filter(Boolean);
    const more = found.length > 1 ? ` And ${found.length - 1} other match.` : '';
    return {
      ok: true,
      spoken: `${parts[0]}.${more}`,
      detail: found.map((c) => `${c.name} — ${c.phone ?? c.email}`).join('\n'),
    };
  },
};

const CALL: Ability = {
  id: 'call.start',
  name: 'Call',
  what: 'Starts a phone call to someone in your contacts.',
  where: 'device',
  wired: true,
  needs: ['email'],
  args: { who: { type: 'string', what: 'who to call', required: true } },
  examples: ['call John', 'ring Priya', 'dial Sam'],
  run: async (args) => {
    const who = (args.who || '').trim();
    if (!who) return { ok: false, spoken: 'Call who?' };

    const digits = who.replace(/\D/g, '');
    let number = digits.length >= 7 ? digits : '';
    let name = who;

    if (!number) {
      const found = await google.findContact(who);
      if (found === null) return { ok: false, spoken: google.explain('your contacts') };
      const withPhone = found.filter((c) => c.phone);
      if (withPhone.length === 0) return { ok: false, spoken: `I have no number for ${who}.` };
      // Calling the wrong person is not undoable in the way a search is.
      if (withPhone.length > 1) {
        return {
          ok: false,
          spoken: `I have ${withPhone.length} people called ${who}. Which one?`,
          detail: withPhone.map((c) => `${c.name} — ${c.phone}`).join('\n'),
        };
      }
      number = (withPhone[0].phone ?? '').replace(/[^\d+]/g, '');
      name = withPhone[0].name;
    }

    // iOS shows its own confirmation before dialling, which is the check that
    // matters: Grove never places a call the person has not seen and approved.
    const opened = await Linking.openURL(`tel:${number}`).then(
      () => true,
      () => false
    );
    return opened
      ? { ok: true, spoken: `Calling ${name}.` }
      : { ok: false, spoken: 'I could not start that call.' };
  },
};

/* ---------------------------------------------------------------- notes */

/**
 * Finding what was said in a voice note.
 *
 * Notes are too long to live in every prompt the way facts do, so they are
 * searched when something asks about them. The spoken line is the best match's
 * title and summary; the detail carries the full note — points, actions and
 * transcript — because "what were the action items" and "what exactly did I say
 * about the budget" can only be answered from the whole thing.
 */
/**
 * Several things to do, put in the list in one go.
 *
 * Exists for the end of a meeting log, where the alternative is four separate
 * confirmations for four action items — which nobody presses through. One
 * press for the set, and no press means none of them, which is the safe way
 * round for something that writes into a list you keep.
 */
const REMIND_BATCH: Ability = {
  id: 'reminders.batch',
  name: 'Reminders',
  what: 'Adds several things to your reminders at once.',
  where: 'device',
  wired: capabilities().calendar,
  needs: ['reminders-permission'],
  args: {
    items: { type: 'string', what: 'the things to do, one per line', required: true },
    confirmed: { type: 'string', what: 'never set this; the turn sets it after they say yes' },
  },
  examples: ['add those to my reminders', 'put all of that in my reminders'],
  run: async (args) => {
    const items = (args.items || '')
      .split('\n')
      .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
      .filter(Boolean)
      .slice(0, 12);
    if (items.length === 0) return { ok: false, spoken: 'Add what?' };

    if (!/^(yes|confirmed?)$/i.test((args.confirmed || '').trim())) {
      return {
        ok: false,
        needsConfirming: true,
        spoken: `Adding ${items.length} ${items.length === 1 ? 'reminder' : 'reminders'}`,
        detail: items.map((i) => `- ${i}`).join('\n'),
      };
    }

    if (!(await ensureRemindersAccess())) {
      return { ok: false, spoken: 'I need access to your reminders. It is in iOS Settings.' };
    }

    let added = 0;
    let list = '';
    for (const item of items) {
      // The date is read out of the sentence it came in — "send Jason the build
      // by Friday" is due Friday, and the reminder keeps the whole sentence.
      const outcome = await addReminder(item.slice(0, 200), readWhen(item));
      if (outcome.ok) {
        added += 1;
        list = outcome.list ?? list;
      }
    }
    if (added === 0) return { ok: false, spoken: 'None of those went in.' };
    return {
      ok: true,
      spoken: `${added} ${added === 1 ? 'reminder' : 'reminders'} in ${list || 'Reminders'}.`,
      detail: items.map((i) => `- ${i}`).join('\n'),
    };
  },
};

/**
 * The long memory, searched.
 *
 * Everything the voice notes, meetings and conversations have left behind —
 * people, projects, ideas and the dated things that happened with them. The
 * time half of a question is handled separately from the words, because "that
 * idea from last month" has one useful word in it and it is not "idea".
 */
const LIFE_SEARCH: Ability = {
  id: 'memory.search',
  name: 'Long memory',
  what: 'Searches everything Grove has remembered about their life — people, projects, ideas, decisions and when things happened.',
  where: 'device',
  wired: true,
  needs: [],
  reads: true,
  args: {
    about: { type: 'string', what: 'what they are asking about, in their words', required: true },
    when: { type: 'string', what: 'any time they named: "last month", "in August", "last week"' },
  },
  examples: [
    'what was that defence startup idea I had last month',
    'what did we decide about the pricing',
    'what have I been working on lately',
    'what did I say about the demo',
  ],
  run: async (args) => {
    const about = (args.about || '').trim();
    if (!about) return { ok: false, spoken: 'About what?' };

    const life = await loadLife(CURRENT_UID);
    // The `when` argument on its own first: it arrives as a bare "March" or
    // "last month", and gluing it to the question buried it — "March decisions"
    // reads as no time at all, so a question about March searched everything.
    const window = windowFor(args.when || '') ?? windowFor(about);
    const found = searchLife(life, about, window);

    if (!window && found.entities.length === 0 && found.episodes.length === 0) {
      // "What have I been working on" names nothing in particular, so nothing
      // scores. The last fortnight is the honest reading of it.
      const fortnight = life.episodes
        .filter((ep) => Date.now() - new Date(ep.at).getTime() < 14 * 86_400_000)
        .slice(0, 8);
      const projects = life.entities.filter((e) => e.kind === 'project').slice(0, 5);
      if (fortnight.length === 0 && projects.length === 0) {
        return { ok: true, spoken: 'I have not written anything down about that.' };
      }
      return {
        ok: true,
        // Spoken as what it is — nothing found. The recent episodes go to the
        // model as detail; announcing "here is what has been going on" and then
        // saying none of it was worse than saying nothing.
        spoken: "I don't have anything saved on that.",
        detail: [
          'Nothing matched those words. Recently, though:',
          projects.length ? `Projects: ${projects.map((p) => `${p.name} — ${p.summary}`).join('; ')}` : '',
          fortnight.length ? episodeLines(fortnight, life) : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }

    // A named stretch of time with nothing matching in it is an answer, and
    // handing over what is known about the same subject from another month is
    // how "what did I decide in March" gets answered with September's
    // decision, dated March.
    if (window && found.episodes.length === 0) {
      // Before giving up: what IS in that time. The words people use rarely
      // match the words that got written down — "what did I decide" against an
      // episode that says "agreed" — and someone who names a stretch of time
      // usually wants what is in it.
      const inside = life.episodes.filter((ep) => inWindow(ep.at, window)).slice(0, 8);
      if (inside.length === 0) {
        return {
          ok: true,
          spoken: `Nothing from ${window.label} about that.`,
          detail: `Nothing at all was recorded in ${window.label}. Do not answer from other dates — say there is nothing from then.`,
        };
      }
      return {
        ok: true,
        spoken: `Nothing matching that from ${window.label}, but here is what is.`,
        detail: `Nothing matched those words. Everything from ${window.label}, which may or may not be what they meant:\n${episodeLines(inside, life)}`,
      };
    }

    const detail = [
      found.entities.map((e) => entityLines(life, e)).join('\n\n'),
      found.episodes.length ? `What happened:\n${episodeLines(found.episodes, life)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    const first = found.episodes[0];
    const spoken = first
      ? `${first.title}, from ${shortDate(first.at)}.`
      : `${found.entities[0].name}: ${found.entities[0].summary || 'I have a few notes.'}`;
    return { ok: true, spoken, detail };
  },
};

/**
 * Capture, don't switch.
 *
 * The whole value is in what this does not do: no date, no list, no category,
 * no question back, and a reply short enough that the thought is gone in five
 * seconds and the person is back on what they were doing. Anything that turns
 * a capture into a small conversation defeats the point.
 */
const CAPTURE: Ability = {
  id: 'inbox.add',
  name: 'Capture',
  what: 'Puts a passing thought straight into their inbox to deal with later — an idea, someone to contact, something they promised, a thing to look up. Instant, no questions.',
  where: 'device',
  wired: true,
  needs: [],
  args: {
    what: { type: 'string', what: 'the thought or task, in their words', required: true },
    when: { type: 'string', what: 'when it is due, if they said: "tomorrow", "Friday", "at 3"' },
  },
  examples: [
    'I have to do the dishes',
    'I need to book the dentist',
    'I have to hand in the lab report by Friday',
    'capture: email the PE guy',
    'jot down that I need to book the dentist',
    'add to my list: look into thermal sensors',
    'note down ask Priya about the survey',
  ],
  run: async (args) => {
    const what = (args.what || '').trim();
    if (!what) return { ok: false, spoken: 'Capture what?' };
    const focus = await loadFocus(CURRENT_UID);
    const next = await inbox.capture(CURRENT_UID, what, focus?.what);
    const waiting = inbox.open(next).length;

    // Everything caught also goes to the Reminders app, dated when they gave a
    // time. Two homes on purpose: the phone is what shouts at you, and the
    // inbox is what Grove can see when it asks what you should be doing.
    const due = readWhen(args.when || '');
    const reminded = await addReminder(inbox.tidy(what).slice(0, 200), due).catch(() => ({ ok: false }));
    // Two or three words. A capture that gets a sentence back has already
    // cost more attention than the thought was worth.
    return {
      ok: true,
      spoken: focus
        ? `Got it. Back to ${focus.what}.`
        : reminded.ok
          ? due
            ? `Got it — reminders, ${sayWhen(due)}.`
            : 'Got it — in your reminders.'
          : 'Got it.',
      detail: `Captured: ${inbox.tidy(what)}${due ? ` (due ${sayWhen(due)})` : ''}\n${waiting} waiting in the inbox${reminded.ok ? ', and in the Reminders app' : ''}.`,
    };
  },
};

/** Everything caught and not yet dealt with. */
const INBOX_REVIEW: Ability = {
  id: 'inbox.review',
  name: 'Inbox',
  what: 'Reads back what they have captured and not yet dealt with.',
  where: 'device',
  wired: true,
  needs: [],
  reads: true,
  args: {},
  examples: ["what's in my inbox", 'what did I capture today', 'read me my list', 'what is on my list'],
  run: async () => {
    const items = inbox.open(await inbox.loadInbox(CURRENT_UID));
    if (items.length === 0) return { ok: true, spoken: 'Your inbox is empty.' };
    return {
      ok: true,
      spoken: `${items.length} thing${items.length === 1 ? '' : 's'} waiting. Newest: ${items[0].text}.`,
      detail: inbox.inboxLines(items),
    };
  },
};

/**
 * "I'm on FIN 312 for the next hour."
 *
 * The session is what makes capture work: while one is running Grove knows
 * what they are meant to be doing, so a thought about something else is caught
 * and handed back at the end rather than becoming the next half hour.
 */
const FOCUS_START: Ability = {
  id: 'focus.start',
  name: 'Focus on something',
  what: 'Starts a focus session on one thing, so anything unrelated gets captured for later instead of pursued.',
  where: 'device',
  wired: true,
  needs: [],
  args: {
    what: { type: 'string', what: 'what they are working on, in their words', required: true },
    how_long: { type: 'string', what: 'how long, if they said: "an hour", "40 minutes", "until 3"' },
  },
  examples: [
    'I am working on FIN 312 for the next hour',
    'focus on the Noctus build for 40 minutes',
    'start a focus session on my assignment',
  ],
  run: async (args) => {
    const what = (args.what || '').trim();
    if (!what) return { ok: false, spoken: 'Focusing on what?' };
    // A length ("40 minutes") first, then a clock time ("until 3").
    const until = inbox.endsIn(args.how_long || '') ?? readWhen(args.how_long || '');
    await inbox.setFocus(CURRENT_UID, {
      what,
      startedAt: new Date().toISOString(),
      ...(until ? { until: until.toISOString() } : {}),
    });
    const waiting = inbox.open(await inbox.loadInbox(CURRENT_UID)).length;
    return {
      ok: true,
      spoken: until
        ? `${what} until ${clockOnly(until)}. Anything else I'll catch for later.`
        : `${what} it is. Anything else I'll catch for later.`,
      detail: waiting > 0 ? `${waiting} already in the inbox for afterwards.` : undefined,
    };
  },
};

/** The end of a session, and what got caught during it. */
const FOCUS_END: Ability = {
  id: 'focus.end',
  name: 'Done focusing',
  what: 'Ends the focus session and reads back anything caught during it.',
  where: 'device',
  wired: true,
  needs: [],
  args: {},
  examples: ['I am done focusing', 'end the focus session', 'stop focus mode', 'finished studying'],
  run: async () => {
    const focus = await loadFocus(CURRENT_UID);
    await inbox.setFocus(CURRENT_UID, null);
    if (!focus) return { ok: true, spoken: 'You were not focusing on anything.' };

    const caught = inbox
      .open(await inbox.loadInbox(CURRENT_UID))
      .filter((i) => new Date(i.at).getTime() >= new Date(focus.startedAt).getTime());
    const minutes = Math.round((Date.now() - new Date(focus.startedAt).getTime()) / 60_000);
    // "0 minutes on FIN 312" is what a stopwatch says, not a person.
    const spent = minutes < 1 ? `on ${focus.what}` : `${minutes} minutes on ${focus.what}`;
    if (caught.length === 0) {
      return { ok: true, spoken: `Done ${spent}, nothing caught.` };
    }
    return {
      ok: true,
      spoken: `Done ${spent}. ${caught.length} thing${caught.length === 1 ? '' : 's'} came up: ${caught[0].text}${caught.length > 1 ? ', and more' : ''}.`,
      detail: inbox.inboxLines(caught),
    };
  },
};

/**
 * "I sent Jason the build."
 *
 * A promise the long memory recorded stays outstanding until something says
 * it was kept, and nothing did: "what should I be doing" went on raising the
 * build for Jason long after it was sent. This closes it — the closest open
 * commitment to the words, and only one, so "done" never clears the wrong
 * thing. Not a confirmation: reopening a closed promise is one sentence away.
 */
const COMMITMENT_DONE: Ability = {
  id: 'memory.done',
  name: 'Mark as done',
  what: 'Marks something they promised or had outstanding as done, so it stops coming up. For "I sent Jason the build", "that\'s done", "I handed in the draft".',
  where: 'device',
  wired: true,
  needs: [],
  args: { what: { type: 'string', what: 'what they finished, in their words', required: true } },
  examples: [
    'mark the build for Jason as done',
    'tick off handing in the draft',
    'mark the pricing page as done',
    'tick off emailing the PE guy',
  ],
  run: async (args) => {
    const what = (args.what || '').trim();
    if (!what) return { ok: false, spoken: 'What did you finish?' };
    // The inbox first: a captured thought is the thing most likely to be
    // finished and said out loud, and it is cheaper to match than an episode.
    const caught = inbox.bestMatch(await inbox.loadInbox(CURRENT_UID), what);
    if (caught) {
      await inbox.complete(CURRENT_UID, caught.id);
      return { ok: true, spoken: `Ticked off: ${caught.text}.` };
    }

    const life = await loadLife(CURRENT_UID);
    const open = openCommitments(life);
    if (open.length === 0) return { ok: true, spoken: 'Nothing was outstanding — noted all the same.' };

    const found = searchLife({ ...life, episodes: open }, what).episodes;
    const hit = found[0];
    if (!hit) {
      return {
        ok: false,
        spoken: "I couldn't match that to anything outstanding. Which one did you finish?",
        detail: episodeLines(open, life),
      };
    }
    await updateLife(CURRENT_UID, (now) => closeEpisode(now, hit.id));
    return { ok: true, spoken: `Done: ${hit.title}.` };
  },
};

/**
 * "Brief me on Jason."
 *
 * Pulls the person together from everywhere they appear: what Grove has been
 * told about them, what happened with them, recent mail either way, and what
 * is in the calendar with their name on it. The point is the composite — any
 * one of those alone is something you could have looked up yourself.
 */
const PERSON_BRIEF: Ability = {
  id: 'person.brief',
  name: 'Brief me on someone',
  what: 'Everything about a person: what you know, what happened with them, recent mail and anything in the calendar with them.',
  where: 'server',
  wired: true,
  needs: [],
  reads: true,
  args: { who: { type: 'string', what: 'the person', required: true } },
  examples: ['brief me on Jason', 'catch me up on Priya', 'what do I know about Sarah', 'remind me who Mark is'],
  run: async (args) => {
    const who = (args.who || '').trim().replace(/^(?:my|the)\s+/i, '');
    if (!who) return { ok: false, spoken: 'Who?' };

    const life = await loadLife(CURRENT_UID);
    const entity = findEntity(life.entities, who, 'person') ?? findEntity(life.entities, who);
    const facts = recall(await loadFacts(CURRENT_UID), who);

    // Mail and calendar are live rather than remembered: what matters about a
    // person before you see them is usually the thing that arrived this week.
    const [mail, events] = await Promise.all([
      google.searchMail({ from: who, limit: 4 }).catch(() => null),
      google.readCalendar(45).catch(() => null),
    ]);
    // Not followed by a number, or "Mark" matches "MARK 312 Lecture" and
    // Grove tells you about a meeting with a course code.
    const first = who.split(/\s+/)[0].replace(/[^\w]/g, '');
    const withThem = first
      ? (events ?? []).filter((e) => new RegExp(`\\b${first}\\b(?!\\s*\\d)`, 'i').test(e.title))
      : [];
    const notes = searchNotes(await loadNotes(CURRENT_UID), who).slice(0, 3);

    const detail = [
      entity ? entityLines(life, entity) : '',
      facts.length ? `You have told me: ${facts.map((f) => f.value).join('; ')}` : '',
      withThem.length
        ? `In the calendar:\n${withThem.slice(0, 5).map((e) => `- ${shortDate(e.start)}: ${e.title}`).join('\n')}`
        : '',
      mail && mail.length > 0
        ? `Recent mail from them:\n${mail.map((m) => `- ${m.date}: ${m.subject} — ${m.snippet}`).join('\n')}`
        : '',
      notes.length ? `Notes mentioning them:\n${notes.map((n) => `- ${n.title}: ${n.summary}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    if (!detail) return { ok: true, spoken: `I have nothing on ${who} yet.` };
    return {
      ok: true,
      spoken: entity?.summary || `Here is what I have on ${who}.`,
      detail,
    };
  },
};

/**
 * Everything at once: what is happening, what is owed, what is next.
 *
 * The tool behind "what am I supposed to be doing right now" and "I have forty
 * minutes before class, what should I do". Nothing here is new information —
 * it is the calendar, the reminders, the open commitments and the goals, in
 * one place, so the model can weigh them against each other instead of
 * answering from whichever one it happened to look at.
 */
const NOW: Ability = {
  id: 'now.context',
  name: 'Where things stand',
  what: 'A picture of right now: what is on, what is outstanding, what is next, and what they are working towards. Use for "what should I be doing" and "I have an hour, what now".',
  where: 'device',
  wired: true,
  needs: [],
  reads: true,
  args: {},
  examples: [
    'what am I supposed to be doing right now',
    'I have 40 minutes before class, what should I do',
    'what should I work on',
    'where am I at',
    'catch me up',
  ],
  run: async () => {
    const now = new Date();
    const [focus, caught] = await Promise.all([
      loadFocus(CURRENT_UID),
      inbox.loadInbox(CURRENT_UID).then(inbox.open),
    ]);
    const [events, reminders, life, facts, notes, usual] = await Promise.all([
      google.readCalendar(2).catch(() => null),
      openReminders(15).catch(() => null),
      loadLife(CURRENT_UID),
      loadFacts(CURRENT_UID),
      loadNotes(CURRENT_UID),
      rhythms(CURRENT_UID)
        .then((r) => rhythmLines(r))
        .catch(() => ''),
    ]);

    // An all-day event starts at midnight, so the "last two hours" window drops
    // it for the rest of the day — today's reading week vanished from "what's
    // on". All-day entries count for the whole day they fall on.
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const soon = (events ?? [])
      .filter((e) =>
        e.allDay
          ? localTime(e.start).getTime() >= midnight.getTime()
          : localTime(e.start).getTime() > now.getTime() - 2 * 3_600_000
      )
      .slice(0, 6);
    // All-day entries are not "on now until six": they have no clock time, so
    // they are listed with the day rather than treated as something in progress.
    const timed = soon.filter((e) => !e.allDay);
    const on = timed.find(
      (e) => localTime(e.start).getTime() <= now.getTime() && localTime(e.end || e.start).getTime() > now.getTime()
    );
    const next = timed.find((e) => localTime(e.start).getTime() > now.getTime());
    const gap = next ? Math.round((localTime(next.start).getTime() - now.getTime()) / 60000) : null;

    const goals = facts.filter((f) => f.kind === 'goal').map((f) => f.value);
    const owed = facts.filter((f) => f.open).map((f) => f.value);
    const commitments = openCommitments(life).map((e) => `${e.title}${e.summary ? ` — ${e.summary}` : ''}`);
    // Anything said in the last week that someone still has to do.
    const recentNotes = notes
      .filter((n) => Date.now() - new Date(n.createdAt).getTime() < 7 * 86_400_000)
      .slice(0, 5);
    const todo = recentNotes.flatMap((n) => n.actions.map((a) => `${a} (from "${n.title}")`));

    const detail = [
      `Now: ${now.toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' })}`,
      focus
        ? `They are in a focus session on ${focus.what}${inbox.remaining(focus) ? ` — ${inbox.remaining(focus)}` : ''}. That is what they should be doing.`
        : '',
      caught.length
        ? `Captured and not dealt with (${caught.length}):\n${inbox.inboxLines(caught)}`
        : '',
      on ? `Happening now: ${on.title} until ${localTime(on.end || on.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'Nothing on right now.',
      next
        ? `Next: ${next.title} at ${localTime(next.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}${gap !== null ? ` — ${gap} minutes from now` : ''}`
        : 'Nothing else in the calendar today or tomorrow.',
      soon.length
        ? `Coming up:\n${soon
            .map(
              (e) =>
                `- ${shortDate(e.start)}${e.allDay ? ' (all day)' : ` ${localTime(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`}: ${e.title}`
            )
            .join('\n')}`
        : '',
      reminders === null
        ? 'Reminders: no access.'
        : reminders.length
          ? `Reminders outstanding:\n${reminders.slice(0, 10).map((r) => `- ${r.title}${r.due ? ` (due ${shortDate(r.due.toISOString())}${r.overdue ? ', overdue' : ''})` : ''}`).join('\n')}`
          : 'Nothing outstanding in reminders.',
      commitments.length ? `Promised and not done:\n${commitments.map((c) => `- ${c}`).join('\n')}` : '',
      owed.length ? `Still owed:\n${owed.map((o) => `- ${o}`).join('\n')}` : '',
      todo.length ? `From recent notes:\n${todo.slice(0, 8).map((t) => `- ${t}`).join('\n')}` : '',
      goals.length ? `Working towards: ${goals.join('; ')}` : '',
      // What a normal day looks like, so "I have 40 minutes" is answered
      // against their week rather than in a vacuum.
      usual,
    ]
      .filter(Boolean)
      .join('\n');

    const spoken = focus
      ? `You are meant to be on ${focus.what}${inbox.remaining(focus) ? `, ${inbox.remaining(focus)}` : ''}.`
      : on
      ? `${on.title} is on now.`
      : next && gap !== null && gap < 180
        ? `${next.title} in ${gap} minutes.`
        : 'Nothing on right now.';
    return { ok: true, spoken, detail };
  },
};

/**
 * "Anything important?"
 *
 * The inbox sorted by whether a person needs something from you, which is not
 * what an inbox is sorted by. The test is deliberately crude and local: mail
 * from a no-reply address or carrying the vocabulary of marketing is not
 * something to be told about while walking. The model gets both the sorted
 * list and the reasoning, and writes the sentence.
 */
const MAIL_IMPORTANT: Ability = {
  id: 'mail.important',
  name: 'What needs attention',
  what: 'The mail that actually needs them — real people and replies waiting — with the newsletters left out.',
  where: 'server',
  wired: true,
  needs: ['email'],
  reads: true,
  args: { since: { type: 'string', what: 'how far back, as Gmail writes it: newer_than:3d' } },
  examples: ['anything important', 'anything I need to deal with', 'what needs my attention', 'is there anything urgent'],
  run: async (args) => {
    const messages = await google.searchMail({
      category: 'primary',
      since: (args.since || '').trim() || 'newer_than:3d',
      limit: 20,
    });
    if (messages === null) return { ok: false, spoken: google.explain('your inbox') };
    if (messages.length === 0) return { ok: true, spoken: 'Nothing new worth bothering you with.' };

    const life = await loadLife(CURRENT_UID);
    const known = new Set(
      life.entities.filter((e) => e.kind === 'person').map((e) => e.name.toLowerCase().split(' ')[0])
    );

    const scored = messages
      .map((m) => {
        const from = m.from.replace(/"/g, '').toLowerCase();
        const text = `${m.subject} ${m.snippet}`.toLowerCase();
        let score = 0;
        const why: string[] = [];
        if (/no-?reply|donotreply|notifications?@|newsletter|marketing|updates@|info@/.test(from)) score -= 4;
        if (/unsubscribe|% off|sale|deal|webinar|promo|offer ends/.test(text)) score -= 3;
        if (known.has(from.replace(/<.*/, '').trim().split(/\s+/)[0])) {
          score += 3;
          why.push('someone you know');
        }
        // A person writing to you, rather than a system writing at you: a
        // display name of two or more words. "Prof. Chen" counts and
        // "LinkedIn" does not, which is the whole distinction being drawn.
        if (
          !/@(?:no-?reply|mailer|bounce)/.test(from) &&
          /^[A-Za-z][\w.,'-]*(?:\s+[A-Za-z][\w.,'-]*)+\s*</.test(m.from.replace(/"/g, '').trim())
        ) {
          score += 2;
          why.push('a person, not a service');
        }
        if (/\?/.test(text)) {
          score += 2;
          why.push('asks you something');
        }
        // Every weekday, not the two that happened to be written down first:
        // "the draft by Thursday" is exactly the mail this tool exists to find,
        // and it was scoring zero.
        if (
          /\bby (?:today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|the \d|end of|next week|then)\b|deadline|\bdue\b|asap|urgent|waiting on|waiting for|follow(?:ing)? up|chase|need (?:it|this|them|the \w+) by/.test(
            text
          )
        ) {
          score += 3;
          why.push('has a deadline');
        }
        if (/^re:/i.test(m.subject)) {
          score += 1;
          why.push('part of a thread');
        }
        return { m, score, why };
      })
      .sort((a, b) => b.score - a.score);

    const needed = scored.filter((s) => s.score >= 2).slice(0, 5);
    if (needed.length === 0) {
      return {
        ok: true,
        spoken: 'Nothing that needs you — it is all newsletters and notifications.',
        detail: scored.map((s) => `- ${s.m.from}: ${s.m.subject}`).join('\n'),
      };
    }

    return {
      ok: true,
      spoken: `${needed.length} ${needed.length === 1 ? 'email needs' : 'emails need'} you.`,
      detail: [
        `Needs attention (${needed.length}):`,
        ...needed.map((s) => `- ${s.m.from} — ${s.m.subject}: ${s.m.snippet}${s.why.length ? ` [${s.why.join(', ')}]` : ''}`),
        '',
        `The rest, not worth mentioning unless asked: ${scored
          .filter((s) => s.score < 2)
          .slice(0, 8)
          .map((s) => s.m.from.replace(/<.*/, '').trim())
          .join(', ')}`,
      ].join('\n'),
    };
  },
};

const NOTES_SEARCH: Ability = {
  id: 'notes.search',
  name: 'Notes',
  what: 'Finds what they said in their voice notes and answers from it.',
  where: 'device',
  wired: true,
  needs: [],
  reads: true,
  args: {
    about: { type: 'string', what: 'what they want to find, in their own words', required: true },
  },
  examples: [
    "what did I say about Jason's demo",
    'find my note about the budget',
    'what were the action items in my last note',
    'read me my latest note',
  ],
  run: async (args) => {
    const all = await loadNotes(CURRENT_UID);
    if (all.length === 0) {
      return { ok: true, spoken: 'You have no notes yet. Say "listen to this" to start one.' };
    }

    const about = (args.about || '').trim();
    // "My last note" names a position, not a subject — searching its words
    // would match whichever note happened to use the word "last".
    const newest = /\b(last|latest|most recent|newest|previous)\b/i.test(about);
    const found = newest ? [all[0]] : searchNotes(all, about);
    if (found.length === 0) return { ok: true, spoken: `Nothing in your notes about ${about}.` };

    const top = found[0];
    return {
      ok: true,
      spoken: top.summary ? `${top.title}. ${top.summary}` : top.title,
      detail: found
        .map((n) =>
          [
            `NOTE "${n.title}" — ${new Date(n.createdAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })}`,
            n.summary && `Summary: ${n.summary}`,
            n.points.length > 0 && `Points: ${n.points.join(' | ')}`,
            n.actions.length > 0 && `To do: ${n.actions.join(' | ')}`,
            `Transcript: ${n.transcript.slice(0, 1800)}`,
          ]
            .filter(Boolean)
            .join('\n')
        )
        .join('\n\n'),
    };
  },
};

/* ------------------------------------------------------------- the mac */

/**
 * Handing a job to the computer.
 *
 * Everything else in this file is a phone doing phone things — read this, play
 * that, put it in the calendar. This one is different in kind: it gives a
 * spoken sentence to an agent with a shell, a filesystem and a browser, and
 * lets it work. "Research the three best options and write it up" is a real
 * request, a phone cannot answer it, and a laptop can.
 *
 * Which is why it is the most carefully fenced thing here. It needs a press
 * before it runs, the same as spending money, because an agent acting on a
 * misheard sentence is the same class of problem as a payment made on one. The
 * bridge at the other end enforces the rest: one folder, a shared secret, a
 * time limit, and a log of everything it did.
 *
 * Unset by default — no URL and no token means no ability. This does not
 * quietly become available because someone is on the right network.
 */
const MAC_URL = (process.env.EXPO_PUBLIC_MAC_URL ?? '').trim();
const MAC_TOKEN = (process.env.EXPO_PUBLIC_MAC_TOKEN ?? '').trim();

const MAC_TASK: Ability = {
  id: 'mac.do',
  name: 'The Mac',
  what: 'Gives a job to the agent on your laptop — research, writing, code.',
  where: 'server',
  wired: Boolean(MAC_URL && MAC_TOKEN),
  needs: MAC_URL && MAC_TOKEN ? [] : ['the bridge running on your Mac'],
  args: {
    task: { type: 'string', what: 'the job, in their own words', required: true },
    confirmed: { type: 'string', what: 'never set this; the turn sets it after they say yes' },
  },
  examples: [
    'get my laptop to research noise cancelling headphones',
    'have my mac write up the assignment outline',
    'ask my computer to summarise that paper',
  ],
  run: async (args) => {
    const task = (args.task || '').trim();
    if (!task) return { ok: false, spoken: 'What should it do?' };
    if (!MAC_URL || !MAC_TOKEN) {
      return { ok: false, spoken: 'The bridge on your Mac is not set up yet.' };
    }

    // The same gate as a payment, for the same reason: irreversible work
    // started by a sentence, and a sentence can be misheard.
    if (!/^(yes|confirmed?)$/i.test((args.confirmed || '').trim())) {
      return {
        ok: false,
        needsConfirming: true,
        spoken: `Setting your Mac on: ${task.slice(0, 140)}`,
        detail: 'Runs in the Grove-agent folder, and is logged',
      };
    }

    try {
      // Generous, because the point of this is work that takes a while. Still
      // bounded, because an agent nobody is waiting on is one nobody is
      // watching.
      const response = await fetch(`${MAC_URL.replace(/\/$/, '')}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MAC_TOKEN}` },
        body: JSON.stringify({ task }),
        signal: AbortSignal.timeout(240_000),
      });
      if (response.status === 401) {
        return { ok: false, spoken: 'The Mac refused my token. It needs setting up again.' };
      }
      if (!response.ok) return { ok: false, spoken: 'The Mac could not take that one.' };

      const data = (await response.json()) as { ok?: boolean; text?: string };
      const said = (data.text ?? '').trim();
      if (!data.ok || !said) return { ok: false, spoken: 'It ran, and came back with nothing.' };

      // Said short, kept whole: an agent's write-up is for reading, not for
      // reciting into someone's ear.
      return { ok: true, spoken: gistOf(said, 260), detail: said };
    } catch {
      return { ok: false, spoken: 'I could not reach your Mac.' };
    }
  },
};

/* ------------------------------------------------- rides and deliveries */

/**
 * GROVE DOES NOT PAY FOR ANYTHING, AND THIS IS HOW.
 *
 * A ride and a takeaway both end in a payment, and the safe way to reach one is
 * not to build a checkout — it is to stop at the door of the app that already
 * has one. Uber knows the card, the address, the surge price and the driver;
 * it also has its own confirm screen, built by people who only do this. Grove
 * fills that screen in and hands it over.
 *
 * So the worst a misheard word can do here is open an app with the wrong
 * destination typed in, which is a thing you look at and close. There is no
 * path from a sentence to a charge, and there is not meant to be one.
 *
 * The press before the hand-off is still worth having: opening Uber mid-walk
 * because someone said "over" is its own small annoyance.
 */
const RIDE: Ability = {
  id: 'ride.request',
  name: 'Ride',
  what: 'Opens Uber with your destination already set. Only when they ask for an Uber, a ride or a cab. You confirm and pay there.',
  where: 'device',
  wired: true,
  needs: [],
  args: {
    to: { type: 'string', what: 'where they want to go', required: true },
    confirmed: { type: 'string', what: 'never set this; the turn sets it after they say yes' },
  },
  examples: ['get me an uber to campus', 'order an uber home', 'book a ride to the airport'],
  run: async (args) => {
    let to = (args.to || '').trim();
    if (!to) return { ok: false, spoken: 'Where to?' };
    if (HOME.test(to)) {
      const address = await homeAddress();
      if (!address) {
        return { ok: false, spoken: "I don't have your home address yet. Say take me home and I'll ask for it." };
      }
      to = address;
    }

    if (!/^(yes|confirmed?)$/i.test((args.confirmed || '').trim())) {
      return {
        ok: false,
        needsConfirming: true,
        spoken: `Opening Uber to ${to}`,
        detail: 'Uber takes the payment, not Grove',
      };
    }

    // Pickup is left as the current location rather than guessed: Uber knows
    // where the phone is and Grove's idea of "here" is a geocoded town.
    const url = `uber://?action=setPickup&pickup=my_location&dropoff[formatted_address]=${encodeURIComponent(to)}`;
    const web = `https://m.uber.com/ul/?action=setPickup&pickup=my_location&dropoff[formatted_address]=${encodeURIComponent(to)}`;
    const opened = (await Linking.canOpenURL(url).catch(() => false))
      ? await Linking.openURL(url).then(() => true, () => false)
      : await Linking.openURL(web).then(() => true, () => false);

    return opened
      ? { ok: true, spoken: `Uber is open with ${to} set. Confirm it there.` }
      : { ok: false, spoken: 'I could not open Uber.' };
  },
};

const DELIVERY: Ability = {
  id: 'food.order',
  name: 'Food',
  what: 'Opens a delivery app, searched for what you asked for. You order and pay there.',
  where: 'device',
  wired: true,
  needs: [],
  args: {
    what: { type: 'string', what: 'the food, restaurant or cuisine — or their usual, looked up in memory' },
    app: { type: 'string', what: '"doordash" if they said DoorDash, otherwise Uber Eats' },
    confirmed: { type: 'string', what: 'never set this; the turn sets it after they say yes' },
  },
  // Named foods, because the keyword fallback matches on words and "order some
  // sushi" shares none with a description about delivery apps. These are the
  // things people actually say when they are hungry.
  examples: [
    'order me some food',
    'get me a pizza on uber eats',
    'order thai food',
    'order some sushi',
    'get me a burger',
    'order indian food',
    'order chinese takeaway',
    'get me a curry on uber eats',
    'order my usual',
    'get me a pizza on doordash',
  ],
  run: async (args) => {
    const what = (args.what || '').trim();
    const doordash = /door ?dash/i.test(args.app || '');
    const app = doordash ? 'DoorDash' : 'Uber Eats';

    if (!/^(yes|confirmed?)$/i.test((args.confirmed || '').trim())) {
      return {
        ok: false,
        needsConfirming: true,
        spoken: what ? `Opening ${app} for ${what}` : `Opening ${app}`,
        detail: `${app} takes the payment, not Grove`,
      };
    }

    if (doordash) {
      const url = what
        ? `https://www.doordash.com/search/store/${encodeURIComponent(what)}/`
        : 'https://www.doordash.com/';
      const ok = await Linking.openURL(url).then(() => true, () => false);
      return ok
        ? { ok: true, spoken: what ? `DoorDash is open, searching ${what}. Order it there.` : 'DoorDash is open.' }
        : { ok: false, spoken: 'I could not open DoorDash.' };
    }

    // A search, never a basket. "Order my usual" is the request people make and
    // the one no app exposes to a third party — putting food in a basket
    // unseen is exactly the thing this file refuses to do.
    const web = what
      ? `https://www.ubereats.com/search?q=${encodeURIComponent(what)}`
      : 'https://www.ubereats.com/';
    const opened = await Linking.openURL(web).then(() => true, () => false);
    return opened
      ? {
          ok: true,
          spoken: what
            ? `Uber Eats is open, searching ${what}. Order it there.`
            : 'Uber Eats is open.',
        }
      : { ok: false, spoken: 'I could not open Uber Eats.' };
  },
};

/**
 * Where they are, as a shop's country: .ca, .co.uk or .com.
 *
 * Read from the phone's locale rather than guessed from the home town, because
 * the locale is what the store's own app will be set to — and an Amazon search
 * opened on the wrong country's site shows prices you cannot pay.
 */
function shopRegion(): 'ca' | 'uk' | 'us' {
  const locale = Intl.NumberFormat().resolvedOptions().locale || '';
  if (/-CA\b/i.test(locale)) return 'ca';
  if (/-GB\b/i.test(locale)) return 'uk';
  return 'us';
}

const STORES: Record<string, { name: string; url: (q: string, region: 'ca' | 'uk' | 'us') => string }> = {
  amazon: {
    name: 'Amazon',
    url: (q, r) => `https://www.amazon.${r === 'ca' ? 'ca' : r === 'uk' ? 'co.uk' : 'com'}/s?k=${encodeURIComponent(q)}`,
  },
  instacart: {
    name: 'Instacart',
    url: (q, r) => `https://www.instacart.${r === 'ca' ? 'ca' : 'com'}/store/s?k=${encodeURIComponent(q)}`,
  },
  walmart: {
    name: 'Walmart',
    url: (q, r) => `https://www.walmart.${r === 'ca' ? 'ca' : 'com'}/search?q=${encodeURIComponent(q)}`,
  },
  costco: {
    name: 'Costco',
    url: (q, r) => `https://www.costco.${r === 'ca' ? 'ca' : 'com'}/CatalogSearch?keyword=${encodeURIComponent(q)}`,
  },
};

/**
 * Buying things, the same way rides and takeaways work: Grove opens the store
 * already searched, and the person picks, pays and confirms there.
 *
 * Never a basket, never a checkout. Amazon knows the card, the address and the
 * price; Grove's part ends at the search, behind a press — see the note on
 * money at the top of this file.
 */
const SHOP: Ability = {
  id: 'shop.order',
  name: 'Shopping',
  what: 'Opens a store app searched for something to buy — Amazon, Instacart, Walmart or Costco. They choose and pay there.',
  where: 'device',
  wired: true,
  needs: [],
  args: {
    what: { type: 'string', what: 'what they want to buy, as specific as they said', required: true },
    store: { type: 'string', what: 'amazon, instacart (groceries), walmart or costco; amazon if they did not say' },
    confirmed: { type: 'string', what: 'never set this; the turn sets it after they say yes' },
  },
  examples: [
    'order me a phone charger on amazon',
    'get me paper towels from amazon',
    'order groceries on instacart',
    'buy protein powder on costco',
  ],
  run: async (args) => {
    const what = (args.what || '').trim();
    if (!what) return { ok: false, spoken: 'What are we buying?' };
    const key = Object.keys(STORES).find((k) => (args.store || '').toLowerCase().includes(k)) ?? 'amazon';
    const store = STORES[key];

    if (!/^(yes|confirmed?)$/i.test((args.confirmed || '').trim())) {
      return {
        ok: false,
        needsConfirming: true,
        spoken: `Opening ${store.name} for ${what}`,
        detail: `${store.name} takes the payment, not Grove`,
      };
    }

    const opened = await Linking.openURL(store.url(what, shopRegion())).then(() => true, () => false);
    return opened
      ? { ok: true, spoken: `${store.name} is open with ${what} searched. Pick one and check out there.` }
      : { ok: false, spoken: `I could not open ${store.name}.` };
  },
};

const MEMORY_ADD: Ability = {
  id: 'memory.add',
  name: 'Remember',
  what: 'Writes something down — a fact about you, or a goal you are working towards.',
  where: 'device',
  wired: true,
  needs: [],
  args: {
    what: { type: 'string', what: 'the thing to remember, in their own words', required: true },
    kind: { type: 'string', what: '"goal" if it is something they are working towards' },
    about: { type: 'string', what: 'who it concerns, if not themselves' },
  },
  examples: [
    'add learning Spanish to my goals',
    'remember that Sam owes me twenty quid',
    'add this to my goals',
    'note that the landlord visit is on Friday',
    'keep in mind I prefer mornings',
  ],
  run: async (args) => {
    const what = (args.what || '').trim();
    if (!what) return { ok: false, spoken: 'What should I remember?' };

    // A goal because they said so, or because the phrasing is unmistakable.
    const asGoal =
      /goal|aim|ambition|working towards|want to achieve/i.test(args.kind || '') ||
      /\b(?:to my goals?|as a goal)\b/i.test(what);

    const subject = (args.about || '').trim().toLowerCase() || 'me';
    const value = what
      .replace(/\b(?:to|on|in) my (?:goals?|memory|list)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!value) return { ok: false, spoken: 'What should I remember?' };

    await remember(CURRENT_UID, {
      key: asGoal ? 'goal' : 'note',
      value,
      source: 'told',
      subject,
      ...(asGoal ? { kind: 'goal' as const } : {}),
    });

    return {
      ok: true,
      spoken: asGoal ? `Added to your goals: ${value}.` : `Got it — ${value}.`,
      detail: asGoal ? 'goal' : `about ${subject}`,
    };
  },
};

const RECALL: Ability = {
  id: 'memory.recall',
  name: 'Memory',
  what: 'Says what it knows about someone, and what you still owe them.',
  where: 'device',
  wired: true,
  needs: [],
  reads: true,
  args: { about: { type: 'string', what: 'the person or thing being asked about', required: true } },
  examples: [
    'what was I supposed to ask Sarah about',
    'what do I know about Priya',
    'what did I say about the flat',
  ],
  run: async (args) => {
    const about = (args.about || '').trim();
    if (!about) return { ok: false, spoken: 'About who?' };

    // uid is not in scope here; memory is per-account and the agent passes the
    // account through remember(). Reading the same store keyed the same way.
    const facts = await loadFacts(CURRENT_UID);
    const hits = recall(facts, about);
    if (hits.length === 0) return { ok: true, spoken: `Nothing about ${about}.` };

    // Outstanding things first — the question is almost always "what am I
    // forgetting", not "recite everything".
    const open = hits.filter((f) => f.open);
    const rest = hits.filter((f) => !f.open);
    const pick = [...open, ...rest].slice(0, 3);

    const said = pick.map((f) => f.value).join('. ');
    const more = hits.length > pick.length ? ` And ${hits.length - pick.length} more.` : '';
    return { ok: true, spoken: `${said}.${more}`, detail: `${hits.length} remembered` };
  },
};

/**
 * A message, as far as iOS will allow.
 *
 * There is no API to send an SMS or an iMessage. None. `sms:` opens the
 * Messages app with the recipient and body already filled in, and the person
 * taps send — which is one tap more than hands-free, and is the entire
 * available surface. Anyone claiming otherwise is describing a jailbreak.
 *
 * So this is honest about what it does: it composes the message and hands it
 * over ready to send, and says so. Mail is the path that genuinely completes
 * without touching the phone, and Grove offers that instead when it can.
 */
const MESSAGE: Ability = {
  id: 'message.compose',
  name: 'Message',
  what: 'Writes a text and opens it ready to send.',
  where: 'device',
  wired: true,
  needs: [],
  args: {
    to: { type: 'string', what: 'who — a name, or a number if they gave one' },
    body: { type: 'string', what: 'what the message says', required: true },
  },
  examples: [
    'text Sam that we are going at seven',
    'message the group the address',
    'let Priya know I am running late',
  ],
  run: async (args) => {
    const body = (args.body || '').trim();
    if (!body) return { ok: false, spoken: 'Saying what?' };

    const to = (args.to || '').trim();
    // A number goes straight in. A name is looked up in Google Contacts, which
    // is the one address book Grove can read — iOS keeps its own to itself.
    // When the lookup cannot settle on one number the sheet still opens with
    // the words ready, and says so, because naming a recipient that is not
    // filled in is how someone sends "running late" to nobody.
    const digits = to.replace(/[^\d+]/g, '');
    let target = digits.length >= 7 ? digits : '';
    let named = '';
    let unsure = '';
    if (!target && to) {
      const found = await google.findContact(to).catch(() => null);
      const withPhone = (found ?? []).filter((c) => c.phone);
      if (withPhone.length === 1) {
        target = (withPhone[0].phone ?? '').replace(/[^\d+]/g, '');
        named = withPhone[0].name;
      } else if (withPhone.length > 1) {
        unsure = `I found ${withPhone.length} people called ${to}, so pick which one`;
      } else {
        unsure = `I have no number for ${to}, so pick them`;
      }
    }
    const url = `sms:${target}${Platform.OS === 'ios' ? '&' : '?'}body=${encodeURIComponent(body)}`;

    const opened = await Linking.canOpenURL(url)
      .then((can) => (can ? Linking.openURL(url).then(() => true) : false))
      .catch(() => false);

    if (!opened) return { ok: false, spoken: 'I could not open Messages.' };
    // Said plainly, because the one thing worse than a tap is thinking it sent.
    return {
      ok: true,
      spoken: target
        ? `Written to ${named || to}. Tap send — iOS won't let me send it for you.`
        : unsure
          ? `It's written. ${unsure}, then tap send.`
          : "It's ready in Messages. Pick who, and tap send.",
    };
  },
};

/**
 * Switching mode by voice.
 *
 * This was missing, and its absence was invisible from the outside: asked to go
 * into focus mode, Grove correctly reported that it could not touch the
 * device's settings, because nothing here could. A mode you can only reach by
 * tapping is a mode you cannot use with your phone in your pocket, which is the
 * only situation Grove exists for.
 *
 * Matched loosely on the mode's own name, because "focus", "focus mode" and
 * "go into focus" are the same request.
 */
const SET_MODE: Ability = {
  id: 'mode.set',
  name: 'Mode',
  what: 'Switches which mode you are in, and runs whatever that mode starts.',
  where: 'device',
  wired: true,
  needs: [],
  args: { mode: { type: 'string', what: 'which one: normal, focus, gym or wind down', required: true } },
  examples: ['go into focus mode', 'switch to wind down', 'gym mode', 'back to normal'],
  run: async (args) => {
    const asked = (args.mode || '').toLowerCase().replace(/\bmode\b/g, '').trim();
    if (!asked) return { ok: false, spoken: 'Which mode?' };

    const wanted = MODES.find((m) => {
      const label = m.label.toLowerCase();
      const id = m.id.replace('-', ' ');
      return asked.includes(label) || label.includes(asked) || asked.includes(id) || id.includes(asked);
    });
    if (!wanted) {
      return {
        ok: false,
        spoken: `There's no ${asked} mode. There's focus, gym, wind down, or normal.`,
      };
    }
    if (!onModeChange) return { ok: false, spoken: 'I can\'t switch modes right now.' };

    await onModeChange(wanted.id);
    // The mode's own instruction runs from the provider, and speaks for itself,
    // so this stays short rather than announcing something twice.
    return { ok: true, spoken: wanted.id === 'normal' ? 'Back to normal.' : `${wanted.label} mode.` };
  },
};

export const ABILITIES: Ability[] = [
  NOW,
  CAPTURE,
  INBOX_REVIEW,
  FOCUS_START,
  FOCUS_END,
  COMMITMENT_DONE,
  LIFE_SEARCH,
  PERSON_BRIEF,
  MAIL_IMPORTANT,
  REMIND_BATCH,
  NOTES_SEARCH,
  MAC_TASK,
  RIDE,
  DELIVERY,
  SHOP,
  CONTACT_FIND,
  CALL,
  MEMORY_ADD,
  MAIL_DIGEST,
  CALENDAR_ADD,
  CALENDAR_REMOVE,
  CALENDAR_FIND,
  MAIL_REPLY,
  GCAL_READ,
  DOC_FIND,
  DOC_CREATE,
  DOC_RECENT,
  DOC_APPEND,
  SET_MODE,
  RECALL,
  MESSAGE,
  DAY,
  WEATHER,
  DIRECTIONS,
  NAVIGATE,
  MAIL_READ,
  MAIL_SEND,
  BRIEF,
  CALENDAR_READ,
  CALENDAR_MOVE,
  REMIND,
  MUSIC,
  MUSIC_RECENT,
];

/* ------------------------------------------------------------- lookups */

/**
 * How long any ability gets before Grove gives up on it.
 *
 * Spoken, so this is generous rather than snappy — a briefing that takes eight
 * seconds is fine. What is not fine is never coming back at all.
 */
const RUN_TIMEOUT_MS = 20_000;

/** For abilities that write rather than look up. See `slow` on Ability. */
const SLOW_RUN_TIMEOUT_MS = 150_000;

/**
 * Runs an ability and guarantees an answer.
 *
 * This exists because of a specific failure: Grove would say "I'll check that
 * for you", the ability would hang on a stalled fetch, and nothing ever
 * followed. There is no second turn and no background retry, so a run that
 * never resolves is a conversation that simply stops — with the person waiting
 * on something that is never coming.
 *
 * Bounding it here rather than inside each ability is deliberate. Every ability
 * is a hand-written function, some of them call `fetch` directly, and one that
 * forgets its own timeout should not be able to take the turn down. This is the
 * one place that has to be right.
 */
export async function runAbility(
  ability: Ability,
  args: Record<string, string>
): Promise<AbilityResult> {
  try {
    return await Promise.race([
      ability.run(args),
      new Promise<AbilityResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              spoken: `${ability.name} took too long. Ask me again in a moment.`,
            }),
          ability.timeoutMs ?? (ability.slow ? SLOW_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS)
        )
      ),
    ]);
  } catch (error) {
    return {
      ok: false,
      spoken: error instanceof Error ? error.message : `${ability.name} failed.`,
    };
  }
}

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

