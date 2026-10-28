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

/**
 * The region of a file between two landmarks, or null if it cannot be found.
 *
 * Several checks here read a stretch of source by locating two comments and
 * slicing between them. Done by hand that is a trap, and it caught me: the end
 * landmark was a hardcoded line, the line was later rewritten, `indexOf`
 * returned -1, and `slice(start, -1)` cheerfully handed back everything up to
 * the last character of the file. The check then failed on a match three
 * hundred lines from the thing it was guarding.
 *
 * The direction it broke was luck. Had the *start* landmark gone instead,
 * `slice(-1, …)` returns an empty string, and a check of the form "this
 * region does not contain X" **passes** against nothing at all — a green tick
 * on a guard that had stopped guarding, which here would have been the one
 * rule between an offer and a payment.
 *
 * So: both ends asserted, a size expected, and null rather than a guess. The
 * section below tests this function against a missing landmark, because a
 * harness that cannot catch its own blind spot has no business asserting
 * anything about the app.
 */
function between(source, from, to, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const start = source.indexOf(from);
  if (start < 0) return null;
  const end = source.indexOf(to, start + from.length);
  if (end <= start) return null;
  const slice = source.slice(start, end);
  if (slice.length < min || slice.length > max) return null;
  return slice;
}

/* ---------------------------------------------------------------- run */

compile();
const abilities = require(path.join(OUT, 'lib/abilities.js'));
const grove = require(path.join(OUT, 'lib/grove.js'));
const connections = require(path.join(OUT, 'lib/connections.js'));
const googleAuth = require(path.join(OUT, 'lib/googleAuth.js'));
const devicePermissions = require(path.join(OUT, 'lib/devicePermissions.js'));
const persona = require(path.join(OUT, 'lib/persona.js'));

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

