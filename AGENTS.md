# Grove

A companion app for a pair of Bluetooth AI glasses and a ring. One agent, spoken
to hands-free, that runs on the phone and reaches Google, the calendar, music
and the web directly. Noctus is optional.

## Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before
writing any code.

## Expo Go is no longer supported. This is a development-build project.

Until 2026-09-04 this project was pinned to **SDK 54** specifically so that the
App Store build of Expo Go (54.0.2) could open it, and the pin carried an
escape clause: *unless the project moves to a development build*.

That clause has been triggered. Grove needs native code Expo Go does not carry:

- `expo-speech-recognition` — the ear.
- `modules/grove-remote` — a local Swift module that holds the audio session
  and receives the ring's media keys. **Nothing off the shelf does this job**:
  `react-native-track-player` is the usual answer and it does not support the
  New Architecture, which SDK 54 enables by default.
- `UIBackgroundModes: ["audio"]`, which only exists in a real binary.

So: **`npx expo start` in Expo Go will run, but Grove will be in reduced mode**
— no listening, no ring. That is deliberate and is worth preserving (see
below). Real work needs `eas build --profile development --platform ios`.

### Stay on SDK 54 anyway, for now

The reason for the pin is gone, but the reason to sit still is not: the
dependency tree is aligned and `npx expo install --check` is clean. Bump the SDK
as its own change, never alongside feature work.

`npx expo install --check` must report "Dependencies are up to date" before any
commit that touches dependencies.

## The reduced-mode invariant

Every native dependency is probed at runtime in `src/lib/capabilities.ts` and
imported with a lazy `require` inside a `try`/`catch` — never a static `import`.
A static import is hoisted and evaluated before anything else runs, so on a
build without the native half it takes the entire bundle down before the first
screen renders.

The payoff is that the app remains developable, and every route remains
bundlable, without a device build. **Do not "clean this up" into static
imports.** If you add a native dependency, add it to the probe.

## The iOS constraint that shapes the product

An iOS app **cannot** receive hardware key presses in the background, and
**cannot** be woken from a terminated state by one. There is no API and no
entitlement. Do not go looking for one, and do not promise it in copy.

What works instead: Grove holds an active audio session and publishes
now-playing info, which makes it the system's now-playing app, which means iOS
delivers remote transport commands to it — including from a cheap BLE ring that
pairs as a media remote. That works backgrounded, locked and pocketed. It does
not work force-quit.

The session is kept alive by rendering silence. **This is the most likely cause
of an App Store rejection in the whole project.** It is fine for personal builds
and TestFlight. If Grove is ever submitted, that is the thing to argue for or
replace.

## The glasses are not special

Cheap "AI glasses" are ordinary Bluetooth headsets. iOS routes microphone and
speaker to them once paired, so there is **no Bluetooth code in this app and
there should not be**. `src/lib/speak.ts` speaks into whatever route is current;
the native module reports what that route is so the UI can say "your glasses are
connected".

The one thing worth checking is A2DP versus HFP: a pair connected for playback
only will play Grove's voice into your ear while the *phone* listens. That is
surfaced as "playback only" on the Talk screen rather than left to be discovered.

## Grove is standalone. Noctus is optional.

Noctus was reduced to plumbing, then removed from the critical path entirely.
It is now an integration layer you may point at, and Grove works with
`EXPO_PUBLIC_NOCTUS_URL` blank — which is the default.

**What made the difference is the OAuth client type.** A *web* client can only
redirect to an `https://` address, so the phone's consent screen had to come
home to a public server; against a laptop backend that address is
`http://localhost:4000`, which resolves *on the phone* to nothing. Signing in
from a device could not work, at any point, whatever was registered. An *iOS*
client has no secret to protect, so it needs nowhere to hide one: it proves
itself with PKCE and redirects back through a custom URI scheme. No server, no
public address, nothing to keep deployed.

So:

- `src/lib/googleAuth.ts` — PKCE consent, tokens in the Keychain, refresh.
- `src/lib/google.ts` — Gmail, Calendar, Docs, Contacts, called directly.
- `src/lib/lightModel.ts` — Ollama, then the device's own key, then a backend
  if one is configured. **The order matters**: while the server came first,
  every turn paid its timeout before falling through.
- Identity — with no backend there is no account. `localIdentity()` mints a uid
  into the Keychain, because uid keys memory, sparks and the transcript, and an
  unstable one forgets you every launch.

The redirect scheme **is** the client id with its dotted parts reversed. It is
not a free choice, `grove://` is rejected, and it must match in two places:
`app.config.js` (Info.plist) and `googleAuth.ts` (the redirect). Both derive it
from `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`; never hardcode it. A mismatch fails
after consent, which is the most confusing place a sign-in can break.

What a backend would still buy you: one shared model key instead of one per
device, and sparks that run with the phone in a drawer. Neither is needed for a
single user, and iOS cannot wake a terminated app anyway, so `catchUp()` runs
due sparks when Grove is next opened.

## Where the rules live

- `src/lib/brain.ts` and `src/lib/tools.ts` — how an ordinary turn works. The
  model is given every ability as a typed function and chooses what to call,
  several at once if the sentence asks for several things. **The model proposes;
  code decides what happens.** Abilities marked `reads` run inside the loop and
  the model answers from what they returned. Anything else is handed back to
  the turn unrun, and anything irreversible returns `needsConfirming` and stops
  short until the person presses.

  This replaced a keyword gate (`detectActIntent` / `detectLookupIntent`), a
  parser for `ABILITY:` markers in the model's prose, and a growing set of
  regexes recovering arguments the model had dropped. Each fix covered one
  phrasing; the inconsistency was the design, not a bug in it. The rule that
  gate existed for — *a misheard sentence must never send, book, buy or delete
  anything* — is now enforced by the confirmation in code, and the harness
  proves the model cannot supply a confirmation itself: `confirmed` is never
  declared to it and is stripped if it appears anyway.

  When adding an ability: leave `reads` unset unless running it truly only
  reads, and give anything irreversible a `needsConfirming` branch. Put the full
  data in `detail`. `spoken` is shortened for an ear; the model answers from
  `detail`, and handing it the shortened line is how "what's my first thing
  tomorrow" was answered from two events out of four.
- `src/lib/grove.ts` — standing jobs only now: schedules and phrase triggers,
  which save a spark rather than doing something this turn. The keyword gates
  still live here for that path and for the harness.
- `src/lib/sparks.ts` — `parseSchedule` decides whether something keeps
  happening. Same rule, same reason: a false positive here wakes you at seven
  every morning for something you asked once. Its clock parser is written for
  speech, not for a form — people say "half four", not "16:30".
- `src/lib/persona.ts` — the manner is user-authored and goes into a system
  prompt, so `mannerDirective` wraps it to quarantine it as style-only. It is a
  guard, not a guarantee; keep the framing when editing.
- `src/lib/lightModel.ts` — every model call, and the only file that knows a
  provider. The Gemini key is a bundled `EXPO_PUBLIC_*` value: accepted for a
  personal build on a prepaid key, and to be moved behind a server before a
  build reaches anyone else. Everything outside this file is provider-agnostic,
  so that move is one file.
- `src/lib/modes.ts` — a mode is a manner, a set of allowed abilities, and how
  freely Grove may speak first. Commute has no mail on purpose: a message read
  aloud at a junction is worse than no mail at all.
- `src/lib/memory.ts` — facts carry a subject, so "what was I supposed to ask
  Sarah about" is answerable. Capped at 40 and sent whole; there is no retrieval
  step because at this size sending everything is cheaper than fetching some.
  Goals (`kind: 'goal'`) are capped separately and never compete with facts for
  room: one oldest-first cap meant an intention set months ago was always
  evicted before a passing note about lunch, and recency is the wrong measure
  for a goal. They also carry their own heading in the prompt, so the model can
  tell "wants to run a half marathon" from "ran a half marathon". Memory is read
  and edited on the Sparks screen rather than in Settings — a spark is a
  standing instruction and a fact is standing context.

