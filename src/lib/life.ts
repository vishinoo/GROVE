/**
 * The long memory: the people, projects, places and ideas in someone's life,
 * and the dated things that happened with them.
 *
 * WHY THIS IS NOT memory.ts
 *
 * memory.ts holds forty one-line facts and sends every one of them with every
 * turn. That is right for what it is — where you live, your sister's name — and
 * wrong for a life, which is thousands of things, most of them irrelevant to
 * any given question. This is the other half: kept in full, sent never, and
 * searched when something asks about it. "Brief me on Jason" and "that defence
 * startup idea from last month" are answered from here.
 *
 * TWO SHAPES, BECAUSE THERE ARE TWO QUESTIONS
 *
 *   Entities  who and what. A person, a project, a place, an idea. Each holds
 *             a short summary and its own facts, so everything known about
 *             Jason is one lookup rather than a search through everything.
 *   Episodes  what happened, and when. A meeting, a conversation, a note, an
 *             idea you had on a walk. Dated, and linked to the entities in
 *             them, which is what makes "last month" answerable.
 *
 * HOW IT FILLS, AND WHAT IT COSTS
 *
 * Never a model call per turn. It fills from consolidation: turns collect in a
 * small buffer, and every dozen or so one call reads them and keeps what
 * matters. A finished voice note or meeting log gets the same read once, as it
 * closes. The buffer is then deleted, so the words you said are not kept; what
 * they meant is.
 *
 * WHERE IT LIVES
 *
 * On the phone, per account, like everything else. Every record carries an id
 * and an updatedAt so it can be merged with Noctus later without a migration —
 * that is the only concession to a server, and it costs two fields.
 *
 * Everything here is visible and deletable on the Sparks screen. A memory you
 * cannot see is a memory you cannot correct, and a wrong one repeated back with
 * confidence is worse than none.
 */

import { vault } from './vault';

import { shortDate, within, type Window } from './when';

export type EntityKind = 'person' | 'project' | 'place' | 'org' | 'idea' | 'topic';

export type EntityFact = {
  text: string;
  at: string;
  /** Where it was learned: a note id, or 'conversation'. */
  source?: string;
  /**
   * Replaced by something newer — "lives in Toronto" once "moved to Berlin"
   * arrives. Kept rather than deleted, so the history is there, but never
   * offered as current: holding both as true is how an assistant ends up
   * confidently wrong about someone it knows well.
   */
  stale?: boolean;
};

export type Entity = {
  id: string;
  kind: EntityKind;
  /** As they say it: "Jason", "Noctus", "FIN 312". */
  name: string;
  /** Other ways they have referred to it: "Jason Park", "J". */
  aliases: string[];
  /** For a person, who they are to the user: "cofounder", "sister", "professor". */
  relation?: string;
  /** One or two sentences, rewritten as more is learned. */
  summary: string;
  /** Specific things, newest first. Capped per entity. */
  facts: EntityFact[];
  firstSeen: string;
  lastSeen: string;
  /** How many episodes have involved it — a rough measure of how central it is. */
  mentions: number;
  updatedAt: string;
};

export type EpisodeKind = 'conversation' | 'note' | 'meeting' | 'idea' | 'commitment' | 'event';

export type Episode = {
  id: string;
  kind: EpisodeKind;
  /** When it happened, not when it was stored. */
  at: string;
  title: string;
  summary: string;
  /** Entity ids. */
  about: string[];
  /** A commitment still outstanding — "send Jason the build by Friday". */
  open?: boolean;
  /** Where it came from: a note id, or 'conversation'. */
  source: string;
  updatedAt: string;
};

export type Life = {
  entities: Entity[];
  episodes: Episode[];
  /** Turns waiting to be consolidated. Deleted once they have been. */
  pending: { at: string; said: string; replied: string }[];
  lastConsolidated?: string;
  /** How many consolidations have run since the memory was last tidied. */
  sinceCompacted?: number;
};

/**
 * Large enough to hold years, small enough that loading it is never the slow
 * part. At a few hundred bytes each this is well under a megabyte.
 */
const ENTITY_LIMIT = 500;
const EPISODE_LIMIT = 2000;
const FACTS_PER_ENTITY = 30;
/** Turns held for consolidation. Past this the oldest go unread. */
const PENDING_LIMIT = 40;
/** How many turns collect before they are worth a consolidation call. */
export const CONSOLIDATE_AFTER = 12;

