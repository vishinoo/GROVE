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
const cp = require('child_process');
const os = require('os');
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

/**
 * A section whose checks have to await something.
 *
 * Nearly everything here is synchronous, and the verdict at the bottom used to
 * be reached synchronously too — so an `async` block in the middle of the file
 * scheduled its checks, `process.exit` ran first, and they never happened.
 * Thirteen checks printed a heading and nothing else, the tally was unaffected,
 * and the section looked like it had simply found nothing wrong. Which is this
 * harness's own worst failure: a check that stops checking and keeps looking
 * green.
 *
 * So anything async is registered here and awaited before the verdict, and the
 * verdict is inside the same async tail. An ability is an async function; the
 * only way to assert what one actually *does*, rather than what its source
 * looks like, is to run it.
 */
const deferred = [];
const laterSection = (name, fn) => deferred.push(async () => {
  section(name);
  await fn();
});
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
section('A sum is worked out in code, never in the model\'s head');
// The four films that came back as "two billion", then "four" when challenged.
{
  const calc = require(path.join(OUT, 'lib/calc.js'));
  const films = calc.workOut('1518.8 + 1402.8 + 130.8 + 1131.4');
  check(films && films.value === '4,183.8', 'the four-film total is 4,183.8 (millions)', films ? `got ${films.value}` : 'not parsed');
  const pct = calc.workOut('15% * 240');
  check(pct && pct.value === '36', '15% of 240 is 36', pct ? `got ${pct.value}` : 'not parsed');
  check(calc.workOut('Avengers + Captain Marvel') === null, 'names are refused, not guessed at', 'workOut accepted words');
  check(calc.workOut('2 + ') === null, 'a broken sum is refused', 'workOut accepted a dangling operator');
  for (const said of [
    'avengers + avengers age of ultron + blue beetle + captain marvel how much did they make',
    'how much did those four films make together',
    "what's the total box office for the Nolan films",
    'what is the average rent across those three',
    'how much more did Avatar make than Titanic',
  ]) check(calc.asksToCombine(said), `"${said}" is a sum`, 'the double-check would not run');
  for (const said of ['can we watch something together tonight', 'how much is a ticket to Avatar', 'what did Avengers make']) {
    check(!calc.asksToCombine(said), `"${said}" is not a sum`, 'the double-check would send an ordinary answer back');
  }
  const maths = byId.get('maths.work');
  check(maths && maths.reads === true, 'the maths tool is a read', 'it must be reachable from a question');
  const brainSource = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');
  check(/asksToCombine\(userText\)/.test(brainSource) && /checkedSum = true/.test(brainSource), 'a total answered without the tool is sent back once', 'the code-side check is gone from brain.ts');
}

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
for (const id of ['ride.request', 'food.order', 'shop.order', 'mail.send', 'mail.reply', 'calendar.remove', 'calendar.move', 'mac.do', 'mac.use', 'doc.append']) {
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
section('An action runs only on words that asked for it');
{
  /*
    "goon session" became a calendar event, again and again: a model that did
    not understand reached for the nearest tool. A rule in the prompt did not
    hold, so every action quotes the words that asked for it and the turn
    checks the quote against what was said.
  */
  const tools = require(path.join(OUT, 'lib/tools.js'));
  for (const d of tools.declarationsFor(ALL)) {
    const ability = ALL.find((a) => tools.toolNameFor(a.id) === d.name);
    if (!ability || ability.reads) continue;
    check(
      (d.parameters.required ?? []).includes(tools.ASKED),
      `${d.name} must quote what asked for it`,
      'the model could run it on a sentence that never asked'
    );
  }
  check(tools.askedFor('add goon session tomorrow at 3', 'add goon session tomorrow at 3pm'), 'a real request passes');
  check(tools.askedFor('text Priya', 'can you text priya i am running late'), 'a quote from inside the sentence passes');
  check(!tools.askedFor('create a calendar event', 'goon session'), 'an action nobody asked for is refused');
  check(!tools.askedFor('', 'add milk to the list'), 'an empty quote is refused');
  const brain = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');
  const guard = between(brain, 'if (!ability.reads) {', 'const wrote = plainSpeech', { min: 400, max: 2500 });
  check(guard !== null && /askedFor\(/.test(guard) && /continue;/.test(guard), 'the turn refuses an unasked action before it runs');
}

section('The phone hears what the Mac did');
{
  const mac = fs.readFileSync(path.join(ROOT, 'src/lib/mac.ts'), 'utf8');
  check(/m\.t === 'news'/.test(mac) && /noteMacWork\(/.test(mac.slice(mac.indexOf("m.t === 'news'"))), 'Mac news is recorded for the next sentence');
  const link = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Link.swift'), 'utf8');
  check(/func news\(/.test(link) && /outbox/.test(link), 'the Mac sends news, held through a reconnect');
  const main = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/main.swift'), 'utf8');
  check((main.match(/link\.news\(/g) ?? []).length >= 4, 'every way a Mac ask ends is reported to the phone');
}

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
 * 22. The Memory screen shows a couple, not a drawer.
 *
 * Folding the archive away left a screen of shut drawers: nothing to read,
 * nothing to recognise, and no reason to believe any of it had anything in it.
 *
 * It also held "What it did" — the last few tool calls, with their state and
 * their timestamps. **That is a log, not a memory.** It was the first thing on
 * the screen and the largest, it said nothing that would still matter
 * tomorrow, and it pushed the things that would below the fold. Memory is for
 * what Grove should know next week; a receipt for something it did forty
 * seconds ago belongs nowhere, and certainly not above a list of the people
 * in somebody's life.
 */
section('Memory is what it knows, not a log of what it did');
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
  check(/<Peek show=\{5\}>/.test(screen), 'a long list shows five before the rest');

  /*
   * And there is no action log on it at all.
   *
   * Asserted as an absence, on both halves, because deleting a block from a
   * screen is the easiest thing in the world to half-do: the list goes and
   * the section stays, leaving a heading, a colour on the map and a set of
   * dots for a list that renders nothing.
   */
  const map = fs.readFileSync(path.join(ROOT, 'src/components/memory-map.tsx'), 'utf8');
  check(!/\bactivity\b/.test(screen), 'the memory screen does not read the action log');
  check(!/'did'/.test(map) && !/'did'/.test(screen), 'and no section is left behind for it');
  check(
    !/What it did/.test(map),
    'nor a heading with nothing under it',
    'a memory screen is for what Grove should know next week, not a receipt for a minute ago'
  );

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
    max: 3800,
  });
  check(after !== null, 'the automatic window is where it is expected to be');
  check(
    after !== null && /beginListening\(false, false, \{ window/.test(after),
    'a reply that ends on its own waits for the tail'
  );

  /*
   * Barge-in, which must not wait — and must not guillotine either.
   *
   * This used to assert `stopSpeaking()` right there in the press, because
   * the press stopped the voice dead and then opened the microphone. Correct,
   * and it sounded awful: a reply cut off mid-word reads as the app having
   * crashed rather than as having heard you.
   *
   * The voice now runs into the gap where the recogniser has agreed to start
   * but no microphone is capturing yet, and stops at the first level reading.
   * So what has to hold is different and stronger: the listen starts at once,
   * and the voice is guaranteed to stop by something — the level reading, or
   * the backstop for a build that reports none.
   */
  const barge = between(agent, 'Barge-in, without the guillotine.', "if (current === 'listening')", {
    min: 200,
    max: 2000,
  });
  check(barge !== null, 'the barge-in is where it is expected to be');
  check(
    barge !== null && /beginListening\(false, false, \{ hushSpeech: true \}\)/.test(barge),
    'a press interrupts without waiting for anything'
  );
  check(
    barge !== null && !/SPEECH_TAIL_MS/.test(barge),
    'and never pays the speech tail, which is for a reply that ended on its own'
  );
  const hush = between(agent, 'if (opts.hushSpeech) stopSpeaking();', 'armSilence();', { min: 10, max: 400 });
  check(hush !== null, 'the voice is stopped at the first level reading');
  check(
    /if \(opts\.hushSpeech\) \{\s*\n\s*setTimeout\(/.test(agent) && /BARGE_TAIL_MS/.test(agent),
    'and by a backstop, so a build that reports no levels still stops talking',
    'otherwise interrupting on such a build leaves Grove speaking for ever'
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
/**
 * An address you have used once is an address Grove knows.
 *
 * "Email mom" is the case contacts can never answer. Nobody has a contact
 * called mom, so `findContact` returns nothing, the inbox search finds nothing,
 * and Grove says "I have no address for mom" — every time, however many times
 * it has already sent one. The word people use for somebody is not the word
 * written on the contact card.
 *
 * So a send that worked teaches the word, keyed on what was *said*: that is
 * the half contacts does not already hold, and the half that comes back next
 * time. Written after the send rather than after the lookup, so it only ever
 * records an address a press approved going out.
 *
 * Driven rather than read. The ordering — memory before contacts — is the
 * whole feature, and a check that greps for both calls cannot tell which runs
 * first. So `findContact` is made to throw, and the send has to succeed
 * anyway.
 */
/*
  Phone or Mac, without being told which.

  "Play wordle" and "order the large one instead" used to need "on my Mac" to
  reach it, because nothing in the turn said what the Mac was doing. The fix is
  a few lines of fact in the per-turn context, and the rules for using them in
  the cached half — so these check that the facts are there, that they are
  NOT in the system prompt (where they would cost the cache on every change),
  and that an unreachable Mac goes back to the model to explain rather than
  to a canned line.
*/
laterSection('Grove picks the phone or the Mac without being told', async () => {
  const mac = require(path.join(OUT, 'lib/mac.js'));
  const brain = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');
  const unlinked = mac.macContext();
  check(/not linked/.test(unlinked) && !/On the Mac/.test(unlinked), 'with nothing linked, the context says so and claims no work', unlinked);

  const t0 = Date.now();
  mac.noteMacWork({ what: 'order pad thai from Thai Basil on Uber Eats', state: 'confirm', said: 'Pad thai, one, $17.50. Order it?', task: 'T42' });
  const busy = mac.macContext(t0 + 3 * 60_000);
  check(/order pad thai/.test(busy) && /waiting on their yes/.test(busy) && /task T42/.test(busy), 'work in progress is in the context with its state and task id', busy);
  check(!/On the Mac/.test(mac.macContext(t0 + 31 * 60_000)), 'and drops out after half an hour, so an old job is not carried on by accident');

  const sys = between(brain, 'function systemFor(', 'function contextFor(', { min: 200, max: 3000 });
  check(sys !== null && !/macContext|macStatus|macWork/.test(sys), 'the Mac\'s state is never in the system prompt');
  const rules = between(brain, 'const TOOL_RULES = `', 'How to answer once tools return', { min: 2000, max: 30000 });
  check(rules !== null && /Phone or Mac/.test(rules) && /never ask which one/.test(rules), 'the rules say to choose the device, not ask');

  const hand = between(brain, 'if (MAC_HANDS.has(ability.id)', 'if (!ability.reads)', { min: 100, max: 1500 });
  check(hand !== null && /macReachable\(\)/.test(hand) && /continue;/.test(hand), 'an unreachable Mac is handed back to the model, not run');

  for (const id of ['mac.music', 'mac.open']) {
    const a = ALL.find((x) => x.id === id);
    check(Boolean(a) && !/Only when they say/.test(a.what), `${id} no longer needs "on my Mac" to be said`);
  }

  const use = ALL.find((a) => a.id === 'mac.use');
  const started = Date.now();
  const out = await use.run({ goal: 'play wordle' });
  check(out.ok === false && Date.now() - started < 1500, 'with no Mac linked, a Mac job answers at once rather than waiting on one', JSON.stringify(out));
});

laterSection('An address you have used once is one Grove knows', async () => {
  const memory = require(path.join(OUT, 'lib/memory.js'));
  const google = require(path.join(OUT, 'lib/google.js'));
  const send = ALL.find((a) => a.id === 'mail.send');
  check(Boolean(send), 'there is a mail.send to drive');

  // Everything replaced here is put back at the end: later sections read the
  // real modules, and a harness that leaves its own stubs lying around is
  // measuring itself.
  const keep = {
    loadFacts: memory.loadFacts,
    remember: memory.remember,
    me: google.me,
    findContact: google.findContact,
    searchMail: google.searchMail,
    allowed: google.allowed,
    sendMail: google.sendMail,
  };

  let facts = [];
  memory.loadFacts = async () => facts;
  memory.remember = async (_uid, entry) => {
    facts = [...facts.filter((f) => !(f.key === entry.key && f.subject === entry.subject)), { ...entry, id: entry.key }];
    return facts;
  };
  google.me = async () => 'you@example.com';
  google.allowed = async () => true;
  google.searchMail = async () => [];
  let sentTo = null;
  google.sendMail = async (to) => {
    sentTo = to;
    return true;
  };

  /**
   * Run the two halves of a confirmed send and report where it went.
   *
   * Throws are caught and reported as a refusal rather than left to escape.
   * `findContact` is deliberately made to throw below, and an escaping error
   * failed the section as "an async section threw" — which is a red tick with
   * no idea which rule broke, three lines from a check written to say exactly
   * that.
   */
  const sendTo = async (to, body) => {
    sentTo = null;
    try {
      const first = await send.run({ to, body });
      if (!first.needsConfirming) return { refused: first.spoken, sentTo: null, detail: '' };
      const done = await send.run({ ...first.confirmArgs, confirmed: 'yes' });
      return { refused: done.ok ? null : done.spoken, sentTo, detail: first.detail ?? '' };
    } catch (error) {
      return { refused: `threw: ${String((error && error.message) || error)}`, sentTo, detail: '' };
    }
  };

  {
    // Nothing known, and contacts has never heard of her.
    google.findContact = async () => [];
    let out = await sendTo('mom', 'I will be home at six');
    check(
      out.sentTo === null && /no address/i.test(out.refused ?? ''),
      'with nothing known, a name contacts cannot match is refused rather than guessed'
    );

    // An address dictated in full teaches nothing: the key would be the
    // address and the fact would say an address is its own address.
    out = await sendTo('jane@example.com', 'I will be home at six');
    check(out.sentTo === 'jane@example.com', 'an address said in full is used as it is');
    check(
      !facts.some((f) => String(f.key).startsWith('email:')),
      'and files nothing, since the word and the address would be the same',
      JSON.stringify(facts.map((f) => f.key))
    );

    // Contacts works once, which is how the word gets learned.
    google.findContact = async () => [{ name: 'Mom', email: 'jane@example.com' }];
    out = await sendTo('mom', 'I will be home at six');
    check(out.sentTo === 'jane@example.com', 'a name contacts can match sends as before');
    const learned = facts.find((f) => f.key === 'email:mom');
    check(Boolean(learned), 'and the word is remembered against the address it reached');
    check(
      learned !== undefined && /jane@example\.com/.test(learned.value) && /\bmom\b/i.test(learned.value),
      'in a line that reads as a fact about her',
      learned && learned.value
    );
    check(learned !== undefined && learned.kind !== 'goal', 'as an ordinary fact, never a goal');
    check(
      learned !== undefined && learned.source === 'noticed',
      'marked as noticed rather than told, because nobody said it'
    );

    // The whole point. Contacts is now a trap: consulting it fails the test.
    google.findContact = async () => {
      throw new Error('contacts must not be consulted');
    };
    out = await sendTo('mom', 'running ten minutes late');
    check(
      out.sentTo === 'jane@example.com',
      'next time the word alone is enough, without contacts at all',
      out.refused ?? 'contacts was consulted'
    );
    check(
      /^To jane@example\.com$/m.test(out.detail),
      'and the address is on the card being confirmed',
      'a remembered address that is never shown cannot be caught when it goes stale'
    );

    // Correcting the fact on the Memory screen changes where mail goes, which
    // is what makes the staleness survivable.
    facts = facts.map((f) => (f.key === 'email:mom' ? { ...f, value: 'email for mom is new@example.com' } : f));
    out = await sendTo('mom', 'changed my mind');
    check(out.sentTo === 'new@example.com', 'correcting the fact changes where mail goes');

    /*
     * A send that failed teaches nothing.
     *
     * The address was found, the press happened, and the mail did not go —
     * which is exactly when the address is least worth keeping, because the
     * failure may be the address. Learning it anyway would file a bad one and
     * then use it in preference to contacts for ever.
     *
     * This is the one guarantee the cases above cannot see: with `sendMail`
     * always succeeding, recording before the send and recording after it
     * look identical.
     */
    facts = [];
    google.findContact = async () => [{ name: 'Dad', email: 'dad@example.com' }];
    google.sendMail = async () => false;
    const failed = await sendTo('dad', 'I will call you tonight');
    check(failed.refused !== null, 'a send that fails is reported as a failure');
    check(
      !facts.some((f) => f.key === 'email:dad'),
      'and teaches nothing, since the address may be why it failed',
      JSON.stringify(facts.map((f) => f.key))
    );
    google.sendMail = async (to) => {
      sentTo = to;
      return true;
    };

    // And the one address that is nobody's.
    google.findContact = async () => [];
    await sendTo('me', 'remember the bins');
    check(
      !facts.some((f) => f.key === 'email:me'),
      'emailing yourself files no fact about a person called me'
    );

    Object.assign(memory, { loadFacts: keep.loadFacts, remember: keep.remember });
    Object.assign(google, keep);
  }
});

/**
 * One sentence can ask for five things, and all five happen.
 *
 * "Prepare my evening. Check my calendar, order dinner, finish the
 * presentation on my Mac, email it to my colleague, and put the film back
 * on." Measured against the live model: it comes back with five tool calls,
 * split correctly, each quoting the words that asked for it, routed to the
 * right machine. The model was never the problem.
 *
 * The tool loop was. It ran the reads, reached the first call that *does*
 * something, and returned — and **the three calls after it were dropped with
 * nothing on screen to say so**, which reads exactly like Grove deciding
 * those parts were not worth doing. One sentence asking for five things did
 * two of them.
 *
 * What is left is now kept, as the words that asked for each, and said back
 * one at a time once the one before it has finished. The safety of that
 * rests entirely on the rules below, which is why they are asserted rather
 * than described: a queue that could confirm its own steps would turn one
 * misheard sentence into four actions nobody pressed for.
 */
section('The rest of what they asked for');
{
  const plan = require(path.join(OUT, 'lib/plan.js'));
  const idFor = (n) => require(path.join(OUT, 'lib/tools.js')).abilityIdFor(n, ALL.map((a) => a.id));
  const step = (name, args) => [{ name, args }];

  const kept = plan.planFrom([
    { name: 'mac_use', args: { asked: 'finish the presentation on my Mac', goal: 'x' } },
    { name: 'mac_use', args: { asked: 'email it to my colleague', goal: 'y' } },
  ], ALL, idFor);
  check(kept !== null && kept.steps.length === 2, 'what the turn did not run is kept');
  check(
    kept !== null && kept.steps.every((x) => x.asked && x.tool),
    'each step carries the words that asked for it and the tool it named'
  );

  /*
   * The one that matters. Everything else here is tidiness; this is the
   * difference between a queue that finishes a sentence and a queue that
   * spends money on its own authority.
   */
  for (const bad of ['confirmed', 'draft', 'new_email']) {
    const sneak = plan.planFrom(step('mail_send', { asked: 'email Priya', [bad]: 'yes' }), ALL, idFor);
    check(sneak === null, `a step carrying \`${bad}\` is refused outright`,
      'a plan may never answer the press its own step is about to ask for');
  }
  const source = fs.readFileSync(path.join(ROOT, 'src/lib/plan.ts'), 'utf8');
  check(
    !/confirmed:\s*'yes'|confirmed:\s*"yes"/.test(source),
    'and nothing in plan.ts ever writes one'
  );

  // A read already ran inside the loop. Queueing it would do it twice.
  check(
    plan.planFrom(step('calendar_read', { asked: 'check my calendar' }), ALL, idFor) === null,
    'a pure read is never queued, having already run in the turn'
  );

  // No quote, no replay: inventing the words would be Grove putting them in
  // somebody's mouth, and those words are what the askedFor guard checks.
  check(
    plan.planFrom(step('food_order', { what: 'pizza' }), ALL, idFor) === null,
    'a step with no quote from their sentence is dropped'
  );

  const many = plan.planFrom(
    Array.from({ length: 12 }, (_, i) => ({ name: 'mac_use', args: { asked: `thing ${i}`, goal: 'x' } })),
    ALL, idFor
  );
  check(
    many !== null && many.steps.length === plan.MOST_STEPS && plan.MOST_STEPS <= 4,
    `a model having an afternoon is capped at ${plan.MOST_STEPS} steps`
  );

  const twice = plan.planFrom([
    { name: 'food_order', args: { asked: 'order dinner', what: 'dinner' } },
    { name: 'food_order', args: { asked: 'order dinner', what: 'dinner' } },
  ], ALL, idFor);
  check(twice !== null && twice.steps.length === 1, 'the same order twice is one step, not two');

  const old = { steps: [{ tool: 'mac.use', asked: 'x' }], at: 0, made: Date.now() - plan.PLAN_LIFE_MS - 1000 };
  check(plan.nextStep(old) === null, 'a plan left standing expires, like a confirmation left armed');
  check(plan.PLAN_LIFE_MS <= 10 * 60_000, 'and does not outlive the conversation it came from');

  /* The wiring, which the module cannot see. */
  const brain = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');
  const agent = fs.readFileSync(path.join(ROOT, 'src/context/agent.tsx'), 'utf8');
  check(/planFrom\(\s*\n?\s*turn\.calls\.slice\(at \+ 1\)/.test(brain),
    'the loop keeps the calls after the one it returns on');
  check(/if \(!replaying\) queue\.current = null;/.test(agent),
    'a new sentence abandons whatever was queued',
    'changing your mind must not leave four actions still coming');
  check(/if \(!replaying\) void noticeRapport/.test(agent),
    'a replayed step is not counted as evidence of how they talk',
    'otherwise the register learns from Grove reading their words back');
  check(/!awaitingYes\.current\) await carryOn/.test(agent),
    'the next step waits while a press is still owed',
    'two things armed at once is one press deciding the wrong one');
  check(/await carryOn\(outcome\.ok\)/.test(agent) && (agent.match(/carryOn\(outcome\.ok\)/g) || []).length >= 2,
    'and it carries on from both the pressed path and the unpressed one');
}

/**
 * A press always means "I want to say something".
 *
 * "Press while listening means stop" was right for as long as listening only
 * ever happened because somebody pressed. The grace window broke that without
 * editing the line: Grove is in 'listening' for three seconds after **every
 * single reply**, so a press in those three seconds — exactly when you have
 * heard the answer and want to ask the next thing — was read as stop, dropped
 * to Ready, and swallowed the question. Press again and it worked.
 *
 * That is the whole of "sometimes it takes the click and sometimes it
 * doesn't", and it is the third time the grace window has made a sentence
 * elsewhere untrue without touching it. The other two were the music and the
 * unprompted microphone.
 */
/**
 * A reaction is a reaction, not a slideshow.
 *
 * Two faults, both of the shape this file keeps finding: a rule written down
 * once and enforced in one of the places it had to hold.
 *
 *   ONE A MINUTE, IN ONE OF FIVE PLACES. The spacing lived in `reactToPhone`.
 *   A remark, a song, a finished task and any answer carrying a `gif` all
 *   reached `react()` directly with no spacing at all, so saying hello a few
 *   times produced a wall of them. It belongs to the window, which is the
 *   only thing every reaction passes through and the only thing that knows
 *   whether one is already up.
 *
 *   A ONE-WORD SEARCH IS NOT A SEARCH. The fallback ladder ended at the
 *   first word, so anything that found nothing finished by asking GIPHY for
 *   "hello" — which is the front page, not a reaction. That is where the
 *   strangers came from: not a bad choice of face, a query with nothing in
 *   it to be wrong about.
 */
/**
 * What they asked for, not what Grove is good at.
 *
 * Asked for "a number game", Grove opened chess.com and played a game
 * against the computer by itself while they watched. Two faults in one
 * sentence: a kind of thing was named and a different one was substituted
 * because that one has the most machinery behind it, and "I want to play"
 * was read as "play something".
 *
 * The first is the shape to watch for. Chess has a board reader, a drag
 * mover, a loop guard and forty minutes of patience — so every mention of a
 * game pulls towards it, and the better Grove gets at one thing the worse
 * this gets. A rule in the decision is the only place it can be answered,
 * since by the time a board is on screen the choice has been made.
 */
/**
 * You can say something while it is working.
 *
 * Watching it get a job wrong, the only things you could do were let it
 * finish or stop it — so you stopped it and said the whole thing again. The
 * notch showed no box at all while thinking or working, which is the moment
 * you can see exactly what you want and have no way to say it.
 *
 * A line typed then is a change to the run, not a new task. It is folded
 * into the run's own history, which is what the next move reads, and never
 * handed to `resume`: a run already looping would then have two, both
 * driving the same tab. Nothing is interrupted and nothing waits — the
 * current move finishes and the next is made knowing what was said.
 */
section('You can say something while it is working');
{
  const agent = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Agent.swift'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/main.swift'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Resources/panel.html'), 'utf8');

  check(/func redirect\(_ said: String\) -> String\?/.test(agent), 'a run can be redirected while it is going');
  check(
    /tasks\.values\.first\(where: \{ \$0\.live \}\)/.test(agent),
    'and only one that is actually looping is redirected',
    'one waiting on a yes belongs to resume, which the loop must not be given twice'
  );
  check(
    /task\.history\.append\(\s*\n?\s*"They just said this while you were working/.test(agent),
    'the line goes into the history the next move reads'
  );
  check(
    /task\.live = true\s*\n\s*defer \{ task\.live = false \}/.test(agent),
    'and the live flag is cleared however the run ends',
    'left set, every later line would be folded into a run that had finished'
  );
  check(
    /if Agent\.shared\.redirect\(text\) != nil \{ break \}/.test(main),
    'a typed line reaches the run before it reaches a new decision'
  );

  // And there has to be somewhere to type it.
  const job = between(panel, "if (m === 'job')", "if (m === 'done')", { min: 200, max: 2000 });
  check(job !== null, 'the working panel is where it is expected to be');
  check(
    job !== null && /id="ask-input"/.test(job) && /wireAsk\(\)/.test(job),
    'the working panel has a box you can type into',
    'without one the feature is unreachable, however well it is wired'
  );
  const thinking = between(panel, "if (m === 'thinking')", "if (m === 'rewrite' || m === 'answer')", { min: 150, max: 1500 });
  check(
    thinking !== null && /id="ask-input"/.test(thinking),
    'and so does the one shown while it is deciding'
  );
}

/**
 * A board is not a mandate.
 *
 * `if !page.chess.isEmpty { task.game = true }` read "a board, therefore a
 * game" — and a game gets forty minutes and five hundred steps instead of a
 * check-in after one. So asking for a game to be set up ended with Grove
 * playing the whole of it while they watched, which is both the most
 * annoying thing it can do and the hardest to interrupt, since the long
 * budget is exactly what stops it coming back to ask.
 */
section('A board is not a mandate to play');
{
  const agent = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Agent.swift'), 'utf8');
  check(
    /if !page\.chess\.isEmpty, !task\.handOver \{ task\.game = true \}/.test(agent),
    'a board only buys the long budget when the job was not to hand it over'
  );
  check(
    /var handOver = false/.test(agent) && /task\.handOver = goal\.range\(of:/.test(agent),
    'and that is read from the goal Grove itself wrote',
    'a phrase may decide this only because it is this app\'s own output, not somebody\'s speech'
  );
}

section('What they asked for, not what Grove is good at');
{
  const thinking = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Thinking.swift'), 'utf8');
  check(
    /NOT WHAT YOU ARE GOOD AT/.test(thinking),
    'an open request is answered with what suits them'
  );
  check(
    /a number game is not chess/.test(thinking),
    'and naming a kind of thing is not an invitation to substitute an easier one'
  );
  check(
    /"I WANT TO PLAY" MEANS THEY PLAY/.test(thinking),
    'and wanting to play means they play, not that Grove does'
  );
}

section('A reaction is a reaction, not a slideshow');
{
  const gifs = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Gifs.swift'), 'utf8');
  const popup = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Popup.swift'), 'utf8');

  check(
    /static var welcome: Bool/.test(popup) && /Date\(\)\.timeIntervalSince\(lastShown\) > apart/.test(popup),
    'the window decides when a face may appear',
    'every caller passes through it; none of them can forget the spacing'
  );
  check(
    /guard welcome else \{/.test(popup) && /lastShown = Date\(\)/.test(popup),
    'and refuses one that is too soon, or on top of one already up'
  );
  check(
    /guard await Popup\.welcome else/.test(gifs),
    'and the search is skipped when nothing could be shown',
    'a face that will not appear is not worth a round trip'
  );

  /*
   * The floor on a query. Asserted on the behaviour rather than on the
   * source, because "never one word" is the whole rule and a reader of the
   * ladder cannot tell what it bottoms out at.
   */
  const ladder = between(gifs, 'static func attempts(', '\n  private static func get(', { min: 300, max: 2600 });
  check(ladder !== null, 'the search ladder is where it is expected to be');
  check(
    ladder !== null && /count >= 2/.test(ladder),
    'no search is ever made on a single word',
    'a one-word search on a GIF site is the front page, not a reaction'
  );
  check(
    ladder !== null && !/words\.first \?\? ""/.test(ladder),
    'and the ladder no longer bottoms out at one'
  );
  check(/lang=en/.test(gifs), 'the search asks for the language it was written in');
  check(
    !/urls\.randomElement\(\)/.test(gifs) && !/urls\.prefix\(2\)\.randomElement\(\)/.test(gifs),
    'and takes the best result rather than a lucky dip through a weak query'
  );

  /*
   * And what just happened is context, never a menu. A model that has not
   * understood the sentence in front of it will take something off a bare
   * list rather than admit it — which is how a misheard phrase became
   * whatever the last task was.
   */
  const recent = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Recent.swift'), 'utf8');
  check(
    /not a list of things to do and not a pattern to copy/.test(recent),
    'what just happened says outright that it is not a list of things to do'
  );

  /*
   * And a face is rare, from one list.
   *
   * The set of moments that get one was written out twice — once in
   * `Gifs.choose`, once in `Thinking.decide` — so narrowing either would
   * have left every hello still getting a face through the other path. Two
   * copies of a rule is the fault this file exists to catch, and here it
   * would have shown up as the fix appearing not to work.
   */
  const thinking = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Thinking.swift'), 'utf8');
  check(
    /static func wants\(/.test(gifs) && /static let quiet: Set<String> = \[/.test(gifs),
    'the moments that get no face are named in one place, and the rest can have one'
  );
  check(
    /Gifs\.wants\(moment\)/.test(thinking) && /wants\(\(obj\?\["moment"\]/.test(gifs),
    'and both paths read that list rather than keeping their own',
    'two copies means changing one leaves the other deciding differently'
  );
  check(/"private"/.test(gifs.slice(gifs.indexOf('static let quiet'), gifs.indexOf('static let quiet') + 80)), 'and nothing private gets a face');
  check(
    /static func echoes\(/.test(gifs) && /return parts\.isEmpty/.test(gifs),
    'a search with nothing in it but filler is dropped, and a subject by name is not'
  );
  check(
    /Pick the single best point/.test(gifs),
    'and the rule picks the best point of the moment, which can be the subject itself'
  );
  check(
    /grove\.gifs\.shown/.test(gifs) && /!shown\.contains/.test(gifs),
    'and the same GIF is never shown twice running: the first result for the same search is the same picture'
  );

  const apart = /apart: TimeInterval = (\d+)(?:\s*\*\s*(\d+))?/.exec(popup);
  const seconds = apart ? Number(apart[1]) * (apart[2] ? Number(apart[2]) : 1) : 0;
  check(seconds >= 5, `and no two are closer than ${seconds} seconds`);
  check(
    /ask them what they mean/.test(recent),
    'and that a sentence which makes no sense is asked about, not matched to an old task'
  );
}

section('A press is never swallowed');
{
  const agent = fs.readFileSync(path.join(ROOT, 'src/context/agent.tsx'), 'utf8');

  const listening = between(agent, 'A window Grove opened itself is not a listen they started.',
    "trigger.notePress('stopped listening')", { min: 400, max: 2600 });
  check(listening !== null, 'the press-while-listening branch is where it is expected to be');
  check(
    listening !== null && /if \(quietListen\.current\) \{/.test(listening),
    'a press into a window Grove opened itself starts a listen',
    'otherwise every press in the three seconds after a reply is read as stop'
  );
  check(
    listening !== null && /beginListening\(false\)/.test(listening),
    'and starts a real one, with the chime and the full window'
  );

  /*
   * The flag has to mean what the branch assumes. It is set for a window
   * opened on spec and cleared the moment a word is heard — so a press
   * mid-sentence still settles what was said, which is what a press means
   * once you have started talking.
   */
  check(/quiet: !listenAfter/.test(agent), 'a grace window is marked as one, and a question window is not');
  check(
    /quietListen\.current = false;/.test(agent) && /onPartial/.test(agent),
    'and the mark is cleared as soon as a word arrives'
  );
}

/**
 * Nothing in a render path picks at random.
 *
 * The greeting is computed inside render, so a `Math.random()` in it would
 * change the line several times a second while somebody was reading it. It
 * reads as the app being broken, and it is invisible to every other gate.
 */
section('What is on screen holds still');
{
  const talk = fs.readFileSync(path.join(ROOT, 'src/app/(app)/index.tsx'), 'utf8');
  const hello = between(talk, 'function greeting(', '\nfunction ', { min: 300, max: 3000 });
  check(hello !== null, 'the greeting is where it is expected to be');
  check(
    hello !== null && !/Math\.random/.test(hello),
    'the greeting does not change while you are reading it',
    'it runs on every render, so a random pick flickers several times a second'
  );
  check(
    hello !== null && /h % set\.length/.test(hello),
    'and varies through the day instead'
  );

  // The Mac, in the corner rather than across the middle.
  check(/macBusy/.test(talk), 'the Talk screen shows what the Mac is still doing');
  check(
    /macBusy: string \| null;/.test(fs.readFileSync(path.join(ROOT, 'src/context/agent.tsx'), 'utf8')),
    'and the agent publishes it as its own thing, not as the phone being busy'
  );
}

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

  /*
   * And the music gets out of the way, because the session cannot.
   *
   * Mixable is not a free win. Bluetooth has two profiles: A2DP carries
   * stereo and has **no microphone**, HFP has one and is mono. A headset does
   * one or the other. So while a song plays, the glasses are in A2DP and
   * there is no input for a recogniser to open — which is what "The audio
   * input is busy" means, `inputNode.outputFormat` with a sample rate of
   * nought.
   *
   * And Grove may not take it: a mixable session has promised not to
   * interrupt anybody, and forcing the glasses off A2DP would. But it has to
   * stay mixable, because a non-mixable session **cannot be activated from
   * the background at all** (`!int`,
   * `AVAudioSessionErrorCodeCannotInterruptOthers`) and that is where every
   * ring press comes from.
   *
   * Neither option is available, so the track pauses instead. Asserted
   * because the alternative is silent: the microphone simply never opens, and
   * the only sign is a four-character code in Settings.
   */
  const agent = fs.readFileSync(path.join(ROOT, 'src/context/agent.tsx'), 'utf8');
  const opening = between(agent, 'Before the recogniser starts, because its engine', 'const started = startListening(', {
    min: 100,
    max: 2600,
  });
  check(opening !== null, 'the run-up to the recogniser is where it is expected to be');
  check(
    opening !== null && /await hushMusic\(\)/.test(opening),
    'a playing track is paused before the recogniser starts',
    'on Bluetooth glasses an A2DP route has no microphone, so the listen fails with nothing to show for it'
  );

  // Only ever a track Grove stopped. One somebody paused on purpose stays
  // paused, and resuming it would be Grove starting music nobody asked for.
  const hush = between(agent, 'const hushMusic = useCallback', 'const resumeMusic = useCallback', {
    min: 100,
    max: 800,
  });
  check(hush !== null, 'the pause is where it is expected to be');
  check(
    hush !== null && /pausedMusic\.current = true/.test(hush) && /trigger\.musicPlaying\(\)/.test(hush),
    'and only a track that was actually playing is remembered as paused'
  );
  const resume = between(agent, 'const resumeMusic = useCallback', '}, []);', { min: 100, max: 800 });
  check(
    resume !== null && /if \(!pausedMusic\.current\) return;/.test(resume),
    'so nothing Grove did not pause is ever started by it'
  );

  /*
   * And the grace window does not chop the song.
   *
   * It is a microphone opened on spec, in case there is one more sentence.
   * Opened while a track is paused mid-song it either fails for want of an
   * input or succeeds and keeps the music stopped for another three seconds —
   * so the song was interrupted for Grove to listen to silence.
   */
  const windowChoice = between(agent, 'A song Grove paused is a song', 'void beginListening(false, false,', {
    min: 100,
    max: 2500,
  });
  check(windowChoice !== null, 'the window decision is where it is expected to be');
  check(
    windowChoice !== null && /const playing = pausedMusic\.current/.test(windowChoice),
    'the window knows whether a song is waiting'
  );
  /*
   * The condition, not the variable. The first version of this check looked
   * for `pausedMusic.current` anywhere in the region and passed with the
   * value computed and then ignored — which is the whole bug wearing the
   * costume of the fix. What has to be true is that the test guarding the
   * window actually reads it.
   */
  const guard = /if \(([^)]*\([^)]*\)[^)]*|[^)]*)\) \{\s*$/m.exec(
    (windowChoice ?? '').split('\n').filter((l) => l.includes('if (')).pop() ?? ''
  );
  check(
    guard !== null && /\bplaying\b/.test(guard[1]),
    'and will not open one over a paused song',
    guard ? `the guard reads: ${guard[1]}` : 'no guard found before beginListening'
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
    max: 2200,
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
    call !== null && /contextFor\(context, \[roster, usual, friction[,\]]/.test(call),
    'and so do the roster, the rhythms and the frictions'
  );
  check(
    call !== null && /contextFor\(context, \[[^\]]*macContext\(\)/.test(call),
    'and so does what the Mac is doing, which changes every few minutes'
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
  /*
   * Two jobs, which were one number and should not have been.
   *
   * This ceiling is a sanity bound on the slice: it catches an end landmark
   * that stopped matching and handed back half the file. It is not a budget
   * — and while it was both, ordinary growth in the rules tripped it (five
   * characters over, in the end), where the only honest response is to raise
   * the number, which quietly turns a real check into a rubber stamp. So it
   * is generous now, and the budget is stated separately below where it can
   * be argued with.
   */
  const rules = between(brain, 'const TOOL_RULES = `', '`;', { min: 500, max: 40_000 });
  check(rules !== null, 'the tool rules are where they are expected to be');
  const stableChars =
    (rules?.length ?? 0) + MEMORY_RULES.length + persona.mannerDirective(persona.DEFAULT_PERSONA).length;
  check(
    stableChars / 4 > 1200,
    `the stable prefix is about ${Math.round(stableChars / 4)} tokens, over any cache minimum`
  );
  /*
   * The budget, said out loud, because this rides on every single turn.
   *
   * Cacheable at a quarter price, so it is not the dearest thing here — but
   * it has grown by half since it was measured at 3,031 tokens, a few lines
   * at a time, each justified on its own. That is how a prompt reaches
   * twelve thousand tokens without anybody deciding it should. Past this,
   * something comes out rather than the number going up.
   */
  const ruleTokens = Math.round((rules?.length ?? 0) / 4);
  check(
    ruleTokens < 6500,
    `the tool rules are about ${ruleTokens} tokens`,
    'every line is sent on every turn; past this, take something out rather than raising this'
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


/*
 * Grove can hand a job to another AI, and cannot do it by accident
 * ----------------------------------------------------------------
 *
 * `Delegates.swift`. Grove is one lite model with a calendar and a pair of
 * hands; their Chrome is signed in to things that are better at writing, code
 * and research, and they are already paying for them. So "ask Claude to write
 * the cover letter" opens Claude, types it, waits and brings back what it
 * said.
 *
 * The whole risk is in the other direction, because a false positive derails
 * a job somebody actually asked for: a delegation is a note telling the mover
 * to go to claude.ai, and getting that note in the middle of an Uber Eats
 * order is worse than never having the feature. So the match wants a verb of
 * handing over IMMEDIATELY in front of the name — looking for the verb
 * anywhere in the sentence makes "use the cursor keys to move" a hand-off to
 * an editor.
 *
 * Run rather than read, because the only thing worth asserting here is what
 * the matcher does to a sentence, and a regex read out of a file tells you
 * nothing about that. Where there is no Swift compiler the behavioural half
 * cannot run; it says so rather than passing quietly, which is the failure
 * this harness exists to not have.
 */
laterSection('A job can be handed to another AI, and never by accident', async () => {
  const delegates = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Delegates.swift'), 'utf8');
  const agent = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Agent.swift'), 'utf8');
  const thinking = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Thinking.swift'), 'utf8');

  check(
    /if let to = Delegates\.wanted\(in: goal\) \{/.test(agent),
    'a task is a delegation only when a verb of handing over sits in front of the name',
    'Delegates.named alone matches "what do you think of Claude"'
  );
  check(
    /\\\(Delegates\.rule\)/.test(thinking),
    'and the decision is told that naming an assistant is an instruction about where the work happens'
  );

  /*
   * A delegation must not become a way to spend money with one yes. It is a
   * note handed to the same mover, so the confirmations in front of a cart
   * and a checkout still apply — and nothing in the note may say otherwise.
   */
  check(
    !/confirm(ed)?\s*[:=]\s*true/i.test(delegates) && !/\bapprove\b/i.test(delegates),
    'a delegation confirms nothing: every press it reaches is still asked for',
    'the note rides into the same loop as every other task and must not carry an exemption'
  );
  check(
    /It is NOT done when your words are in the box/.test(delegates),
    'and a prompt sitting in a composer is not a finished job',
    'the mover is generous about its own work; this is the sentence that stops it'
  );
  check(
    /static func awaitWritten/.test(agent) && /task\.delegate != nil, task\.desk\.isEmpty, !task\.tab\.isEmpty/.test(agent),
    'waiting for another AI is watched for, not thought about',
    'a model call every two seconds of somebody else writing is most of the cost and none of the moves'
  );

  // The behaviour itself.
  const swiftc = cp.spawnSync('which', ['swiftc'], { encoding: 'utf8' }).status === 0;
  if (!swiftc) {
    check(false, 'the matcher itself could not be run: no swiftc on this machine',
      'the source checks above passed; what a sentence actually matches was NOT tested');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-delegates-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'mac/Sources/Grove/Delegates.swift'), path.join(dir, 'Delegates.swift'));
    // Each line: the sentence, then the delegate it must resolve to ("-" for none).
    const table = [
      ['ask claude to write a cover letter for the jane street internship', 'claude'],
      ['get chatgpt to draft the email to my landlord', 'chatgpt'],
      ['have gemini summarise that paper', 'gemini'],
      // Perplexity is off the roster — not signed into. A name Grove does
      // not have must resolve to nothing rather than to the nearest thing.
      ['run this by perplexity', '-'],
      ['ask claude code to fix the failing tests', 'claude-code'],
      ['Ask Claude to write a cover letter for the Jane Street internship', 'claude'],
      // Named, but nothing is being handed over.
      ['what do you think of claude', '-'],
      ['is gemini any good', '-'],
      ['claude is slow today', '-'],
      // The one that made adjacency the rule rather than a refinement of it.
      ['use the cursor keys to move', '-'],
      ['move the cursor to the end of the line', '-'],
      // Ordinary jobs, which must stay ordinary jobs.
      ['play wordle', '-'],
      ['order me a burrito on uber eats', '-'],
      ['Start a game of Wordle on the New York Times website and stop there', '-'],
    ];
    fs.writeFileSync(path.join(dir, 'main.swift'),
      'let table: [(String, String)] = [\n' +
      table.map(([said, want]) => `  (${JSON.stringify(said)}, ${JSON.stringify(want)}),`).join('\n') +
      '\n]\nfor (said, want) in table {\n' +
      '  let got = Delegates.wanted(in: said)?.id ?? "-"\n' +
      '  print("\\(got == want ? "ok" : "BAD")\\t\\(got)\\t\\(want)\\t\\(said)")\n}\n' +
      'if let d = Delegates.named("ask claude to write a cover letter") {\n' +
      '  print("ASKED\\t" + Delegates.asked(from: "Ask Claude to write a cover letter", to: d))\n}\n');
    const built = cp.spawnSync('swiftc', ['-O', 'Delegates.swift', 'main.swift', '-o', 'run'],
      { cwd: dir, encoding: 'utf8' });
    if (built.status !== 0) {
      check(false, 'Delegates.swift did not compile on its own', String(built.stderr).slice(0, 400));
      return;
    }
    const ran = cp.spawnSync(path.join(dir, 'run'), [], { encoding: 'utf8' });
    const lines = String(ran.stdout).trim().split('\n').filter(Boolean);
    const verdicts = lines.filter((l) => !l.startsWith('ASKED'));
    // Assert the size of what came back, not just its contents: a run that
    // printed nothing would otherwise pass every "nothing was BAD" test.
    check(
      verdicts.length === table.length,
      `all ${table.length} sentences were actually matched`,
      `got ${verdicts.length} verdicts`
    );
    const bad = verdicts.filter((l) => l.startsWith('BAD'));
    check(
      bad.length === 0,
      'every one resolves to the delegate it should, and the rest to none',
      bad.join('\n         ')
    );
    const asked = lines.find((l) => l.startsWith('ASKED')) || '';
    check(
      asked === 'ASKED\twrite a cover letter',
      'and what is handed over is the request, not the instruction to hand it over',
      `got ${JSON.stringify(asked)} — "Ask Claude to ask Claude" is what the seam exists to prevent`
    );
    /*
     * A delegate that is a program, not a page.
     *
     * Driving Claude Code by taking pictures of VS Code and clicking where
     * its panel appeared to be is how "type this into Claude" typed it into
     * the editor instead: app, click, type, click, click, and the run's own
     * parting lesson was "use keyboard shortcuts rather than guessing icon
     * locations". A CLI has an exact way in, so it gets one.
     */
    check(
      /Delegate\(id: "claude-code"[\s\S]{0,400}?command: "claude \{task\}"\)/.test(delegates),
      'Claude Code is run, not looked at'
    );
    check(
      /if !to\.command\.isEmpty \{[\s\S]{0,1400}?tell application \\"Terminal\\"/.test(agent),
      'and a delegate with a command never enters the browser loop at all'
    );
    /*
     * The escaping, run rather than read. Two parsers sit between here and
     * the program — the shell and AppleScript's own string — and skipping
     * either means a sentence with an apostrophe in it fails to run, or
     * runs as something nobody wrote.
     */
    fs.writeFileSync(path.join(dir, 'esc.swift'),
      `for nasty in [${[
        `draft Priya's email about the "big" launch`,
        'fix it; echo PWNED',
        'run $(whoami) and `date`',
        `a'b"c$d\`e;f|g&h`,
      ].map((n) => JSON.stringify(n)).join(', ')}] {\n` +
      `  print(Delegates.shell("printf '%s\\\\n' {task}", task: nasty))\n}\n`);
    fs.copyFileSync(path.join(ROOT, 'mac/Sources/Grove/Delegates.swift'), path.join(dir, 'Delegates2.swift'));
    const escDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-esc-'));
    try {
      fs.copyFileSync(path.join(dir, 'Delegates2.swift'), path.join(escDir, 'Delegates.swift'));
      fs.copyFileSync(path.join(dir, 'esc.swift'), path.join(escDir, 'main.swift'));
      const b2 = cp.spawnSync('swiftc', ['-O', 'Delegates.swift', 'main.swift', '-o', 'esc'], { cwd: escDir, encoding: 'utf8' });
      if (b2.status !== 0) {
        check(false, 'the escaping could not be compiled on its own', String(b2.stderr).slice(0, 300));
      } else {
        const cmds = String(cp.spawnSync(path.join(escDir, 'esc'), [], { encoding: 'utf8' }).stdout).trim().split('\n').filter(Boolean);
        check(cmds.length === 4, 'all four awkward sentences produced a command', `got ${cmds.length}`);
        // Run each through a real shell and compare what arrived with what went in.
        const wanted = [
          `draft Priya's email about the "big" launch`,
          'fix it; echo PWNED',
          'run $(whoami) and `date`',
          `a'b"c$d\`e;f|g&h`,
        ];
        const got = cmds.map((c) => String(cp.spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8' }).stdout).replace(/\n$/, ''));
        check(
          got.length === wanted.length && got.every((g, i) => g === wanted[i]),
          'and each arrives at the program as one argument, byte for byte',
          got.map((g, i) => `${g === wanted[i] ? 'ok ' : 'BAD'} ${JSON.stringify(g)}`).join('\n         ')
        );
        /*
         * The independent signal, because the check above compares text and
         * the text legitimately contains the word PWNED: a sentence that was
         * executed rather than passed produces a SECOND line of output. One
         * line each means one argument each, whatever it said.
         */
        const lines = cmds.map((c) => String(cp.spawnSync('/bin/sh', ['-c', c], { encoding: 'utf8' }).stdout).replace(/\n$/, '').split('\n').length);
        check(
          lines.every((n) => n === 1),
          'nothing in a sentence is ever run as a command',
          `a semicolon, a $(…) or a backtick that ran would print a second line — got ${lines.join(', ')}`
        );
      }
    } finally {
      fs.rmSync(escDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * Grove learns which apps they actually use
 * -----------------------------------------
 *
 * `Services.swift`. Nearly every request on the Mac has a fork in it that
 * Grove cannot see: "put a song on" is Spotify for one person and Apple Music
 * for another, "order dinner" is DoorDash or Uber Eats. Grove was guessing,
 * and a guess here is not a small error — it opens the wrong app, signs into
 * nothing, and comes back saying it could not find their playlist.
 *
 * The fix is not a better guess, it is asking once and never asking again.
 * One interruption in exchange for every later request going to the right
 * place, which is the trade the rest of this app makes everywhere else.
 *
 * A list of KINDS rather than a list of apps: a kind is a question somebody
 * can answer, an app is an answer looking for a question, and a file full of
 * them goes stale the week a new one appears.
 */
laterSection('Grove learns which apps they actually use', async () => {
  const services = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Services.swift'), 'utf8');
  const thinking = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Thinking.swift'), 'utf8');

  check(
    /do not guess and do not pick the one you know best/.test(services),
    'an unsettled kind is a question, not a gap to fill in',
    'a list of known services with no instruction beside it gets read as background'
  );
  check(
    /Services\.block/.test(thinking) && /Services\.note\("\\\(uses\["for"\] \?\? ""\)", "\\\(uses\["is"\] \?\? ""\)"\)/.test(thinking),
    'the decision is told what is known and records what settles it'
  );
  /*
   * Playing something new happens in the app they use; the "music" kind is
   * Apple Music and nothing else. The rule says so and the model mostly
   * follows it, but a vague "put a song on" came back as "music" with the
   * word Spotify in the search text — Apple Music hunting its library for a
   * song called "put a song on Spotify". So code decides.
   */
  check(
    /if action == "play", !service\.isEmpty, !service\.lowercased\(\)\.contains\("apple"\) \{/.test(thinking),
    'and playing something new goes to the app they use, decided in code',
    'the model got "put on some Mac DeMarco" right and a vague "put a song on" wrong'
  );
  check(
    /Steering is left\s*\n?\s*alone|Steering is left alone/.test(thinking),
    'while pause, skip and louder are left alone',
    'those work on whatever is making sound, and Player already handles Spotify'
  );

  const swiftc = cp.spawnSync('which', ['swiftc'], { encoding: 'utf8' }).status === 0;
  if (!swiftc) {
    check(false, 'the kind matching could not be run: no swiftc on this machine',
      'the source checks above passed; what a kind actually matches was NOT tested');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-services-'));
  try {
    // The real `match`, lifted with its table, because the model writes the
    // kind in its own words and throwing away the answer to a question Grove
    // itself asked is the worst possible place to be strict.
    const body = between(services, 'private static func match(_ kind: String) -> String? {', '\n  }\n', { min: 100, max: 700 });
    const table = between(services, 'private static let also: [String: [String]] = [', '\n  ]\n', { min: 200, max: 1200 });
    check(body !== null && table !== null, 'the matcher and its table are where they are expected to be');
    if (body === null || table === null) return;
    const cases = [
      ['music', 'music'], ['songs', 'music'], ['playlist', 'music'],
      ['film', 'film'], ['movies', 'film'], ['streaming', 'film'],
      ['food', 'food'], ['takeout', 'food'], ['delivery', 'food'],
      ['shopping', 'shopping'], ['rides', 'rides'], ['messages', 'messages'],
      ['food delivery', 'food'], ['my music', 'music'],
      // 'weather' contains 'eat': containment filed it under food.
      ['weather', '-'], ['', '-'], ['something else entirely', '-'], ['heated', '-'],
    ];
    fs.writeFileSync(path.join(dir, 'main.swift'), `import Foundation
enum Services {
${table}
  ]
${body}
  }
}
let cases: [(String, String)] = [
${cases.map(([k, w]) => `  (${JSON.stringify(k)}, ${JSON.stringify(w)}),`).join('\n')}
]
for (k, want) in cases {
  let got = Services.match(k) ?? "-"
  print("\\(got == want ? "ok" : "BAD")\\t\\(k)\\t\\(got)")
}
`.replace('private static func match', 'static func match').replace('private static let also', 'static let also'));
    const built = cp.spawnSync('swiftc', ['-O', 'main.swift', '-o', 'run'], { cwd: dir, encoding: 'utf8' });
    if (built.status !== 0) {
      check(false, 'the matcher did not compile on its own', String(built.stderr).slice(0, 400));
      return;
    }
    const lines = String(cp.spawnSync(path.join(dir, 'run'), [], { encoding: 'utf8' }).stdout).trim().split('\n').filter(Boolean);
    check(lines.length === cases.length, `all ${cases.length} words were actually matched`, `got ${lines.length}`);
    const bad = lines.filter((l) => l.startsWith('BAD'));
    check(
      bad.length === 0,
      'a kind written in the model\'s own words still finds its slot, and nothing else does',
      bad.join('\n         ')
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * Grove hands over what it should not be doing itself
 * ---------------------------------------------------
 *
 * It runs on a lite model with a calendar and a pair of hands. It cannot
 * make a picture and it cannot make a video, and a thousand words of code or
 * a real piece of research out of it is the worst answer in the app, because
 * it looks exactly like a good one. Their browser is signed in to things
 * that do each of those properly and they are already paying for them.
 *
 * So the list is not a menu of sites, it is a list of jobs this model should
 * not be doing — and it reaches for them unasked, which is the half that
 * makes the feature worth having.
 */
section('Grove hands over what it should not be doing itself');
{
  const delegates = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Delegates.swift'), 'utf8');
  const agent = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Agent.swift'), 'utf8');
  /*
   * Was "reach for one when the job is beyond you", which the model
   * generalised from code and images to curiosity and sent "teach me
   * something interesting" to ChatGPT. Narrowed to a deliverable, which is
   * a thing it can actually tell, and the wording changed with it.
   */
  check(
    /REACHING FOR ONE YOURSELF IS RARE, and only ever for A THING TO BE MADE/.test(delegates),
    'the decision hands over unasked only for something to be made'
  );
  check(
    /you cannot make an image or a video at all/i.test(delegates),
    'and told plainly what it cannot do, rather than left to judge its own range'
  );
  // The menu is built from the list, so a delegate added later is offered.
  check(
    /let menu = all\.map \{ "\\\(\$0\.name\) — \\\(\$0\.good\)" \}/.test(delegates),
    'what each one is for comes from the list itself',
    'a hand-written menu is one a new delegate is missing from'
  );
  for (const [id, what] of [['higgsfield', 'video'], ['gemini', 'images'], ['claude-code', 'a codebase']]) {
    check(
      new RegExp(`Delegate\\(id: "${id}"`).test(delegates),
      `there is somewhere to send ${what}`
    );
  }
  check(
    /never as a disclaimer about what you cannot do/.test(delegates),
    'and it says who it asked in passing, not as an apology for its own limits'
  );

  /*
   * The roster is what they are actually signed into. A delegate they do not
   * have is worse than no delegate: the job goes somewhere, gets a sign-in
   * wall, and comes back as a failure that reads like Grove being broken.
   */
  const ids = [...delegates.matchAll(/Delegate\(id: "([^"]+)"/g)].map((m) => m[1]);
  check(
    ids.length === 6 && ['chatgpt', 'gemini', 'higgsfield', 'claude', 'claude-code', 'vscode'].every((i) => ids.includes(i)),
    'the roster is the six they are signed into',
    `found ${ids.join(', ')}`
  );
  check(
    !['perplexity', 'grok', 'copilot', 'cursor', 'suno'].some((i) => ids.includes(i)),
    'and nothing they do not have',
    'a job sent to a sign-in wall comes back as a failure that reads like Grove being broken'
  );
  check(
    /ChatGPT IS THE DEFAULT/.test(delegates) && /CLAUDE IS A LAST RESORT/.test(delegates),
    'ChatGPT is the default and Claude is the last resort'
  );
  check(
    /important is not the same as heavy/.test(delegates),
    'with the mistake to avoid named, since that is the one a model makes',
    'reaching for Claude because a job feels important rather than because it is heavy'
  );
  check(
    /IF YOU ARE NOT SURE WHICH, ASK/.test(delegates),
    'and an unsure pick is a question rather than a guess',
    'cheaper than sending a long job to the wrong one'
  );

  /*
   * A prompt is the whole of what the other one will do, so it is read back
   * and pressed for before it goes. Both halves: the page ones through the
   * ordinary confirm, and the CLI one — the heaviest thing Grove can start,
   * running inside their own files — through `send`.
   */
  check(
    /BEFORE YOU SEND IT, ASK THEM/.test(delegates),
    'a prompt going to another AI is read back before it is sent'
  );
  check(
    /task\.send = \{[\s\S]{0,400}?tell application \\"Terminal\\"/.test(agent) &&
      /return AgentResult\(state: "confirm", spoken: "Handing this to/.test(agent),
    'and so is the one that runs a command on their Mac',
    'it is cheaper to fix a word now than to read a thousand of the wrong thing'
  );
}

/*
 * The lite model has no thinking to configure, and says so with a 400
 * ------------------------------------------------------------------
 *
 * `gemini-flash-lite-latest` does not ignore `thinkingConfig`; it refuses the
 * whole request, INVALID_ARGUMENT, before reading a word of it. The browser
 * agent sent it `{"thinkingBudget": 0}` on the fallback leg — which exists
 * for when the better model is slow or down, so it could only ever be reached
 * on the one day it mattered, and it always failed there. On screen that was
 * "I couldn't work out the next step on your Mac", and in the log it was no
 * move from either model, which reads like the network rather than like a
 * field we sent ourselves.
 *
 * A dead fallback is the worst kind of dead code: it type-checks, it is never
 * reached on a good day, and it is missing on the bad one.
 */
section('Nothing asks the lite model to think');
{
  const agent = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Agent.swift'), 'utf8');
  check(
    /if model\.contains\("lite"\) == false \{ config\["thinkingConfig"\]/.test(agent),
    'the move call sends thinkingConfig only to a model that has it',
    'the lite leg is the fallback, so it fails exactly when it is needed'
  );
  // Every other place that names thinkingConfig must be on a model that takes it.
  const lines = agent.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('thinkingConfig'));
  check(lines.length === 2, 'and there are exactly two places that mention it at all', `found ${lines.length}`);
  const loose = lines.filter(([, l]) => !l.includes('lite') && !l.includes('maxOutputTokens'));
  check(
    loose.length === 0,
    'with none of them unguarded',
    loose.map(([n, l]) => `${n}: ${l.trim().slice(0, 90)}`).join('\n         ')
  );
}

/*
 * A panel is as tall as what is in it
 * -----------------------------------
 *
 * Every state here sets a height, and a height set by hand is a guess about
 * content that has since changed. The two states that grew a text box last
 * were raised by hand to make room for it and then kept the raised number
 * when the box turned out to be shorter than the guess — a third of the card
 * was empty glass under the typing box, which reads as the panel having
 * failed to draw rather than as a panel with nothing more to say.
 *
 * `fit(max)` is the fix and it is the one already used by the answer states:
 * the hand-set number stops being the height and becomes the ceiling.
 */
section('A panel is as tall as what is in it');
{
  const panel = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Resources/panel.html'), 'utf8');
  check(
    /const fit = \(max\) => \{/.test(panel) && /last\.offsetTop \+ last\.offsetHeight/.test(panel) && /new ResizeObserver\(/.test(panel),
    'the height is measured from the last thing in the card, up to the mode\'s ceiling, and again whenever the card changes size'
  );
  /*
   * Every state that carries a typing box must fit.
   *
   * Each region runs from its own `if (m === ...)` to the next one, through
   * `between`, so a landmark that stops matching fails rather than handing
   * back most of the file — and the ceiling on the size is what catches a
   * region that has swallowed the state after it, which is the way this
   * check would otherwise pass while testing somebody else's card.
   */
  const states = [
    ['thinking', "if (m === 'thinking')", "if (m === 'rewrite' || m === 'answer')"],
    ['answer', "if (m === 'rewrite' || m === 'answer')", "if (m === 'job')"],
    ['job', "if (m === 'job')", "if (m === 'done')"],
  ];
  for (const [mode, from, to] of states) {
    const region = between(panel, from, to, { min: 200, max: 2200 });
    check(region !== null, `the ${mode} card is where it is expected to be`);
    check(
      region !== null && /\bfit\(/.test(region),
      `the ${mode} card fits its content rather than standing at a fixed height`,
      'a hand-set height is a guess about content that has since changed'
    );
  }
}


/*
 * Grove listens when it is the one waiting — and never in front of a yes
 * ---------------------------------------------------------------------
 *
 * A question on screen with a microphone already open is the difference
 * between talking to something and operating it, and not having to touch
 * anything is the whole reason the ring and the glasses exist. So when Grove
 * asks, the microphone opens with the question.
 *
 * **Except in front of a confirmation**, and that exception is the whole
 * reason this section exists. Every other prompt's worst answer is a wrong
 * sentence; a confirmation's worst answer is a purchase. A yes stays two
 * deliberate keys (⌘K then Return) or a press on the card — the rule the
 * rest of this app is built on, and not one a convenience gets to soften.
 *
 * It is the easy thing to break, too: "in any capacity" is how the feature
 * was asked for, the confirm card is a card like the others, and a later
 * tidy-up that treated them all the same would read as consistency.
 */
/*
 * The microphone opens by itself on ⌘K, and nowhere else
 * ------------------------------------------------------
 *
 * This has been wrong in both directions, and the second was worse than the
 * first. It began opening only when Grove had asked something, which left
 * somebody opening the notch to find the microphone off. Then it opened on
 * every card with a box — an answer, a question, every step of a job — and
 * that is a microphone that is on most of the time. The worst of it was the
 * Mac listening alongside the phone: two recognisers on one room, each
 * hearing the other's half of a sentence.
 *
 * ⌘K is the one moment that cannot be anything else. Somebody pressed a key
 * meaning to talk, and nobody opens a panel by accident with a keyboard
 * shortcut. Everywhere else the button is still there, and pressing it is a
 * decision rather than a guess about one.
 */
section('The microphone opens by itself on ⌘K, and nowhere else');
{
  const main = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/main.swift'), 'utf8');
  const notch = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Notch.swift'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Resources/panel.html'), 'utf8');

  check(
    /var wantsMic: \(\(String, \[String: Any\]\) -> Bool\)\?/.test(notch) &&
      /if payload\["mic"\] == nil, wantsMic\?\(mode, data\) == true \{ payload\["mic"\] = true \}/.test(notch),
    'one rule decides it, where every card is drawn'
  );
  const rule = between(main, 'private func openMicOn(_ mode: String, _ data: [String: Any]) -> Bool {', '\n  }\n', { min: 300, max: 2200 });
  check(rule !== null, 'the rule is where it is expected to be');
  check(
    rule !== null && /guard \(data\["summoned"\] as\? Bool\) == true/.test(rule),
    'nothing opens the microphone by itself except a summon',
    'an answer, a question and every step of a job is a microphone on most of the time'
  );
  /*
   * Marked by the summon rather than inferred from "an idle card that
   * happens to be pinned". That is true of ⌘K today and stops being true
   * the moment somebody pins an idle card for another reason — and the
   * failure would be a microphone opening with no explanation.
   */
  check(
    /private func summon\(\)[\s\S]{0,600}?notch\.show\("idle", \["summoned": true\], pin: true\)/.test(main),
    'and the summon says so itself rather than being guessed at from the card'
  );
  check(
    rule !== null && !/mode == "answer"|mode == "job"|mode == "thinking"|contains\(mode\)/.test(rule),
    'no card opens it by being a particular kind of card',
    'that is the version that had the Mac listening alongside the phone'
  );
  check(
    rule !== null && /!voice\.busy/.test(rule),
    'not over a microphone already open, which would be torn down mid-sentence'
  );
  check(
    rule !== null && /!\(MainActor\.assumeIsolated \{ Speaker\.shared\.isReading \}\), !Player\.soundPlaying\(\)/.test(rule),
    'nor over a film, a song, or Grove reading aloud',
    'the microphone would transcribe it and send it back as a change of plan'
  );
  /*
   * Exactly one card is ever marked summoned, and it is the ⌘K one.
   *
   * Stated as a count rather than as "a confirmation is not summoned",
   * which was the first version and missed the mutation that proved it:
   * it looked for `"confirm": true` while the real line reads `"confirm":
   * result.state == "confirm"`. Counting cannot be dodged by how a
   * neighbouring field happens to be spelled, and it covers every card at
   * once — including the one that costs money to get wrong.
   */
  const marks = main.split('"summoned": true').length - 1;
  check(
    marks === 1,
    'exactly one card is ever marked as summoned',
    `found ${marks}; a second one is a microphone opening somewhere nobody pressed ⌘K`
  );
  const summonBody = between(main, 'private func summon() {', '\n  }\n', { min: 80, max: 900 });
  check(
    summonBody !== null && summonBody.includes('"summoned": true'),
    'and it is the summon, so no confirmation, answer or job can ever carry it'
  );

  /*
   * The button stays everywhere, because "press to talk" has to be possible
   * on a card that no longer listens on its own — and it is a one-off now,
   * not the switch. Turning off a thing that is already off is not what
   * somebody reaching for a microphone wants.
   */
  for (const [mode, from, to] of [
    ['idle', "if (m === 'idle')", "if (m === 'listening')"],
    ['thinking', "if (m === 'thinking')", "if (m === 'rewrite' || m === 'answer')"],
    ['answer', "if (m === 'rewrite' || m === 'answer')", "if (m === 'job')"],
    ['job', "if (m === 'job')", "if (m === 'done')"],
    ['waiting', "if (m === 'waiting')", "if (m === 'pair')"],
  ]) {
    const region = between(panel, from, to, { min: 200, max: 2200 });
    check(region !== null, `the ${mode} card is where it is expected to be`);
    check(
      region !== null && /id="mic"/.test(region),
      `the ${mode} card still has a microphone to press`,
      'a card that cannot listen on its own must at least be able to be asked'
    );
  }
  const press = between(main, 'case "mic":', 'case "stop":', { min: 200, max: 1200 });
  check(press !== null, 'what the button does is where it is expected to be');
  check(
    press !== null && !/AppDelegate\.listensItself = /.test(press),
    'and pressing it listens now rather than rewriting the setting',
    'the setting governs ⌘K; the button governs this moment'
  );
  check(
    /const on = !b\.classList\.contains\('on'\);[\s\S]{0,120}?post\(\{ t: 'mic', on \}\)/.test(panel),
    'it is still a toggle, so a press that started it can stop it'
  );
  check(
    /static var listensItself: Bool/.test(main) && /grove\.listen\.auto/.test(main),
    'and the setting is still there to switch the ⌘K half off'
  );
  check(
    /const micOn = \(\) => \{ if \(S\.data && S\.data\.mic\)/.test(panel),
    'the panel draws the microphone as on rather than switching it on',
    'a card re-renders on every step, phone and remark; starting it there would start it each time'
  );
}

/*
 * ⌘K opens Grove, except where it would be missed
 * -----------------------------------------------
 *
 * The rule used to be "only when something is highlighted", which is a good
 * rule for not taking somebody's shortcut and a bad one for being summoned:
 * the point of a key is that it works when you have nothing in particular to
 * say, and with nothing selected the way to reach Grove was to find the notch
 * with a mouse.
 *
 * The old reasoning was not wrong, it was incomplete — it measured the cost
 * of taking ⌘K and never the cost of having no key at all. The cost is not
 * the same in every app, so neither is the answer: a short editable list of
 * apps whose own ⌘K is worth more (a chord prefix, a terminal's clear, a
 * quick switcher), and everywhere else the press opens Grove.
 *
 * Matched on a word's beginning, never inside one. Plain containment was the
 * first version and was wrong both ways at once: "Code" — which is what VS
 * Code calls itself — is inside **Xcode**, so a list meant to protect one
 * editor's chords took the key from another by accident; and a strict word
 * match would have missed "iTerm2".
 */
laterSection('⌘K opens Grove, except where it would be missed', async () => {
  const shortcut = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Shortcut.swift'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/main.swift'), 'utf8');

  check(
    /var onSummon: \(\(\) -> Void\)\?/.test(shortcut) && /shortcut\.onSummon = \{ \[weak self\] in self\?\.summon\(\) \}/.test(main),
    'a press with nothing highlighted reaches Grove'
  );
  const none = between(shortcut, 'case .none:', 'case .unknown(let app):', { min: 80, max: 600 });
  check(none !== null, 'the nothing-highlighted branch is where it is expected to be');
  check(
    none !== null && /if Shortcut\.sharesK\(with: front, option: useOption\) \{ return Unmanaged\.passUnretained\(event\) \}/.test(none),
    'and goes to the app instead only when that app is on the list'
  );
  // An app that will not say whether anything is selected must get the same
  // answer as one that said "nothing" — otherwise ⌘K does nothing in Chrome.
  check(
    /else if mine \{ self\?\.onSummon\(\) \}|else if mine \{ self\?\.onSummon\?\(\) \}/.test(shortcut),
    'an app that will not say whether text is selected is answered the same way',
    'Chrome and Electron apps do not say; silence there is the press doing nothing'
  );
  check(
    /guard !option/.test(shortcut),
    '⌥⌘K is never shared with anything, which is what choosing it means'
  );
  // It marks the card as summoned; the one microphone rule listens on that
  // and on nothing else. Two places deciding the same thing is how they
  // come to disagree.
  check(
    /private func summon\(\)[\s\S]{0,600}?notch\.show\("idle", \["summoned": true\], pin: true\)/.test(main),
    'and summoning Grove is the one thing that opens the microphone with it',
    'a shortcut that opens a box to type in has saved a mouse and nothing else'
  );

  const swiftc = cp.spawnSync('which', ['swiftc'], { encoding: 'utf8' }).status === 0;
  if (!swiftc) {
    check(false, 'the app matching itself could not be run: no swiftc on this machine',
      'the source checks above passed; which apps keep ⌘K was NOT tested');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grove-shortcut-'));
  try {
    // The real function, lifted out with its list, so what is tested is what ships.
    const body = between(shortcut, 'static func sharesK(with app: String?, option: Bool) -> Bool {', '\n  }\n', { min: 200, max: 1800 });
    const list = shortcut.match(/static let sharedByDefault = \[([^\]]*)\]/);
    check(body !== null && list !== null, 'the matcher and its default list are where they are expected to be');
    if (body === null || list === null) return;
    const apps = [
      ['Code', true], ['Visual Studio Code', true], ['Visual Studio Code - Insiders', true],
      ['Cursor', true], ['Xcode', true], ['Terminal', true], ['iTerm2', true], ['Slack', true],
      ['Finder', false], ['Google Chrome', false], ['Safari', false], ['Notes', false],
      ['Mail', false], ['Notion', false], ['Messages', false], ['Music', false], ['Preview', false],
    ];
    fs.writeFileSync(path.join(dir, 'main.swift'), `import Foundation
enum Shortcut {
  nonisolated(unsafe) static var shared = [${list[1]}]
  ${body}
  }
}
let apps: [(String, Bool)] = [
${apps.map(([a, k]) => `  (${JSON.stringify(a)}, ${k}),`).join('\n')}
]
for (app, keeps) in apps {
  let got = Shortcut.sharesK(with: app, option: false)
  print("\\(got == keeps ? "ok" : "BAD")\\t\\(app)\\t\\(got ? "keeps" : "Grove")")
}
print("OPTION\\t\\(Shortcut.sharesK(with: "Code", option: true))")
// The rule, not the list. Xcode is on the default list, so its ⌘K survives
// either way and the list cannot tell a word match from a substring one.
// With only "Code" listed, catching Xcode is the bug and nothing else.
Shortcut.shared = ["Code"]
print("INSIDE\\t\\(Shortcut.sharesK(with: "Xcode", option: false))\\t\\(Shortcut.sharesK(with: "Visual Studio Code", option: false))\\t\\(Shortcut.sharesK(with: "Code", option: false))")
Shortcut.shared = ["iTerm"]
print("PREFIX\\t\\(Shortcut.sharesK(with: "iTerm2", option: false))")
`);
    const built = cp.spawnSync('swiftc', ['-O', 'main.swift', '-o', 'run'], { cwd: dir, encoding: 'utf8' });
    if (built.status !== 0) {
      check(false, 'the matcher did not compile on its own', String(built.stderr).slice(0, 400));
      return;
    }
    const lines = String(cp.spawnSync(path.join(dir, 'run'), [], { encoding: 'utf8' }).stdout).trim().split('\n').filter(Boolean);
    const verdicts = lines.filter((l) => !/^(OPTION|INSIDE|PREFIX)\t/.test(l));
    check(verdicts.length === apps.length, `all ${apps.length} apps were actually matched`, `got ${verdicts.length}`);
    const bad = verdicts.filter((l) => l.startsWith('BAD'));
    check(bad.length === 0, 'each app either keeps ⌘K or hands it to Grove, as intended', bad.join('\n         '));
    check(
      lines.includes('INSIDE\tfalse\ttrue\ttrue'),
      'a listed name matches a word\'s beginning, never inside one',
      'with only "Code" listed, Xcode must keep nothing: it is a different editor, caught by spelling'
    );
    check(
      lines.includes('PREFIX\ttrue'),
      'and still catches iTerm2, which is one word and obviously iTerm',
      'a strict word match would be the opposite mistake'
    );
    check(
      verdicts.some((l) => l.includes('Xcode') && l.endsWith('keeps')),
      'Xcode keeps its clear-console because somebody put it on the list'
    );
    check(
      lines.includes('OPTION\tfalse'),
      '⌥⌘K is shared with nothing, even an app on the list'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


/*
 * A script that was not ready is asked again
 * ------------------------------------------
 *
 * Every AppleScript in this app — Music, Chrome, Messages, Notes, the agent's
 * whole browser — goes through `Script.run`, and it was one-shot. Some of its
 * failures mean "ask again" rather than "no": a scripting connection goes
 * stale when an app is relaunched or is still coming up, and the answer is
 * -609 "Connection is invalid", -600 "Application isn't running", or a
 * timeout. All of them work on the next attempt.
 *
 * Which is why the symptom was never a failure anybody saw. It was being told
 * to pause the music and having to say it again, with nothing on screen
 * either time to say why. Measured in a real log: a -609 on Music at
 * 12:57:35, and fourteen seconds later the person typing "can you initialize
 * my music please".
 *
 * Retried the way every network call here already is, including the
 * exclusions — never a permission, never a syntax error — because a second
 * attempt at those only doubles the wait before the same honest answer.
 */
section('A script that was not ready is asked again');
{
  const script = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Script.swift'), 'utf8');
  const list = script.match(/static let worthAnotherGo: Set<Int> = \[([^\]]*)\]/);
  check(list !== null, 'the retryable errors are named in one place');
  const codes = list === null ? [] : list[1].split(',').map((n) => Number(n.trim()));
  check(
    [-600, -609, -1712].every((n) => codes.includes(n)),
    'a stale connection, an app not up yet and a timeout are all tried once more',
    `got ${codes.join(', ')}`
  );
  check(
    !codes.includes(-1743),
    'and "not authorized" is not, because the second attempt fails identically',
    'the same rule as never retrying a 401 — it only doubles the wait before the same answer'
  );
  check(
    !codes.includes(-2741) && !codes.includes(-2740) && !codes.includes(-1728),
    'nor a syntax error or a missing object, which are answers rather than bad timing'
  );
  // Once more, not until it works: a retry that can retry is a loop against
  // an app that is genuinely gone.
  check(
    /attempt\(source, again: true, done: done\)/.test(script) &&
      /attempt\(source, again: false, done: done\)/.test(script),
    'exactly one more go, never a loop'
  );
  const retry = between(script, 'if again, worthAnotherGo.contains(number) {', 'Log.say("script: failed', { min: 120, max: 700 });
  check(retry !== null, 'the retry is where it is expected to be');
  check(
    retry !== null && /asyncAfter\(deadline: \.now\(\) \+ 0\.4\)/.test(retry),
    'after long enough for a launching app to finish, short enough that nobody notices'
  );
  // Everything that drives an app goes through this one door.
  const agent = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Agent.swift'), 'utf8');
  check(
    /Script\.run\(bounded\)/.test(agent),
    'and Browser.run goes through it, so Chrome, Player and Messages are covered by the same fix'
  );
}

/*
 * "Play" after a pause means carry on
 * -----------------------------------
 *
 * `play` arrived with nothing named, and what it meant depended on something
 * the model could not see: whether anything was paused. If something was,
 * this went to the library and started SHUFFLING it. Pause your song, say
 * "play", get your whole library on random — and the second nudge was naming
 * the song again.
 *
 * The model will not fix this and should not be asked to: **"play" is the
 * word.** Measured against the live model with the song and its paused state
 * in front of it, "play", "play it", "keep playing" and "start it again" all
 * come back as `play`, because that is what the word means in English. A rule
 * telling a model to call a thing by a name nobody uses is a rule that gets
 * quietly ignored. So code decides, which is the rule this app is built on.
 *
 * Two places, because two different things know the answer. `Player` knows
 * when Grove did the pausing, and knows it for a video in Chrome or Spotify
 * as readily as for Music. Music itself knows when something else did it — a
 * keyboard key, or a launch ago — and is the only one that can say so.
 */
section('"Play" after a pause means carry on, not shuffle');
{
  const jobs = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Jobs.swift'), 'utf8');
  const player = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Player.swift'), 'utf8');

  check(
    /case "music\.play": MainActor\.assumeIsolated \{ Music\.start\(/.test(jobs),
    'a play job goes through the step that decides what "play" meant'
  );
  const start = between(jobs, '  static func start(_ what: String, playlistOnly: Bool = false', '  static func play(_ what: String', { min: 150, max: 900 });
  check(start !== null, 'that step is where it is expected to be');
  check(
    start !== null && /if what\.isEmpty, !playlistOnly, Player\.hasPaused \{/.test(start),
    'nothing named and something paused: carry on with it, wherever it is playing'
  );
  check(
    /static var hasPaused: Bool \{ paused != nil \}/.test(player),
    'and Player says so, since it is the only thing that knows about Chrome and Spotify'
  );

  // The half Player cannot answer: paused by a keyboard key, or before Grove
  // was last launched.
  const empty = between(jobs, 'tell application "Music"\n        -- Paused, and they said', 'set shuffle enabled to true', { min: 200, max: 900 });
  check(empty !== null, 'the nothing-named script is where it is expected to be');
  check(
    empty !== null && /if player state is paused then\s*\n\s*play\b/.test(empty),
    'a bare "play" asks Music whether it is paused before it shuffles anything',
    'this is the one that turned a paused song into the whole library on random'
  );
  check(
    /"play" is the\s+word/.test(jobs),
    'and why this is code and not a rule in a prompt is written down where it was decided'
  );

  // "Play it" and "start it again" come back naming the loaded song.
  const named = between(jobs, 'set wanted to "\\(q)"', 'set found to missing value', { min: 200, max: 1100 });
  check(named !== null, 'the named script is where it is expected to be');
  check(
    named !== null && /here contains wanted or wanted contains here/.test(named),
    'naming the song already loaded resumes it rather than finding it again',
    'a library search restarts it from the beginning, which is not what "play it" asked for'
  );
  check(
    named !== null && /\\\(playlistOnly \? "" : """/.test(named),
    'and a request for a playlist never takes that shortcut',
    'a paused track whose name happens to match would answer for the playlist'
  );
}


/*
 * Grove works beside them, not on top of them
 * -------------------------------------------
 *
 * A run used to open its tab in whatever Chrome window was in front — theirs,
 * with their tabs in it — and in Chrome a new tab becomes the active one. So
 * starting a job took over what they were reading, and every later step
 * scrolled and clicked inside the window they were trying to use. Then the
 * first real click left Chrome in front for the rest of the task, so the next
 * forty steps, which needed nothing, looked exactly like Grove hogging the
 * machine.
 *
 * Three things, each a different half of "get out of the way":
 *
 * - **Its own window.** Their tabs are never touched and their scroll
 *   positions survive. A tab they chose is still theirs: the model may take
 *   one with `tab` when the job belongs there, which is a different thing
 *   from Grove helping itself to the front window.
 * - **The screen is borrowed and given back.** Most of a run needs nothing in
 *   front; only the fallbacks do — a page that ignores a scripted click, a
 *   canvas, a picture. Those take the screen for as long as they need it.
 * - **And they wait for a gap.** Taking the keyboard out from under somebody
 *   mid-sentence puts their words in Grove's window, and the cost is not a
 *   lost keystroke, it is having to find what it broke.
 */
section('Grove works beside them, not on top of them');
{
  const agent = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Agent.swift'), 'utf8');

  check(
    /nonisolated\(unsafe\) static var ownWindow = ""/.test(agent) &&
      /if made is missing value then set made to \(make new window\)/.test(agent),
    'a run that needs a fresh tab gets one in Grove\'s own window',
    'a new tab in their window becomes their active tab'
  );
  check(
    /falling back to a tab in theirs/.test(agent),
    'and falls back to a tab in one of theirs only when its own window cannot be read',
    'a profile with JavaScript from Apple Events off makes Grove\'s window useless'
  );

  /*
   * The one that would be silently undone: every real click, key and picture
   * must go through `borrow`, because that is the only thing that waits and
   * the only thing that gives the screen back. A bare `front()` next to a
   * real click is the old behaviour, and it reads as perfectly normal code.
   */
  // borrow's own call is the one legitimate one, so it is cut out before
  // looking — rather than excused by a line number, which moves.
  const borrowBody = between(agent, 'static func borrow<T>(_ body: () async -> T) async -> T {', '\n  /** Brings the task', { min: 400, max: 2600 });
  check(borrowBody !== null, 'borrow is where it is expected to be before the sweep');
  const elsewhere = borrowBody === null ? agent : agent.replace(borrowBody, '');
  const bare = elsewhere
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, l]) => /\bawait (Browser\.)?front\(\)/.test(l));
  check(
    bare.length === 0,
    'nothing takes the screen except through borrow',
    bare.map(([n, l]) => `${n}: ${l.trim()}`).join('\n         ')
  );
  check(
    /static func waitForAGap\(\) async \{[\s\S]{0,400}?while handsIdle\(\) < 1\.5, Date\(\)\.timeIntervalSince\(waited\) < 10/.test(agent),
    'the screen is taken only after their hands have been still, and never waits for ever',
    'somebody typing without a pause for ten seconds is working; a task that waits for ever has failed quietly'
  );
  const borrow = between(agent, 'static func borrow<T>(_ body: () async -> T) async -> T {', '  /** Brings the task\'s own tab to the front', { min: 400, max: 2600 });
  check(borrow !== null, 'borrow is where it is expected to be');
  check(
    borrow !== null && /set frontmost of \(first application process whose unix id is/.test(borrow),
    'and gives the focus back through System Events, which actually works',
    'NSRunningApplication.activate() from an app that is not in front does nothing and reports success'
  );
  check(
    borrow !== null && !/was\.activate\(\)/.test(borrow),
    'never through the AppKit call that looks right and is not'
  );

  /*
   * The subtle one, and the reason this was measured rather than reasoned
   * about: kCGAnyInputEventType counts synthetic events. Seventy-two seconds
   * of genuine stillness, one key posted by Grove, and it read 0.6.
   */
  const idle = between(agent, 'static func handsIdle() -> Double {', '\n  }\n', { min: 150, max: 900 });
  check(idle !== null, 'the idle reading is where it is expected to be');
  check(
    idle !== null && /abs\(lastEventAt\.timeIntervalSince\(lastPosted\)\) < 0\.4/.test(idle),
    'an event Grove posted itself does not count as their hands being busy',
    'otherwise the only thing resetting the gap is Grove\'s own last click, and it waits for itself'
  );
  check(
    /lastPosted = Date\(\)/.test(borrow || ''),
    'and borrow records every real thing Grove does, since they all pass through it'
  );
}


/*
 * A lookup comes back with the answer
 * -----------------------------------
 *
 * "Search up a recipe for chicken pot pie." Grove went to Google, opened a
 * recipe, pressed Jump to Recipe — all correct — and then scrolled three
 * times and said nothing, until twenty-five seconds later they pressed Stop.
 * From the outside that is an assistant that did nothing. It had the
 * ingredients on screen and no instruction to hand them over.
 *
 * The rule that should have covered it named the wrong things: "for looking
 * things up (jobs, reviews, prices)". A recipe is not a job, a review or a
 * price, so the model did what the rest of the brief says — act on a page —
 * and a page is not an answer to somebody who asked for a recipe.
 *
 * Two halves. The mover is told the answer itself comes back, written out
 * far enough to use. And the card that shows it stops behaving like a
 * receipt: everything here closed itself within ten seconds, which is right
 * for "Playing Interstellar" and wrong for the ingredients list they are
 * halfway through reading.
 */
section('A lookup comes back with the answer, not a page');
{
  const agent = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Agent.swift'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/main.swift'), 'utf8');

  check(
    /LOOKING SOMETHING UP ENDS WITH THE ANSWER, NOT WITH A PAGE/.test(agent),
    'the mover is told that finding something ends with the thing, not with a page'
  );
  check(
    /A recipe means its ingredients and its steps, written out/.test(agent),
    'and what "in full enough to use" means, by example rather than by adjective'
  );
  check(
    /"I found a recipe", "it's on your screen" and a link are not answers/.test(agent),
    'with the three non-answers named, since each one reads like a reply'
  );
  check(
    /Do not keep scrolling to admire it/.test(agent),
    'and scrolling past the answer is called out, which is what it actually did'
  );

  // The card. A receipt goes; an answer stays.
  const card = between(main, '          A receipt goes; an answer stays.', 'Recent.ended(', { min: 300, max: 1600 });
  check(card !== null, 'the done card is where it is expected to be');
  check(
    card !== null && /let answer = result\.spoken\.count > 280/.test(card) &&
      /closeAfter: answer \? nil : read/.test(card),
    'something long enough to be an answer stays on screen instead of closing itself',
    'length separates the two: a line Grove wrote about what it did is short, a thing it went and found is not'
  );
  check(
    card !== null && /thenHome: !answer/.test(card),
    'and does not bounce back to the ask box out from under them'
  );

  /*
   * And the card shows it as words. Told not to use markdown the model
   * writes it anyway, reliably, on exactly the long answers this card now
   * keeps on screen — so "**Ingredients:**" was about to be the first line
   * of every recipe. The same fix the phone has had since plainSpeech.
   */
  const panel = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Resources/panel.html'), 'utf8');
  check(
    /const plain = \(t\) =>/.test(panel) && /replace\(\/\\\*\\\*\(\.\+\?\)\\\*\\\*\/g, '\$1'\)/.test(panel),
    'the card strips the markdown the model writes whatever it is told'
  );
  for (const [card, from, to] of [['done', "if (m === 'done')", "if (m === 'waiting')"], ['answer', "if (m === 'rewrite' || m === 'answer')", "if (m === 'job')"]]) {
    const region = between(panel, from, to, { min: 200, max: 2200 });
    check(
      region !== null && /esc\(plain\(d\.text\)\)/.test(region),
      `the ${card} card puts its text through it`,
      'this card shows text as it is, so an asterisk is an asterisk'
    );
  }

  // Stopping is not a reason to throw away what it had.
  const stopped = between(main, 'case "stopped":', 'default:', { min: 150, max: 900 });
  check(stopped !== null, 'the stopped branch is where it is expected to be');
  check(
    stopped !== null && /notch\.show\("done", \["title": "Stopped"/.test(stopped),
    'and stopping still says where it had got to',
    'it was halfway down a recipe when they gave up on it, and said nothing'
  );
}


/*
 * A list is a list, not a shop
 * ----------------------------
 *
 * "Add toothpaste to my shopping list" is the commonest thing anybody says to
 * an assistant, and it had nowhere to go: every reminder landed in the default
 * list, nothing took a list name, and the model — finding no tool that fitted
 * — reached for the shopping tool, **which opens Amazon to buy toothpaste.**
 * Measured, against the real declarations: `shop_order`. It takes a press, so
 * nothing was bought silently, but the right answer is a line in a list.
 *
 * And Grove could write to their lists and never read one, so "what's on my
 * shopping list" and "what am I running low on" had nothing either. The same
 * shape as the gap `openReminders` was written to close for "what am I
 * supposed to be doing": a store written to and never read knows less than
 * the last few minutes of conversation.
 */
section('A list is a list, not a shop');
{
  const abilitiesSrc = fs.readFileSync(path.join(ROOT, 'src/lib/abilities.ts'), 'utf8');
  const device = fs.readFileSync(path.join(ROOT, 'src/lib/deviceCalendar.ts'), 'utf8');
  const brain = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');

  const add = ALL.find((a) => a.id === 'reminders.add');
  const read = ALL.find((a) => a.id === 'reminders.read');
  check(!!add && !!read, 'there is a way into a list and a way back out of it');
  check(!!add && !!add.args.list, 'adding takes the list they named');
  check(!!read && !!read.args.list, 'and reading takes it too');
  check(!!read && read.reads === true, 'reading a list is a read, so a question can reach it');
  check(!!add && add.reads !== true, 'and adding to one is not, so a question can never write');

  /*
   * The two halves must agree. A thing added to "shopping" and then not
   * found by "my shopping list" is worse than no list support at all: it is
   * there, they are told it is there, and it cannot be found.
   */
  // A literal count, not a regex: what matters is that the same line of code
  // appears on both sides, and spelling that line as a pattern is how a
  // check comes to pass against something slightly different.
  const strip = String.raw`(wanted || '').toLowerCase().replace(/\b(my|the|list)\b/g, '').trim()`;
  const both = device.split(strip).length - 1;
  check(
    both === 2,
    'adding and reading strip the same words off a list name',
    `found ${both}; they must agree or a thing added to "shopping" is not found by "my shopping list"`
  );
  check(
    device.includes('falls back to the usual list rather than refusing'),
    'a name that matches nothing still saves it somewhere',
    'a reminder in the wrong list is recoverable; a lost one is not'
  );
  check(
    device.includes('reads everything rather than'),
    'and reading an unknown list name is too wide rather than empty',
    'they can see which list each line came from'
  );

  // The rule, which is what stopped it reaching for a shop.
  check(
    /A LIST IS NOT AN ORDER\./.test(brain),
    'and the rules say outright that writing it down is not buying it'
  );
  check(
    /never the shopping or food tool, which open a shop to buy the thing/.test(brain),
    'naming the tools it must not reach for, since those are the ones it reached for'
  );
}

/*
 * Two things Grove cannot do, said rather than faked
 * --------------------------------------------------
 *
 * Both were measured against the real declarations and both came back as a
 * confident wrong answer, which is the failure this app cares about most.
 *
 * "Set my alarm for 7:30" quietly became a reminder. iOS does not let any app
 * but Apple's own set an alarm — the same class of platform limit as not
 * being able to receive a key press in the background. A reminder in place of
 * an alarm does not wake anybody, and they find that out at eight.
 *
 * "How much did I spend eating out last week" became a WEB SEARCH. There is
 * no bank, no card and no receipts in this app, and searching the internet
 * cannot find out what one person spent. Of all the ways to be wrong, that
 * one produces an answer that looks researched.
 */
section('Two things Grove cannot do, said rather than faked');
{
  const brain = fs.readFileSync(path.join(ROOT, 'src/lib/brain.ts'), 'utf8');
  check(
    /YOU CANNOT SET AN ALARM\./.test(brain),
    'an alarm is refused rather than substituted'
  );
  check(
    /A reminder set quietly in place of an alarm is the worst answer here/.test(brain),
    'and the substitution is named, since that is what it did',
    'it does not wake anybody, and they find that out at eight'
  );
  check(
    /YOU DO NOT KNOW WHAT THEY SPEND\./.test(brain),
    'spending is said to be unknown rather than searched for'
  );
  check(
    /searching the internet cannot find out what one person spent/.test(brain),
    'with the reason, because the wrong answer here looks researched'
  );
  // There is no spending ability to reach, so the rule is the whole of it.
  check(
    !ALL.some((a) => /spend|budget|bank|transaction/i.test(a.id + ' ' + a.name)),
    'and there is genuinely no such tool to call'
  );
}


/*
 * A voice downloaded is a voice heard
 * -----------------------------------
 *
 * Siri's voice is not available to any third-party app, at any price, with
 * any entitlement, and a neural TTS API was measured rather than assumed:
 * Gemini's own, on the key this app already has, took **2.6 seconds before a
 * single sound** for a short sentence and 3.7 for a longer one — mostly fixed
 * overhead, because the whole clip is generated before anything plays. For
 * something you talk to hands-free through glasses, that silence is a worse
 * problem than the timbre. So the system synthesiser stays, driven properly.
 *
 * Which makes the downloaded Enhanced or Premium voice the whole of the
 * quality difference — and the one instruction this app gives about it was
 * quietly broken. The voice list was read once and kept for the life of the
 * app, so somebody who followed the notice, downloaded a voice and came back
 * got the same synthetic voice and no explanation. The obvious conclusion is
 * that it did not work, or that Grove was lying about the cause.
 */
section('A voice downloaded is a voice heard');
{
  const speak = fs.readFileSync(path.join(ROOT, 'src/lib/speak.ts'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'src/app/(app)/settings.tsx'), 'utf8');

  check(
    /if \(cached && cached\.some\(isGood\)\) return cached;/.test(speak),
    'the voice list is kept only once it holds a voice worth keeping',
    'cached while the best available is compact, a download never takes effect'
  );
  check(
    /export function forgetVoices\(\): void \{\s*\n\s*cached = null;\s*\n\s*best = undefined;/.test(speak),
    'and can be forgotten outright'
  );
  check(
    /forgetVoices\(\);/.test(settings),
    'which the screen that told them to download one does on opening',
    'it is the only place that knows they may have just done it'
  );
  check(
    /if \(next\.some\(isGood\) \|\| !cached\) best = undefined;/.test(speak),
    'a newly found voice also clears which one is best',
    'otherwise the list updates and the voice actually used does not'
  );

  /*
   * One test for "good", used by the picker and by the notice. They asked
   * different questions before: the notice looked only at Enhanced, so
   * somebody with a Premium voice installed was told they had none — and
   * Premium is exactly the tier that stops sounding synthetic.
   */
  const good = (speak.match(/\bisGood\b/g) || []).length;
  check(
    good >= 4 && /function isGood\(voice: Speech\.Voice\): boolean/.test(speak),
    'the notice and the picker ask the same question about a voice',
    `found ${good} mentions of isGood; one definition and three callers is the minimum`
  );
  check(
    /\/premium\/i\.test\(voice\.identifier \|\| ''\)/.test(speak),
    'and that question looks at the identifier, not only the quality field',
    'expo-speech predates Premium and reports it as Enhanced, so the name is the only way to tell'
  );
  check(
    !/return voices\.some\(\(v\) => v\.quality === Speech\.VoiceQuality\.Enhanced\);/.test(speak),
    'and neither of them asks about Enhanced alone'
  );

  // Quality has to dominate, or a nicely-named compact voice wins.
  const scoreFn = between(speak, 'function scoreVoice(voice: Speech.Voice): number {', '\n}\n', { min: 300, max: 1800 });
  check(scoreFn !== null, 'the scoring is where it is expected to be');
  const enhanced = Number((scoreFn || '').match(/Enhanced\) score \+= (\d+)/)?.[1] ?? 0);
  const named = Number((scoreFn || '').match(/score \+= (\d+) - rank/)?.[1] ?? 99);
  const accent = Number((scoreFn || '').match(/en-gb'\)\) score \+= (\d+)/)?.[1] ?? 99);
  check(
    enhanced > named + accent,
    'an enhanced voice beats the best-named compact one of any accent',
    `enhanced ${enhanced} must exceed name ${named} + accent ${accent}, or quality stops deciding`
  );
}


/*
 * Stop stops, and Grove does not type into itself
 * -----------------------------------------------
 *
 * Both of these are from one run, in one log, and both are the kind of thing
 * that makes somebody stop trusting an app rather than merely be annoyed by
 * it.
 *
 *     01:23:07  agent: stop
 *     01:23:14  agent: waited 10.2s for a gap before taking the screen
 *
 * **A stopped run carried on and typed.** The loop checks whether it is still
 * the current run at the top of each step and after each model call — but a
 * step can be most of a minute long, and one of them now waits up to ten
 * seconds for a gap in their typing before taking the screen. Stop arrived
 * during that wait; the wait finished, took the screen, and typed. Seven
 * seconds after being told not to, which from outside is Grove ignoring them.
 *
 * **And it typed into its own ask box.** Real keys go wherever the system is
 * pointing, and Grove's notch panel takes focus while it is open, so "type
 * this into ChatGPT" went into Grove's own box in front of them.
 *
 * Guarded at the primitives rather than at the call sites: that is the layer
 * where the harm happens, and a path somebody adds later gets it for free.
 */
section('Stop stops, and Grove does not type into itself');
{
  const agent = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Agent.swift'), 'utf8');

  const may = between(agent, 'static func mayAct(_ what: String) -> Bool {', '\n  }\n', { min: 150, max: 900 });
  check(may !== null, 'the guard is where it is expected to be');
  check(
    may !== null && /if !acting \{/.test(may),
    'a stopped run may not touch the mouse or the keyboard'
  );
  check(
    may !== null && /front\?\.bundleIdentifier == Bundle\.main\.bundleIdentifier/.test(may),
    'and Grove refuses to type when Grove is the window in front',
    'real keys go wherever the system is pointing, and the notch panel takes focus'
  );

  // Every primitive that reaches the real mouse or keyboard asks first.
  for (const sig of [
    'static func pressReal(_ text: String, enter: Bool) async {',
    'private static func realPresses(_ list: [(key: String, code: Int, mac: Int?, char: String?)]) async {',
    'static func realScroll() async {',
    'private static func realDrag(from a: CGPoint, to b: CGPoint) async {',
    'static func realClick(_ p: CGPoint) async {',
    'static func realType(_ text: String) async {',
  ]) {
    const at = agent.indexOf(sig);
    const name = sig.match(/func (\w+)/)[1];
    check(
      at >= 0 && /guard mayAct\("/.test(agent.slice(at, at + sig.length + 90)),
      `${name} asks before it acts`,
      'this is the layer where the harm happens'
    );
  }
  // Counted too, so a seventh primitive added without a guard is visible.
  const posts = (agent.match(/\.post\(tap: \.cghidEventTap\)/g) || []).length;
  const guards = (agent.match(/guard mayAct\("/g) || []).length;
  check(
    guards >= 6,
    `every real-input primitive is guarded (${guards} guards, ${posts} places that post an event)`,
    'a new one without a guard is a stop that does not stop'
  );

  check(
    /Browser\.acting = false/.test(agent) && /Browser\.acting = true/.test(agent),
    'stop clears it and a new run sets it, so no means no until they ask again'
  );
  const gap = between(agent, 'static func waitForAGap() async {', '\n  }\n', { min: 150, max: 900 });
  check(
    gap !== null && /if !acting \{ Log\.say\("agent: stopped while waiting for a gap"\); return \}/.test(gap),
    'and the wait itself gives up rather than finishing and acting',
    'ten seconds is long enough for somebody to press stop twice'
  );
}

/*
 * A question is Grove's own
 * -------------------------
 *
 * "Teach me something interesting" was sent to ChatGPT. That is the most
 * irritating thing this feature can do with itself: they asked Grove, they
 * are standing in front of it, and handing the question over reads as not
 * wanting to talk to them.
 *
 * The rule said to reach for a delegate "when the job is beyond you", which
 * the model generalised from code and images to curiosity. So it is now
 * restricted to **a thing to be made** — an artefact at the end of it — with
 * the negatives named, which is what actually works here, and a tie broken
 * towards the question.
 *
 * And only the ones on the roster: told merely to pick the best one, it
 * invented **Midjourney**, which they have no account on, and a sign-up wall
 * is a dead end wearing the costume of an answer.
 */
section('A question is Grove\'s own');
{
  const delegates = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Delegates.swift'), 'utf8');
  check(
    /NEVER FOR A QUESTION, AND NEVER FOR CONVERSATION\./.test(delegates),
    'a question is never handed to another assistant'
  );
  check(
    /they asked you, they are standing in front of you/.test(delegates),
    'with the reason, which is about them rather than about capability'
  );
  check(
    /only ever for A THING TO BE MADE/.test(delegates),
    'and handing over needs an artefact at the end of it'
  );
  check(
    /it is a question\./.test(delegates),
    'an unsure call goes to the question, not to the hand-off'
  );
  check(
    /Do not NAME one of them either/.test(delegates),
    'and they are not mentioned in a reply unless one is actually being sent a job',
    '"you could ask ChatGPT" is not an answer, it is a shrug'
  );
  check(
    /not Midjourney, not DALL-E/.test(delegates),
    'inventing a delegate they have no account on is ruled out by name',
    'told only to pick the best one, it reached for Midjourney'
  );
}


/*
 * Pause what they named
 * ---------------------
 *
 * "Pause YouTube" paused Apple Music. The decision had the word and the job
 * dropped it: `args` carried `what` only for play, so every other action
 * arrived with nothing to aim at and `Player` fell back to asking Music
 * first. Being given a different thing from the one you asked for is worse
 * than being told nothing is playing — they now have to work out what
 * happened and undo it.
 *
 * Three layers had to agree: the brief has to put the named thing in `text`,
 * the job has to carry it, and the player has to prefer it over whatever
 * happens to be making sound. Each was a one-line omission on its own.
 */
section('Pause what they named');
{
  const player = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Player.swift'), 'utf8');
  const jobs = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Jobs.swift'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/main.swift'), 'utf8');
  const thinking = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Thinking.swift'), 'utf8');

  check(
    /IF THEY NAMED WHAT TO STOP, PUT IT IN TEXT exactly as they said it/.test(thinking),
    'the decision puts the thing they named where it can be read',
    'the brief used to say steering never needs to know which app, so it never said'
  );
  check(
    /args: \["what": what, "say": say\]/.test(main),
    'and the job carries it for every action, not only play',
    'this one line is where the word "YouTube" used to stop'
  );
  // All four transport jobs, or the one that was missed is the one it breaks on.
  const carried = (jobs.match(/Player\.transport\("[a-z ]+", what: job\.args\["what"\] \?\? ""/g) || []).length;
  check(
    carried === 4,
    'all four of pause, resume, next and back carry it',
    `found ${carried}; a missed one is a command that silently aims at the wrong player`
  );
  const named = between(player, 'private static func named(_ what: String) -> Source? {', '\n  }\n', { min: 200, max: 1200 });
  check(named !== null, 'the player reads it, where it is expected to');
  check(
    named !== null && /if let source = named\(what\) \{ return await only\(source, command\) \}/.test(player),
    'and what they named wins over what happens to be playing'
  );
  /*
   * "Music" is not a player, it is a word. Somebody on Spotify who says
   * "pause the music" means Spotify, not the Apple Music that is installed
   * on every Mac whether they use it or not.
   */
  check(
    named !== null && /Services\.use\("music"\)/.test(named),
    '"the music" means whichever player they actually use',
    'Apple Music is on every Mac; that is not a reason to aim at it'
  );
}

/*
 * A done is one sentence
 * ----------------------
 *
 * The card after a job was running to two and three sentences describing
 * what is on their screen — which they are looking at. "One or two
 * sentences" reads as permission to use two, and a model given permission
 * uses it every time.
 *
 * The exception stays, and it is the opposite case: when the answer IS the
 * thing they asked for, it is as long as the answer needs.
 */
section('A done is one sentence');
{
  const agent = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Agent.swift'), 'utf8');
  check(
    /ONE SHORT SENTENCE for something you did/.test(agent),
    'a job done is said in one short sentence'
  );
  check(
    /They can see it; you are not describing it to someone on the phone/.test(agent),
    'with the reason, which is that they are looking at the thing'
  );
  check(
    /never a recap of the steps, never "let me know if you need anything else"/.test(agent),
    'and the two fillers that pad a receipt are named'
  );
  check(
    /The exception is when the answer IS the thing they asked for/.test(agent),
    'while a lookup is still as long as its answer needs',
    'that is the half fixed the other way round, and it must not be undone here'
  );
}


/*
 * ⌘V works, and the colour goes both ways
 * ---------------------------------------
 *
 * Grove has no Dock icon and no menu bar of its own, and nothing ever set
 * `NSApp.mainMenu` — which is where the key equivalents for Cut, Copy, Paste
 * and Select All live. So ⌘V was not bound to anything, in any text field in
 * the app: the notch's ask box, and every link field in the Grove window.
 * Typing a URL out by hand is the opposite of what that window is for.
 *
 * And the colour had only ever travelled one way, phone to Mac, because the
 * phone is where Settings lives. But the Mac is where somebody sits with a
 * keyboard, and the field is the one thing both ends share — a pair that
 * disagree about it look like two different apps.
 */
section('⌘V works, and the colour goes both ways');
{
  const main = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/main.swift'), 'utf8');
  const home = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Home.swift'), 'utf8');
  const link = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Link.swift'), 'utf8');
  const page = fs.readFileSync(path.join(ROOT, 'mac/Sources/Grove/Resources/home.html'), 'utf8');
  const macts = fs.readFileSync(path.join(ROOT, 'src/lib/mac.ts'), 'utf8');

  const menu = between(main, 'private func installEditMenu() {', '\n  }\n', { min: 300, max: 1600 });
  check(menu !== null, 'the Edit menu is where it is expected to be');
  check(
    menu !== null && /NSApp\.mainMenu = main/.test(menu),
    'the app has a main menu, which is where ⌘V is bound',
    'without one the shortcut is not attached to anything, in any field'
  );
  for (const key of ['"x"', '"c"', '"v"', '"a"']) {
    check(menu !== null && menu.includes(key), `${key} is bound`);
  }
  check(
    /installEditMenu\(\)/.test(main) && main.indexOf('installEditMenu()') < main.indexOf('private func installEditMenu'),
    'and it is installed at launch rather than defined and forgotten'
  );

  /*
   * The same four colours in three places, which cannot be helped — one is
   * Swift, one is a web page and one is the phone — so they are checked
   * against each other rather than trusted.
   */
  const phone = fs.readFileSync(path.join(ROOT, 'src/components/field-shader.ts'), 'utf8');
  // The captured name, not the whole match: the three spell the line
  // differently and stripping punctuation left "keytide" beside "tide".
  const keys = (src, re) => [...src.matchAll(re)].map((m) => m[1]);
  const onPhone = keys(phone, /key: '(tide|ember|moss|aurora)'/g);
  const onMac = keys(home, /\("(tide|ember|moss|aurora)",/g);
  const onPage = keys(page, /key: '(tide|ember|moss|aurora)'/g);
  check(
    onPhone.length === 4 && onMac.join() === onPhone.join() && onPage.join() === onPhone.join(),
    'the Mac, its settings page and the phone offer the same colours in the same order',
    `phone ${onPhone.join()} / mac ${onMac.join()} / page ${onPage.join()}`
  );
  // And the actual hex, since a matching list of names with different colours
  // is the version of this bug nobody would notice until they saw both.
  const hex = (src) => (src.match(/#[0-9A-F]{6}/g) || []).filter((h) => phone.includes(h));
  check(
    hex(home).length >= 16 && hex(page).length >= 16,
    'with the same stops, not just the same names',
    `mac ${hex(home).length}, page ${hex(page).length} of the phone's hex values found`
  );

  check(
    /func colour\(_ key: String\) \{[\s\S]{0,200}?deliver\(\["t": "colour", "key": key\]\)/.test(link),
    'the Mac can tell the phone which one was picked'
  );
  check(
    /home\.onColour = \{[\s\S]{0,600}?self\.notch\.setLook\(self\.look\)[\s\S]{0,300}?self\.link\.colour\(key\)/.test(main),
    'and paints everything here before it tells the phone',
    'otherwise it recolours when the phone answers, and not at all when it is away'
  );
  check(
    /m\.t === 'colour' && typeof m\.key === 'string'/.test(macts) && /savePersona\(\{ \.\.\.persona, sky: key \}\)/.test(macts),
    'the phone keeps it'
  );
  check(
    /sentLook = null;/.test(macts),
    'and does not then skip sending it back as "nothing changed"',
    'the phone\'s copy really did change; the Mac needs it confirmed rather than assumed'
  );

  // The paste button, for the one field nobody types into.
  check(
    /data-paste="\$\{i\}"/.test(page) && /navigator\.clipboard\.readText\(\)/.test(page),
    'a link row has a button that pastes, not only a shortcut',
    'a link is copied from a browser; the gesture people reach for is a button they can see'
  );
}

/* ------------------------------------------------------------- verdict */

/*
 * The async sections run here, before the count is read. A `process.exit` in
 * synchronous code at the bottom of this file would run before any of them.
 */
(async () => {
  for (const run of deferred) {
    try {
      await run();
    } catch (error) {
      check(false, 'an async section threw', String((error && error.stack) || error));
    }
  }

  console.log(
    `\n${failures === 0 ? 'All' : `${checks - failures}/${checks}`} checks passed` +
      (failures ? ` — ${failures} FAILING` : '')
  );
  process.exit(failures === 0 ? 0 : 1);
})();