## Documents, and why a scope change needs a reconnect

`doc.create` writes a new Google Doc and never touches one you already have.
`doc.append` adds to an existing one and takes a confirmation, because that
changes work you wrote. The assignment case — "I have an assignment due on
here, can you do it for me" — is the model calling `doc.find` first and passing
what it read as `source`, so the writing answers the real question.

Writing is the one job here that is not written for an ear: `lightDocument`
runs with a 3000-token budget, search behind it when the subject is out in the
world, and a 75-second deadline, and its ability is marked `slow` so
`runAbility` gives it ninety seconds instead of twenty. `gemini-flash-latest`
was tried for this and hangs on our key — several minutes, then a timeout — so
documents use the same lite model as everything else, which writes 500 to 750
grounded words in under ten seconds.

**Research reports are three steps, not one.** Asked for "a couple of energy
stocks", a single call names companies from memory and writes figures that were
true a year ago. So `doc.create` with `research` plans the subjects
(`lightPlan`), researches each against the web in parallel (`lightResearch`),
then writes from those dated notes (`lightDocument`). Measured at about twelve
seconds for a thousand-word, three-company report — plan 1s, research 5s,
writing 5s. Anything touching money says it is research rather than advice, and
never names a price target or an amount to spend.

The model writes two structure markers, `## ` for a heading and `- ` for a
bullet, and `google.layout()` turns them into real Docs styles on the ranges
where those lines landed. Styling is a second batchUpdate: if it fails, the
words are still in the document.

Written documents are recorded in `docs.ts` with their links, and `doc.recent`
reads them back. Without it, "send that report to Priya" had nothing to send —
writing is not a read, so it runs outside the tool loop and the model never saw
the link.

Harness note: `withTimeout` deliberately leaves its timer armed after success
(it bounds the body read too), so a Node test script lingers up to 75 seconds
after its last model call. That is the test process, not the app — time the
ability, not the process.

**A token keeps the scopes it was granted, forever.** Adding a scope to
`SCOPES` does nothing for anyone already signed in: the refresh token silently
keeps working for everything it already covered and refuses the new thing. That
is how "it still won't send emails" survived a release that added sending.

So the grant is now recorded rather than assumed. `store()` keeps the `scope`
string Google returns, `missingScopes(job)` compares it against `SCOPE_FOR`,
and `google.allowed(job)` is called **before** the work — including before the
confirmation, so nobody presses yes on a message that was never going to send.
Connections says outright which jobs the current sign-in does not cover. Null
from `missingScopes` means "cannot tell", and is treated as permission to try;
refusing on an unknown is how a working setup gets declared broken.

**If you change `SCOPES`, say in the release notes that Google must be
disconnected and reconnected.** Nothing else can fix it.

## When Grove listens, and how you know

**The microphone opens after speech only when something is waiting on an
answer** — the model called `ask_back`, or an ability asked for a missing detail
(`pending` in agent.tsx). It used to open after anything ending in a question
mark, and a personality that ends half its replies on a joke opened the mic at
random. People stopped trusting when it was safe to talk. Punctuation was never
the signal; intent is. `utter(text, listenAfter)` takes that decision
explicitly — never infer it from the text again.

`ask_back` is a declared tool rather than an ability: calling it ends the turn,
the question is the reply, and the answer arrives as the next sentence with the
question in the history. The rules push it towards plans, recommendations,
gifts and decisions, and away from plain requests. Tested: "make me a workout
plan" asks the goal and days; the answer produces the plan without a second
question.

