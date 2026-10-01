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

**A press that does nothing is the worst failure this app has**, because there
is no screen to explain it, and the habit it teaches is pressing twice. Three
paths used to end in silence and all three now recover:

- The recogniser refusing to start returned quietly to Ready. It now hands the
  audio graph back, takes it again and tries once more; only then does it say
  it could not open the microphone.
- A recogniser that starts and ends within 700ms never really started — the
  usual shape coming back from the background — and gets exactly one more go.
- The session can be lost silently to another app, and only opening Grove took
  it back. A four-minute heartbeat re-arms, but only when `isArmed()` says it
  has genuinely been lost, so an armed Grove and another app's music are never
  disturbed.

**Haptics say which thing happened**, because the chimes only exist on a build
that has them and a pocket has no screen: two rising taps when the microphone
actually opens, two light taps when it closes having heard nothing, a success
tap when something was changed, a warning tap when it could not. One Light tap
for everything was indistinguishable from the phone's own notifications.

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

## Speaking first

Everything else in Grove waits to be asked. `src/lib/attention.ts` is the part
that speaks unprompted, which makes it the part most likely to get the app
switched off, so the rule is not "what could Grove say" but **"what would a
person regret not being told"**. That is a short list: you need to leave now,
the thing you are about to walk into starts in minutes, something you said you
would do today is late. A pleasant fact, or a summary of your day, is not on it
and is left for when you ask.

Rules, not a model. It runs every ninety seconds all day; a model call per check
would cost more than the rest of the app together and be wrong in a more
interesting way. Each moment carries a **stable id** so a warning is said once
and not once a minute, and a journey gets two — a nudge while there is still
time to act, and a "go now" when there is not.

Both this and the Talk screen's card run on timers, and asked straight through
they would make a calendar request and a route lookup every minute for as long
as Grove is open. The diary is held for two and a half minutes and a route for
five, which are shorter than either can meaningfully change.

`src/lib/reveal.ts` is the first week: one discovery a day, each about the
person's own life — the names from their intro, a promise they have not closed,
a thought that has sat in the list, the thing that has come up most this week.
**None of these lines is about what Grove can do.** A feature tour read into
someone's ear by the thing they are paying for is worse than silence, which is
why the harness asserts every line interpolates something of theirs. Each needs
its evidence to exist or the day passes quietly; one a day, once ever, nothing
after the first week and a bit.

**On the seventh day Grove asks whether it may speak up before being asked**,
and asks on screen with two buttons rather than out loud — a spoken question
needs an open microphone, and on this particular decision a misheard yes is the
worst possible outcome. `persona.friend.proactive` has three states and the
unset one is the point: unset volunteers only things with a clock on them, plus
the one-a-day discoveries that earn the right to ask. Yes opens the standing
observations; no closes them and leaves the urgent half alone, because "don't
chat to me" and "don't tell me I'm about to be late" are different requests.

**Nothing unprompted opens the microphone**, even the lines that end in a
question. Grove started it, the phone is in a pocket, and a mic that hears
nothing closes with a second sound. Urgency always wins over a discovery: being
told what you talk about most while you should be leaving the house is the wrong
order.

## The first run teaches it about you

Three slides, then the checklist. The slides are the only marketing in the app
and exist because Grove is indistinguishable from any other voice assistant for
thirty seconds and completely different after a week.

**Onboarding was unreachable in a release build for a while.** The gate in
`src/app/index.tsx` read the session: a live one meant the app had been used
before. True while Noctus was mandatory, false the moment Grove went standalone
— with no backend the session reports `signed-in` on the first launch, by
design, because there is no account to sign in to. It now turns on whether the
intro has been seen, and nothing else.

`src/app/onboarding.tsx` also has one step that is not setup: a box asking who is in
your life and what you are working on. Typed, not spoken, and this is the one
place in the app where that is the right way round — it is a paragraph, it is
full of proper nouns a recogniser has never heard, and people edit themselves
when they write.

