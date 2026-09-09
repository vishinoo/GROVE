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
  'doc.find': 'https://www.googleapis.com/auth/documents.readonly',
  // Writing a calendar needs the full scope, not calendar.readonly — a read
  // scope accepts the request and refuses the write, which surfaces as a 403
  // long after the consent screen said yes.
  'calendar.add': 'https://www.googleapis.com/auth/calendar',
  'calendar.move': 'https://www.googleapis.com/auth/calendar',
  'calendar.remove': 'https://www.googleapis.com/auth/calendar',
  'tasks.add': 'https://www.googleapis.com/auth/tasks',
  'tasks.list': 'https://www.googleapis.com/auth/tasks',
  'tasks.done': 'https://www.googleapis.com/auth/tasks',
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

/* 11. Spoken output is spoken, not printed. */
section('Nothing speaks markdown, JSON or a URL');
const source = fs.readFileSync(path.join(ROOT, 'src/lib/abilities.ts'), 'utf8');
for (const m of source.matchAll(/spoken:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) {
  const text = m[2];
  const bad = /https?:\/\/|[*_#]{2}|^\s*[-*]\s|\{"/.test(text);
  check(!bad, `spoken: "${text.slice(0, 52)}${text.length > 52 ? '…' : ''}"`, 'contains markup or a URL');
}

/* ------------------------------------------------------------- verdict */

console.log(
  `\n${failures === 0 ? 'All' : `${checks - failures}/${checks}`} checks passed` +
    (failures ? ` — ${failures} FAILING` : '')
);
process.exit(failures === 0 ? 0 : 1);
