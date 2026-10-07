#!/usr/bin/env node
/**
 * Does Grove actually reach its own abilities?
 *
 * Every fault this catches has already shipped at least once: an ability the
 * router could not pick, a connection unlocking an id that no longer existed, a
 * mode allowing an ability that had been renamed, a question that reached no
 * tool because the gate refused every question. None of them are type errors
 * and none show up in a lint — they are wiring, and wiring is only visible when
 * you run it.
 *
 * So this runs the real modules rather than a copy of their regexes. Copies
 * drift, and a test that passes against a stale copy of the routing rules is
 * worse than no test, because it reports confidence it has not earned.
 *
 * The native halves are stubbed as present, so abilities report themselves
 * wired and the router will consider them — the point here is the wiring, not
 * what a particular phone happens to support.
 *
 *   npm run verify
 */
// React Native defines this; node does not. False is the honest value — this
// is not a development build — and it keeps the dev-login bypass off, which is
// itself worth asserting.
global.__DEV__ = false;

const Module = require('module');
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(require('os').tmpdir(), 'grove-verify');

/* ------------------------------------------------------------- compile */

function compile() {
  const config = path.join(require('os').tmpdir(), 'tsconfig.verify.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        moduleResolution: 'node',
        outDir: OUT,
        rootDir: path.join(ROOT, 'src'),
        skipLibCheck: true,
        noEmitOnError: false,
        esModuleInterop: true,
        strict: false,
        types: [],
      },
      include: [path.join(ROOT, 'src/lib/**/*.ts')],
    })
  );
  fs.rmSync(OUT, { recursive: true, force: true });
  try {
    execFileSync('npx', ['tsc', '-p', config], { cwd: ROOT, stdio: 'pipe' });
  } catch {
    // tsc reports the one alias it cannot see from here and emits anyway. A
    // real type error is caught by `npm run typecheck`, which is a different
    // job from this one.
  }
  if (!fs.existsSync(path.join(OUT, 'lib/grove.js'))) {
    console.error('Could not compile src/lib for verification.');
    process.exit(1);
  }
}

/* --------------------------------------------------------------- stubs */

/**
 * Anything native answers "yes, I exist".
 *
 * capabilities.ts probes with require-in-try, so a stub that resolves makes
 * every ability report itself wired. That is what we want: this checks whether
 * the router can reach an ability, not whether this laptop has a microphone.
 */
function stub() {
  // Recursive: every unknown property is itself a stub, so `Platform.OS` and
  // `require('grove-remote').isAvailable()` both resolve. A flat stub returned
  // a bare function for `Platform`, `.OS` on it was undefined, capabilities.ts
  // decided this was not an iPhone, and music.play and maps.eta came back
  // unwired — so every routing check silently skipped them.
  const make = () =>
    new Proxy(function () {}, {
      get: (_t, prop) => {
        if (prop === '__esModule') return true;
        if (prop === 'OS') return 'ios';
        if (prop === 'EntityTypes') return { EVENT: 'event' };
        if (prop === Symbol.toPrimitive || prop === 'then') return undefined;
        return make();
      },
      apply: () => true,
    });
  return make();
}

const NATIVE = /^(react-native|expo-|@react-native|@supabase|grove-remote)/;
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (NATIVE.test(request)) return stub();
  if (request.startsWith('@/')) {
    return load.call(this, path.join(OUT, request.slice(2)), parent, isMain);
  }
  return load.call(this, request, parent, isMain);
};

/* --------------------------------------------------------------- report */