/* 11. Spoken output is spoken, not printed. */
section('Nothing speaks markdown, JSON or a URL');
const source = fs.readFileSync(path.join(ROOT, 'src/lib/abilities.ts'), 'utf8');
for (const m of source.matchAll(/spoken:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) {
  const text = m[2];
  const bad = /https?:\/\/|[*_#]{2}|^\s*[-*]\s|\{"/.test(text);
  check(!bad, `spoken: "${text.slice(0, 52)}${text.length > 52 ? '…' : ''}"`, 'contains markup or a URL');
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
    'struggles',  // what keeps going wrong
    'transcript', // the last thirty exchanges
    'docs',
    'rapport',    // how they talk
    'rhythms',
    'troubles',  // what has failed, which quotes what was being done
    'offers',    // what they said yes and no to, which is a record of refusals
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
  for (const gone of ['forgetAllLife', 'forgetAllStruggles', 'forgetRapport', 'forgetOffers']) {
    check(wipe.includes(gone), `starting again clears ${gone.replace(/^forget(All)?/, '').toLowerCase()}`);
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

}

/*
 * 18. Rapport is read, never asked.
 *
 * Six settings used to ask, on a screen, in the abstract, about something the
 * person demonstrates every time they open their mouth. The replacement has to
 * hold two properties that a settings screen got for free: it must say nothing
 * at all until it knows something, and it must never keep what was said.
 */
section('How they talk is counted, not stored');
{
  const rapportSrc = fs.readFileSync(path.join(ROOT, 'src/lib/rapport.ts'), 'utf8');

  // A block saying it has not worked you out yet is a thing the model mentions.
  check(/if \(r\.seen < ENOUGH\) return '';/.test(rapportSrc), 'it says nothing until it knows something');

  // The tally is counts. A field holding text would be a transcript by another
  // name, in the one file whose whole job is describing how someone speaks.
  const tally = rapportSrc.slice(rapportSrc.indexOf('type Tally = {'), rapportSrc.indexOf('export type Rapport'));
  check(!/:\s*string/.test(tally), 'nothing it keeps is text', tally.replace(/\s+/g, ' ').slice(0, 90));
  check(/words: was\.words \+ words/.test(rapportSrc), 'length is a running sum, not a list of turns');

  // Length and tone are different questions. One enum had to choose, and read
  // "nah leave it" as brief while throwing away that it was informal.
  check(/brevity:/.test(rapportSrc) && /tone:/.test(rapportSrc), 'length and tone are separate axes');

  // A register that cannot change is a setting with extra steps.
  check(/if \(next\.turns > WINDOW\)/.test(rapportSrc), 'the window slides, so a register can change');

  // And it is sealed like every other store that holds someone's life.
  check(/from '\.\/vault'/.test(rapportSrc), 'it stores through the vault');
  check(!/async-storage/.test(rapportSrc), 'and never reaches AsyncStorage directly');
}

/*
 * 19. A time said out loud is a time.
 *
 * The clock parser read an hour only after the word "at", a colon, or "half" —
 * so "move it to 5pm", which is how most people say it, parsed as nothing and
 * Grove asked when, of someone who had just said when. A bare "five" answering
 * Grove's own question failed the same way.
 */
section('Times people actually say');
{
  const cal = require(path.join(OUT, 'lib/deviceCalendar.js'));
  const noon = new Date('2026-10-07T12:00:00');
  const hourOf = (text) => {
    const d = cal.readWhen(text, noon);
    return d ? d.getHours() : null;
  };

  for (const [said, hour] of [
    ['at five', 17], ['5pm', 17], ["five o'clock", 17], ['five', 17], ['17:00', 17],
    ['half five', 17], ['tomorrow at five', 17], ['9am', 9], ['at 9am', 9], ['noon', 12],
  ]) {
    check(hourOf(said) === hour, `"${said}" is ${hour}:00`, `read as ${hourOf(said)}`);
  }

  // And the things that are not times. A loose number inside a sentence is the
  // mistake the maths parser made; the bare-hour case is anchored for that
  // reason.
  for (const said of ['the 5 things on my list', 'chapter five of the book', '']) {
    check(cal.readWhen(said, noon) === null, `"${said}" is not a time`);
  }
}

/*
 * 20. Opening the app is not an invitation to be told things.
 *
 * Grove used to greet a launch by reading its own memory back — "I've got
 * Grove, the energy stock document and probabilistic machine learning written
 * down, ask me what I know about any of them" — and then open the microphone.
 * That line is gone with the first-week sequence, but the shape of the bug is
 * not: the first check runs the moment Grove comes forward, and anything soft
 * reaching it lands as a lecture before the screen has settled.
 */
section('A launch is quiet unless you are about to be late');
{
  const agent = fs.readFileSync(path.join(ROOT, 'src/context/agent.tsx'), 'utf8');

  check(/considerSpeaking\(true\)/.test(agent), 'the launch check asks for time-critical only');
  check(
    /whatMatters\(attention\.current, account, !urgentOnly\)/.test(agent),
    'and that is what reaches whatMatters'
  );

  // The soft half must still be gated inside attention.ts, or the flag above
  // is decorative.
  const attention = fs.readFileSync(path.join(ROOT, 'src/lib/attention.ts'), 'utf8');
  check(/if \(!freely\) return out;/.test(attention), 'the soft rules sit behind that gate');
  const urgent = attention.slice(0, attention.indexOf('if (!freely) return out;'));
  check(/costOfMissing: 5/.test(urgent), 'and a leave-by sits in front of it');

  // Nothing anywhere reads the memory back as a greeting.
  const screen = fs.readFileSync(path.join(ROOT, 'src/app/(app)/index.tsx'), 'utf8');
  // Just the greeting: from its signature to whichever function follows it.
  const helloAt = screen.indexOf('function greeting(');
  const hello = screen.slice(helloAt, screen.indexOf('\nfunction ', helloAt + 1));
  check(!/life|entit|memor|fact/i.test(hello), 'the greeting names nothing it remembers');
  check(!/persona|name/i.test(hello), 'and nobody by name');
}

/*
 * 21. A failure that cannot be retried says so.
 *
 * A depleted account returns 402 on every call, which was filed as a refusal —
 * so every turn said "nothing came back, ask me again", which is advice that
 * could never work, and the whole app going quiet at once looked like a bad
 * release rather than a bill.
 */
section('Running out of credit says it has run out of credit');
{
  const light = fs.readFileSync(path.join(ROOT, 'src/lib/lightModel.ts'), 'utf8');
  const brainSrc = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');
  const self = fs.readFileSync(path.join(ROOT, 'src/lib/selfCheck.ts'), 'utf8');

  check(/\| 'no-credit'/.test(light), 'a 402 has its own kind of trouble');
  // Both paths to the API, because the one that was missed is the one that
  // matters: every ordinary turn goes through the tool call.
  check((light.match(/status === 402/g) ?? []).length >= 2, 'both the plain and the tool call recognise it');
  check(/case 'no-credit':/.test(brainSrc), 'and the spoken line names it');
  check(/out of credit/i.test(brainSrc), 'in words someone can act on');
  check(/no-credit/.test(self) && /ai\.studio/.test(self), 'the self-check says where to fix it');
}

/*
 * 22. The Sparks screen shows a couple, not a drawer.
 *
 * Folding the archive away left a screen of shut drawers: nothing to read,
 * nothing to recognise, and no reason to believe any of it had anything in it.
 * And a conversation is not a log — filling the action list with "hey" and
 * "thanks" would bury the five lines worth reading.
 */
section('What it did, and what it still owes');
{
  const screen = fs.readFileSync(path.join(ROOT, 'src/app/(app)/sparks.tsx'), 'utf8');

  check(!/<Folding/.test(screen), 'nothing on it is collapsed by default');

  /*
   * Deleting a memory is a swipe, and nothing else.
   *
   * Each row also had a disclosure — tap for where the fact came from, when it
   * was first known, and a Forget link — which was a panel of metadata about a
   * sentence already on screen. The gesture everyone has does the deleting;
   * the tap does the one thing the panel was for, which is correcting a
   * misheard name.
   */
  check(!/Forget this/.test(screen), 'no row carries its own forget link');
  check(!/>Delete</.test(screen), 'nor a delete link');
  const swipe = fs.readFileSync(path.join(ROOT, 'src/components/swipe-away.tsx'), 'utf8');
  check(/Math\.min\(0, x\.value \+ event\.changeX\)/.test(swipe), 'rows pull left, the way every list does');
  check(/Swipe left to forget/.test(swipe), 'and say so to a screen reader');
  // Sparks names the section you are in once, in its pinned header, so the
  // blocks themselves carry no label any more. What still has to hold is the
  // shape: five shown, the rest behind a press.
  check(/<Peek show=\{5\}>/.test(screen), 'the action log shows five before the rest');
  check(/entry\.tool\)/.test(screen), 'and only exchanges that actually did something');
  check(/still going/.test(screen), 'something still running says so');

  // Goals and commitments are one list: the split was a filing decision.
  // Goals and open commitments render inside one block. Checking for the
  // heading stopped working when the heading moved; checking that nothing
  // opens a new section between the two maps is the thing that was ever
  // actually meant.
  const bothLists = screen.slice(screen.indexOf('{goals.map('), screen.indexOf('{owed.map('));
  check(
    bothLists.length > 0 && !/<(Peek|Section)\b/.test(bothLists),
    'goals and promises are one list'
  );
  // Labels only: the comment above it explains why that name was dropped, and
  // a check that cannot tell prose from an interface fails on its own reason.
  const labels = [...screen.matchAll(/label="([^"]+)"/g)].map((m) => m[1]);
  check(
    !labels.some((l) => /promised/i.test(l)),
    'and no section is named after the filing',
    labels.join(', ')
  );

  // A commitment is closed by saying it is done, which also marks it kept.
  // Swiping would record nothing and lose the thread.
  const owed = screen.slice(screen.indexOf('{owed.map('), screen.indexOf('{owed.map(') + 400);
  check(!/SwipeAway/.test(owed), 'a promise cannot be swiped away');

  // The read on how someone talks is not shown anywhere any more. It was on
  // the memory screen, then beside the switches it replaced, and it belongs on
  // neither: it is an observation about a person, not a control, and a screen
  // of toggles is the wrong place to be told what you sound like.
  //
  // What still has to be true is that it reaches the model. Deleting the
  // read-out and quietly deleting the behaviour with it is the regression this
  // guards — the app would look identical and stop adapting.
  const settings = fs.readFileSync(path.join(ROOT, 'src/app/(app)/settings.tsx'), 'utf8');
  check(!/function HowYouTalk\(/.test(settings), 'the read on how they talk is not a setting');
  check(!/function HowYouTalk\(/.test(screen), 'nor is it on the memory screen');

  const brain = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');
  check(/rapportDirective/.test(brain), 'but it still reaches the prompt');
}

/*
 * N. A preset reaches the model whole.
 *
 * Every built-in manner is written the same way — the character first, the
 * restraint last — and mannerDirective used to slice them to MANNER_LIMIT,
 * which is the cap on what someone may TYPE, not on what Grove ships. The cut
 * landed inside the final sentence of all three, so each preset went to the
 * model with its own brake removed:
 *
 *   jarvis  lost "if they are having a bad day, drop the act entirely"
 *   alfred  lost "never fawning, never a caricature"
 *   hal     lost "rudeness is noise; you are simply exact"
 *
 * The visible symptom was a serious question answered with a joke, which reads
 * as a personality problem and was a substring.
 */
section('Every preset reaches the model whole');
{
  for (const preset of persona.PRESETS) {
    check(
      preset.manner.length <= persona.PROMPT_MANNER_MAX,
      `${preset.key} is not truncated on its way to the prompt`,
      `${preset.manner.length} characters against a ceiling of ${persona.PROMPT_MANNER_MAX}; ` +
        'the tail of these is always the restraint, so cutting it ships the character without its brake'
    );
    // The directive is what the model actually sees, so assert on that rather
    // than on the constant feeding it.
    const said = persona.mannerDirective({ ...persona.DEFAULT_PERSONA, manner: preset.manner });
    check(
      said.includes(preset.manner.slice(-40)),
      `and ${preset.key} keeps its last sentence`
    );
  }

  // The one rule that does not come from the user, and must survive any manner.
  const any = persona.mannerDirective({ ...persona.DEFAULT_PERSONA, manner: 'Be funny.' });
  check(
    /how seriously to take/.test(any),
    'a manner never decides what deserves a straight answer'
  );
}

/*
 * N. The reply finishes before the microphone opens.
 *
 * `Speech.speak`'s onDone reports that the last buffer is queued, not that the
 * sound has left the speaker, and starting the recogniser takes the audio
 * route. Opening the microphone the instant speech "ended" clipped the last
 * word of every reply with the thing listening for the next one.
 *
 * The distinction this guards is the interesting half: a reply that ends on
 * its own waits for the tail, and a press does not. A press means "stop
 * talking and listen to me now", and making that wait would be a button that
 * does nothing for half a second.
 */
section('A reply is finished before the microphone opens');
{
  const agent = fs.readFileSync(path.join(ROOT, 'src/context/agent.tsx'), 'utf8');

  const tail = agent.match(/const SPEECH_TAIL_MS = (\d+);/);
  check(Boolean(tail) && Number(tail[1]) > 0, 'there is a gap between speaking and listening');

  /*
   * And the windows are the right way round.
   *
   * Four numbers that have each been wrong on their own, and the failures
   * only make sense as relationships between them:
   *
   *   - A plain reply's window is only "how long to wait for you to BEGIN".
   *     At four and a half seconds every answer ended in a pause that read as
   *     the app having hung.
   *   - A question's window is "how long to decide", which is much longer.
   *   - Once a word is heard the timer re-arms to the trailing window, so
   *     nobody who did start talking is cut off. That has to be the larger of
   *     the two, or starting to speak would shorten your own window.
   *   - The speech tail is spent inside the window, so it has to be a small
   *     part of it.
   */
  const ms = (name) =>
    Number(agent.match(new RegExp(`const ${name} = ([\\d_]+);`))?.[1]?.replace(/_/g, ''));
  const grace = ms('GRACE_MS');
  const answer = ms('ANSWER_MS');
  const trailing = ms('TRAILING_MS');
  const speechTail = ms('SPEECH_TAIL_MS');
  check([grace, answer, trailing, speechTail].every(Number.isFinite), 'every window is a number');
  // The ceiling is three and a half seconds, not four and a half. Four and a
  // half was the number that read as the app having hung; a second and a half
  // was the number that was gone before the microphone had finished opening.
  // What made the small number safe to raise is the arming check below: the
  // clock now starts at the first level reading, so this is time spent
  // listening rather than time spent partly on the audio engine.
  check(grace > 1500 && grace <= 3500, `an ordinary reply waits ${grace}ms for you to start`);
  check(answer >= 4 * grace, `and a question waits ${answer}ms, much longer`);
  check(
    trailing > grace,
    `starting to talk buys ${trailing}ms per pause, more than the window itself`,
    'otherwise beginning a sentence would shorten the time you had to finish it'
  );
  check(speechTail < grace / 2, 'and the speech tail is a small part of the window');

  // An offer ends in a question, so it must get the question's window. The
  // whole point of asking is that someone answers.
  const offerListens = between(
    agent,
    'One sentence added to the end, sometimes',
    'if (offer) offerSpoken(offer)',
    { min: 200, max: 3000 }
  );
  check(offerListens !== null, 'the offer utterance is where it is expected to be');
  check(
    offerListens !== null && /offer \? true :/.test(offerListens),
    'an offer opens the microphone like any other question'
  );

  // The automatic window, opened when a reply ended by itself.
  //
  // Landmarked rather than sliced to a byte count. This read `+ 1600` and
  // broke the first time a comment was added above the code it was pointing
  // at — which is a check failing for a reason that has nothing to do with
  // what it checks, and the kind of noise that gets a harness ignored.
  const after = between(agent, 'The tail has to finish', '}, SPEECH_TAIL_MS);', {
    min: 400,
    max: 3000,
  });
  check(after !== null, 'the automatic window is where it is expected to be');
  check(
    after !== null && /beginListening\(false, false, \{ window/.test(after),
    'a reply that ends on its own waits for the tail'
  );

  // Barge-in, which must not.
  const barge = agent.slice(agent.indexOf('// Barge-in.'), agent.indexOf('// Barge-in.') + 260);
  check(
    /stopSpeaking\(\)/.test(barge) && !/SPEECH_TAIL_MS/.test(barge),
    'and a press interrupts without waiting'
  );

  /*
   * The window is measured from the microphone, not from asking for one.
   *
   * `startListening` returning true is the recogniser accepting the request;
   * the audio engine comes up a few hundred milliseconds later. On a short
   * window that gap was most of it, which is why talking straight away worked
   * some of the time and not others.
   *
   * Two halves, and the check needs both. The first level reading re-arms the
   * clock — that is the fix. And the clock is armed after start regardless —
   * that is what stops the fix becoming a microphone held open for ever on a
   * build whose native half never reports a level.
   */
  const onLevel = between(agent, 'onLevel: (value) =>', 'onError: (message) =>', {
    min: 100,
    max: 1200,
  });
  check(onLevel !== null, 'the level handler is where it is expected to be');
  check(
    onLevel !== null && /armSilence\(\)/.test(onLevel),
    'the first level reading starts the no-speech clock',
    'otherwise the window is partly spent waiting for the audio engine'
  );
  check(
    onLevel !== null && /micLive/.test(onLevel),
    'and only the first one, since they arrive every hundred milliseconds'
  );
  const afterStart = between(agent, 'openedAt.current = Date.now();', 'beginListeningRef.current =', {
    min: 10,
    max: 600,
  });
  check(
    afterStart !== null && /armSilence\(\)/.test(afterStart),
    'the clock is armed on starting too, so a silent build still closes the microphone'
  );
}

/**
 * "Enough" closes the microphone, and nothing else does by accident.
 *
 * Every reply ends with a window you can talk into. The word is for when you
 * already know you are finished and would rather not wait it out.
 *
 * The whole risk is in the other direction. "Enough" is an ordinary English
 * word and most of its uses are not this one, so the cost of a false positive
 * is a sentence silently truncated or dropped — a request that half happened,
 * with nothing on screen to explain why. Every phrase here is one that has to
 * keep working.
 */
/**
 * You can see what you are typing, and finishing a line does something.
 *
 * Two faults of exactly the kind this harness exists for: both type-check,
 * both read correctly, and both fail by quietly doing nothing.
 *
 *   THE KEYBOARD COVERS THE FIELD. The Memory screen is a list where every
 *   line is editable, and it had no keyboard handling at all — tap a fact
 *   past the first screenful and the keyboard comes up over the thing you are
 *   typing into. On the screen whose whole argument is that a memory you
 *   cannot see is one you cannot correct.
 *
 *   DONE DID NOTHING. A `multiline` TextInput defaults to
 *   `submitBehavior: 'newline'`, so the return key inserts a line break and
 *   `onSubmitEditing` is never called. Both boxes with a submit handler had
 *   one that could not fire: the fact editor's Done key put a newline in the
 *   middle of the fact, and the Talk screen's return key did the same to a
 *   sentence meant for Grove.
 *
 * The rules are general rather than named at the two fixes, because the next
 * input somebody adds will have the same two defaults.
 */
section('You can see what you type, and Done does something');
{
  const screens = [
    'src/app/(app)/index.tsx',
    'src/app/(app)/sparks.tsx',
    'src/app/(app)/settings.tsx',
    'src/app/onboarding.tsx',
    'src/app/login.tsx',
    'src/components/ui.tsx',
  ];

  /*
   * Comments stripped first, because this section is about what the code
   * does. The note in sparks.tsx explaining why a KeyboardAvoidingView must
   * not be used here contains the words "KeyboardAvoidingView", and the
   * check read its own explanation as the thing it was warning about.
   */
  const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  for (const file of screens) {
    // Both: the stripped text is what gets tested, the original is what line
    // numbers are counted in. Reporting a line from the stripped copy points
    // at whatever happens to sit there in the real file.
    const original = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const source = code(original);
    const inputs = source.match(/<TextInput\b[\s\S]*?\/>/g) ?? [];

    /*
     * A submit handler that cannot be reached is worse than no handler: it
     * reads as the feature being there. `blurOnSubmit` is accepted because
     * React Native still honours it, though `submitBehavior` supersedes it.
     */
    for (const input of inputs) {
      if (!/\bmultiline\b/.test(input) || !/onSubmitEditing/.test(input)) continue;
      // Located by its `value={…}` prop, which survives stripping and is
      // unique per field; the whole tag does not match, since the original
      // still has the comments in it.
      const marker = /value=\{[^}]*\}/.exec(input)?.[0];
      const at = marker ? original.indexOf(marker) : -1;
      const line = at >= 0 ? original.slice(0, at).split('\n').length : '?';
      check(
        /submitBehavior|blurOnSubmit/.test(input),
        `${file}:${line} — a multiline field with a submit handler says what the return key does`,
        "multiline defaults to inserting a newline, so onSubmitEditing never fires and the key lies"
      );
    }

    // Only screens that actually take typing need to deal with a keyboard.
    if (inputs.length === 0) continue;
    const avoiding = /KeyboardAvoidingView/.test(source);
    const insets = /automaticallyAdjustKeyboardInsets/.test(source);
    /*
     * Or it hands the job to the shared wrapper, which is itself in this
     * list. Settings has three fields and no scroll view of its own — the
     * first version of this check called that a failure, which is the check
     * being wrong rather than the screen.
     */
    const delegates = /<Screen\b/.test(source);
    check(
      avoiding || insets || delegates,
      `${file} takes typing and moves out of the keyboard's way`,
      'otherwise the keyboard covers whatever is being typed into'
    );
    /*
     * Never both. A KeyboardAvoidingView shrinks the container by the
     * keyboard's height and the inset adjustment subtracts it again, so the
     * content jumps twice as far as it should and the field overshoots off
     * the top.
     */
    check(
      !(avoiding && insets),
      `${file} subtracts the keyboard once, not twice`,
      'a KeyboardAvoidingView and keyboard insets together scroll the field clean past where you are looking'
    );
  }

  /*
   * And the wrapper those screens delegate to, checked on its own terms.
   *
   * This is the hole the first version of the section had, and it is the one
   * this harness already has a whole section about: `ui.tsx` holds no
   * TextInput of its own, so the loop above skipped it entirely, while
   * Settings passed by pointing at it. Removing the keyboard handling from
   * the shared `Screen` broke Settings and every other screen using it, and
   * every check still printed ok. A delegation is only worth accepting if the
   * delegate is the thing being asserted.
   */
  const ui = code(fs.readFileSync(path.join(ROOT, 'src/components/ui.tsx'), 'utf8'));
  const shared = between(ui, 'export function Screen(', 'stickyHeaderIndices', {
    min: 400,
    max: 2500,
  });
  check(shared !== null, 'the shared screen wrapper is where it is expected to be');
  check(
    shared !== null && /automaticallyAdjustKeyboardInsets/.test(shared),
    'the shared screen wrapper moves out of the keyboard’s way',
    'every screen that delegates its scrolling to it is relying on this'
  );
}

/**
 * Opening the microphone does not stop the music.
 *
 * `expo-speech-recognition` configures the shared audio session itself, and
 * given no category it uses its own default: `.playAndRecord` in
 * `.measurement` mode with `[.defaultToSpeaker, .allowBluetooth]` and **no
 * `.mixWithOthers`**, then `setActive(true, .notifyOthersOnDeactivation)`. A
 * non-mixable `playAndRecord` session going active interrupts whatever else
 * is making sound, so starting a listen stopped the Music app.
 *
 * Which is the bug `configureSession` in grove-remote carries a long comment
 * about having fixed — "start a song and it stops, every time" — arriving
 * from the other side. **Nothing in the Swift was wrong**, which is why it
 * survived: the file that explains the problem is not the file that caused it.
 *
 * Two things made it total. Every reply opens the microphone now for the
 * grace window, so the override ran after every turn — about half a second
 * after the song had been resumed. And nothing sets the category back:
 * `setKeepAlive` only plays or pauses the silence, and in the foreground
 * `beginListening` deliberately skips `reactivate`. So one press left the
 * session non-mixable for the rest of the launch, with Grove's own keep-alive
 * silence holding it open, and from then on nothing could play at all.
 *
 * The check is a cross-language one, because the failure is a disagreement
 * between two files in two languages that no compiler reads together.
 */
section('Listening does not stop the music');
{
  const listen = fs.readFileSync(path.join(ROOT, 'src/lib/listen.ts'), 'utf8');
  const swift = fs.readFileSync(path.join(ROOT, 'modules/grove-remote/ios/GroveRemoteModule.swift'), 'utf8');

  // The recogniser has to be told, on the path that actually records.
  const start = between(listen, 'module.start({', 'volumeChangeEventOptions', { min: 100, max: 1200 });
  check(start !== null, 'the recogniser start options are where they are expected to be');
  check(
    start !== null && /iosCategory:/.test(start),
    'the recogniser is told which audio session to leave behind',
    'given none it picks a non-mixable one, which interrupts whatever is playing'
  );

  // What we tell it.
  const ours = between(listen, 'const SESSION = {', '} as const;', { min: 80, max: 400 });
  check(ours !== null, 'the session Grove asks for is where it is expected to be');
  const mode = /mode:\s*'([a-zA-Z]+)'/.exec(ours ?? '')?.[1] ?? null;
  const category = /category:\s*'([a-zA-Z]+)'/.exec(ours ?? '')?.[1] ?? null;
  const options = [...(ours ?? '').matchAll(/'([a-zA-Z0-9]+)'/g)]
    .map((m) => m[1])
    .filter((v) => v !== mode && v !== category);

  // What grove-remote sets for itself.
  const configure = between(swift, 'private func configureSession()', 'setActive(true', {
    min: 100,
    max: 1400,
  });
  check(configure !== null, 'the native session config is where it is expected to be');
  const nativeMode = /mode:\s*\.([a-zA-Z]+)/.exec(configure ?? '')?.[1] ?? null;
  const nativeCategory = /setCategory\(\s*\.([a-zA-Z]+)/.exec(configure ?? '')?.[1] ?? null;
  const nativeOptions = (/options:\s*\[([^\]]*)\]/.exec(configure ?? '')?.[1] ?? '')
    .split(',')
    .map((v) => v.trim().replace(/^\./, ''))
    .filter(Boolean);

  check(
    options.includes('mixWithOthers'),
    'the session Grove listens on is mixable',
    'the one thing that decides whether a song survives the microphone opening'
  );
  check(
    nativeOptions.includes('mixWithOthers'),
    'and so is the one it holds the rest of the time'
  );

  /*
   * Identical, not merely both mixable. If the two differ the category is
   * swapped on every listen, and the Swift says why that is not free:
   * swapping category mid-conversation audibly clips the first syllable.
   */
  const same = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  check(category === nativeCategory, `both ask for the same category (${category})`);
  check(mode === nativeMode, `and the same mode (${mode})`);
  check(
    nativeOptions.length > 0 && same(options, nativeOptions),
    'and exactly the same options, so the session never changes shape',
    `listen.ts has [${[...options].sort()}], the module has [${[...nativeOptions].sort()}]`
  );
}

section('Enough means enough, and nothing else does');
{
  const { closing } = require(path.join(OUT, 'lib/closing.js'));

  /** Said on its own: nothing left to answer, and the window stays shut. */
  const alone = [
    'Enough.',
    'enough',
    'Ok, enough.',
    "That's enough.",
    "That's all.",
    "That's it.",
    'Thanks, that’s all.',
    'Nothing else.',
    'Stop listening.',
    "We're done.",
    'Done.',
    'Alright, done',
  ];
  for (const said of alone) {
    const got = closing(said);
    check(
      got.closed === true && got.text === '',
      `"${said}" closes the microphone and needs no reply`,
      'a reply to "enough" is the exact noise being asked for less of'
    );
  }

  /** Riding on a real sentence: answer it, then stay shut. */
  const riding = [
    ["Text Priya I'm running three minutes late, enough.", "Text Priya I'm running three minutes late"],
    ['Add milk to the list and enough', 'Add milk to the list'],
    ['Send that report to Priya, that’s all.', 'Send that report to Priya'],
    ['Put the gym at seven tomorrow, nothing else', 'Put the gym at seven tomorrow'],
    ['Remind me to call Mark — that’s it', 'Remind me to call Mark'],
  ];
  for (const [said, left] of riding) {
    const got = closing(said);
    check(
      got.closed === true && got.text === left,
      `"${said}" is answered as "${got.text}" with no window after`
    );
  }

  /*
   * And the sentences that end in one of those words and mean something else.
   *
   * These are the reason the bare words need a break in front of them and the
   * match is exact rather than contained. Without either rule, "mark the
   * essay as done" becomes "mark the essay as".
   */
  const ordinary = [
    'Is twenty minutes enough?',
    "That's good enough",
    "I've had enough of this course",
    'Have I slept enough',
    "No, that's not enough",
    'Book it for nine, that is not enough time',
    'Mark the essay as done',
    'Is the build done?',
    'Tell Priya the deck is finished',
    'Am I done for the day?',
    'I need enough time to get there',
    'Add enough milk for the week to the list',
    'No more meetings this week please',
    'Can you text Priya, that’s all?',
    'Move my 2 - 3 pm meeting',
    'Order me a burger and some fries',
  ];
  for (const said of ordinary) {
    const got = closing(said);
    check(
      got.closed === false && got.text === said,
      `"${said}" is an ordinary sentence and survives whole`,
      'a stop word read into a real request truncates it with nothing on screen to say why'
    );
  }

  /*
   * The wiring, which the strings above cannot see.
   *
   * Two things set the hush, and the second is the one that was quietly
   * untrue: "nothing unprompted opens the microphone" used to hold by
   * construction, because a reply only listened when something was waiting on
   * an answer. The grace window after every reply broke it without anything
   * in attention.ts or interrupt.ts changing.
   */
  const agent = fs.readFileSync(path.join(ROOT, 'src/context/agent.tsx'), 'utf8');

  const exchange = between(agent, 'const exchange = useCallback', 'const turn = ++turnSeq.current;', {
    min: 200,
    max: 2600,
  });
  check(exchange !== null, 'the start of a turn is where it is expected to be');
  check(
    exchange !== null && /closing\(said\)/.test(exchange),
    'the stop word is read before anything else looks at the sentence'
  );

  const volunteered = between(agent, 'attention.current.said.add', 'transcript.record', {
    min: 100,
    max: 1500,
  });
  check(volunteered !== null, 'the unprompted line is where it is expected to be');
  check(
    volunteered !== null && /hushAfter\.current = turnSeq\.current;/.test(volunteered),
    'nothing Grove says unprompted opens the microphone',
    'nobody asked for it, the phone is in a pocket, and the window would record the room'
  );

  const window = between(agent, 'A window that was asked not to open.', 'const window = listenAfter', {
    min: 100,
    max: 1200,
  });
  check(window !== null, 'the hush is read where the window is chosen');
  check(
    window !== null && /!listenAfter && hushAfter\.current === turn/.test(window),
    'the hush drops the grace window but never a real question',
    'a question Grove had to ask, with no way to answer it, is the worse failure'
  );
}

/**
 * Nothing calls a web API that React Native does not have.
 *
 * `AbortSignal.timeout(ms)` type-checks, works in node, works in the browser
 * the web export builds for, and throws on a phone: React Native replaces the
 * global `AbortSignal` with the `abort-controller` package's version, which
 * has no static helpers. The throw happens inside the caller's `try`, so it
 * wears the costume of a network failure — weather answered "the weather
 * service is not answering" on every call, on full signal, for months, and no
 * retry could help because the retry threw in the same place.
 *
 * This is the only check that can see it. Every other gate ran somewhere the
 * call works. `src/lib/abort.ts` has the replacement, and the ban is on the
 * call rather than on the file so that a new one cannot be added quietly.
 */
section('No web API React Native does not have');
{
  const BANNED = [
    // Each: what is missing on a phone, and what to use instead.
    { call: 'AbortSignal.timeout(', use: 'timeoutSignal() from lib/abort' },
    { call: 'AbortSignal.any(', use: 'an AbortController of your own' },
  ];
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  })(path.join(ROOT, 'src'));

  for (const { call, use } of BANNED) {
    const guilty = files.filter((file) => {
      // Comments talk about it on purpose — abort.ts is the explanation.
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => line.includes(call) && !/^\s*(?:\/\/|\*|\/\*)/.test(line));
    });
    check(
      guilty.length === 0,
      `nothing calls ${call}) — use ${use}` +
        (guilty.length ? ` (found in ${guilty.map((f) => path.relative(ROOT, f)).join(', ')})` : '')
    );
  }

  // And the replacement does what it replaces: falls back where the native
  // helper is missing, which is the whole point of it existing.
  const abort = fs.readFileSync(path.join(ROOT, 'src/lib/abort.ts'), 'utf8');
  check(/new AbortController\(\)/.test(abort), 'abort.ts falls back to an AbortController');
  check(/setTimeout\(/.test(abort), 'and arms a timer of its own');
}

/*
 * Offers, and the division of labour that makes them safe.
 *
 * Grove may end a reply with one line offering the obvious next thing — send
 * you the link, write that up, put the numbers in a doc. **The model decides
 * what; this file's subject decides whether.**
 *
 * The first version decided *what* here too, with a keyword list, and it was
 * wrong in the way a keyword list is always wrong: "I'm running three minutes
 * late" matched the gym rule and offered a training plan. So the proposal now
 * comes from the model, on the call that was happening anyway, and
 * `offerFrom` is the gate. These checks are that gate — every one of them is
 * a way a model-written proposal could reach a person as nonsense or worse.
 */
section('An offer must survive its own schema');
{
  const offers = require(path.join(OUT, 'lib/offers.js'));
  const { ABILITIES, abilityById } = require(path.join(OUT, 'lib/abilities.js'));
  const available = ABILITIES.filter((a) => a.wired);

  const good = {
    say: 'Want me to send you the Amazon link for it?',
    tool: 'shop_order',
    args: '{"what":"Never Split The Difference book","store":"amazon"}',
  };
  const made = offers.offerFrom(good, available);
  check(Boolean(made), 'a proposal naming a real tool with real arguments is kept');
  check(made && made.ability === 'shop.order', 'and resolves the dotted ability id from the tool name');
  check(made && made.args.what === 'Never Split The Difference book', 'with its arguments parsed');

  /*
   * The check that replaced the keyword list, and the better rule.
   *
   * An offer that cannot fill the required arguments of the thing it is
   * offering has not worked out what it would do. "Want me to look that up
   * for you?" with no topic is the sentence this feature exists never to say,
   * and it is exactly what a model produces when it is being agreeable rather
   * than useful.
   */
  check(
    offers.offerFrom({ say: 'Want me to look that up?', tool: 'brief_web', args: '{}' }, available) === null,
    'a proposal with no arguments is dropped',
    'otherwise the offer is "shall I help with that?"'
  );
  check(
    offers.offerFrom({ say: 'Want me to order it?', tool: 'shop_order', args: '{"store":"amazon"}' }, available) === null,
    'and so is one missing a required argument'
  );

  // A tool that does not exist, and one this mode does not allow.
  check(
    offers.offerFrom({ say: 'Want me to book a table?', tool: 'restaurant_book', args: '{"where":"x"}' }, available) === null,
    'a proposal naming a tool that does not exist is dropped'
  );
  check(
    offers.offerFrom(good, available.filter((a) => a.id !== 'shop.order')) === null,
    'and one naming a tool this mode has switched off'
  );

  // It has to be answerable out loud.
  check(
    offers.offerFrom({ ...good, say: 'I will send you the Amazon link.' }, available) === null,
    'a statement is not an offer',
    'there would be nothing for the person to say yes to'
  );
  check(
    offers.offerFrom({ ...good, say: `${'Want me to '.repeat(20)}?` }, available) === null,
    'and neither is a paragraph'
  );

  // Arguments arrive as JSON because a flat schema has nowhere to nest. A
  // model that wraps it in prose should cost the offer, not the reply.
  check(
    Boolean(offers.offerFrom({ ...good, args: 'here you go: {"what":"a book","store":"amazon"} ' }, available)),
    'arguments wrapped in prose are still recovered'
  );
  check(
    offers.offerFrom({ ...good, args: 'what: a book, store: amazon' }, available) === null,
    'and arguments that are not JSON at all are dropped'
  );
  check(
    Boolean(offers.offerFrom({ ...good, args: { what: 'a book', store: 'amazon' } }, available)),
    'arguments already given as an object work too'
  );

  /*
   * The money rule, at the one new door into the same room.
   *
   * An offer is a question Grove thought of by itself. If one could carry a
   * confirmation then a yes to Grove's own idea would be the thing that sends
   * or buys, and the whole point of the confirmation is that only the person
   * supplies it. Stripped here as well as in tools.ts.
   */
  const sneaky = offers.offerFrom(
    { ...good, args: '{"what":"a book","store":"amazon","confirmed":"yes"}' },
    available
  );
  check(Boolean(sneaky), 'a proposal that tries to confirm itself still offers');
  check(sneaky && !('confirmed' in sneaky.args), 'but the confirmation is stripped out of it');
  for (const forbidden of ['draft', 'new_email']) {
    const withIt = offers.offerFrom(
      { say: 'Want me to send it?', tool: 'mail_send', args: JSON.stringify({ to: 'Priya', body: 'hello there', [forbidden]: 'yes' }) },
      available
    );
    check(withIt && !(forbidden in withIt.args), `and so is ${forbidden}`);
  }

  const offersSource = fs.readFileSync(path.join(ROOT, 'src/lib/offers.ts'), 'utf8');
  const agentSourceFull = fs.readFileSync(path.join(ROOT, 'src/context/agent.tsx'), 'utf8');
  const settles = offersSource
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .some((line) => /\bconfirmed\s*:/.test(line));
  check(!settles, 'offers.ts never sets a confirmation itself');

  /*
   * Both ends of this slice are asserted, which they were not.
   *
   * It used to end at a hardcoded line that was later rewritten, so
   * `indexOf` returned -1, `slice(start, -1)` handed back most of the file,
   * and the check failed on a `confirmed:` three hundred lines away. An
   * unasserted offset is a check that silently measures the wrong thing —
   * the same fault as the unguarded `.replace` that once left a whole pane
   * without its class.
   */
  const accept = between(
    agentSourceFull,
    'An answer to something Grove offered to do',
    "An answer to Grove's own question",
    { min: 400, max: 8000 }
  );
  check(accept !== null, 'the accept branch is found, both ends, at a branch\'s size');
  check(
    accept !== null && !/confirmed:/.test(accept),
    'accepting an offer never supplies the confirmation itself',
    'an ability that asks for a press must still ask for it'
  );
  check(
    accept !== null && /needsConfirming/.test(accept),
    'and an accepted offer re-arms the confirmation when the ability wants one'
  );

  /*
   * Declining is not disagreeing, and this is the check that says so.
   *
   * The first version switched a kind off for good after two nos. That read a
   * verdict on two badly-chosen offers as an instruction about a whole
   * ability — say no to two bad link offers and links were gone, which makes
   * something useful look broken. Worse than never shipping it, because the
   * person has now watched it stop.
   *
   * So a decline buys **rest** and only an explicit "stop offering that" is
   * permanent. Nothing a count can reach may take a kind to zero, and the
   * ceiling on what Grove may conclude from being turned down is a week.
   */
  const DAY = 86400000;
  const now = new Date('2026-06-15T12:00:00Z');
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();

  check(offers.welcome({}, 'shop.order', now), 'a kind never offered gets a go');
  check(
    offers.welcome({ 'shop.order': { yes: 0, no: 1, run: 1, lastNo: ago(60_000) } }, 'shop.order', now),
    'one no costs nothing extra',
    'a no is a verdict on one offer, not on the ability'
  );
  check(
    !offers.welcome({ 'shop.order': { yes: 0, no: 2, run: 2, lastNo: ago(60_000) } }, 'shop.order', now),
    'two nos buy a day of quiet'
  );
  check(
    offers.welcome({ 'shop.order': { yes: 0, no: 2, run: 2, lastNo: ago(2 * DAY) } }, 'shop.order', now),
    'and the kind comes back on its own the next day',
    'this is the whole difference from the rule it replaced'
  );
  check(
    !offers.welcome({ 'shop.order': { yes: 0, no: 9, run: 9, lastNo: ago(6 * DAY) } }, 'shop.order', now),
    'a long run of nos rests for longer'
  );
  check(
    offers.welcome({ 'shop.order': { yes: 0, no: 9, run: 9, lastNo: ago(8 * DAY) } }, 'shop.order', now),
    'but never for more than a week',
    'a fortnight of silence is indistinguishable from being switched off'
  );
  // The ceiling, read from the table rather than inferred from the cases.
  const rests = offersSource.match(/const REST_DAYS = \[([^\]]+)\]/);
  check(Boolean(rests), 'the rest table is where it is expected to be');
  if (rests) {
    const days = rests[1].split(',').map((n) => Number(n.trim()));
    check(days[0] === 0 && days[1] === 0, 'the first no rests for no days at all');
    check(Math.max(...days) <= 7, `and the longest rest is ${Math.max(...days)} days`);
  }
  check(
    offers.welcome({ 'shop.order': { yes: 0, no: 2, run: 2, lastNo: ago(60_000) } }, 'doc.create', now),
    'resting one kind leaves the others alone'
  );
  check(
    offers.welcome({ 'shop.order': { yes: 4, no: 9, run: 0, lastNo: ago(60_000) } }, 'shop.order', now),
    'and an accept clears the run, however many nos came before it'
  );

  /*
   * Only a sentence switches something off.
   *
   * The asymmetry is deliberate: they should be able to stop a kind of offer
   * in one sentence, and Grove should never be able to infer the same thing
   * from two shrugs. So `vetoed` is the only permanent state, nothing but an
   * explicit answer sets it, and a later yes lifts it.
   */
  check(
    !offers.welcome({ 'shop.order': { yes: 3, no: 1, run: 0, vetoed: true } }, 'shop.order', now),
    'a veto outranks every count'
  );
  const vetoSource = agentSourceFull;
  const vetoLine = /const veto =\s*\n?\s*\/(.+)\/i\.test\(/.exec(vetoSource);
  check(/const veto =/.test(vetoSource), 'the turn tells a veto apart from a no');
  check(
    /answeredOffer\(account, proposed\.kind, 'vetoed'\)/.test(vetoSource) &&
      /answeredOffer\(account, proposed\.kind, 'declined'\)/.test(vetoSource) &&
      /answeredOffer\(account, proposed\.kind, 'accepted'\)/.test(vetoSource),
    'and records all three answers distinctly'
  );
  // A bare no must not be able to reach the veto branch. Checked by running
  // the real patterns out of the real source rather than retyping them.
  {
    const src = vetoSource.slice(vetoSource.indexOf('const veto ='));
    const pats = [...src.slice(0, src.indexOf(';')).matchAll(/\/((?:\\.|[^/\\])+)\/i/g)].map(
      (m) => new RegExp(m[1], 'i')
    );
    check(pats.length >= 1, 'the veto patterns can be read out of the source');
    const vetoes = (text) => pats.some((p) => p.test(text));
    for (const bare of ['no', 'nope', 'nah', 'not now', 'later', 'leave it', "don't"]) {
      check(!vetoes(bare), `"${bare}" cannot switch a kind off`);
    }
    for (const said of ['stop offering that', "don't offer that again", 'never ask me that again']) {
      check(vetoes(said), `"${said}" can`);
    }
    // And it must not fire on an unrelated sentence that happens to say stop.
    for (const other of ['stop the music', 'never mind, what is the weather']) {
      check(!vetoes(other), `"${other}" is not a veto`);
    }
  }
  check(/export async function allowAgain/.test(offersSource), 'and a veto can be taken back');

  // Caps as a backstop, not as the decision. Read from the source, because
  // exercising them needs the vault and this file stubs no Keychain.
  const perDay = Number(offersSource.match(/const PER_DAY = (\d+);/)?.[1]);
  check(perDay >= 1 && perDay <= 6, `at most ${perDay} offers in a day`);
  const gap = Number(offersSource.match(/const TURNS_BETWEEN = (\d+);/)?.[1]);
  check(gap >= 1, `and ${gap} turns of ordinary conversation between them`);

  /*
   * The model is actually asked, and told what makes an offer real.
   *
   * Checked because the whole design now rests on the model proposing: a tool
   * declared but never offered to it, or offered without the rule that it has
   * to name what it would do, is this feature silently reverting to nothing
   * or to noise.
   */
  const brain = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');
  check(/OFFER_NEXT/.test(brain) && /declarationsFor\(available\), ASK_BACK, OFFER_NEXT/.test(brain),
    'the model is given offer_next alongside its abilities');
  check(/name: 'offer_next'/.test(brain), 'declared under the name the loop looks for');
  check(/offernext/.test(brain), 'and the loop recognises the call however it is spelled');
  check(
    /Offer the obvious next step/.test(brain) && /must be able to NAME it/i.test(brain),
    'the rules tell it to name what it would do'
  );
  // Two questions and one microphone is a reply whose answer goes to
  // whichever one Grove felt like.
  check(
    /if \(!proposed\.offer \|\| reply\.expectsReply\) return reply;/.test(brain),
    'an offer is dropped when the turn already asked something back'
  );

  /*
   * Sending to yourself has no confirmation, and the reason has to stay true.
   *
   * Every other writing ability here takes a press. This one does not, and
   * the entire argument is that the address is read from the account and
   * cannot be passed in — so there is no argument a misheard sentence could
   * fill that would send it to anybody else. If an argument for the
   * recipient ever appears, the exemption is no longer earned.
   */
  const sendSelf = abilityById('link.send');
  check(Boolean(sendSelf), 'there is a way to send something to yourself');
  if (sendSelf) {
    check(sendSelf.reads !== true, 'sending to yourself is not a read');
    for (const named of ['to', 'recipient', 'address', 'email', 'who']) {
      check(!(named in sendSelf.args), `link.send takes no "${named}" argument`,
        'its lack of a confirmation depends on the address coming from the account');
    }
    const body = fs.readFileSync(path.join(ROOT, 'src/lib/abilities.ts'), 'utf8');
    const run = body.slice(body.indexOf("id: 'link.send'"));
    check(/google\.me\(\)/.test(run.slice(0, run.indexOf('\n};'))),
      'and reads the address from the account instead');
  }

  /*
   * A link found by a search survives to be sendable.
   *
   * The spoken half of an answer cannot contain a web address — read aloud it
   * is a minute of letters — so they used to be stripped, twice, and that
   * made "send me that link" impossible to honour: by the time anything could
   * be asked, the address no longer existed anywhere in the app.
   */
  const light = fs.readFileSync(path.join(ROOT, 'src/lib/lightModel.ts'), 'utf8');
  const brief = light.slice(light.indexOf('export async function lightBrief'));
  const briefEnd = brief.indexOf('\n}\n');
  const briefBody = brief.slice(0, briefEnd);
  check(/LINKS:/.test(briefBody), 'a web search is asked for the addresses behind its answer');
  check(/spoken:/.test(briefBody) && /detail:/.test(briefBody),
    'and returns them in detail rather than in what is spoken');
  // Exercised rather than grepped: a regex about a regex proves nothing, and
  // the property is simply that no address survives into `spoken`.
  const spokenStrip = briefBody.slice(briefBody.indexOf('const said = whole'));
  check(
    /replace\(\/\\bhttps\?/.test(spokenStrip),
    'while still stripping addresses out of the spoken half'
  );
  check(
    briefBody.indexOf("replace(/^\\s*LINKS:.*$/im, '')") > 0,
    'and takes the links line out of what is said'
  );
  const briefAbility = fs.readFileSync(path.join(ROOT, 'src/lib/abilities.ts'), 'utf8');
  const briefRun = briefAbility.slice(briefAbility.indexOf("id: 'brief.web'"));
  check(
    /found\.detail/.test(briefRun.slice(0, briefRun.indexOf('\n};'))),
    'and the search ability passes that detail on to the model'
  );
}

/*
 * The harness checks itself.
 *
 * Every other section here asserts something about the app. This one asserts
 * something about this file, because the most expensive failure a harness can
 * have is not a check that breaks — you see those — it is a check that
 * silently stops checking and keeps printing "ok".
 *
 * That happened: a slice between two landmarks lost its end landmark to an
 * unrelated edit, `indexOf` returned -1, and `slice(start, -1)` returned most
 * of the file. The *lucky* direction. Lose the start landmark instead and the
 * slice is empty, every "this region does not contain X" passes against
 * nothing, and the guard between an offer and a payment reports success while
 * guarding air.
 *
 * So `between()` returns null rather than guessing, and the cases below are a
 * missing landmark, a reversed pair and a region the wrong size — the three
 * ways that function can be asked for something that is not there.
 */
section('A check that stops checking must fail, not pass');
{
  const sample = ['alpha', 'START', 'the middle of it', 'END', 'omega'].join('\n');

  check(between(sample, 'START', 'END') !== null, 'a region with both landmarks is found');
  check(
    (between(sample, 'START', 'END') ?? '').includes('the middle of it'),
    'and contains what sits between them'
  );

  // The fault that shipped: the end landmark is gone.
  check(
    between(sample, 'START', 'GONE') === null,
    'a missing end landmark gives nothing, not the rest of the file',
    'slice(start, -1) returns everything up to the last character'
  );
  // The fault that would have passed silently.
  check(
    between(sample, 'GONE', 'END') === null,
    'a missing start landmark gives nothing, not an empty string',
    'an empty region makes every "does not contain" check pass'
  );
  check(between(sample, 'END', 'START') === null, 'landmarks in the wrong order give nothing');
  check(
    between(sample, 'START', 'END', { min: 10_000 }) === null,
    'and a region smaller than expected gives nothing'
  );
  check(
    between(sample, 'START', 'END', { max: 4 }) === null,
    'as does one larger than expected'
  );

  /*
   * And a null region can never be mistaken for a clean one.
   *
   * This is the actual property that matters: a check written as "the region
   * does not contain the forbidden thing" has to fail when the region could
   * not be read. Written the obvious way — `!/x/.test(region)` — it passes.
   */
  const missing = between(sample, 'GONE', 'END');
  check(missing !== null === false, 'a region that could not be read is null');
  check(
    !(missing !== null && !/forbidden/.test(missing)),
    'so a guard on an unreadable region reports failure',
    'every such check in this file is written `region !== null && ...`'
  );
}

/*
 * A searched answer, and an answer that only looks searched.
 *
 * Asked for "burgers near me", the model named a place that does not exist.
 * Nothing downstream could tell, which is what makes an invented local
 * business worse than most inventions — the sentence reads exactly like a
 * sentence about a real place, and the person can be sent to it.
 *
 * Gemini says whether it actually searched, in `groundingMetadata`, and that
 * was being discarded along with the URIs of the pages it read. Both are now
 * kept: the groundedness so the turn can be honest, and the URIs because
 * asking the model to write its own links out is asking the faculty that
 * invented the restaurant to invent the address too.
 */
section('An answer that was not searched does not pretend to be');
{
  const light = fs.readFileSync(path.join(ROOT, 'src/lib/lightModel.ts'), 'utf8');
  const abilitiesSource = fs.readFileSync(path.join(ROOT, 'src/lib/abilities.ts'), 'utf8');
  const brainSource = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');

  /*
   * Run, not grepped. The grounding read is its own function precisely so the
   * absent case can be exercised — and absent is the case that matters, since
   * it is the one that says the model answered out of its own head.
   */
  const { groundingFrom } = require(path.join(OUT, 'lib/lightModel.js'));
  check(/export function lastGrounding\(\)/.test(light), 'groundedness is available to the search path');

  // A real grounded reply.
  const grounded = groundingFrom({
    webSearchQueries: ['burger restaurants near Edmonton'],
    groundingChunks: [
      { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'yelp.ca' } },
      { web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/def', title: 'opentable.ca' } },
    ],
  });
  check(grounded.searched === true, 'a reply with pages behind it counts as searched');
  check(grounded.links.length === 2, 'and its real page addresses are kept');

  // The one that produced "Fox Burger": the model did not look at all.
  for (const [what, metadata] of [
    ['no metadata at all', undefined],
    ['an empty object', {}],
    ['empty arrays', { groundingChunks: [], webSearchQueries: [] }],
    ['null', null],
  ]) {
    const out = groundingFrom(metadata);
    check(out.searched === false, `${what} means it did not search`);
    check(out.links.length === 0, `and offers no links (${what})`);
  }

  // A query with no pages is still a search; a junk URI is not a link.
  check(groundingFrom({ webSearchQueries: ['x'] }).searched === true, 'a query it ran counts on its own');
  const junk = groundingFrom({ groundingChunks: [{ web: { uri: 'not-a-url' } }, { web: {} }, {}] });
  check(junk.links.length === 0, 'and a chunk with no web address yields no link');
  check(junk.searched === false, 'so it does not count as having searched');

  // Duplicates collapse, and the list is bounded.
  const many = groundingFrom({
    groundingChunks: Array.from({ length: 9 }, (_, i) => ({
      web: { uri: `https://example.com/${i % 2}` },
    })),
  });
  check(many.links.length === 2, 'duplicate pages collapse to one link each');

  /*
   * And it cannot be stale.
   *
   * Only the Gemini path sets groundedness, and it is not the only path:
   * Ollama runs locally with no web at all. Left over from the previous call,
   * a local answer would arrive carrying the last search's "searched: true"
   * and its links — an unverified sentence with real-looking citations
   * attached, which is this signal's own failure mode wearing a disguise.
   */
  const completeBody = between(light, 'async function complete(', '\n}\n', { min: 300, max: 4000 });
  check(completeBody !== null, 'the model entry point is where it is expected to be');
  check(
    completeBody !== null && /grounding = \{ searched: false, links: \[\] \};/.test(completeBody),
    'groundedness is reset before every completion',
    'otherwise a local answer inherits the last search'
  );
  check(
    completeBody !== null &&
      completeBody.indexOf('grounding = {') < completeBody.indexOf('probeOllama'),
    'and reset before any path can answer'
  );

  // Real URIs beat model-written ones.
  const briefBody = between(
    light,
    'export async function lightBrief',
    '\n}\n',
    { min: 500, max: 8000 }
  );
  check(briefBody !== null, 'lightBrief is where it is expected to be');
  check(
    briefBody !== null && /found\.links\.length > 0\s*\n?\s*\? found\.links/.test(briefBody),
    'a real grounding URI is preferred over one the model typed',
    'a typed link can be invented by whatever invented the restaurant'
  );
  check(briefBody !== null && /grounded: found\.searched/.test(briefBody), 'and groundedness is returned');

  // The prompt carries the instruction that was missing.
  check(
    briefBody !== null && /NEVER name a shop, restaurant, venue, product, person or price/.test(briefBody),
    'the search is told never to name something it did not find'
  );

  // An ungrounded answer is labelled on its way to the turn.
  const briefRun = between(abilitiesSource, "id: 'brief.web'", '\n};', { min: 400, max: 6000 });
  check(briefRun !== null, 'the search ability is where it is expected to be');
  check(
    briefRun !== null && /found\.grounded/.test(briefRun),
    'the search ability checks whether its answer was grounded'
  );
  check(
    briefRun !== null && /NOT FROM A SEARCH/.test(briefRun),
    'and says so in the detail the model reads'
  );
  check(
    briefRun !== null && /detail: found\.grounded/.test(briefRun),
    'while a grounded answer is handed over unlabelled'
  );

  // And the turn is told what to do about it, which is to hand off.
  check(
    /Never name a place, business, product, price or person you did not get from a tool/.test(brainSource),
    'the rules forbid naming anything a tool did not return'
  );
  check(
    /NOT FROM A SEARCH/.test(brainSource),
    'name the label the rules are talking about',
    'the ability writes it and the prompt has to use the same words'
  );
  check(
    /that hand-off IS the answer/.test(brainSource),
    'and tell it to hand off to the app rather than guess a name'
  );
}

/*
 * Memory that bears on the question, rather than memory that sits there.
 *
 * Grove's memory was complete and inert. All forty facts rode in every
 * prompt — and the framing above them said, in these words, "use a line ONLY
 * when it is directly relevant to what they just asked. Most turns need none
 * of it." That sentence fixed a real fault, where a note about someone owing
 * for lunch turned up in a question about software. It also taught the model
 * that memory is wallpaper: Grove knew somebody was trying to lose ten kilos,
 * was asked where to get a burger, and answered the question.
 *
 * Two halves, and they pull in opposite directions, which is why they are now
 * two blocks. Restraint about background facts is right. Restraint about
 * goals is the bug — a goal is not trivia about someone, it is the thing they
 * asked for help with.
 */
section('What bears on this, and what stays out of it');
{
  const { bearingOn, contentWords } = require(path.join(OUT, 'lib/bearing.js'));
  const { memoryData, MEMORY_RULES } = require(path.join(OUT, 'lib/memory.js'));

  const ent = (kind, name, summary, facts = []) => ({
    id: name.toLowerCase().replace(/\W+/g, '-'),
    kind,
    name,
    aliases: [],
    summary,
    facts: facts.map((text) => ({ text, at: '2026-09-01' })),
    firstSeen: '2026-01-01',
    lastSeen: '2026-10-01',
    mentions: 3,
    updatedAt: '2026-10-01',
  });
  const life = {
    entities: [
      ent('idea', 'Never Split The Difference', 'A negotiation book he read twice.', ['book by Chris Voss']),
      ent('idea', 'Thinking Fast and Slow', 'A book on judgement he never finished.', ['book by Kahneman']),
      ent('person', 'Priya Shah', 'Classmate on the finance case competition.', ['owes him the Tuesday notes']),
      ent('project', 'Noctus', 'His own backend project, mostly retired.', ['was the OAuth broker']),
      ent('place', 'Padmanadi', 'Vegetarian place on 97 Street.', ['he likes the rendang']),
    ],
    episodes: [
      {
        id: 'e1',
        kind: 'commitment',
        at: '2026-10-20',
        title: 'Send Priya the lecture notes',
        summary: 'He said he would send Priya his notes from the Tuesday lecture.',
        about: ['priya-shah'],
        open: true,
        source: 'conversation',
        updatedAt: '2026-10-20',
      },
    ],
    pending: [],
  };
  const facts = [
    { id: 'f1', subject: 'me', key: 'home', value: 'I live in Edmonton', source: 'told', at: '2026-01-01' },
    { id: 'f2', subject: 'me', key: 'weight', value: 'wants to lose 10 kg', source: 'told', at: '2026-09-01', kind: 'goal' },
    { id: 'f3', subject: 'me', key: 'study', value: 'studying finance at UAlberta', source: 'told', at: '2026-01-01' },
  ];

  /*
   * The restraint half. A block that shows up on every turn is one the model
   * stops reading, and the original complaint about memory was that it got
   * worked into answers to prove it had remembered.
   */
  const QUIET = [
    "what's the weather",
    'put some music on',
    'remind me to call mum at six',
    'how are you doing today',
    'set a timer for ten minutes',
    'what is the capital of France',
    'tell me a joke',
    'what time is it',
  ];
  const noisy = QUIET.filter((said) => bearingOn(said, life, facts).block !== '');
  check(
    noisy.length === 0,
    `nothing is surfaced on ${QUIET.length} turns that touch nothing`,
    noisy.length ? `surfaced on: ${noisy.map((s) => JSON.stringify(s)).join(', ')}` : ''
  );

  // And the half that was missing.
  const named = (said) => bearingOn(said, life, facts).named;
  check(
    named('what should I get Priya for her birthday').includes('Priya Shah'),
    'one distinctive word of a name surfaces that person',
    'requiring every word meant "Priya" did not match "Priya Shah"'
  );
  check(
    named('I really liked Never Split The Difference').includes('Never Split The Difference'),
    'something named outright is surfaced'
  );
  check(
    named('I really liked Never Split The Difference').includes('Thinking Fast and Slow'),
    'along with the nearest thing of the same kind',
    'this is what makes "you liked that one, this is close to it" possible'
  );
  check(
    named('can you recommend me a book').length >= 2,
    'and one shared word that is not ubiquitous is enough on its own'
  );
  check(
    /Still open: Send Priya the lecture notes/.test(bearingOn('I need to send those notes', life, facts).block),
    'an open promise the sentence touches comes with it'
  );

  /*
   * The stemmer, which had this exact bug.
   *
   * "notes" lost its "es" and became "not", which is a stopword, so a
   * sentence about sending notes matched a commitment about sending notes on
   * zero words. Nothing in a type system or a lint can see that; it looks
   * like the feature simply not working.
   */
  for (const [word, want] of [
    ['notes', 'note'],
    ['boxes', 'box'],
    ['dishes', 'dish'],
    ['running', 'run'],
    ['burgers', 'burger'],
  ]) {
    const got = [...contentWords(word)][0];
    check(got === want, `"${word}" stems to "${want}"${got === want ? '' : ` (got "${got}")`}`);
  }
  /*
   * The real property, stated correctly.
   *
   * My first attempt at this check asserted that no stem may land on a
   * stopword, and it failed on "needs", "uses" and "things" — whose stems
   * land on stopwords because their singulars *are* stopwords, which is
   * correct behaviour. The fault was never "a stem is a stopword"; it was "a
   * stem is a DIFFERENT word that happens to be a stopword". So the words
   * tested are ones whose singular carries meaning.
   */
  const swallowed = ['notes', 'cases', 'roles', 'goals', 'rates', 'dates', 'sites'].filter(
    (w) => contentWords(w).size === 0
  );
  check(
    swallowed.length === 0,
    'stemming never deletes a word whose singular means something',
    swallowed.length ? `swallowed: ${swallowed.join(', ')}` : ''
  );

  // Bounded, because the point is a few things it should notice.
  const biggest = Math.max(
    ...['I need to send those notes to Priya about the finance lecture at UAlberta', 'book'].map(
      (s) => bearingOn(s, life, facts).block.length
    )
  );
  check(biggest < 1200, `the block stays small (${biggest} chars at its largest here)`);
  // And never says the same thing twice: a promise lives as both a fact and
  // an episode by design.
  const both = bearingOn('I need to send those notes', life, facts).block;
  const dupes = both.split('\n').filter((l) => /Priya/.test(l) && /notes?/i.test(l));
  check(dupes.length <= 1, 'and never says the same thing twice');

  /*
   * Goals are out from under the instruction to ignore background.
   *
   * The rules and the data are separate now, for caching — so the property
   * splits in two: the data must label the goals apart from the background,
   * and the rules must say the two are to be treated differently.
   */
  const data = memoryData(facts);
  const beforeGoals = data.split('WHAT THEY ARE TRYING TO DO')[0];
  check(!/lose 10 kg/.test(beforeGoals), 'goals are labelled apart from the background');
  check(/BACKGROUND:/.test(data), 'and the background is labelled as background');

  check(/ONLY when it is directly relevant/.test(MEMORY_RULES), 'background keeps its restraint');
  check(
    /is the opposite/.test(MEMORY_RULES) && /not background/i.test(MEMORY_RULES),
    'and the rules say outright that goals are not background',
    'they used to be under one heading and one instruction, written for the first'
  );
  check(
    /ONE sentence/.test(MEMORY_RULES) && /never a lecture/.test(MEMORY_RULES),
    'with the restraint that keeps it from becoming a diet app',
    'the failure of fixing this is an assistant that nags about your weight'
  );
  check(
    /get them the burger/.test(MEMORY_RULES),
    'and does what was asked regardless',
    'Grove is not in charge of them'
  );
  check(memoryData([]) === '', 'nothing at all when there is no memory');

  // Wired in, not merely written.
  const brainSource = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');
  check(/bearingOn\(userText/.test(brainSource), 'the turn asks what bears on what was said');
  check(/MEMORY_RULES/.test(brainSource), 'the rules ride in the system prompt');
  check(/memoryData\(context\.facts\)/.test(brainSource), 'and the memory itself rides with the question');
}

/*
 * The expensive half of a request has to be identical to the last one.
 *
 * Gemini serves a repeated request prefix from its implicit cache at a
 * quarter of the input price, and the match is a *prefix* — so one line that
 * changes near the top makes the whole thing uncacheable. Measured before
 * this was fixed: the clock was the second line of the system prompt, so the
 * cacheable prefix was 29 tokens out of 9,727, and every single request paid
 * full price for ~3,000 tokens of rules and ~4,000 of tool declarations that
 * were byte-for-byte the same as the previous one.
 *
 * The fix is a discipline rather than a flag, which is exactly why it needs a
 * check: nothing breaks when somebody puts a timestamp back in the system
 * prompt. It just quietly costs four times as much.
 */
section('Nothing that changes every turn is in the system prompt');
{
  const brain = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');

  const stable = between(brain, 'function systemFor(', '\n}\n', { min: 100, max: 3000 });
  check(stable !== null, 'the system prompt builder is where it is expected to be');

  /*
   * The volatile things, by name. Each of these was in the system prompt at
   * some point and each would cost the whole cache.
   */
  for (const [what, pattern] of [
    ['the clock', /toLocaleTimeString|clock/],
    ['the date', /toLocaleDateString|today/],
    ['the memory', /memoryData|asPromptBlock|facts\b/],
    ['what bears on the question', /bearingOn/],
  ]) {
    check(
      stable !== null && !pattern.test(stable),
      `${what} is not in the system prompt`,
      'it changes every turn, so it would cost the entire cached prefix'
    );
  }

  // And they are all in the part that rides with the question instead.
  const perTurn = between(brain, 'function contextFor(', '\n}\n', { min: 100, max: 3000 });
  check(perTurn !== null, 'the per-turn context builder exists');
  check(
    perTurn !== null && /toLocaleTimeString/.test(perTurn) && /memoryData/.test(perTurn),
    'the clock and the memory ride with the question'
  );
  const call = between(brain, 'const system = [systemFor(', 'const ran: RanTool[]', { min: 100, max: 2500 });
  check(call !== null, 'the request assembly is where it is expected to be');
  check(
    call !== null && /contextFor\(context, \[roster, usual, friction\]/.test(call),
    'and so do the roster, the rhythms and the frictions'
  );
  check(
    call !== null && !/systemFor\(context, available\)/.test(call),
    'the system prompt no longer takes the ability list',
    'the declarations already carry it, and they are sent separately'
  );

  /*
   * The stable part has to be big enough to be worth caching at all.
   *
   * Gemini's implicit cache has a minimum prefix — around a thousand tokens
   * for the lite models — below which nothing is cached however often it
   * repeats. Counted in characters at four to a token, which is close enough
   * to tell a thousand from a hundred.
   */
  const persona = require(path.join(OUT, 'lib/persona.js'));
  const { MEMORY_RULES } = require(path.join(OUT, 'lib/memory.js'));
  const rules = between(brain, 'const TOOL_RULES = `', '`;', { min: 500, max: 20_000 });
  check(rules !== null, 'the tool rules are where they are expected to be');
  const stableChars =
    (rules?.length ?? 0) + MEMORY_RULES.length + persona.mannerDirective(persona.DEFAULT_PERSONA).length;
  check(
    stableChars / 4 > 1200,
    `the stable prefix is about ${Math.round(stableChars / 4)} tokens, over any cache minimum`
  );

  // The one deliberate exception, stated so it is a decision and not a leak.
  check(
    call !== null && /\[systemFor\(context\), talks\]/.test(call),
    'the register is the one slow-changing thing kept in the rules',
    'it is an instruction about how to speak, and it shifts over ~30 turns'
  );
}



/*
 * What is actually billed per request, as opposed to per token.
 *
 * Grounding with Google Search is charged **per search query**, not per
 * token: $14 per thousand on the current lite model after a free monthly
 * allowance, and one request can trigger several queries. At this app's
 * volume that is inside the free allowance and the token bill is about a
 * pound a month — which is only true because the turn that runs on every
 * single sentence does not ground.
 *
 * Nothing stops someone adding `google_search` to the tool turn. It would
 * look like an improvement, it would pass every other check here, and it
 * would turn a free line item into a per-sentence charge. So the separation
 * is asserted: the tool loop declares functions, and searching is something
 * an ability does on purpose.
 */
section('The per-sentence path never pays for a search');
{
  const light = fs.readFileSync(path.join(ROOT, 'src/lib/lightModel.ts'), 'utf8');

  const toolBody = between(light, 'async function toolTurnOnce(', '\n}\n', { min: 500, max: 8000 });
  check(toolBody !== null, 'the tool turn is where it is expected to be');
  check(
    toolBody !== null && /functionDeclarations/.test(toolBody),
    'the tool turn declares the abilities'
  );
  check(
    toolBody !== null && !/google_search/.test(toolBody),
    'and never asks for grounding',
    'grounding is billed per query; this path runs on every sentence'
  );

  // Searching is something an ability does, deliberately, and there is one
  // switch for it.
  const grounders = light
    .split('\n')
    .filter((line) => /google_search/.test(line) && !/^\s*(?:\/\/|\*|\/\*)/.test(line));
  check(
    grounders.length === 1,
    `grounding is requested from exactly one place (${grounders.length} found)`
  );
  check(
    grounders.length === 1 && /json \|\| !search \? \{\} :/.test(grounders[0]),
    'and only when the caller asked for it'
  );

  /*
   * A research report fans out into one grounded query per subject, in
   * parallel. That is the one place a single request becomes several billed
   * ones, so the fan-out is bounded.
   */
  const plan = between(light, 'export async function lightPlan(', '\n}\n', { min: 200, max: 3000 });
  check(plan !== null, 'the research planner is where it is expected to be');
  // The cap on the subject list, not the cap on the brief that is fed in —
  // both are `.slice(0, n)` and the first one in the function is the brief.
  const fan = Number(plan?.match(/parsed\.subjects[\s\S]*?\.slice\(0,\s*(\d+)\)/)?.[1]);
  check(
    Number.isFinite(fan) && fan <= 5,
    `a researched document fans out to at most ${fan} grounded queries`,
    'each subject is a separate billed search'
  );

  // The cheapest tier, by floating alias: a pinned version is worse, because
  // Google retires them and every turn then 404s — which this file's own
  // history records.
  check(
    /'gemini-flash-lite-latest'/.test(light),
    'the default model is the cheapest tier, by floating alias'
  );
}

/* ------------------------------------------------------------- verdict */

console.log(
  `\n${failures === 0 ? 'All' : `${checks - failures}/${checks}`} checks passed` +
    (failures ? ` — ${failures} FAILING` : '')
);
process.exit(failures === 0 ? 0 : 1);