**Grove's own sounds must never press the ring.** The J09 works through the
volume fallback, and any sound Grove starts — a chime, the working pulse, speech
starting or stopping — can move the volume on Bluetooth glasses, which the
fallback reads as a press. Mid-task, that press abandoned the answer, opened the
mic to nothing and fell back to Ready: "listening, ready, and it doesn't do
anything". So every sound calls `suppressVolumeTriggers()` first, and a
volume-fallback press while thinking or working is ignored outright. Real
interruptions still work from the screen, a media-key ring, or while Grove is
speaking. And a turn never ends in silence: an empty reply says so and listens.

**Every state change has a sound**, synthesised natively in grove-remote the
same way the keep-alive silence is (no bundled audio files): a rising chime when
the mic opens, a falling one when it closes with nothing heard, a soft pulse
while work takes longer than 900ms, and a single note when something was
actually changed — added, sent, moved, written. Lookups get no "done" chime;
their answer is the signal. The pulse is delayed so a fast turn makes no sound
at all. The JS side probes for the native functions, so an update reaching an
older binary is silent rather than broken.

## A friend, not a service

`persona.friend` is the relationship, beside the manner (which is only how
Grove sounds): what it calls you, how straight it is (gentle, honest, blunt),
swearing, how deep it goes (always brief, depends, properly), what to look out
for, and whether it checks in. `friendDirective` and `depthRule` turn these into
prompt; `cares` is free text and is quarantined like the manner — context,
never instructions. `life.lately()` puts the last few days' episode titles and
anything outstanding on every turn, which is what lets it say "you've got the
demo tomorrow" without being asked.

Length is the person's choice, not a rule about glasses: quick questions stay at
one or two sentences, but a decision or "what do you think" gets a real opinion.

**Voices.** Grove will not imitate a real person's voice — asked for Tommy Lee
Jones or Ralph Fiennes, it offers the register instead: `characterVoice()` picks
the best installed low British or low American voice and slows and lowers it.
The Premium iOS voices (a free download) are what make that convincing. The
chosen voice lives on `persona.voiceId`; speech used to read only
`delivery.voiceId`, so choosing a voice changed the preview and nothing else.

**Hearing.** The names in the long memory, Grove's name and what it calls you
are passed to iOS as `contextualStrings`, so the recogniser stops mishearing the
people and projects it hears about most.

**Ordering** is three hand-offs, all behind a press, none holding a basket:
`ride.request` (Uber), `food.order` (Uber Eats or DoorDash) and `shop.order`
(Amazon, Instacart, Walmart, Costco, on the phone's own country's site). "My
usual is…" is saved as a fact keyed by the place, so each place keeps its own
and "order my usual" works next week, not just while the sentence is in the
conversation.

## Email in your words, sent in better ones

You give the gist — "tell them no, I'm busy" — and `lightEmail` writes the email:
a greeting ("Hi Professor Chen,"), the point in one to three sentences, your
first name signed by code from your Google profile (`signed()`), never by the
model, which invents names. Texts are left in your own voice.

- **Its own call, not a rule in the turn's prompt.** The same instruction in the
  big system prompt was followed one time and ignored the next.
- **It may polish, never add.** No reasons, dates, promises or offers you didn't
  give. The approver is listening, not reading, and will not catch an extra
  sentence. The prompt's own examples leak: "thanks for your patience" in an
  example ended up in unrelated emails, so examples are kept neutral.
- **The press sends what was heard.** The draft is read back in full and
  carried to the confirmation in `confirmArgs`; a confirmation that re-drafted
  would send words nobody approved. `draft` is on the list the model can never
  set, alongside `confirmed`.
- **Addresses come from the inbox too.** Someone who emailed you has an address
  even when they are not in contacts. And a reply with nothing to reply to
  becomes a new email to the person named, through the same read-back and press.

## Failing honestly

- **A thrown error is not "offline" unless it says so.** `failure.ts` sorts
  timeouts, real network failures and everything else. React Native rejects an
  abort with a DOMException that is not always an `Error`, and
  `AbortSignal.timeout` names it TimeoutError — so the old test announced every
  slow answer as "I have no connection right now", on full signal.