`rememberIntro` sends it to **two places in two parallel calls**, because asking
for both at once got neither right: the people, projects and places into
`life.ts`, which is searched, and what is true about the person into `memory.ts`,
which is in every prompt — split into facts and goals, because "wants a summer
internship" and "studying finance at UAlberta" are not the same kind of sentence
and a model that cannot tell them apart congratulates you on things you have not
done.

The read starts when they move on, and the two steps after it are hardware, so
by the last screen it has long finished and that screen shows their own names
back to them.

**The person is not a person in their own life.** Told not to file them as an
entity, the model did it anyway from a first-person intro, which put
"Vishnu (self)" at the head of a roster of the people in Vishnu's life. So
`absorb` drops any entity whose relation says it is the user *and refuses that
name for the rest of the pass* — skipping only the entity meant the name arrived
again from an episode's `about` list and was minted as a bare topic.

## Capture, don't switch

`src/lib/inbox.ts` is a flat list of raw thoughts, written the instant they are
said, plus the focus session that defends it. The point is what capture does
NOT do: no date, no list, no category, no question back, and a two-word reply —
"Got it. Back to FIN 312." Anything that turns a capture into a small
conversation has already cost more attention than the thought was worth.

**Everything caught also goes to the Reminders app**, dated when a time was
given. Two homes on purpose and by request: the phone is the thing that shouts
at you, and the inbox is the copy Grove can see when it asks what you should be
doing. Notes are different again (long, dictated on purpose), as is the long
memory (written by a model after the fact).