const KEY = 'grove:life:v1';

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const EMPTY: Life = { entities: [], episodes: [], pending: [] };

export async function loadLife(uid: string): Promise<Life> {
  try {
    const raw = await vault.getItem(storageKey(uid));
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<Life>;
    return {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      episodes: Array.isArray(parsed.episodes) ? parsed.episodes : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      lastConsolidated: parsed.lastConsolidated,
      // Dropped here once, which reset the counter on every load and meant
      // compaction never reached its threshold — the whole tidy-up path was
      // dead code that type-checked and passed the harness.
      sinceCompacted: typeof parsed.sinceCompacted === 'number' ? parsed.sinceCompacted : 0,
    };
  } catch {
    // A corrupt archive is a forgetful assistant, not a broken app.
    return { ...EMPTY };
  }
}

/**
 * One writer at a time.
 *
 * Consolidation, a finished note and a new turn can all land within the same
 * second, and two read-modify-write cycles interleaved lose whichever finished
 * first. Chained here so each sees the last one's result.
 */
let queue: Promise<unknown> = Promise.resolve();

export function updateLife(uid: string, change: (life: Life) => Life): Promise<Life> {
  const run = queue.then(async () => {
    const next = trim(change(await loadLife(uid)));
    try {
      await vault.setItem(storageKey(uid), JSON.stringify(next));
    } catch {
      // Losing one write costs a detail, not the archive.
    }
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}

function trim(life: Life): Life {
  // Least-mentioned and longest-unseen go first: someone you talk about every
  // week outlives a restaurant named once in March.
  const entities =
    life.entities.length <= ENTITY_LIMIT
      ? life.entities
      : [...life.entities]
          .sort((a, b) => b.mentions - a.mentions || b.lastSeen.localeCompare(a.lastSeen))
          .slice(0, ENTITY_LIMIT);
  const episodes = [...life.episodes].sort((a, b) => b.at.localeCompare(a.at)).slice(0, EPISODE_LIMIT);
  return { ...life, entities, episodes, pending: life.pending.slice(-PENDING_LIMIT) };
}

/* ------------------------------------------------------------ matching */

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The entity a name refers to, if one is already known.
 *
 * Exact name or alias first, then a first name matching a full one — "Jason"
 * finds "Jason Park". Never the reverse on people: "Jason Park" arriving when
 * two Jasons are known is a new person rather than a guess.
 */
/** Everything Grove worked out about someone's life, gone. */
export async function forgetAllLife(uid: string): Promise<void> {
  await vault.removeItem(storageKey(uid)).catch(() => {});
}

export function findEntity(entities: Entity[], name: string, kind?: EntityKind): Entity | undefined {
  const n = norm(name);
  if (!n) return undefined;
  const pool = kind ? entities.filter((e) => e.kind === kind) : entities;
  const exact = pool.find((e) => norm(e.name) === n || e.aliases.some((a) => norm(a) === n));
  if (exact) return exact;
  // A leading word only counts inside one kind. Without that, "Mark" the
  // investor was filed under "MARK 312" the course — one entity holding a
  // person's relationship and a lecture's midterm, which is unrecoverable
  // once it has happened.
  const firsts = pool.filter((e) => norm(e.name).split(' ')[0] === n && e.kind === (kind ?? e.kind));
  return firsts.length === 1 && (kind || firsts[0].kind === 'person') ? firsts[0] : undefined;
}

/* ---------------------------------------------------------------- writes */

export type Learned = {
  entities?: {
    name: string;
    kind?: string;
    relation?: string;
    summary?: string;
    facts?: string[];
    /** Facts already held that this replaces, as they were written. */
    outdated?: string[];
  }[];
  episodes?: {
    kind?: string;
    title: string;
    summary?: string;
    about?: string[];
    open?: boolean;
    at?: string;
  }[];
};

const KINDS: EntityKind[] = ['person', 'project', 'place', 'org', 'idea', 'topic'];
const EPISODE_KINDS: EpisodeKind[] = ['conversation', 'note', 'meeting', 'idea', 'commitment', 'event'];

/**
 * Folds what was learned into the archive.
 *
 * Merges rather than appends: a known person gets new facts and a fresh
 * summary, not a second entry. Facts already held, word for word, are dropped
 * — a consolidation that runs over the same week twice should change nothing.
 */
/** How a model says "this entity is the person I am talking to". */
const SELF = /^(self|me|myself|user|the user|owner|i)$/i;

export function absorb(life: Life, learned: Learned, source: string, now = new Date()): Life {
  const stamp = now.toISOString();
  const entities = [...life.entities];

  /**
   * The names this material used for the person themselves.
   *
   * Collected before anything is absorbed, because an episode's `about` list
   * refers to entities by name and is read after them. Skipping the self entity
   * on its own was not enough: "Vishnu" then arrived as an unknown name from an
   * episode and was minted a second time as a bare topic.
   */
  const mine = new Set(
    (learned.entities ?? [])
      .filter((e) => SELF.test((e.relation ?? '').trim()))
      .map((e) => norm(e.name ?? ''))
      .filter(Boolean)
  );

  const idFor = (name: string, kind?: string): string | null => {
    const clean = name.trim().slice(0, 60);
    if (!clean || /^(me|i|myself|the user|user)$/i.test(clean)) return null;
    if (mine.has(norm(clean))) return null;
    const k = (KINDS.includes(kind as EntityKind) ? kind : 'topic') as EntityKind;
    // Kindless only when the model did not say what this is. A named kind that
    // finds nothing is a new thing, not an excuse to match something else.
    const known = kind ? findEntity(entities, clean, k) : findEntity(entities, clean);
    if (known) return known.id;
    const made: Entity = {
      id: newId(),
      kind: k,
      name: clean,
      aliases: [],
      summary: '',
      facts: [],
      firstSeen: stamp,
      lastSeen: stamp,
      mentions: 0,
      updatedAt: stamp,
    };
    entities.push(made);
    return made.id;
  };

  for (const e of learned.entities ?? []) {
    // The person is not a person in their own life.
    //
    // The name guard in idFor catches "me" and "the user"; this catches the
    // commoner version, which is the model filing them under their own name
    // with a relation that gives it away. Told not to, it still did it from a
    // first-person intro — so code decides. Left in, it put "Vishnu (self)" at
    // the head of a roster of the people in Vishnu's life, and everything true
    // about them was held twice, in the one place that is searched rather than
    // the one place that is always in mind.
    if (mine.has(norm(e.name ?? ''))) continue;
    const id = idFor(e.name, e.kind);
    if (!id) continue;
    const i = entities.findIndex((x) => x.id === id);
    const current = entities[i];
    const held = new Set(current.facts.map((f) => norm(f.text)));
    const fresh: EntityFact[] = (e.facts ?? [])
      .map((f) => String(f).trim().slice(0, 200))
      .filter((f) => f && !held.has(norm(f)))
      .map((text) => ({ text, at: stamp, source }));
    const outdated = new Set((e.outdated ?? []).map((f) => norm(String(f))));
    const kept = current.facts.map((f) => (outdated.has(norm(f.text)) ? { ...f, stale: true } : f));
    const longer = e.name.trim().length > current.name.length && norm(e.name).startsWith(norm(current.name));
    entities[i] = {
      ...current,
      // "Jason" becomes "Jason Park" when the surname turns up, and "Jason"
      // stays an alias so it is still found by the name used most.
      name: longer ? e.name.trim() : current.name,
      aliases: longer && !current.aliases.includes(current.name) ? [...current.aliases, current.name] : current.aliases,
      relation: e.relation?.trim() || current.relation,
      summary: e.summary?.trim() ? e.summary.trim().slice(0, 400) : current.summary,
      // Stale facts go first when the cap bites: history is worth less than
      // anything still true.
      facts: [...fresh, ...kept.filter((f) => !f.stale), ...kept.filter((f) => f.stale)].slice(0, FACTS_PER_ENTITY),
      lastSeen: stamp,
      updatedAt: stamp,
    };
  }

  const episodes = [...life.episodes];
  for (const ep of learned.episodes ?? []) {
    const title = ep.title?.trim().slice(0, 120);
    if (!title) continue;
    const about = (ep.about ?? []).map((n) => idFor(n)).filter((x): x is string => !!x);
    const at = ep.at && Number.isFinite(new Date(ep.at).getTime()) ? new Date(ep.at).toISOString() : stamp;
    // The same thing learned twice — a note consolidated again — is one episode.
    if (episodes.some((x) => norm(x.title) === norm(title) && x.at.slice(0, 10) === at.slice(0, 10))) continue;
    episodes.push({
      id: newId(),
      kind: (EPISODE_KINDS.includes(ep.kind as EpisodeKind) ? ep.kind : 'conversation') as EpisodeKind,
      at,
      title,
      summary: (ep.summary ?? '').trim().slice(0, 600),
      about,
      ...(ep.open ? { open: true } : {}),
      source,
      updatedAt: stamp,
    });
    for (const id of new Set(about)) {
      const i = entities.findIndex((x) => x.id === id);
      if (i >= 0) entities[i] = { ...entities[i], mentions: entities[i].mentions + 1, lastSeen: stamp };
    }
  }

  return { ...life, entities, episodes };
}

export function forgetEntity(life: Life, id: string): Life {
  return {
    ...life,
    entities: life.entities.filter((e) => e.id !== id),
    // Episodes stay — they happened — but stop pointing at someone deleted.
    episodes: life.episodes.map((ep) => ({ ...ep, about: ep.about.filter((a) => a !== id) })),
  };
}

export function forgetEpisode(life: Life, id: string): Life {
  return { ...life, episodes: life.episodes.filter((e) => e.id !== id) };
}

export function closeEpisode(life: Life, id: string): Life {
  return {
    ...life,
    episodes: life.episodes.map((e) =>
      e.id === id ? { ...e, open: false, updatedAt: new Date().toISOString() } : e
    ),
  };
}

/* ------------------------------------------------------------- reading */

const IGNORED = new Set([
  'what', 'did', 'say', 'said', 'about', 'the', 'and', 'for', 'that', 'this', 'with', 'was',
  'were', 'have', 'had', 'you', 'tell', 'remember', 'from', 'when', 'where', 'which', 'any',
  'anything', 'again', 'last', 'month', 'week', 'year', 'ago', 'recently', 'yesterday',
  'today', 'thing', 'things', 'something', 'there', 'they', 'them', 'there', 'mine', 'our',
]);

function words(text: string): string[] {
  return norm(text)
    .split(' ')
    .map((w) => w.replace(/s$/, ''))
    .filter((w) => w.length > 2 && !IGNORED.has(w));
}

export type Found = { entities: Entity[]; episodes: Episode[] };

/**
 * What bears on a question, best first, inside a time window if one was named.
 *
 * Scored on words, because the question never repeats what was said. An entity
 * whose name is in the question wins outright; after that, titles count more
 * than summaries, and recent beats old when the scores tie.
 */
export function searchLife(life: Life, query: string, window: Window | null = null): Found {
  const wanted = [...new Set(words(query))];

  const named = life.entities.filter((e) =>
    [e.name, ...e.aliases].some((n) => {
      const nn = norm(n);
      return nn.length > 1 && (` ${norm(query)} `.includes(` ${nn} `) || wanted.includes(nn.split(' ')[0]));
    })
  );
  const namedIds = new Set(named.map((e) => e.id));

  const episodes = life.episodes
    .filter((ep) => within(ep.at, window))
    .map((ep) => {
      let score = ep.about.some((a) => namedIds.has(a)) ? 6 : 0;
      const title = words(ep.title);
      const body = words(ep.summary);
      for (const w of wanted) {
        if (title.includes(w)) score += 3;
        if (body.includes(w)) score += 1;
      }
      // A window with no words ("what happened last week") wants everything in it.
      if (wanted.length === 0 && window) score += 1;
      return { ep, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || b.ep.at.localeCompare(a.ep.at))
    .slice(0, 12)
    .map((m) => m.ep);

  const entities = [
    ...named,
    ...life.entities
      .filter((e) => !namedIds.has(e.id))
      .map((e) => {
        const text = words(`${e.name} ${e.relation ?? ''} ${e.summary} ${current(e).map((f) => f.text).join(' ')}`);
        return { e, score: wanted.filter((w) => text.includes(w)).length };
      })
      .filter((m) => m.score > 0 && (!window || within(m.e.lastSeen, window)))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((m) => m.e),
  ];

  return { entities, episodes };
}

/** What is still believed about an entity. */
export function current(entity: Entity): EntityFact[] {
  return entity.facts.filter((f) => !f.stale);
}

/** Everything about one entity, as the model will read it. */
export function entityLines(life: Life, entity: Entity): string {
  const eps = life.episodes
    .filter((ep) => ep.about.includes(entity.id))
    .slice(0, 15)
    .map((ep) => `- ${shortDate(ep.at)}: ${ep.title}${ep.open ? ' (still outstanding)' : ''}${ep.summary ? ` — ${ep.summary}` : ''}`);
  return [
    `${entity.name}${entity.relation ? ` (${entity.relation})` : ''} — ${entity.kind}`,
    entity.summary,
    current(entity).length ? `Known: ${current(entity).map((f) => f.text).join('; ')}` : '',
    entity.facts.some((f) => f.stale)
      ? `No longer true: ${entity.facts.filter((f) => f.stale).map((f) => f.text).join('; ')}`
      : '',
    eps.length ? `History:\n${eps.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function episodeLines(episodes: Episode[], life: Life): string {
  const name = (id: string) => life.entities.find((e) => e.id === id)?.name;
  return episodes
    .map((ep) => {
      const who = ep.about.map(name).filter(Boolean).join(', ');
      return `- ${shortDate(ep.at)} [${ep.kind}] ${ep.title}${ep.open ? ' (still outstanding)' : ''}${who ? ` — with/about ${who}` : ''}${ep.summary ? `: ${ep.summary}` : ''}`;
    })
    .join('\n');
}

/** Commitments not yet done, newest first. */
export function openCommitments(life: Life): Episode[] {
  return life.episodes.filter((ep) => ep.open).slice(0, 10);
}

/**
 * The people and projects in someone's life right now, for the system prompt.
 *
 * A handful of names with who they are, so "tell my cofounder" and "Jason" are
 * the same person without a lookup. Short on purpose: this rides on every turn.
 */
export function whoIsWho(life: Life, limit = 10): string {
  const recent = [...life.entities]
    .filter((e) => e.kind === 'person' || e.kind === 'project')
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.mentions - a.mentions)
    .slice(0, limit);
  if (recent.length === 0) return '';
  return `People and projects in their life right now: ${recent
    .map((e) => `${e.name}${e.relation ? ` (${e.relation})` : e.kind === 'project' ? ' (project)' : ''}`)
    .join(', ')}. Look one up with the memory tools before saying anything specific about them.`;
}

/**
 * What has been going on in their life, in a line or two.
 *
 * This is what lets Grove behave like a friend rather than a search engine:
 * knowing, without being asked, that the midterm is Thursday and that the build
 * for Jason is still owed. Titles only, the last few days and anything still
 * outstanding — a friend's working memory, not the archive, and small enough to
 * ride on every turn.
 */
export function lately(life: Life, now = new Date()): string {
  /*
    What is owed, and nothing else.

    This used to open with "Lately in their life:" and five recent episode
    titles, on every turn. Telling a model five things that happened this week,
    every time anyone says anything, is an instruction to mention them — and it
    did: a greeting came back with a fact about last Tuesday's meeting attached.
    Asking it nicely in the next sentence not to does not work, because the
    cheapest way to look like you were listening is to use what you were handed.

    An open commitment survives because it is not a topic, it is a thing with
    someone waiting at the other end of it, and it stays true until it is done.
    Anything else that happened is a tool call away the moment it is asked for.
  */
  void now;
  const owed = openCommitments(life)
    .slice(0, 4)
    .map((ep) => ep.title);
  return owed.length
    ? `Still outstanding: ${owed.join('; ')}. Background only — raise one only if they ask, or if what they just said bears on it directly.`
    : '';
}

/* ---------------------------------------------------------- compaction */

/** Facts worth tidying: enough of them that they have started to overlap. */
const CLUTTERED = 6;

/**
 * The subjects worth a tidy-up, densest first.
 *
 * Only ones that have collected enough separate facts to be repeating
 * themselves — tidying a person you have mentioned twice costs a call and
 * changes nothing.
 */
export function needsCompacting(life: Life, limit = 5): Entity[] {
  return [...life.entities]
    .filter((e) => current(e).length >= CLUTTERED)
    .sort((a, b) => current(b).length - current(a).length)
    .slice(0, limit);
}

/** What the model is given: each subject, and what is known about it. */
export function compactionBlock(entities: Entity[]): string {
  return entities
    .map((e) =>
      [
        `Subject: ${e.name}${e.relation ? ` (${e.relation})` : ''} [${e.kind}]`,
        e.summary ? `Summary: ${e.summary}` : '',
        ...current(e).map((f) => `- ${f.text}`),
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');
}

/**
 * Folds a tidied subject back in.
 *
 * The merged facts replace the current ones and keep the oldest timestamp
 * among them, because a fact learned in March that was merged in September is
 * still something known since March — and the date is what "what did I decide
 * back then" searches on. Stale facts are left exactly as they were.
 */
export function applyCompaction(
  life: Life,
  tidied: { name: string; summary?: string; facts?: string[] }[],
  now = new Date()
): Life {
  const stamp = now.toISOString();
  const entities = life.entities.map((entity) => {
    const match = tidied.find((t) => norm(t.name) === norm(entity.name));
    const facts = (match?.facts ?? []).map((f) => String(f).trim()).filter(Boolean);
    if (!match || facts.length === 0) return entity;

    const was = current(entity);
    // Good tidying is meant to shrink the list — seven facts into three is the
    // point — so length is the wrong thing to guard. What must survive is the
    // specifics: every name, number and date that was there before has to
    // still be there after, or this was a summariser losing information rather
    // than a tidier merging it.
    if (facts.length === 0 || facts.length > was.length) return entity;
    // Proper nouns and numbers, ignoring the first word of a sentence — which
    // is capitalised for grammar, not because it is a name. Without that,
    // "Taking MARK 312" losing its capital T counted as lost information and
    // every tidy-up was refused.
    const specifics = (text: string) =>
      (text.replace(/^\W*\w+/, '').match(/[A-Z][\w&.'-]+|\d[\d:/.,-]*/g) ?? []).map((w) => w.toLowerCase());
    const kept = facts.join(' ').toLowerCase();
    const lost = [...new Set(was.flatMap((f) => specifics(f.text)))].filter((w) => !kept.includes(w));
    if (lost.length > 0) return entity;

    const oldest = was.map((f) => f.at).sort()[0] ?? stamp;
    return {
      ...entity,
      summary: match.summary?.trim() ? match.summary.trim().slice(0, 400) : entity.summary,
      facts: [
        ...facts.map((text) => ({ text: text.slice(0, 200), at: oldest, source: 'compacted' })),
        ...entity.facts.filter((f) => f.stale),
      ],
      updatedAt: stamp,
    };
  });
  return { ...life, entities, sinceCompacted: 0 };
}

/**
 * The same subject, learned twice under one name.
 *
 * Done locally because it needs no judgement: identical names, same kind, one
 * of them holding everything both knew. Two "Jason" entities is the shape that
 * makes a brief read like it is about two different people.
 */
export function mergeDuplicates(life: Life): Life {
  const kept = new Map<string, Entity>();
  const moved = new Map<string, string>();

  for (const entity of life.entities) {
    const key = `${entity.kind}:${norm(entity.name)}`;
    const existing = kept.get(key);
    if (!existing) {
      kept.set(key, entity);
      continue;
    }
    // The one seen most often wins the id, so episodes mostly stay pointed
    // where they already point.
    const [winner, loser] = existing.mentions >= entity.mentions ? [existing, entity] : [entity, existing];
    moved.set(loser.id, winner.id);
    const held = new Set(winner.facts.map((f) => norm(f.text)));
    kept.set(key, {
      ...winner,
      aliases: [...new Set([...winner.aliases, ...loser.aliases])],
      relation: winner.relation ?? loser.relation,
      summary: winner.summary || loser.summary,
      facts: [...winner.facts, ...loser.facts.filter((f) => !held.has(norm(f.text)))].slice(0, FACTS_PER_ENTITY),
      mentions: winner.mentions + loser.mentions,
      firstSeen: winner.firstSeen < loser.firstSeen ? winner.firstSeen : loser.firstSeen,
      lastSeen: winner.lastSeen > loser.lastSeen ? winner.lastSeen : loser.lastSeen,
    });
  }

  if (moved.size === 0) return life;
  return {
    ...life,
    entities: [...kept.values()],
    episodes: life.episodes.map((ep) => ({
      ...ep,
      about: [...new Set(ep.about.map((id) => moved.get(id) ?? id))],
    })),
  };
}

/* --------------------------------------------------------- consolidation */

export function addPending(life: Life, said: string, replied: string, now = new Date()): Life {
  return {
    ...life,
    pending: [...life.pending, { at: now.toISOString(), said: said.slice(0, 500), replied: replied.slice(0, 500) }],
  };
}

export function readyToConsolidate(life: Life, now = new Date()): boolean {
  if (life.pending.length >= CONSOLIDATE_AFTER) return true;
  // A quiet day still gets read: a handful of turns more than six hours old.
  const oldest = life.pending[0]?.at;
  return life.pending.length >= 3 && !!oldest && now.getTime() - new Date(oldest).getTime() > 6 * 3_600_000;
}