- **The tool turn is retried once** on timeout, network, 429 or 5xx, then falls
  back to a plain answer with the conversation and search (`lightFallback`),
  which is told to answer public questions and to say plainly when it could not
  reach their own data rather than guess.
- **Tool names are matched however the model spells them.** Declared as
  `brief__web`, the model called back `brief_web` often enough that every
  search failed as "not available" — and the model explained it to the person
  as the internet sulking. Names now use one underscore, `abilityIdFor` ignores
  separators, and the harness checks three spellings of every tool.
- **Questions about now are looked up, in code.** Told to search, the model
  still answered "how did the Oilers do" from training. `needsFreshFacts` sends
  a question about scores, markets, prices, hours or news through web search
  when the model tried to answer without it.
- **Sums are done in `calc.ts`**, not by the model, which said 15% of 240 was
  thirty. The exact answer is handed over as a fact.
- **The phrasing step is bounded.** Once a tool has answered, the model gets
  eight seconds and no retry to phrase it; past that, the tool's own answer is
  said. Gemini sometimes took twelve seconds just to reword a search result.
- **Testing on a laptop on battery:** macOS sleeps a test run mid-flight, and
  every timer in it then fires minutes late. Run live tests under
  `caffeinate -i` or the timings mean nothing.
- **Model markdown is stripped** from every reply in `plainSpeech()` — told not
  to, it still wraps titles in asterisks, which showed on screen and could be
  read aloud.
- **Documents survive the Docs API being switched off.** `createDoc` falls back
  to uploading HTML through Drive, which converts it into a Doc with headings
  and bullets intact. When an API is off, the error names which one and carries
  Google's own activation link to the card.

## The long memory

`src/lib/memory.ts` is forty one-line facts sent with every turn. `src/lib/life.ts`
is the other half: the people, projects, places and ideas in someone's life,
each with its own facts, plus dated **episodes** of what happened — and it is
sent with no turn at all. It is searched when something asks about it, by
`memory.search` and `person.brief`. The two are not redundant: one is what must
always be in mind, the other is what must be findable in March.

**Nothing here costs a model call per turn.** A finished turn appends to a
buffer; every dozen turns, or when Grove is next opened, `consolidate.ts` makes
one call that reads the buffer and returns entities and episodes. A voice note
or meeting log gets the same read as it closes. Measured: twelve turns of real
conversation, one call, 3.6 seconds, six people and projects and six dated
episodes out the other end.

**The buffer is deleted once read.** That is the privacy line, and it is the
same one `transcript.ts` draws at fifteen exchanges: Grove listens while you
walk around, so it keeps what things meant and not what was said. Everything it
keeps is readable and deletable on the Sparks screen, because a memory you
cannot see is one you cannot correct.

Details that were bugs first:

- **A failed read keeps the buffer.** Clearing it whether or not the model
  answered threw away every turn said without signal. A failed read now keeps
  the turns for the next one, for up to two days. And only one read runs per
  account at a time: two at once each took the same turns, and the second's
  clean-up removed turns that had arrived in between, unread.
- **Promises get closed.** `memory.done` ("I sent Jason the build") marks the
  closest open commitment as kept. Without it nothing ever did, and "what
  should I be doing" raised finished work for ever.

- **A leading word only matches inside one kind.** "Mark" the investor was
  merged into "MARK 312" the course, producing one entity holding a person's
  relationship and a lecture's midterm. Unrecoverable once it happens.
- **Facts go stale rather than being overwritten.** "Moved to Berlin" marks
  "lives in Toronto" stale instead of deleting it or sitting alongside it.
  Holding both as true is how you end up confidently wrong about someone.
- **A named stretch of time never borrows from another one.** "What did I
  decide in March" must not be answered with September's decision. When nothing
  in the window matches the words, the episodes actually inside it are offered,
  labelled as such — the words people use rarely match the words written down.