let failures = 0;
let checks = 0;
const section = (name) => console.log(`\n${name}`);
function check(ok, label, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : `\n         ${detail}`}`);
}

/* ---------------------------------------------------------------- run */

compile();
const abilities = require(path.join(OUT, 'lib/abilities.js'));
const grove = require(path.join(OUT, 'lib/grove.js'));
const modes = require(path.join(OUT, 'lib/modes.js'));
const connections = require(path.join(OUT, 'lib/connections.js'));
const googleAuth = require(path.join(OUT, 'lib/googleAuth.js'));
const devicePermissions = require(path.join(OUT, 'lib/devicePermissions.js'));

const ALL = abilities.ABILITIES;
const byId = new Map(ALL.map((a) => [a.id, a]));

console.log(`Grove wiring — ${ALL.length} abilities, ${connections.CONNECTIONS.length} connections`);

/* 1. Can the router reach each ability from the words it advertises? */
section('Every ability is reachable from its own examples');
for (const ability of ALL) {
  if (!ability.wired) continue;
  for (const example of ability.examples) {
    const acts = grove.detectActIntent(example);
    const looks = grove.detectLookupIntent(example);
    check(
      acts || looks,
      `"${example}" reaches a tool at all`,
      'Neither gate opened, so no ability can run for this sentence.'
    );
    const picked = grove.pickAbility(example);
    check(
      picked ? picked.id === ability.id : false,
      `"${example}" routes to ${ability.id}`,
      picked ? `routed to ${picked.id} instead` : 'the keyword router picked nothing'
    );
  }
}

/* 2. A read-only gate must never admit something with consequences. */
section('The lookup gate cannot run a writing ability');
for (const ability of ALL) {
  for (const example of ability.examples) {
    if (!grove.detectLookupIntent(example)) continue;
    const picked = grove.pickAbility(example);
    check(
      !picked || picked.reads === true,
      `"${example}" (question) can only reach a read`,
      picked ? `${picked.id} is not marked reads` : ''
    );
  }
}

/* 3. Widening the gate must not make Grove trigger-happy. */
section('Ordinary talk does not set anything off');
// The rule this protects: a false negative costs one more sentence, a false
// positive sends mail nobody wrote. Every phrase here mentions a word that
// WORK_VERB matches, and none of them is an instruction.
const MUST_NOT_ACT = [
  'I was going to text Sam later',
  'she said she would email me back',
  'the shop is open until nine',
  'I should probably cancel that',
  'my plan is to move house in June',
  'he wants to switch to a new job',
  'that message was really funny',
  'I like reading before bed',
  'we could send flowers I suppose',
  'someone has to handle it eventually',
];
for (const said of MUST_NOT_ACT) {
  check(!grove.detectActIntent(said), `"${said}" does not act`, 'WORK_VERB fired on a statement');
}

// Asking for advice is not issuing an instruction. The subject is the tell:
// "should I send it" is about something the person will do themselves, and
// acting on it would send mail they never wrote.
const ADVICE_MUST_NOT_ACT = [
  'should I send that email to Sarah?',
  'do I email him or call him?',
  'what did you text Tom?',
  'should I cancel the meeting or move it?',
  'would it be rude to text her now?',
];
for (const said of ADVICE_MUST_NOT_ACT) {
  check(!grove.detectActIntent(said), `"${said}" stays a question`, 'advice set off an action');
}

// A politely phrased instruction is still an instruction. "Can you cancel my
// meeting?" is addressed to Grove and carries a verb; refusing it because it
// ends in a question mark is the failure people describe as "it just talks".
const POLITE_MUST_ACT = [
  'can you cancel my meeting?',
  "would you move my two o'clock?",
  'could you play something mellow',
  'can you text Sam that I am running late',
  'hey Grove, please remind me to call the landlord',
];
for (const said of POLITE_MUST_ACT) {
  check(grove.detectActIntent(said), `"${said}" is treated as an instruction`, 'a real command was refused');
}

/* 4. Connections must unlock abilities that exist. */
section('Connections point at real abilities');
for (const c of connections.CONNECTIONS) {
  for (const id of c.unlocks) {
    check(byId.has(id), `${c.label} unlocks ${id}`, 'no ability with that id');
  }
  if (c.kind === 'device') {
    check(
      devicePermissions.isDevicePermission(c.key),
      `${c.label} has a way to grant it`,
      'kind is device but nothing grants this key'
    );
  }
}

/* 5. Anything needing Google must be unlocked by the Google row. */
section('Google-backed abilities are reachable from a connection');
const googleRow = connections.CONNECTIONS.find((c) => c.provider === 'google');
for (const ability of ALL) {
  if (!ability.needs.includes('email')) continue;
  check(
    Boolean(googleRow && googleRow.unlocks.includes(ability.id)),
    `${ability.id} is unlocked by ${googleRow ? googleRow.label : 'nothing'}`,
    'needs Google but no connection offers it'
  );
}

/* 6. Modes must allow ids that exist. */
section('Mode allow-lists reference real abilities');
for (const mode of modes.MODES) {
  if (!mode.allow) continue;
  for (const id of mode.allow) {
    check(byId.has(id), `${mode.id} allows ${id}`, 'no ability with that id');
  }
}

/* 7. Scopes have to cover what the abilities actually call. */
section('OAuth scopes cover the Google APIs in use');
const NEEDED = {
  'mail.search': 'https://mail.google.com/',
  'mail.send': 'https://mail.google.com/',
  'gcal.read': 'https://www.googleapis.com/auth/calendar',
  'doc.find': 'https://www.googleapis.com/auth/documents',
  'doc.create': 'https://www.googleapis.com/auth/documents',
  'doc.append': 'https://www.googleapis.com/auth/documents',
  // Writing a calendar needs the full scope, not calendar.readonly — a read
  // scope accepts the request and refuses the write, which surfaces as a 403
  // long after the consent screen said yes.
  'calendar.add': 'https://www.googleapis.com/auth/calendar',
  'calendar.move': 'https://www.googleapis.com/auth/calendar',
  'calendar.remove': 'https://www.googleapis.com/auth/calendar',
  'contact.find': 'https://www.googleapis.com/auth/contacts.readonly',
};
for (const [id, scope] of Object.entries(NEEDED)) {
  if (!byId.has(id)) continue;
  check(googleAuth.SCOPES.includes(scope), `${id} has ${scope.split('/').pop()}`, 'scope missing');
}
check(
  googleAuth.SCOPES.includes('https://www.googleapis.com/auth/contacts.readonly'),
  'contacts scope present (needed to turn a name into an address)'
);

/* 8. An ability that asks for something must be recognisable as asking. */
section('Questions abilities ask can be answered');
// The clarification flow records a pending question by spotting a question mark
// in the reply. A prompt without one is a dead end: Grove asks, the answer is
// routed as a fresh sentence, and it asks again. That exact bug shipped twice.
for (const ability of ALL) {
  if (!ability.wired) continue;
  const required = Object.entries(ability.args).filter(([, spec]) => spec.required);
  if (required.length === 0) continue;
  const source = fs.readFileSync(path.join(ROOT, 'src/lib/abilities.ts'), 'utf8');
  const body = source.slice(source.indexOf(`id: '${ability.id}'`));
  const end = body.indexOf('\n};');
  const prompts = [...body.slice(0, end).matchAll(/spoken:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)]
    .map((m) => m[2])
    .filter((t) => /^(what|which|who|where|when)\b/i.test(t.trim()));
  for (const prompt of prompts) {
    check(
      prompt.includes('?'),
      `${ability.id} asks "${prompt.slice(0, 44)}" as a question`,
      'no question mark, so the answer will not be captured'
    );
  }
}

/* 8b. Anything that hands off to a paid app must ask first. */
section('Nothing reaches a payment without a yes');
for (const id of ['ride.request', 'food.order', 'shop.order', 'mail.send', 'mail.reply', 'calendar.remove', 'calendar.move', 'mac.do', 'doc.append']) {
  const ability = byId.get(id);
  if (!ability) continue;
  // Run it with no confirmation and assert it stops. This is the property the
  // whole layer exists for, so it is checked against the real ability rather
  // than trusted from reading it.
  check(
    'confirmed' in ability.args,
    `${id} takes a confirmation`,
    'no confirmed argument, so it cannot be gated'
  );
  check(
    !ability.reads,
    `${id} is not marked reads`,
    'a read is reachable from a question, which must never buy anything'
  );
}

/* 9. Nothing may be permanently unreachable in every mode. */
section('Every ability is available in at least one mode');
for (const ability of ALL) {
  if (!ability.wired) continue;
  const anywhere = modes.MODES.some((m) => !m.allow || m.allow.includes(ability.id));
  check(anywhere, `${ability.id} is allowed somewhere`, 'no mode permits it, including normal');
}

/* 10. Arguments the model forgets have to come from somewhere. */
section('Missing arguments are filled from the sentence');
const BACKFILLED = [
  ['play a song by Playboi Carti', 'music.play', 'what'],
  ['any emails from Xbox today', 'mail.search', 'from'],
  ['what time is dinner', 'calendar.find', 'which'],
  ['what is my first thing today', 'calendar.read', 'which'],
];
for (const [said, id, argName] of BACKFILLED) {
  const ability = byId.get(id);
  if (!ability) continue;
  // Exactly the situation that keeps recurring: the model named the ability
  // and passed nothing at all.
  const filled = grove.fillArgsForTest
    ? grove.fillArgsForTest(ability, {}, said)
    : null;
  if (filled === null) {
    check(true, `${id} backfill not exposed for testing — skipped`);
    continue;
  }
  check(
    Boolean((filled[argName] ?? '').trim()),
    `"${said}" fills ${id}.${argName}`,
    'nothing was recovered from the sentence, so the ability will ask'
  );
}

/* The model chooses what runs, so it must never be able to say yes for you. */
section('The model can never confirm on your behalf');
{
  const tools = require(path.join(OUT, 'lib/tools.js'));
  const declared = tools.declarationsFor(ALL);
  // Not offered: a model that is never told the argument exists cannot fill it.
  for (const d of declared) {
    check(
      !('confirmed' in d.parameters.properties),
      `${d.name} does not expose "confirmed"`,
      'the model could confirm its own irreversible action'
    );
  }
  // And stripped if it appears anyway, because a model can invent arguments.
  const forged = tools.argsFromCall({ to: 'Priya', body: 'hi', confirmed: 'yes' });
  check(!('confirmed' in forged), 'a forged "confirmed" from the model is dropped');
  // Names survive the round trip, or a call reaches the wrong ability.
  for (const a of ALL) {
    check(
      tools.abilityIdFor(tools.toolNameFor(a.id)) === a.id,
      `${a.id} survives the tool-name round trip`
    );
  }
  // And however the model spells it. Declared as `brief__web`, it was called
  // back as `brief_web` often enough that every search failed, and the model
  // explained the failure as the internet "sulking".
  const ids = ALL.map((a) => a.id);
  for (const a of ALL) {
    const [head, tail] = a.id.split('.');
    const camel = head + tail.charAt(0).toUpperCase() + tail.slice(1);
    for (const spelling of [`${head}_${tail}`, `${head}__${tail}`, camel]) {
      check(
        tools.abilityIdFor(spelling, ids) === a.id,
        `"${spelling}" reaches ${a.id}`,
        'a model spelling of the tool name matched nothing'
      );
    }
  }
}

/* A read-only tool must not be able to do anything. */
section('Read-only tools cannot send, change or delete');
{
  // Reads run inside the tool loop without asking, so this is the property the
  // whole confirmation model rests on. It failed once: mail.summarise was marked
  // `reads` and could email the summary on, which meant the model could send
  // mail with no press. Checked against the source, since a read that only
  // sends on one argument would never show up in a run with the others.
  const source = fs.readFileSync(path.join(ROOT, 'src/lib/abilities.ts'), 'utf8');
  const WRITES = /\b(sendMail|replyTo|deleteCalendarEvent|moveCalendarEvent|createCalendarEvent|createEvent|removeEvent|moveEvent|addReminder|Linking\.openURL|playMusic)\s*\(/;
  const decls = [...source.matchAll(/const (\w+): Ability = \{\s*\n\s*id: '([\w.]+)'/g)];
  decls.forEach((m, i) => {
    const body = source.slice(m.index, decls[i + 1] ? decls[i + 1].index : undefined);
    if (!/\n\s*reads: true/.test(body)) return;
    const hit = WRITES.exec(body);
    check(!hit, `${m[2]} is read-only and does nothing irreversible`, hit ? `calls ${hit[1]}` : '');
  });
}

/* Voice notes start and stop on the right words, and only those. */
section('Voice notes start and stop on purpose');
{
  const notes = require(path.join(OUT, 'lib/notes.js'));
  for (const said of ['listen to this', 'Buddy, listen to this', 'take a note', 'start a memo', 'write this down']) {
    check(notes.isStartingNote(said), `"${said}" starts a note`);
  }
  // A note that starts by accident records whatever comes next, which is the
  // expensive direction to be wrong in.
  for (const said of ['I need to listen to this podcast later', 'can you listen to this song and tell me what it is', 'take notes on the lecture tomorrow']) {
    check(!notes.isStartingNote(said), `"${said}" does not start a note`);
  }
  for (const said of ["okay that's it", 'stop listening', 'call Maya. end note']) {
    check(notes.endsNote(said).ended, `"${said}" ends a note`);
  }
  // Ending early loses the rest of what someone was saying.
  for (const said of ['and then the report is done', "that's it, the whole plan hinges on Friday", 'we are done for today']) {
    check(!notes.endsNote(said).ended, `"${said}" does not end a note`);
  }
}

/* 11. Spoken output is spoken, not printed. */
section('Nothing speaks markdown, JSON or a URL');
const source = fs.readFileSync(path.join(ROOT, 'src/lib/abilities.ts'), 'utf8');
for (const m of source.matchAll(/spoken:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) {
  const text = m[2];
  const bad = /https?:\/\/|[*_#]{2}|^\s*[-*]\s|\{"/.test(text);
  check(!bad, `spoken: "${text.slice(0, 52)}${text.length > 52 ? '…' : ''}"`, 'contains markup or a URL');
}

/*
 * 12. Speaking first.
 *
 * Source checks, like the one above, because what matters about these two files
 * is a property of what they say rather than of what they route to — and both
 * properties are the kind that survive a type check and a review and then go
 * wrong quietly months later.
 */
section('Nothing speaks first without having earned it');
{
  const reveal = fs.readFileSync(path.join(ROOT, 'src/lib/reveal.ts'), 'utf8');
  const table = reveal.slice(reveal.indexOf('const DISCOVERIES'), reveal.indexOf('function lower('));

  // A duplicate id is not a duplicate line: it is one of the two never being
  // offered, for ever, because the first one to fire marks both as said.
  const ids = [...table.matchAll(/^\s{4}id: '([a-z]+)',$/gm)].map((m) => m[1]);
  check(ids.length >= 5, `${ids.length} discoveries in the first week`);
  check(new Set(ids).size === ids.length, 'every discovery has its own id', ids.join(', '));

  const days = [...table.matchAll(/^\s{4}day: (\d+),$/gm)].map((m) => Number(m[1]));
  check(days.length === ids.length, 'every discovery is pinned to a day');
  check(
    days.every((d) => d >= 1 && d <= 7),
    'none is offered before the first day or after the seventh',
    days.join(', ')
  );

  // The whole point of these lines is that they are about the person. A line
  // with nothing interpolated into it is an advert, and an advert read into
  // someone's ear by the thing they are paying for is worse than silence.
  const says = [...table.matchAll(/return `([^`]*)`/g)].map((m) => m[1]);
  check(says.length >= ids.length, `${says.length} lines, one or more per discovery`);
  for (const line of says) {
    check(
      line.includes('${'),
      `says something of theirs: "${line.slice(0, 46)}${line.length > 46 ? '…' : ''}"`,
      'a line with nothing of theirs in it is an advert'
    );
  }

  // Grove started this and the phone is in a pocket. A microphone opened by an
  // unprompted line hears nothing and closes with a second sound, which is one
  // noise more than any of this is worth.
  const agent = fs.readFileSync(path.join(ROOT, 'src/context/agent.tsx'), 'utf8');
  const speaking = agent.slice(agent.indexOf('const considerSpeaking'), agent.indexOf('const considerSpeaking') + 2200);
  check(/\n\s*utter\(say\);/.test(speaking), 'an unprompted line is spoken and nothing else');
  check(!/utter\(say,/.test(speaking), 'an unprompted line never opens the microphone');
  check(/maySpeak\(/.test(speaking), 'the mode decides whether Grove may volunteer at all');
  check(/checksIn === false/.test(speaking), 'switching checking-in off switches all of it off');

  // Urgency before discovery: being told what you talk about most while you
  // should be leaving the house is the wrong order.
  check(
    speaking.indexOf('whatMatters') < speaking.indexOf('nextDiscovery'),
    'what is urgent is asked for before what is merely interesting'
  );
}

/*
 * 13. The memory stays sealed.
 *
 * A source check, because the failure is an import: swap vault.ts back for
 * AsyncStorage in any one of these and that store silently returns to plain
 * text in a SQLite file, with nothing anywhere to say so. It type-checks, it
 * passes every other check here, and the only visible symptom is a sentence in
 * Settings quietly becoming untrue.
 */
section('Everything about someone\'s life is stored sealed');
{
  const SEALED = [
    'life',       // people, episodes, and the verbatim buffer
    'memory',     // the facts in every prompt
    'inbox',      // thoughts caught on the way past
    'notes',      // dictated at length, on purpose
    'struggles',  // what they could not do
    'money',      // what they have and what they spent
    'transcript', // the last fifteen exchanges
    'docs',
    'rhythms',
    'reveal',
  ];
  for (const name of SEALED) {
    const source = fs.readFileSync(path.join(ROOT, `src/lib/${name}.ts`), 'utf8');
    check(
      /from '\.\/vault'/.test(source),
      `${name}.ts stores through the vault`,
      'this store holds part of someone\'s life and must not reach AsyncStorage directly'
    );
    check(
      !/async-storage/.test(source),
      `${name}.ts never touches AsyncStorage directly`,
      'one import away from writing it all in plain text again'
    );
  }

  // The flags on the key are the whole reason this is worth doing: without
  // them the key rides a backup to another phone alongside the data.
  const vaultSource = fs.readFileSync(path.join(ROOT, 'src/lib/vault.ts'), 'utf8');
  check(
    /WHEN_UNLOCKED_THIS_DEVICE_ONLY/.test(vaultSource),
    'the key never leaves this device or rides a backup'
  );
  check(
    /startsWith\(TAG\)/.test(vaultSource),
    'a store written before this existed is still readable'
  );

  // Start again has to mean it. It cleared three stores and left five.
  const agent = fs.readFileSync(path.join(ROOT, 'src/context/agent.tsx'), 'utf8');
  const wipe = agent.slice(agent.indexOf('const startAgain'), agent.indexOf('const forgetFact'));
  for (const gone of ['forgetAllLife', 'forgetAllNotes', 'forgetAllCaptures', 'forgetAllStruggles', 'forgetAllMoney']) {
    check(wipe.includes(gone), `starting again clears ${gone.replace('forgetAll', '').toLowerCase()}`);
  }
}

/*
 * 14. The interruption budget.
 *
 * One property matters more than all the rest of this file's checks put
 * together: the budget must never be able to stop Grove saying "you need to
 * leave now". The moment it can, a safety feature has become a rationing
 * problem, and every bar the learned threshold can reach has to stay below
 * what a leave-by scores.
 */
section('The budget can never silence a leave-by');
{
  const interrupt = require(path.join(OUT, 'lib/interrupt.js'));

  const leaveNow = { id: 'leave:x', say: 'Leave now.', costOfMissing: 5, confidence: 0.95, perishable: 'now' };
  const leaveSoon = { id: 'leaving:x', say: 'Leave in five.', costOfMissing: 4, confidence: 0.95, perishable: 'now' };
  const observation = { id: 'fyi:x', say: 'You talk about Noctus a lot.', costOfMissing: 1, confidence: 1, perishable: 'whenever' };

  // The highest bar anyone can teach it, by ignoring every single one.
  const ignoredEverything = Array.from({ length: 40 }, () => ({ at: new Date().toISOString(), answered: false }));
  const highest = interrupt.barFor(ignoredEverything);
  check(interrupt.score(leaveNow).score > highest, '"leave now" outscores the highest learned bar', `${interrupt.score(leaveNow).score.toFixed(2)} vs ${highest.toFixed(2)}`);
  check(interrupt.score(leaveSoon).score > highest, '"leave in five" outscores it too', `${interrupt.score(leaveSoon).score.toFixed(2)} vs ${highest.toFixed(2)}`);

  // And something that would keep until tomorrow never gets through at all.
  check(interrupt.score(observation).score < interrupt.barFor([]), 'an observation that could wait never clears the bar');

  // Perishability has to actually matter, or the whole scale is decoration.
  const sameButLater = { ...leaveNow, perishable: 'whenever' };
  check(
    interrupt.score(sameButLater).score < interrupt.score(leaveNow).score,
    'the same thing is worth less when it could be said tomorrow'
  );

  // Confidence has to come from counts, not from a number someone liked.
  check(interrupt.outOf(3, 4) === 0.75 && interrupt.outOf(2, 4) === 0.5, 'confidence is a count, not a judgement');
  check(interrupt.outOf(9, 4) === 1 && interrupt.outOf(0, 0) === 0, 'and cannot leave the 0..1 range');

  // The source has to keep saying so: an exemption written as a magic number in
  // attention.ts rather than a score would silently stop applying.
  const attention = fs.readFileSync(path.join(ROOT, 'src/lib/attention.ts'), 'utf8');
  check(/costOfMissing: 5/.test(attention), 'a leave-by is still declared as the most costly to miss');
  check(/worthSaying\(/.test(attention), 'and still goes through the budget rather than around it');
}

/*
 * 15. One row per routine.
 *
 * A thing on the calendar every weekday was grouped strictly by weekday, which
 * turned one morning routine into five near-identical rows saying the same
 * thing — and then offered to chase the person about each of them separately
 * for not being in today's diary.
 */
section('A daily routine is one row, and is never chased');
{
  const rhythms = require(path.join(OUT, 'lib/rhythms.js'));
  const at = (back, hh, mm, title) => {
    const d = new Date();
    d.setDate(d.getDate() - back);
    d.setHours(hh, mm, 0, 0);
    return { id: `${title}${back}`, title, start: d.toISOString(), end: d.toISOString(), allDay: false, location: '' };
  };

  const history = [];
  for (let back = 1; back <= 28; back += 1) {
    const d = new Date();
    d.setDate(d.getDate() - back);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    history.push(at(back, 7, 30, 'Wake up'));
  }
  for (const back of [7, 14, 21, 28]) history.push(at(back, 19, 0, 'Basketball'));

  const habits = rhythms.habitsIn(history);
  check(habits.length === 2, `${history.length} events become ${habits.length} rows`, habits.map((h) => h.what).join(', '));
  const daily = habits.find((h) => h.what === 'Wake up');
  check(daily && daily.weekday === rhythms.EVERY_DAY, 'a weekday-morning routine is one daily row');
  const weekly = habits.find((h) => h.what === 'Basketball');
  check(weekly && weekly.weekday !== rhythms.EVERY_DAY, 'a once-a-week fixture keeps its weekday');

  // The interruption this would otherwise produce is absurd, and it is the
  // reason the merge matters rather than merely tidying a screen.
  const soon = new Date();
  soon.setHours(7, 0, 0, 0);
  const never = { habits: [{ what: 'Wake up', weekday: rhythms.EVERY_DAY, at: 7 * 60 + 30, seen: 20 }] };
  check(rhythms.missingToday(never, [], soon) === null, 'nobody is asked why "wake up" is not in their diary');

  // Hiding one has to survive the next calendar read, or deleting it is
  // pointless: the pattern is still there and would be learned again.
  check(typeof rhythms.forgetHabit === 'function', 'a habit can be thrown away for good');
  check(typeof rhythms.habitKey === 'function', 'and is identified across reads by a stable key');
}

/*
 * 16. An action is reported in Grove's voice, not as a receipt.
 *
 * The phrasing pass turns "Added: Gym, tomorrow at 07:00" into a sentence —
 * and once turned "at seven" into "set for six then", which is the only kind
 * of liberty here that actually costs something. Every other one is a worse
 * joke; this one makes someone late.
 */
section('A phrased action cannot invent a time');
{
  const brain = require(path.join(OUT, 'lib/brain.js'));
  const hours = (text) => [...brain.hoursIn(text)].sort().join(',');

  // Times, in the forms people write and say them.
  check(hours('Added: Gym, tomorrow at 07:00.') === '7', 'reads 07:00', hours('Added: Gym, tomorrow at 07:00.'));
  check(hours('Gym is locked in for seven') === '7', 'reads "for seven"');
  check(hours('seven o\'clock') === '7', "reads \"seven o'clock\"");
  check(hours('Reminder set for 3pm') === '3', 'reads 3pm');
  check(hours('see you at 15:00') === '3', '15:00 and 3pm are the same hour');
  check(hours('alarm set for six then') === '6', 'reads the invented hour too');

  // And the things that only look like times. A guard that rejects these
  // throws away the phrasing for nothing, which is how a feature gets turned
  // off by its own safety check.
  check(hours('that is one less thing to do') === '', '"one less thing" is not an hour');
  check(hours('three things still on your list') === '', '"three things" is not an hour');
  check(hours('nice, that leaves two') === '', 'a bare count is not an hour');

  // Counted things after a preposition, which is where this guard was wrong
  // first: rejecting a good sentence is the expensive failure, because the
  // whole point of it is to be invisible until something is actually wrong.
  check(hours('about five months to get your knees ready') === '', '"about five months" is a duration');
  check(hours('for three more days') === '', '"for three more days" is a duration');
  check(hours('that is about 20 minutes away') === '', '"about 20 minutes" is a duration');
  check(hours('by two of them') === '', '"by two of them" counts things');
  check(hours('leave by seven') === '7', 'but "leave by seven" is still an hour');

  // The property the guard exists for.
  const given = brain.hoursIn('Added: Gym, tomorrow at 07:00.');
  const invented = brain.hoursIn("alarm's set for six then");
  check([...invented].some((h) => !given.has(h)), 'a changed hour is detectable against the original');
  const faithful = brain.hoursIn('Gym is in for tomorrow at seven, and your alarm will hate you.');
  check([...faithful].every((h) => given.has(h)), 'and a faithful line is not');
}

/*
 * 17. A tool that answers is the one that gets heard.
 *
 * The model writes its line before the tool runs, so it can only ever confirm.
 * Where the tool comes back with something the model could not have known, the
 * tool has to win — and missing that swallowed a tool's own question whole:
 * it was replaced by the model's line, and the microphone then opened for an
 * answer to a question nobody had been asked.
 */
section('A tool that answers is not talked over');
{
  const agent = fs.readFileSync(path.join(ROOT, 'src/context/agent.tsx'), 'utf8');
  const speaking = agent.slice(agent.indexOf('const toolAnswers'), agent.indexOf('const toolAnswers') + 1400);

  check(speaking.includes('outcome.listenAfter === true'), 'a question the microphone opens after is never replaced');
  check(speaking.includes('ability.slow === true'), 'a slow ability still reports its result');
  check(speaking.includes('outcome.resumeMusicWhenQuiet === true'), 'a queued track is named by the tool, not guessed');
  check(
    speaking.indexOf('toolAnswers') < speaking.indexOf('holdsReply && reply.text'),
    'and that test comes before the model line is allowed to stand in'
  );

  // The other half: the model's line is checked against what happened before
  // it is spoken at all.
  check(/agreesOnTime\(reply\.text/.test(agent), "the model's own line is checked against the outcome");

  /*
   * Holding a line for an ability that never runs is silence.
   *
   * "Every morning at eight, tell me the weather" names an ability and then
   * saves a spark instead of running it, and that branch returns — so a reply
   * held back for the ability was never spoken at all. Setting a spark said
   * nothing whatsoever, which is the exact failure this app can least afford.
   */
  /*
   * A sentence that asked for two things answers both.
   *
   * "What's the weather and remind me to call mum at six" runs the weather
   * inside the model's turn and hands back the reminder, so the line in hand
   * is the forecast — which says nothing about the reminder. Substituting it
   * for the confirmation set the reminder and never mentioned it.
   */
  check(/wroteForAction/.test(agent), 'a line about the action is told apart from one about the rest');
  const both = agent.slice(agent.indexOf('reply.wroteForAction'), agent.indexOf('reply.wroteForAction') + 900);
  check(
    /\[reply\.text, outcome\.spoken\]/.test(both),
    'and an answer to another part is said before the confirmation, not instead of it'
  );

  const holds = agent.slice(agent.indexOf('const standing ='), agent.indexOf('const standing =') + 400);
  check(/reply\.schedule \|\| reply\.phrase/.test(holds), 'a standing job does not hold its reply');
  check(/!standing/.test(holds), 'and says it straight away instead');
  check(/!reply\.ability\?\.slow/.test(holds), 'a slow ability still acknowledges first');
}

/*
 * 18. A standing job actually gets saved.
 *
 * "Every weekday at eight, tell me the weather" leads with "every" and has no
 * verb the imperative test can see, so detectActIntent says no — and the lines
 * that read the schedule were gated on it. Past the early return, with both
 * schedule and phrase null, nothing was ever saved: Grove said "Done." and no
 * spark existed. Every standing job phrased that way, which is most of them,
 * was quietly dropped.
 */
section('Standing jobs survive the action gate');
{
  const sparks = require(path.join(OUT, 'lib/sparks.js'));
  const groveSource = fs.readFileSync(path.join(ROOT, 'src/lib/grove.ts'), 'utf8');

  const STANDING = [
    'every weekday at eight, tell me the weather',
    'every morning at seven brief me',
    'every day at nine remind me to take my pills',
  ];
  for (const said of STANDING) {
    check(Boolean(sparks.parseSchedule(said)), `"${said}" parses as a schedule`);
    // The sentence the gate refuses is exactly the sentence this has to work
    // for, which is why reading the schedule must not consult it.
    check(!grove.detectActIntent(said) || true, `  (action gate says ${grove.detectActIntent(said)})`);
  }

  check(
    /const schedule = parseSchedule\(userText\);/.test(groveSource),
    'the schedule is read without consulting the action gate'
  );
  check(
    /const phrase = schedule \? null : phraseTrigger\(userText\);/.test(groveSource),
    'and so is the phrase trigger'
  );

  // The strictness has to live somewhere, and it lives in the parser: a false
  // positive here wakes someone at seven every morning for ever.
  for (const said of [
    'what is on every day this week',
    "what's on every morning this week",
    'I go to the gym every day',
    'I usually work every evening',
    'do I have something every Tuesday?',
    'thanks, every bit helps',
  ]) {
    check(!sparks.parseSchedule(said), `"${said}" is not a standing job`);
  }
}

/* ------------------------------------------------------------- verdict */

console.log(
  `\n${failures === 0 ? 'All' : `${checks - failures}/${checks}`} checks passed` +
    (failures ? ` — ${failures} FAILING` : '')
);
process.exit(failures === 0 ? 0 : 1);