**Everything they say they have to do goes somewhere.** With a time on it
("tomorrow", "at three") it is a reminder; without one ("I have to do the
dishes") it is a capture. Missing that rule, the model answered "I have to do
the dishes" with a joke and logged nothing, which is the one outcome this
feature exists to prevent. The keyword fallback learned the same shape
(`TODO_STATEMENT`), deliberately without "I should": "I should probably cancel
that" is thinking aloud, and that gate can reach the ability that cancels
things.

A focus session — "I'm on FIN 312 for the next hour" — is what makes it work.
While one runs, brain.ts puts it in the system prompt: anything that is not the
session gets captured and pointed back at in one line; anything that IS the
session gets answered properly. `now.context` leads with it, so "what am I
supposed to be doing" answers with the session and the time left. Durations
("40 minutes", "half an hour") are parsed by `endsIn` — `readWhen` reads clock
times and days, and dropped every length, leaving sessions open-ended. A session
nobody ends expires after four hours.

**Asked what to do, Grove names the path of least resistance** — the smallest
thing that can be started now, with anything overdue winning — not the biggest
or most important. And in casual talk it may nudge about ONE thing on the list
when the moment fits, which is why the first few open captures ride in the
prompt: a nudge that costs a tool call to discover there was nothing to nudge
about would not be worth having. Never mid-task, never a list, and never twice
in a row.

`memory.done` checks the inbox before commitments: "I emailed the PE guy" ticks
off the capture. The list is on the Sparks screen, where a tap ticks off and a
tap deletes.

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
- **It answers the message, not the word.** "No" to a request for work is "I
  won't be able to get the build to you before Friday"; "no" to an invitation
  is a decline; "what time?" becomes a sentence. Reply wording that ignored the
  message read as a form letter — every reply opened "Thanks for thinking of
  me", including to someone chasing a deadline, because an example in the
  prompt said so.
- **A pronoun is not a name.** "Respond to him and say no" passed "him" as the
  recipient, which matched no sender and sent the fallback hunting contacts for
  a person called "him". Pronouns are treated as unsaid, so the message just
  discussed wins.
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

## Bugs that type-checked and passed the harness

A review of the last twenty commits found eight; all are fixed, and each is the
kind `tsc` and `npm run verify` cannot see:

- **A dropped field killed a whole feature.** `loadLife` rebuilt `Life` without
  `sinceCompacted`, so the counter reset on every load and compaction never
  reached its threshold. Rebuilding a type field by field means every new field
  has to be added twice.
- **A holding line ended the turn.** The "Writing it now" line for a slow
  ability omitted `stillWorking`, so the screen dropped to Ready two seconds
  into a document write and the mid-turn press guard stopped applying.
- **The confirmation expired while being read.** Twenty-five seconds started
  when the draft began being spoken, and a long draft takes most of that. The
  clock now starts when the speech stops.
- **The maths parser ran on every sentence.** "Move my 2 - 3 pm meeting" became
  -1, "book it for 9/23" became 0.39. It now needs the sentence to ask for a
  calculation, and refuses dates, clock times and fractions with units.
- **A press could send something other than what was approved.** A reply with
  no thread falls back to a new email; the confirmed re-run searched again,
  found a message, and sent a threaded reply instead. The decision now travels
  with the confirmation in `new_email`.
- **All-day events were read as UTC midnight** and filtered out of today by a
  two-hour window. Google sends them as a bare date; `localTime()` reads that
  as local, and all-day entries count for the whole day rather than being
  announced as "happening now until 18:00".
- **Gmail quotes display names.** `"Chen, Mark" <…>` failed both person tests
  in `mail.important`, so a real person's mail scored below the cut.
- **A From line can be a bare address**, with no angle brackets — which the new
  inbox-address lookup discarded, producing "I have no address for Mark" for
  precisely the case it was written for.

## Failing honestly

- **A thrown error is not "offline" unless it says so.** `failure.ts` sorts
  timeouts, real network failures and everything else. React Native rejects an
  abort with a DOMException that is not always an `Error`, and
  `AbortSignal.timeout` names it TimeoutError — so the old test announced every
  slow answer as "I have no connection right now", on full signal.
- **Nothing is one-shot any more.** A Google call is retried once on a timeout,
  a dropped connection, a 429 or a 5xx — and never on a 401, 403 or bad
  request, where the second attempt only doubles the wait before the same
  honest answer. The weather retries each of its two calls, caches coordinates
  (places do not move), and falls back to the last reading within half an hour
  rather than saying it cannot reach anything. The model is told to try twice
  too: a different argument or a different tool before giving up.
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

**Memory is compacted, not just appended.** Every third consolidation,
`compact()` merges duplicate entities locally (no judgement needed) and, for
any subject that has collected six or more facts, one call rewrites them into
fewer, denser ones: "interested in a job at Meta" plus "interested in a job at
Palantir" becomes one fact naming both. Measured: seven facts into three, in
1.4 seconds, with every specific kept.

The guard on that is the interesting part. Length is the wrong thing to check —
shrinking the list is the point — so what must survive is the specifics: every
proper noun and number present before must be present after, or the result is
thrown away and the memory left as it was. Sentence-initial words are ignored,
because they are capitalised for grammar; counting them made "Taking MARK 312"
look like lost information and refused every tidy-up.

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

## What a normal week looks like

`src/lib/rhythms.ts` is the only part that knows what *usually* happens, which
is the missing input behind "you slept late, so I'd leave around 10:20". The
calendar gives the eleven o'clock and the route planner the forty minutes;
neither can tell you today started two hours later than normal, and without
that the advice is the same every day.

Two sources, both already on the phone: the first and last thing said to Grove
each day (a rough proxy for waking and turning in, used only as a comparison
against the same person's own median and never stated as a fact about their
sleep), and a month of calendar history grouped by title and weekday. **Three
Wednesdays at seven is a pattern; two is a coincidence.** No model call — a
median and a group-by have to be free, because this rides in every prompt.

It buys one interruption the calendar cannot produce: a weekly fixture whose
hour is coming round with **nothing in the diary for it**. Matched by
containment, so "Basketball (moved)" counts — an exact match would nag someone
about an event they are looking at. Being up early is never remarked on, and
under four days there is no prompt block at all.

## Things you did not understand

`src/lib/struggles.ts` records a gap rather than a fact, which makes it the one
memory that is useful precisely because it is about something you cannot do.
Anything can explain integration by parts; what nothing else can do is remember
that *you* did not follow it, asked again two weeks later, and have still never
got it right unprompted.

**Two correct answers close it, not one.** One right answer about a thing you
just revised is a memory test; the second, days later, is understanding. A wrong
answer reopens it and resets the count.

The quiz needed a new primitive: `listenAfter` on `AbilityResult`, an ability
whose answer is itself a question. Declared, never inferred — the
missing-argument case works by accident of shape (a failed run whose line
contains a "?") and that cannot work here, where the run succeeded and the
question is the point. A running quiz goes **last** in the system prompt, where
it has the most say, with the answer key: marking is the one job a model is
genuinely good at here and it cannot tell a right answer from a confident wrong
one without knowing what right was.

## Money

See also the section further down on why nothing spends any. `src/lib/money.ts`
is a ledger and an opinion. The numbers are numbers, not facts: "you spent £80
on shoes" as a sentence can be read back and cannot be added up, and a budget
you cannot subtract from is a feeling.

**It asks before it answers.** A missing price and a monthly figure nobody has
stated both come back as questions, through the same path as "which town?", and
both answers are kept so it only ever asks once. Advice with a number missing
sounded certain while doing arithmetic on a budget that did not exist.

**It never says buy it** — not as a moral position, but because Grove can only
see what it has been told and never the bank, and a confident yes off a partial
ledger is the one output here that could cost money. Where the numbers are
comfortable it says so and leaves the decision alone.

## The memory is encrypted at rest

`src/lib/vault.ts` sits under the ten stores that hold someone's life: AES-256
in counter mode, key in the Keychain under
`WHEN_UNLOCKED_THIS_DEVICE_ONLY` — **which is the whole point**, since the key
then never rides an iCloud sync or comes back from a backup onto another phone.
Without that flag the key travels beside the data it protects.

Two rules matter more than the cipher:

- **An unsealed value is read as it is**, then re-sealed on the spot. Refusing
  it would wipe every existing install.
- **A write that cannot be encrypted is written in the clear.** Losing what
  someone just said in order to protect it is the wrong trade.

No MAC, deliberately: confidentiality is the goal, and damaged bytes fail to
parse, which every store already treats as a corrupt archive. `vaultReady()`
is asked rather than assumed, because a claim about encryption nobody checked
is how "encrypted at rest" ends up in a changelog and nowhere else.

`npm run verify` fails if any of those stores reaches AsyncStorage directly —
a one-import regression that type-checks and whose only symptom would be a
sentence in Settings quietly becoming untrue. It also asserts `startAgain`
clears all of them; it used to clear three stores and leave five.

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

Four: normal, focus, gym and wind down. There were nine; the five that only
changed the manner were cut, because a mode earns its place by making a tool
actively wrong, not by having an opinion. Gym has no mail and no sending: out of
breath, mid-set, is not when you deal with your inbox.

Adding one is three things — a palette, a manner, an allow list — and one trap:
the mode words live in `MODE_WORDS` in grove.ts, used by both keyword patterns.
They were two separate regexes once, and the first mode added after that
silently did nothing when spoken.

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

Two kinds, and the difference matters. `npm run verify` and the live harness
run on a laptop, where Gmail, Calendar, Drive and Contacts are stubbed —
because the token that reaches them only ever exists in the Keychain on the
phone. Anything those say about Google is a statement about our code, not about
the account.

So the account is tested on the phone: **Settings → Does it all work?** runs
`selfCheck.ts` against the real connections and reports each one. Reads only —
a self-check that sends an email to prove it can send email is one nobody dares
run twice — and permission to write is tested by asking what the sign-in was
granted rather than by using it. Failures name the API and carry Google's own
activation link.

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