Ideas taken from ACE, agentmemory and Memmy after reading them: batch
consolidation rather than per-turn extraction, keyword plus name-and-alias
lookup rather than embeddings (agentmemory's own benchmark puts BM25 alone at
86% of full recall), time stored as a field and turned into a range before
scoring, provenance on every fact, and supersession instead of contradiction
detection. What was deliberately not taken: vectors, decay formulas and reward
propagation, all of which need a server or a second model to earn their keep.

## Voice notes

"Listen to this" starts a note: Grove stops replying and listens at length
until a press, or "that's it" / "stop listening" held as the last thing said.
The transcript is written up by the model into a title, summary, points and
actions, and stored on the phone in `src/lib/notes.ts`. `notes.search` finds
them again.

Three things are deliberate:

- **Starting is decided on the phone, not by the model.** People talk the
  instant they have said "listen to this"; a model round trip first loses the
  opening sentence, which is usually the one saying what the note is about.
- **iOS ends recognition sessions on its own schedule**, so a note is a series
  of sessions. Results within a session are cumulative and replace the buffer;
  when a session ends the buffer is kept and a new one starts. A result much
  shorter than the buffer is treated as a new session rather than a revision.
- **The transcript is saved even when the write-up fails.** A summary can be
  made again; a recording cannot.

Notes are not memory. Facts are one sentence and go into every prompt; notes are
long and are searched when asked about. A memory server was considered and not
used, because it would bring back the backend Grove was made standalone to shed.

## Modes, and what they are for

Nine of them now: normal, work, focus, study, gym, social, travel, home and
wind down. Adding one is three things — a palette, a manner, an allow list —
and one trap: the mode words live in `MODE_WORDS` in grove.ts, used by both the
keyword patterns. They were two separate regexes once, and the first mode added
after that silently did nothing when spoken.

Work and home allow everything and change the manner; the narrow ones exist for
situations where a tool is actively wrong. Gym has no mail and no sending: out
of breath, mid-set, is not when you deal with your inbox.

## Money

No ability spends any, and rides and takeaways do not change that — they stop at
the door of the app that already has a checkout. Uber knows the card, the
address, the surge price and the driver, and has a confirm screen built by
people who only do this. Grove fills it in and hands it over. The worst a
misheard word can do is open an app with the wrong destination typed in, which
is a thing you look at and close.

Anything irreversible returns `needsConfirming` and stops short of doing it. One
press confirms, two cancels, silence cancels, and it expires into no after
twenty-five seconds — a confirmation left armed is a booby trap, because the
next press is meant for something else. The asymmetry is deliberate: doing
nothing has to be safe, since the failure that matters is a hand brushing a ring
in a pocket, not a purchase that needed asking for twice.

`npm run verify` asserts that every ability which reaches a paid app takes a
confirmation and is not marked `reads` — a read is reachable from a question,
and a question must never buy anything.

The reasoning is the same one `detectActIntent` is built on, taken one step
further: a false positive there costs an email nobody wrote, which is
embarrassing and recoverable. A false positive on a purchase is neither. Uber,
food delivery and shopping were asked for and are deliberately absent, because
the useful version of each is one sentence away from spending money on a
misheard word.

## Checks

```bash
npm run verify      # does Grove actually reach its own abilities?
```

Runs the real modules — not a copy of their regexes — with the native halves
stubbed as present, and asserts the wiring: every ability is reachable from the
phrases it advertises, a question can only ever reach an ability marked `reads`,
ordinary conversation sets nothing off, connections unlock ids that exist, mode
allow-lists name real abilities, and the OAuth scopes cover the APIs actually
called. Every fault it checks for has shipped at least once. None of them is a
type error, so `tsc` cannot see any of them.



```bash
npx tsc --noEmit
npx expo lint
npx expo export --platform web    # catches bad imports across every route
npx expo install --check
```
