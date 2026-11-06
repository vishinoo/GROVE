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
  into the Keychain, because uid keys the memory and the transcript, and an
  unstable one forgets you every launch.

The redirect scheme **is** the client id with its dotted parts reversed. It is
not a free choice, `grove://` is rejected, and it must match in two places:
`app.config.js` (Info.plist) and `googleAuth.ts` (the redirect). Both derive it
from `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`; never hardcode it. A mismatch fails
after consent, which is the most confusing place a sign-in can break.

What a backend would still buy you: one shared model key instead of one per
device. Not needed for a
single user.

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
- `src/lib/grove.ts` — a delegation and the keyword gates. It was the whole
  router once, then the standing-job path; **sparks are gone**, because iOS
  cannot wake a terminated app and a job scheduled for eight in the morning
  only ever fired if Grove happened to be open, which is not a schedule. The
  gates stay because they are how the harness asks whether a sentence can reach
  a tool at all.
- `src/lib/persona.ts` — holding lines all say "one second" rather than "give
  me a moment", because the second one is a request and the first is an
  estimate. The manner is user-authored and goes into a system
  prompt, so `mannerDirective` wraps it to quarantine it as style-only. It is a
  guard, not a guarantee; keep the framing when editing.
- `src/lib/lightModel.ts` — every model call, and the only file that knows a
  provider. The Gemini key is a bundled `EXPO_PUBLIC_*` value: accepted for a
  personal build on a prepaid key, and to be moved behind a server before a
  build reaches anyone else. Everything outside this file is provider-agnostic,
  so that move is one file.
- `src/lib/memory.ts` — facts carry a subject, so "what was I supposed to ask
  Sarah about" is answerable. Capped at 40 and sent whole; there is no retrieval
  step because at this size sending everything is cheaper than fetching some.
  Goals (`kind: 'goal'`) are capped separately and never compete with facts for
  room: one oldest-first cap meant an intention set months ago was always
  evicted before a passing note about lunch, and recency is the wrong measure
  for a goal. They also carry their own heading in the prompt, so the model can
  tell "wants to run a half marathon" from "ran a half marathon". Memory is read
  and edited on its own screen rather than in Settings: a memory you cannot see
  is one you cannot correct.

  **It holds what Grove should know, not a log of what it did.** The screen
  used to open with "What it did" — the last few tool calls with their state
  and timestamps — which was the largest thing on it, said nothing that would
  matter tomorrow, and pushed the things that would below the fold. A receipt
  for something forty seconds old belongs nowhere, and certainly not above the
  list of people in somebody's life. What is left is the five kinds that are
  actually memory: still to do, keeps tripping, people and projects, what
  happened, about you.

## A lookup ends with the answer, not with a page

*"Search up a recipe for chicken pot pie."* Grove went to Google, opened a
recipe, pressed Jump to Recipe — all correct — then scrolled three times and
said nothing, until twenty-five seconds later the person pressed Stop. From
the outside that is an assistant that did nothing. It had the ingredients on
screen and no instruction to hand them over.

The rule that should have covered it named the wrong things: *"for looking
things up (jobs, reviews, prices)"*. A recipe is not a job, a review or a
price, so the model did what the rest of the brief says — act on a page — and
a page is not an answer to somebody who asked for a recipe. **A list of
examples is a list of the cases somebody thought of**, and the ones nobody
thought of fall through to whatever the default behaviour happens to be.

So the mover is told that finding something ends with the thing: read it and
put it in `done` far enough to use, a recipe's ingredients **and** its steps,
written out. The three non-answers are named, because each one reads like a
reply — *"I found a recipe"*, *"it's on your screen"*, and a link. It opens the
page as well, so both halves of what was asked for arrive. Measured against
the live model on a real recipe page: `done`, with the full ingredients and
five steps, 866 characters.

**A receipt goes; an answer stays.** Every result card closed itself within
ten seconds, which is right for "Playing Interstellar" and wrong for the
ingredients list somebody is halfway through reading. Length separates the
two without anything having to declare which it is: a line Grove wrote about
what it did is short, a thing it went and found is not.

**And stopping still says where it got to.** It was halfway down a recipe when
they gave up on it, and saying nothing at that moment is most of what made the
whole thing feel like it had done nothing.

The card strips markdown on its way in. Told not to use it the model writes
`**` and `#` anyway, reliably, on exactly the long answers that now stay on
screen — so *"**Ingredients:**"* was about to be the first line of every
recipe. The same fix `plainSpeech` has done on the phone since it was reading
asterisks out loud.

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

**Every reply ends with a window you can talk into, and the window shuts
itself.** Three seconds after an ordinary reply (`GRACE_MS`), twelve after
Grove has actually asked something (`ANSWER_MS`) — and none at all if you said
you were finished (`closing.ts`).

**They are answers to different questions, and treating them as one dial is
why both have been wrong.** `ANSWER_MS` is "Grove asked you something, how
long to decide" — twelve seconds, because the question was Grove's idea and
deciding takes thought. `GRACE_MS` is only "how long to wait for you to
*begin* a word you already meant to say", with nothing pending and the reply
finished.

That one went two → four and a half → one and a half → three. Four and a half
was set to make room for the tail of Grove's own voice, and overshot badly:
once `SPEECH_TAIL_MS` held the microphone back until the sound had actually
stopped, the window no longer had to absorb it, and four and a half seconds of
a screen saying Listening after an ordinary answer reads as the app having
hung. **An offer counts as a question** and gets the long window, because the
whole point of asking is that somebody answers.

**A second and a half then overshot the other way, and the number was only
half of why.** The clock started when `startListening` *returned*, which is
the recogniser agreeing to start rather than a microphone being open —
bringing up the audio engine takes a few hundred milliseconds more, and on a
window that short most of it was charged to the person. Which is why talking
straight away worked sometimes and not others, for no reason visible from
outside. The clock now starts at the **first level reading**, the first thing
that cannot happen until a microphone is genuinely being read, so three
seconds means three seconds of microphone. It is armed on starting as well as
on that first reading, and only the first reading re-arms it: the readings
arrive every hundred milliseconds whether or not anyone is speaking, so
re-arming on each would be a window that never closes, and arming only on
them would hold the microphone open for ever on a build that reports none.

The number is safe because it only governs *starting*: `onPartial` re-arms to
`TRAILING_MS` the moment a word is heard, so anyone who does begin gets three
and a half seconds of pausing room per breath and is never cut off
mid-sentence. `npm run verify` asserts the relationships rather than the
numbers — the trailing window must exceed the opening one, or beginning a
sentence would shorten the time you had to finish it.

**And "enough" closes it early.** `src/lib/closing.ts`. A window that shuts
itself is right nearly always and wrong in one case: when you already know you
are finished, and the only way out is to say nothing and wait. Said on its own
the word gets **no reply at all** — there is nothing to reply to, and "sure,
done" after "enough" is the exact noise being asked for less of. Said at the
end of a real sentence ("text Priya I'm three minutes late, enough") the
sentence runs normally and only the window after it is dropped. A pending
confirmation is cancelled, and a pending offer is cleared without being
counted as a refusal.

**Spoken input only.** The word exists to shut a listening window and the
typed box has none, so typing "enough" there would have produced no reply and
nothing on screen to say why — the typed version of the press that does
nothing. Typed text is also deliberate in a way dictation is not: taking a
word off the end of something somebody actually typed is a worse trade than
taking it off a transcript.

The whole risk is the other direction, because a false positive silently
truncates a real request with nothing on screen to say why. Three rules, each
earning its place against a sentence that has to keep working:

- **A question is never a close.** "Can you text Priya, that's all?"
- **The bare words need a break in front of them** — a comma, a full stop, an
  "and". "That's good enough", "I've had enough", "late enough" have none.
  Phrases that cannot be said by accident (`that's all`, `nothing else`,
  `stop listening`) do not need one.
- **The match is exact, not contained**, which is what makes negation safe for
  free: "no, that's not enough" has the break and ends in the word, but its
  tail is not in the list. A test for *containing* "enough" would have needed
  a rule about "not", then one about "hardly", and so on.

`npm run verify` runs the real module over both halves: twelve phrasings that
must close, five that must close and still be answered, and sixteen ordinary
sentences — "mark the essay as done", "add enough milk for the week to the
list" — that must survive whole.

This is a change of mind, and the reasoning it replaced is still half right.
The mic used to open after anything ending in a question mark, and a
personality that ends half its replies on a joke opened it at random; people
stopped trusting when it was safe to talk. So it was cut back to opening only
when something was genuinely waiting — `ask_back`, or an ability missing a
detail. Punctuation was never the signal and still is not; `utter(text,
listenAfter)` still takes that decision explicitly and it must never be
inferred from the text again.

What was wrong was the conclusion, not the diagnosis. Reaching for the ring
again to add one more sentence is its own failure, and it is the common case.
What makes the window safe is that it closes on its own, and that **a window
Grove opened itself makes no sound at either end** — `quietListen` in
agent.tsx. A press still chimes, because a press is a question about whether
the thing heard you and the sound is the answer; a grace window nobody used
costs nothing and leaves no trace. Without that, a conversation came with a
two-tone jingle between every sentence.

**A claim to be listening must be backed by a recogniser.** Hearing a word used
to clear the give-up timer outright, so one word followed by silence left
nothing able to close the microphone — and if the recogniser never fired its
own end, which coming back from the background it sometimes does not, the
screen said Listening until the next press. The timer is now re-armed to
`TRAILING_MS` rather than cancelled, and a watchdog checks `isListening()`
while the state claims otherwise. There was already a recovery for this on a
press; that does nothing for someone who just looks at the screen and believes
it.

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

**Opening the microphone must not stop the music.** `expo-speech-recognition`
configures the shared audio session itself, and given no category it uses its
own default — `.playAndRecord` in `.measurement` mode with
`[.defaultToSpeaker, .allowBluetooth]`, **no `.mixWithOthers`** — and then
calls `setActive(true, .notifyOthersOnDeactivation)`. A non-mixable
`playAndRecord` session going active interrupts whatever else is making sound.

Which is the bug `configureSession` in grove-remote carries a long comment
about having fixed — *"start a song and it stops, every time"* — arriving from
the other side. **Nothing in the Swift was wrong**, which is why it survived:
the file that explains the problem is not the file that caused it.

Two things made it total rather than occasional. Every reply opens the
microphone now for the grace window, so the override ran after every single
turn, about half a second after the song had been resumed — Grove said
"Playing …" and then killed it. And **it stuck**: nothing sets the category
back, since `setKeepAlive` only plays or pauses the silence and in the
foreground `beginListening` deliberately skips `reactivate`. So one press left
the session non-mixable for the rest of the launch with Grove's own keep-alive
silence holding it open, and from then on nothing could play at all — which is
why this looked like music being broken rather than like listening breaking
music.

`listen.ts` now passes `iosCategory` on every start, **identical to
`configureSession` field for field** rather than merely mixable: if the two
differ the category is swapped on every listen, and the Swift already says why
that is not free. `npm run verify` compares the two files across the language
boundary and fails if either changes alone, because no compiler reads them
together.

**Mixable is not a free win, and the first version of this fix bought one bug
with another.** Bluetooth has two profiles: A2DP carries stereo and has **no
microphone**, HFP has one and is mono. A headset does one or the other, and
moving between them is a route change that stops whatever was playing. So
while a song plays the glasses are in A2DP and there is no input anywhere for
a recogniser to open — which is what *"The audio input is busy"* in Settings
means: `inputNode.outputFormat` with a sample rate of nought, not a device
somebody else is holding.

And Grove may not simply take it. A mixable session is one that has promised
not to interrupt anybody, which is exactly what forcing the glasses off A2DP
would do. But it **has** to stay mixable, because a non-mixable session cannot
be activated from the background at all — `!int`,
`AVAudioSessionErrorCodeCannotInterruptOthers`, which is Apple's name for
"went active in the background without `.mixWithOthers`" — and the background
is where every ring press comes from.

Neither option is available on the session, so **the track pauses instead**,
the way every assistant on a phone does it: press, the song stops, the route
frees, the microphone opens, and the song comes back when Grove has finished.
Only ever a track Grove paused itself; one somebody stopped on purpose stays
stopped. The resume lives in **one** place — Grove settling to rest — rather
than at each of the five ways a turn can end, because the one that gets missed
is the one that leaves somebody's music silently off.

**And the grace window does not chop the song.** It is a microphone opened on
spec in case there is one more sentence; opened over a paused track it either
fails for want of an input or succeeds and keeps the music off for another
three seconds, so the song was interrupted for Grove to listen to silence. A
press still works. The window is the one of the two that can wait, and it
costs exactly the one press it exists to save.

**A listening failure now says where it happened.** Every one of these arrives
as a four-character CoreAudio code and nothing else, and the code alone does
not separate the three causes this app has. The three things that decide it
are free to ask for at the moment it fails — foreground or background,
Bluetooth or not, and whether the route has a microphone at all — so they ride
in `where` and print under the line in Settings. Which also meant fixing
`noteTrouble`, where a repeat kept the **first** `where` and the **last**
`lastAt`: harmless while `where` was the constant "listening", a lie the
moment it carried state, since the circumstances printed under "Today 12:02"
were then from some other time entirely.

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

## Second nudges

Two things made "pause" and "play" need saying twice, and neither was music.

**Every AppleScript was one-shot.** `Script.run` drives Music, Chrome,
Messages, Notes and the whole browser agent, and some of its failures mean
"ask again" rather than "no": a scripting connection goes stale when an app is
relaunched or was still coming up, and the answer is -609 *Connection is
invalid*, -600 *Application isn't running*, or a timeout. Every one of them
works on the next attempt — which is why the symptom was never a failure
anybody saw. It was being told to pause and having to say it again, with
nothing on screen either time to say why. Measured in a real log: a -609 on
Music at 12:57:35, and fourteen seconds later the person typing *"can you
initialize my music please"*.

Retried exactly the way every network call here already is, with the same
exclusions — never -1743 *not authorized*, never a syntax error or a missing
object, where a second attempt only doubles the wait before the same honest
answer. **Once more, never a loop.** `Browser.run` goes through the same door,
so one fix covers Chrome, `Player` and Messages too.

**And "play" after a pause was shuffling the library.** `play` arrived with
nothing named, and what it meant depended on something the model could not
see: whether anything was paused. If something was, it went to the library and
started shuffling — pause your song, say "play", get your whole library on
random. The second nudge was naming the song again.

The model will not fix this and should not be asked to: **"play" is the
word.** Measured against the live model with the song and its paused state in
front of it, "play", "play it", "keep playing" and "start it again" all come
back as `play`, because that is what the word means in English. A rule telling
a model to call a thing by a name nobody uses is a rule that gets quietly
ignored. So code decides, which is the rule this app is built on.

Two places, because two different things know the answer. `Player` knows when
Grove did the pausing, and knows it for a video in Chrome or Spotify as
readily as for Music. Music itself knows when something else did it — a
keyboard key, or a launch ago — and is the only one that can say so. A request
for a *playlist* never takes the shortcut: a paused track whose name happens
to match would otherwise answer for it.

`play` naming the track already loaded is the same request wearing a name
("play it" comes back as "Vancouver 3"), and finding it in the library again
restarts it from the beginning rather than resuming where it stopped. Both are
the same answer: carry on.

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
question. Grove started it, the phone is in a pocket, and nobody asked for a
microphone to come on. Urgency always wins over a discovery: being told what
you talk about most while you should be leaving the house is the wrong order.

That one used to hold by construction, because a reply only ever listened when
something was waiting on an answer — and **the grace window after every reply
made it untrue without anything here changing, and nothing said so.** So it is
stated in code now rather than only in prose: `volunteer` sets the same hush
`closing.ts` sets, and `npm run verify` fails if it stops doing it. An
invariant that can be broken from another file by someone who never read this
paragraph needs a check, not a sentence.

## The interruption budget

`src/lib/attention.ts` decides what *could* be said; `src/lib/interrupt.ts`
decides whether it is worth saying, and that second question is the product.
**Grove's measure is not how much it gets used, it is how little of someone's
attention it spends.** Every other assistant is tuned the other way, and that
one difference produces opposite software.

Each rule returns a candidate with what it is worth. **Three factors, not
five** — the obvious design multiplies importance, confidence, time
sensitivity, relevance and expected benefit, and the last two are the same
guess wearing different names, both collapsing into "how much would they regret
missing it", which the rule already knows. What is left:

- **cost of missing**, 1–5, stated by the rule, on a scale too coarse to fake
  judgement with.
- **confidence**, taken from an actual count wherever there is one. Three of
  the last four weeks is 0.75 and clears the bar; twice is 0.5 and does not.
  *Nobody picked those numbers*, which is the only reason they can be trusted.
- **perishability** — being told to leave is worthless afterwards; a note about
  spending is as true tomorrow.

Three a day, forty-five minutes apart, nothing repeated. The bar moves with
them: talking shortly after an unprompted line is the only evidence that the
line was wanted, so answering lowers it and ignoring raises it — crude on
purpose, and it takes six before it moves at all.

**The budget may never silence a leave-by.** A budget that can stop "you need
to leave now" has turned a safety feature into a rationing problem. Anything
above the exempt line skips the cap, the spacing and the learned bar, and
`npm run verify` proves the highest bar anyone could teach it still sits below
what a leave-by scores.

## What Grove offers to do next

`src/lib/offers.ts`. Talking about a book and then having to say "send me the
Amazon link" is a sentence the conversation already contained. So Grove may add
**one line** to the end of a reply offering the obvious next thing — send you
the link, write that up as a plan, put the three companies in a doc with
current numbers.

**The model decides what; code decides whether.** That split is the design, and
the first version got it wrong.

### Why the keyword list had to go

Version one decided *what* here too, from a list: books, the gym, shares, each
wired to one ability. It worked for exactly the three cases written into it,
was useless everywhere else, and was wrong in the way a keyword list is always
wrong — **"I'm running three minutes late" matched the gym rule and offered a
training plan.** Tightening it ("a practice *and* a design on it") only moved
the boundary; "I need to run to the shop" has both.

The model already sees the conversation, the long memory, the constraints and
every ability as a typed function, on a call being made anyway. It is the only
thing in the system that can tell a book worth owning from a book mentioned in
passing, or know the restaurant should suit what someone said about eating this
month. So `offer_next` is a declared tool alongside `ask_back`: the model
proposes in the same breath as its reply, at **no extra model call**, and the
turn collects it without running it.

### What the gate checks

`offerFrom` is the *whether*, and it is the half a model should not be trusted
with:

- **It must name a real ability and survive its schema.** The tool has to
  exist, be allowed in this mode, and have its required arguments filled. This
  is a better rule than any keyword list: an offer that cannot fill the
  arguments of the thing it is offering has not worked out what it would do.
  *"Want me to look that up for you?"* with no topic is the sentence this
  feature exists never to say, and it is exactly what a model produces when it
  is being agreeable rather than useful.
- **It must be answerable out loud** — one line, ending in a question. A
  statement is not an offer; there would be nothing to say yes to.
- **Declining is not disagreeing**, and conflating them was the first
  version's second mistake. Two nos used to switch a kind off for good, which
  reads a verdict on two badly-chosen offers as an instruction about a whole
  ability — say no to two bad link offers and links are gone. That makes
  something useful look broken, which is worse than never shipping it, because
  now the person has watched it stop.

  So a decline buys **rest**: `REST_DAYS = [0, 0, 1, 3, 7]`, indexed by the
  run of declines since the last accept. The first no costs nothing extra —
  the generic spacing covers it, and one no is a verdict on one offer. The
  second buys a day. It climbs to a week and stops, because **seven days is
  the ceiling on what Grove may conclude from being turned down**; a fortnight
  of silence is indistinguishable from being switched off, which is the
  outcome the table exists to avoid. An accept clears the run outright, so a
  kind that works never accumulates a sentence out of the odd miss. A decline
  older than thirty days restarts the run rather than adding to it — otherwise
  two nos in January and two in June add up to a week of silence from evidence
  five months apart.

  **Only a sentence switches something off.** `vetoed` is the single permanent
  state and nothing but an explicit "stop offering that" sets it. Deliberately
  a phrase, not a word: nothing a bare "no" can reach may set it, so Grove can
  never infer a veto from two shrugs — they should be able to stop a kind in
  one sentence, and Grove should not be able to decide the same thing by
  counting. A later yes lifts it, and `allowAgain` takes it back from the
  Memory screen. Keyed by ability throughout, so resting links leaves
  documents alone.

  Answering with a different sentence is moving on, not refusing, and teaches
  nothing.
- **The ledger is written through a queue.** Every write was a bare
  load-then-save, which is a lost update waiting to happen: charging the cap
  and recording the answer are two writes a second apart, and whichever one
  loses is the interesting part — losing the decline means Grove never learns,
  losing the charge means it offers again immediately. Same shape as the queue
  in `troubles.ts`.
- **Reason codes are stable and distinct.** `resting` and `vetoed` are
  different sentences to show somebody: one recovers on its own and the other
  needs them to change their mind.
- **Caps as a backstop**, not as the decision: four a day, two turns apart,
  never the same subject twice. They bound a model having an enthusiastic
  afternoon. Measured end to end: forty turns, eight proposals, **four
  offers**. And the suppression, measured: two nos in one afternoon cost one
  quiet day and the kind is offered again the next morning; an accept after
  that makes the following no free; an explicit "stop offering that" is
  refused `vetoed` a month later and comes straight back after `allowAgain`.
- **Never alongside `ask_back`.** Two questions and one microphone is a reply
  whose answer goes to whichever one Grove felt like, so the offer is dropped —
  it is the one of the two that can wait.

An offer costs nothing when nothing is proposed: `offerFrom` is pure and
synchronous, and the ledger is only read once there is something to weigh.

**An offer is not a confirmation.** It cannot be answered with a press, and
saying yes only ever *starts* the ability — `shop.order` then asks for its own
press exactly as before. Nothing in `offers.ts` may set `confirmed`, nor may
the branch that runs an accepted one, and `npm run verify` checks both: an
offer carrying a confirmation would be a way to reach a paid app with one yes
to a question Grove thought of by itself.

## One sentence, five things

`src/lib/plan.ts`. *"Prepare my evening. Check my calendar, order dinner,
finish the presentation on my Mac, email it to my colleague, and put the film
back on."*

**The model was never the problem.** Measured against the live model with the
real declarations, that sentence comes back as five tool calls, split
correctly, each quoting the words that asked for it, and routed to the right
machine — the calendar to the phone, three jobs to the Mac. Environment
awareness, planning and argument-filling all already worked.

The tool loop was the problem. It ran the reads, reached the first call that
*does* something, and returned — and **the three calls after it were dropped
with nothing on screen to say so.** One sentence asking for five things did
two of them, and the failure read exactly like Grove deciding the rest was not
worth doing.

So what is left is kept, and said back one at a time once the step before it
has finished.

**A step is stored as their own words, not as a tool call.** `plan.ts` holds
the quote the model already had to supply (`asked`), and `carryOn` hands it to
`exchange` as though it had just been said. Not because that is cheaper — it
costs one model call a step — but because **everything that guards an action
lives on that path**: the check that their words really asked for it, the
confirmation, the press, the twenty-five second expiry, the offer budget. A
queue that called abilities directly would have to re-implement every one of
them, and the first one somebody forgot would be a plan that spent money
without asking.

What a plan may never do, each asserted rather than described:

- **Confirm anything.** `confirmed`, `draft` and `new_email` are refused on
  the way in and never written on the way out. Every irreversible step stops
  and asks for its own press. *A plan makes Grove finish a sentence; it does
  not make Grove trusted.* So "prepare my evening" still takes a press for the
  dinner and a press for the email — that is the design working, not a gap.
- **Run while a press is owed.** Two things armed at once is one press
  deciding the wrong one.
- **Survive the conversation.** A new sentence abandons it, because changing
  your mind must not leave four actions still coming.
- **Outlive the moment.** Eight minutes, for the same reason a confirmation
  expires: a queue left armed is a booby trap.
- **Grow.** Four steps, so the five-part sentence finishes and a model having
  an enthusiastic afternoon cannot write itself a to-do list.
- **Teach the register.** A replayed step is Grove reading their words back,
  and counting it would have `rapport.ts` learning from its own echo.

A step that fails ends the plan. Ploughing on through "I couldn't reach your
Mac" to order the dinner anyway is how one wrong word becomes four.

**What this does not yet do**: a step cannot take the *output* of the one
before it. "Email the finished presentation" is replayed as those words, so
`mac.use` has to find the presentation itself rather than being handed it.
That is the next piece, and it is a different one.

## A searched answer, and an answer that only looks searched

Asked for "burgers near me", Grove named a burger place that does not exist.
That is the worst kind of invention this app can produce, because **a made-up
local business reads exactly like a real one and you can be sent to it** — it
is not a wrong fact, it is a wasted trip.

Gemini says whether it actually searched, in `groundingMetadata`, and we were
throwing it away along with the URIs of the pages it read. Both are kept now:

- **Groundedness is a hard signal, not a guess.** Chunks it read or queries it
  ran means it looked; no metadata at all means it answered out of its own
  head. `groundingFrom()` is its own function so the **absent** case can be
  tested, which is the case that matters — and "absent" arrives as `undefined`,
  as `{}` and as empty arrays depending on the day.
- **It is reset before every completion.** Only the Gemini path sets it, and
  that is not the only path: Ollama runs locally with no web at all. Left over
  from the previous call, a local answer would have arrived carrying the last
  search's `searched: true` and its links — an unverified sentence with
  real-looking citations attached, which is this signal's own failure mode
  wearing a disguise.
- **Real URIs beat model-written ones.** Asking the model to write its links
  out is asking the faculty that invented the restaurant to invent the address
  too. A grounding URI is a page that was actually fetched, so it wins; the
  `LINKS:` line is only used when there is no grounding to use instead.
- **An ungrounded answer is labelled on its way to the turn.** `brief.web`
  appends `[NOT FROM A SEARCH: …]` to `detail`, and `TOOL_RULES` names the
  same label: nothing specific in it may be stated as true.

And the prompt finally carries the instruction that was missing — *never name
a shop, restaurant, venue, product, person or price the search did not
return.* Found, or not said.

**The hand-off is the answer, not the consolation prize.** When Grove cannot
verify something but an app on the phone could, "I can't find a specific one
from here — want me to open Uber Eats?" is a better reply than any name it
could guess at, and it is the offer mechanism doing exactly what it was built
for. The rules say so outright, because the failure mode is a model reaching
for a plausible name rather than admitting a gap.

## Sending you the thing it found

Two changes made offers worth having, and both were about a link surviving long
enough to be sent.

**A search used to delete its own addresses.** `lightBrief` was told to write
no URLs and then stripped them anyway — sensible for a sentence read into an
ear, where an address arrives as a minute of letters, and it made *"send me
that link"* impossible to honour: by the time anyone could ask, the address no
longer existed anywhere in the app. The rule in this file was already right —
`spoken` is shortened for an ear and the full data goes in `detail` — it simply
was not being followed. The model now writes a `LINKS:` line, which is parsed
off, kept in `detail`, and never spoken. An address the model writes into its
prose anyway is replaced with "their website" rather than deleted, because
deleting it leaves the sentence around it: *"you can get it at for twenty
dollars"*.

**`link.send` is the delivery, and it has no confirmation.** Every other
writing ability here takes a press; this one does not, and the whole argument
is in the address — it comes from `google.me()` and **cannot be passed in**.
There is no argument a misheard sentence could fill that would send it to
anybody else, nothing is spent, and the worst case is an email you delete. That
is a different risk class from `mail.send`, which is why it gets a different
rule rather than an exception to the old one. `npm run verify` asserts the
ability takes no `to`, `recipient`, `address`, `email` or `who` argument, since
the moment one appears the exemption is no longer earned.

## Constraints, in one read

`src/lib/constraints.ts`. Money was never about money: the useful abstraction
is **a fact about someone's situation that makes some answers wrong which would
otherwise be right**. The forty minutes before a lecture, the £180 left, the
thing promised on Tuesday, the thing that keeps going wrong — collected in one place
so a new constraint reaches every answer at once rather than being threaded
through each ability by hand. Nothing is stored; every line is assembled from
whichever module owns it.

Not in every prompt, because it needs the diary and the diary is a network
call. The cheap constraints ride on every turn (rhythm, focus, the list,
frictions); the full picture is assembled by `now.context`, which is the
ability someone reaches when the shape of their day *is* the question.

**Provenance is printed, not dropped**: `told`, `observed` or `inferred` on
every line. The model can then tell which it may state back as fact, and the
person hearing "you're usually up by eight" can find out it came from counting.
Every spoken claim about a pattern carries its count for the same reason — that
sentence is an assertion about someone's life made by a machine, and the
difference between impressive and presumptuous is whether they can see where it
came from. The Memory screen shows what Grove thinks is normal, with the count
beside each line, and what the interruptions have cost today.

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

## An action is reported in Grove's voice

An ability's `spoken` line is written to be correct and short, because it is the
only thing said when a model call fails. What it is not is a reply: "Focus
mode." and "Added to your goals: run a half marathon" are receipts read aloud,
and hearing one back is the moment Grove stops sounding like something you talk
to.

**The cheapest line is the one already written.** When the model calls a tool it
often writes the reply it means to give alongside it — and the parser threw that
away, keeping the function call and dropping the text. That single omission is
why an action sounded like a receipt *and* why fixing it cost a second model
call. `ToolTurn` carries the text now, and the turn holds it until the tool has
actually worked, which costs nothing and stays honest: if the tool fails, the
failure is said and the line is never heard.

When the model does stay silent — which it still does more often than not,
whatever the rules ask — `phraseAction` writes the line instead. **Started
before the tool runs, not after**, so the call overlaps work already happening;
waiting for the outcome first added the two together. It is written from what
was asked for rather than what came back, and checked against the real outcome
before anything is said. Bounded at six seconds, and the canned line stands in
whenever it does not come back.

Never spoken before the tool has finished either way. A model saying "done" in
the same breath as calling the tool is announcing an outcome it does not have,
which is a lie the moment anything fails.

**Said once, by one of them.** When the model already replied in its own words
and the tool then worked, the tool's line is not read out as well — that is a
sentence followed by a receipt.

Two things instructions could not stop:

- **The name.** Told not to use it while `friendDirective` was separately
  telling it to, the model obeyed whichever it preferred. `friendDirective(p,
  { greet: false })` simply does not offer it. Nought out of six, from four.
- **A changed time.** "at 07:00" came back once as "set for six then" — the one
  liberty here that costs something. `hoursIn()` compares the clock times in the
  phrasing against the outcome and throws the phrasing away on a mismatch. Only
  clock times: guarding every number rejects "one less thing to do" and bins a
  good sentence for nothing.

No word count. It is told where the line lands — between someone putting their
phone down and walking off — and left to judge the length the way it would out
loud. A cap produced lines that stopped mid-thought; the brief produces lines
that end. It must not end on a question, though, because nothing is listening
after it.

**A new turn silences the last one.** `exchange` calls `stopSpeaking()` before
anything else. Without it, talking to Grove mid-sentence left the old sentence
playing and queued the new answer behind it through `whenQuiet()`, so replies
arrived late and in order, like a backlog being drained.

## A friend, not a service

`persona` is now two things: a name and a manner. Everything else it used to
ask — what to call you, how blunt to be, whether it may swear, how deep to go,
what to look out for, whether it checks in — was **six screens-worth of
preference standing in for a character**, and every one of them asked you to
describe in the abstract something you demonstrate every time you open your
mouth.

`src/lib/rapport.ts` reads it instead. Swearing is a word list, length is a
mean, formality is a count of greetings and contractions. **Counting, not a
model**: it runs on every turn, a call to decide how to speak would cost more
than the answer it shapes, and counting gives the same answer twice — a
personality that drifts every turn reads as instability rather than adaptation.

Two axes, not one. A single enum had to choose between "brief" and "informal"
for someone who says "nah leave it", and threw half of them away. Length decides
how long a reply is; tone decides what it sounds like.

**It matches register, never mistakes.** Someone dictating through glasses
produces fragments and mishearings, and a Grove that copied those would be
unreadable.

**Counts only — never the sentence.** The window slides by halving the tally
rather than keeping a list of turns, so a register can change within about
thirty turns and nothing of what was said is ever held. The harness asserts no
field of it is a string.

One switch survives, `persona.speaksUp`, because it cannot be observed: someone
who has never been interrupted has given no sign either way.

Length is the person's choice, not a rule about glasses: quick questions stay at
one or two sentences, but a decision or "what do you think" gets a real opinion.

**Voices.** Grove will not imitate a real person's voice — asked for Tommy Lee
Jones or Ralph Fiennes, it offers the register instead: `characterVoice()` picks
the best installed low British or low American voice and slows and lowers it.
The chosen voice lives on `persona.voiceId`.

**Hearing.** The names in the long memory and Grove's own name are passed to iOS
as `contextualStrings`, so the recogniser stops mishearing the people and
projects it hears about most.

**Ordering** is three hand-offs, all behind a press, none holding a basket:
`ride.request` (Uber), `food.order` (Uber Eats or DoorDash) and `shop.order`
(Amazon, Instacart, Walmart, Costco). "My usual is…" is saved as a fact keyed by
the place.

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
- **It drafts; it asks only when asking is the shorter path.** "Email Priya I'm
  running three minutes late" is a complete instruction and is written up and
  read back, no questions. The one thing that is refused is a *bare answer* —
  "no", "yeah", "thanks" — because a reply has a thread that says what is being
  answered and a new email has nothing, and out of one word the whole message
  is invention. The first version of this gate counted words and was wrong:
  "running late" is two words and says everything, "yeah definitely sounds
  good" is four and says nothing a stranger could read. It is about shape, not
  length.
- **Professional unless Grove actually knows otherwise.** `registerFor` never
  guesses casual: a title in the name settles it, a `tone:<name>` fact settles
  it, and otherwise it is written professionally — the only register that is
  never actively wrong. When Grove picked it rather than being told, the
  read-back says so and offers the alternative in the same breath, and
  **"casual" is an answer to the confirmation in its own right**: it re-drafts,
  reads the new one back, and remembers the choice for that person, so this is
  a question asked once rather than a decision made every time. It re-drafts
  rather than sending, because the press must always send the words that were
  actually read out.
- **A loose contact match is read back by the name it matched.** One contact
  matching is not the same as the right one matching: "email Sam" against a
  contact book holding Samantha Okafor matched once, cleanly, and the
  confirmation said "here's the email to Sam" — leaving out the one detail
  that would have caught it.
- **Addresses come from the inbox too.** Someone who emailed you has an address
  even when they are not in contacts. And a reply with nothing to reply to
  becomes a new email to the person named, through the same read-back and press.
- **A send that worked teaches the word.** "Email mom" is the case contacts can
  never answer — nobody has a contact called mom, so the lookup finds nothing,
  the inbox search finds nothing, and Grove says "I have no address for mom"
  however many times it has already sent one. **The word people use for
  somebody is not the word on the contact card.** So a successful send records
  `email:<what was said>`, and memory is consulted **before** contacts.

  Keyed on what was *said*, because that is the half contacts does not already
  hold and the half that comes back next time. Written **after** the send, not
  after the lookup: an address that was found and then failed to send to is
  least worth keeping, since the failure may be the address. It beats contacts
  rather than backing them up, because it got there by being sent to and
  approved by a press, which is better evidence than one of several contacts
  matching on a first name — and it is a visible, correctable fact on the
  Memory screen, with the address on the confirmation card every time, which
  is what makes going stale survivable.

## Typing into something you cannot see

Two defaults, both of which type-check, read correctly and fail by quietly
doing nothing. Both were worst on the Memory screen — a list where every line
is editable, on the screen whose whole argument is that **a memory you cannot
see is one you cannot correct**.

**The keyboard covered the field.** Tap a fact past the first screenful and
the keyboard came up over the thing being typed into, with nothing to scroll
it back. `automaticallyAdjustKeyboardInsets` is both halves of the fix, which
is why it is a prop rather than a `KeyboardAvoidingView`: iOS adds the
keyboard's overlap to the content inset *and* scrolls the focused field up by
exactly how far it was buried (`RCTScrollView.m`, `_keyboardWillChangeFrame`).
A `KeyboardAvoidingView` only does the first, which makes the field reachable
by scrolling rather than putting it where you are looking. **Never both** —
they each subtract the keyboard and the content jumps twice as far.

**Done did nothing.** A `multiline` TextInput defaults to `submitBehavior:
'newline'`, so the return key inserts a line break and `onSubmitEditing` is
never called. Both boxes with a submit handler had one that could not fire:
the fact editor's key said Done and put a newline in the middle of the fact,
and the Talk screen's return key did the same to a sentence meant for Grove.
The fact editor is `blurAndSubmit`; the Talk box is **`submit`**, which sends
and keeps the keyboard, because dismissing it after each line is wrong for the
one case that box exists for — typing to Grove in a meeting, several times
over.

**A background write discarded what you were typing.** `FactCard` followed the
stored value so a fact rewritten by a later turn would not sit there showing
the old one — and `consolidate.ts` runs every dozen turns with `compact()`
rewriting facts wholesale, so a pass landing mid-edit replaced the half-typed
line with the stored one and there was nothing to undo it with. It now skips
while the box is focused, and blurring saves over the background change: of
the two writers, one is in the room looking at it.

The harness checks the general rule rather than the three fixes, because the
next field somebody adds will have the same two defaults: every `multiline`
input with a submit handler must say what its return key does, and every
screen that takes typing must move out of the keyboard's way exactly once.

**A delegation is only worth accepting if the delegate is the thing being
asserted.** The first version of that check let Settings pass by pointing at
the shared `Screen` wrapper — which holds no `TextInput`, so the loop skipped
it entirely. Deleting the keyboard handling from `Screen` broke Settings and
every screen using it, and every check still printed ok. Same fault as the
slice that lost its end landmark, in a new place.

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
- **A harness slice with one unasserted end measures the wrong thing.** A check
  on the offer-accept branch ran from a comment to a hardcoded line; the line
  was later rewritten, `indexOf` returned -1, `slice(start, -1)` handed back
  most of the file, and the check failed on a `confirmed:` three hundred lines
  away. Same fault as the unguarded `.replace` that once left a whole pane
  without its class: **assert every offset, and assert the size of what came
  back.**
- **A From line can be a bare address**, with no angle brackets — which the new
  inbox-address lookup discarded, producing "I have no address for Mark" for
  precisely the case it was written for.

## Failing honestly

- **A web API React Native does not have is not a network failure, and looks
  exactly like one.** `AbortSignal.timeout(ms)` type-checks, runs in node, runs
  in the browser the web export builds for, and throws on a phone: React Native
  replaces the global `AbortSignal` with the `abort-controller` package's
  version (`setUpXHR.js`, `polyfillGlobal('AbortSignal', ...)`), which has no
  static helpers. The throw lands inside the caller's own `try`, so the failure
  is instant, total, and wears the costume of a connectivity problem. **The
  weather answered "the weather service is not answering" on every call, on
  full signal, with Open-Meteo up** — and no retry could help, because the
  retry threw in the same place. It also silently disabled the Drive fallback
  for documents and the scope check behind Connections. `src/lib/abort.ts` has
  `timeoutSignal()`, which uses the native helper where it exists; `npm run
  verify` bans the call outright, because that is the only gate that does not
  run somewhere it works.
- **Nothing framework-shaped reaches the Talk screen.** The recogniser reports
  its failures as "The operation couldn't be completed. (OSStatus error
  560557684.)", and that was going straight to the caption. `failure.ts` now
  sorts machine text from a sentence — `isOpaque` tests for the shapes a
  framework produces and a person never does — and `plainFailure` says what is
  true of the kind instead. The raw text still goes to `troubles.ts`, where a
  number *is* the useful part. A recogniser error is filed and **not** replaced
  with a friendlier line, because `onEnd` already retries and the only honest
  sentence is said by the path that has run out of retries.
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
- **A search needs a where and a when, and had neither.** "When's the next bus"
  matched nothing in `needsFreshFacts` — the list had `next game` and not
  `next bus` — so it never reached a search at all, and the model answered a
  question about this afternoon out of training. Transit, flights, departures,
  "near me" and "in stock" are the same shape and are in the gate now. And
  `lightBrief` is handed the clock, the timezone and the town: a timetable, an
  opening time or a price is not answerable without both, and both are free —
  local arithmetic and a fact already in memory. That one line is the largest
  thing separating a consistent answer from a plausible one.
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

## Memory that bears on the question

`src/lib/bearing.ts`, and the goal block in `memory.ts`. Grove's memory was
complete and inert: all forty facts rode in every prompt, the entity roster
with them — and the framing above the facts said, in these words, *"use a line
ONLY when it is directly relevant to what they just asked. Most turns need
none of it."*

That sentence fixed something real. Without it the model dragged a note about
someone owing for lunch into a question about software, which reads as an
assistant that is not listening rather than one that remembers. **It also
taught the model that memory is wallpaper.** Grove knew somebody was trying to
lose ten kilos, was asked where to get a burger, and answered the question.
The instruction said to.

**The two halves pull in opposite directions, so they are now two blocks.**
Restraint about background facts is right. Restraint about goals is the bug —
a goal is not trivia about a person, it is the thing they asked for help with.

### The goal block, and the thing that stops it becoming a diet app

`goalDirective` says outright that goals are not background, and that when a
request touches one the answer should be shaped by it: the version that gets
them closer, the option they would not have thought of, the conflict they may
not have clocked.

The obvious failure of fixing this is the opposite one, and it is worse —
an assistant that turns every mention of food into a lecture about your
weight gets deleted, where one that merely under-uses its memory only
disappoints. So the rule is **once, alongside, and then help**: one sentence,
never instead of doing what was asked, never twice, never a lecture, never a
reason to refuse. *If they still want the burger after you have said your bit,
get them the burger.* Grove is their friend, not their conscience.

Deliberately **not** a table of what helps or hurts each goal. That would be a
topic map, it would only cover the goals somebody wrote rules for, and the
model does not need one — it knows what a burger has to do with losing weight.
What it did not know was that noticing was part of the job.

### What bears on this

The facts were always in the prompt; what was never there was anything saying
which of them matter *now*. `bearingOn` picks those out in code — no model
call, no embeddings — by overlapping the words of the sentence against the
memory, and puts them under a heading that says what they are for.

- **Scored by rarity, not by count.** Ordinary inverse document frequency,
  measured across this person's own memory, which is the scoring half of BM25
  and the same reasoning already recorded for keeping lookup keyword-based.
  Counting matches flat was wrong in both directions at once: "Priya" shared
  with one entity in seven says a great deal, "lecture" shared with four says
  almost nothing, and a flat count needed two coincidences to beat one real
  signal — so asking what to get Priya for her birthday surfaced nothing
  about Priya.
- **One distinctive word of a name is a name.** Requiring every word meant
  "Priya" did not match "Priya Shah", which is not how anybody refers to
  anyone.
- **Kindred.** When the sentence matches something Grove knows, its nearest
  neighbour of the same kind comes too. That is what makes *"you liked that
  one, this other one is close to it"* possible at all, and it is general:
  nothing in the file knows what a book is, only that two things share
  unusual words.
- **Capped at six lines and deduplicated.** A promise lives as both a fact and
  an episode by design, so both qualify, and printing both makes a short block
  look like padding — which teaches the model that the block is padding. A
  long list under a heading saying "this is relevant" is the flat list again
  with a new label.
- **Silent on most turns.** Measured on ten realistic sentences: five carried
  a block, mean ~60 tokens, and the goal block is ~180 tokens on every turn.
  About 3% on top of the ~7,200 a turn already costs, for the thing that makes
  the memory do any work at all.

**The stemmer had a bug of exactly the shape this file exists to avoid.**
`"notes"` lost its `es` and became `"not"` — a stopword — so "I need to send
those notes" matched an open commitment about sending notes on precisely zero
words. `es` now comes off only after a sibilant (boxes, dishes), `ing` undoes
a doubled consonant (running → run, but falling → fall), and `npm run verify`
tests both. Nothing in a type system can see that one: it looks like the
feature simply not working.

## The long memory

`src/lib/memory.ts` is forty one-line facts sent with every turn. `src/lib/life.ts`
is the other half: the people, projects, places and ideas in someone's life,
each with its own facts, plus dated **episodes** of what happened — and it is
sent with no turn at all. It is searched when something asks about it, by
`memory.search` and `person.brief`. The two are not redundant: one is what must
always be in mind, the other is what must be findable in March.

**Nothing here costs a model call per turn.** A finished turn appends to a
buffer; every dozen turns, or when Grove is next opened, `consolidate.ts` makes
one call that reads the buffer and returns entities and episodes. Measured: twelve turns of real
conversation, one call, 3.6 seconds, six people and projects and six dated
episodes out the other end.

**The buffer is deleted once read.** That is the privacy line, and it is the
same one `transcript.ts` draws at thirty exchanges: Grove listens while you
walk around, so it keeps what things meant and not what was said. Everything it
keeps is readable and deletable on the Memory screen, because a memory you
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

## What keeps going wrong

`src/lib/struggles.ts` records friction — a thing that goes wrong more than
once — which is the only memory here that earns its place by being about
something the person cannot reliably do. "You always forget your charger."

It was a tutor once: it recorded concepts someone did not understand so a quiz
could test them later. **That was a different product wearing this one's
clothes**, and it is gone — three abilities, a model prompt, a cross-turn
session with an answer key, and a directive that outranked everything else in
the system prompt. Grove is a thing you talk to that answers and acts.

**Twice is the bar.** Everyone forgets something once; a list that records the
first time is a list of someone's bad days. The count is the whole signal and
is shown beside each line. Capped at three in the prompt: ten is a list of
someone's failings read back to them.

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

The one exemption is `link.send`, and it is earned in the type rather than
argued for: the destination is the person's own account, read from
`google.me()`, with no argument that could redirect it. See "Sending you the
thing it found".

The reasoning is the same one `detectActIntent` is built on, taken one step
further: a false positive there costs an email nobody wrote, which is
embarrassing and recoverable. A false positive on a purchase is neither. Uber,
food delivery and shopping were asked for and are deliberately absent, because
the useful version of each is one sentence away from spending money on a
misheard word.

## An update arrives one launch late unless you do something about it

`fallbackToCacheTimeout: 0` means expo-updates never makes anyone wait at
launch: it starts the bundle it already has, downloads a new one in the
background, and runs that one **next** time. The right default — nobody should
watch a spinner because a developer shipped something — and it quietly breaks
the only sentence anyone cares about: *"I pushed an update, you'll have it when
you open it."* You will have it the time after that, with nothing on screen
saying so, which looks exactly like the publish having failed.

`src/lib/updates.ts` closes that at the gate in `src/app/index.tsx`, which is
the one moment a `reloadAsync` costs nothing: no audio session, no turn in
flight, no half-read confirmation. A second later there might be all three, and
a reload then abandons an answer mid-sentence and drops the session the ring
reaches Grove through — so it is **never offered mid-use**. Bounded to a few
seconds, because the gate is the splash screen and a slow connection must not
turn opening Grove into staring at one; past that it starts on what it has and
leaves the update for next time, exactly as before.

Settings has a manual check with no deadline, since someone who just tapped it
has said they are willing to wait. It reports all four outcomes including "you
already have the newest one", because that is the answer half of those taps are
looking for and a button that reports nothing is a button you press twice.

**Quote the iOS update ID from Settings → Version, not the EAS group id.** They
are different ids and `eas update:list` only prints the group, so the two are
easy to compare and conclude wrongly from.

## What it costs, and the two things that decide that

Measured, not estimated, at 60 turns a day on `gemini-flash-lite-latest`:

```
cacheable (byte-identical every turn)
   3031 tok  TOOL_RULES
   4470 tok  functionDeclarations (34 tools)
    401 tok  manner directive
    288 tok  MEMORY_RULES
   8259 tok  TOTAL

rebuilt every turn
    658 tok  memory data
    320 tok  roster + bearing + rhythms + frictions
    600 tok  history
     45 tok  clock + question
   1623 tok  TOTAL

9882 tok per round, of which 84% is cacheable
-> $2.86/month before, $1.19 after
```

### Tokens: the prompt is rules plus data, and only the data changes

Gemini serves a repeated request **prefix** from its implicit cache at a
quarter of the input price. The match is a prefix, so one line that changes
near the top makes the whole request uncacheable — and the clock used to be
**the second line** of the system prompt. The cacheable prefix was 29 tokens
out of 9,882, so every request paid full price for three thousand tokens of
rules and four thousand of tool declarations that were byte-for-byte
identical to the previous one.

So `systemFor` now holds nothing but rules, `contextFor` builds everything
that changes, and the volatile half rides with the question in `contents`,
which is after the system instruction either way. `MEMORY_RULES` keeps the
instructions about memory at system level — which matters most for the goals,
since the sentence saying they are not background is what stopped Grove
helping someone lose ten kilos find a burger — while the facts themselves are
data and move. The register is the one slow-changing thing deliberately left
in the rules: it is an instruction about how to speak, and it shifts over
about thirty turns.

**Nothing breaks when somebody puts a timestamp back in the system prompt. It
just quietly costs four times as much**, which is exactly why `npm run verify`
asserts that the clock, the date, the memory and the bearing are all absent
from it, and that the stable prefix stays above any cache minimum.

### Grounding: billed per search, not per token

This is the line item that can dwarf everything else. Grounding with Google
Search is **$14 per 1,000 queries** on the current lite tier after a free
monthly allowance, and one request can trigger several queries. At this
volume it is inside the allowance and free.

It is free **only because the turn that runs on every single sentence does not
ground.** `toolTurnOnce` sends `functionDeclarations` and nothing else;
searching is something `brief.web` does on purpose. Adding `google_search` to
the tool turn would look like an improvement, would pass every other check,
and would turn a free line item into a per-sentence charge — so verify asserts
the tool turn never asks for grounding, that there is exactly one place in the
codebase that does, and that a researched document fans out to at most five
subjects, since each subject is a separate billed query.

Output tokens are a rounding error: about 0.5M a month, twenty pence.

### Removed rather than optimised

`lightTurn`, `lightSummarise`, `lightAdvice` and `lightNotes` were exported
and called from nowhere — the tool loop replaced the first and the other three
were never wired up. **453 lines**, with `HOUSE_RULES`, `parseReply` and the
types that only they used, and with `LOOKUP_SIGNALS` and `DEEP_SIGNALS` — the
last two keyword gates of the kind this project has been removing. No API
saving, but four prompt builders that would have drifted.

Worth knowing how that goes wrong, because it ate live code twice before it
worked: taking each dead declaration together with the doc comment above it
produces **overlapping** spans, since every walkback reaches into the
declaration before it. Delete those one at a time and the later offsets have
already shifted. Merge the spans first, assert that nothing live falls inside
a merged region, then delete bottom-up.

`phraseAction` was the one I expected to find wasteful and it is not: it is
gated on `holdForTool`, which is only set when the model returned a tool call
with no words, so the second call is never made when the first already wrote
the line.

## Grove for Mac: the phone's hands

`mac/` is a native Mac app, built with the command-line tools alone
(`mac/build.sh`, or `--run` to relaunch it). It lives in the notch and the
menu bar, never the Dock, and does two jobs: it is a computer the phone can
drive, and a quicker Grove at the keyboard.

**The phone stays the brain.** Memory, accounts and the decision about what to
do never leave it; the Mac is told colour, name and manner (so the notch is in
the phone's colours), is handed jobs, and asks the phone what to do with ⌘K
text so the answer comes in the same Grove's voice (`lightSelection`). If the
phone is not there, the Mac falls back to the model with a key `build.sh`
writes into the built Info.plist only — never into a tracked file.

**The link is the person's Noctus account.** Both devices sign in with Google
through Noctus's Supabase project — the Mac from its menu bar icon
(`Account.swift`, Supabase PKCE back to `grove-mac://auth-callback`), the phone
from Settings › Your Mac (`src/lib/mac.ts`) — and join one Realtime broadcast
channel named by a 48-character secret kept in the account's own
`user_metadata.grove_link`, which only that account's sign-in can read. No
pairing code, no server of ours, no shared Wi-Fi needed. The protocol is at
the top of `mac/Sources/Grove/Link.swift`.

- **Not a private channel**, on purpose: those are authorised through
  `realtime.messages`, which Noctus's project does not have set up — a private
  join is refused with "MissingPartition". A broadcast channel never touches
  the database.
- **Signing in on the phone is for the link only.** It does not switch
  Grove's own account: that would key the memory to a different account and
  make Grove depend on the Noctus server, and the link needs neither.
- **Both redirects must be on Supabase's allowlist** (Authentication › URL
  Configuration › Redirect URLs): `grove://auth-callback` for the phone and
  `grove-mac://auth-callback` for the Mac. Without them Supabase sends the
  browser to the Noctus website and nothing comes back.

**Permissions survive rebuilds only with a stable signature.** macOS ties
Accessibility, the microphone and Automation to the code signature, and ad-hoc
signing changes on every build — a grant made before one silently stops
applying while System Settings still shows it on, which is how ⌘K stopped
working. `mac/make-signing-identity.sh` makes a local certificate once and
`build.sh` signs with it. The menu bar has a checklist of all four
permissions, and `~/Library/Logs/Grove/grove.log` says what happened to every
⌘K.

**⌘K is Grove's, except in the few apps that would really miss it.** macOS
does not use it, but Notes, Pages, Docs, Mail, Slack, Notion and Terminal all
do, so Grove registers no hotkey: an event tap decides each press. With text
highlighted it is Grove's, on that text. **With nothing highlighted it is
Grove's too** — the panel opens with the microphone already on — unless the
app in front is on `Shortcut.shared`: an editor's chord prefix, a terminal's
clear, a quick switcher. ⌥⌘K is never shared, which is what choosing it means.

The rule used to be "only when something is highlighted". That is a good rule
for not taking somebody's shortcut and a bad one for being summoned: the point
of a key is that it works when you have nothing in particular to say, and with
nothing selected the only way to reach Grove was to find the notch with a
mouse. The old reasoning was not wrong, it was incomplete — it measured the
cost of taking ⌘K and never the cost of having no key at all. That cost is not
the same in every app, so neither is the answer.

A list, rather than a cleverer test, because there is no way to ask an app
whether it uses a key: AppKit will not say, and judging by whether the press
appeared to do anything means doing it first and looking afterwards, which is
the one thing a shortcut cannot do. It is editable in the notch's settings,
because it is a judgement about how somebody works. An app that will not say
whether text is selected (Chrome, anything Electron) gets the same answer as
one that said "nothing", since silence there would be the press doing nothing
at all — the worst failure a shortcut has.

**A listed name matches a word's beginning, never inside one.** Plain
containment was the first version and was wrong both ways at once: "Code" —
which is what VS Code calls itself, whatever its folder is named — sits inside
**Xcode**, so a list meant to protect one editor's chords took the key from
another by accident rather than by anyone's decision; and a strict word match
would have missed "iTerm2", which is one word and is obviously iTerm.

**The microphone is on unless they turn it off.** A panel with a microphone
already open is the difference between talking to something and operating it,
and not having to touch anything is the whole reason the ring and the glasses
exist. So it opens with the card, and what is said fills the box and sends
itself.

**Every card with somewhere to say something into listens**, and they all have
a microphone button to show it and stop it. That was three cards, and only an
idle panel opened on purpose; both were too careful. Opening the notch and
finding the microphone off is the whole complaint, and "I opened it normally"
is most of how anyone opens it, so gating on a deliberate open meant the common
case was the one that did not work. Thinking and working listen too: that is
the card that is up longest and the one worth talking over — *"no, chicken
parm"* while it is halfway through searching is the entire point of the box
being there, and having to type it is why the box got used once.

**Never over sound.** A job playing a film would otherwise have it transcribed
by the microphone Grove just opened over it and sent back into the same job as
a change of plan. Reading aloud is the same problem in Grove's own voice.

**The button is the switch**, not a one-off. On by default means the only
reason to press it is to stop it, and "stop this sentence" and "stop doing
that" are the same gesture when the next card would open it again a minute
later. Pressing it off is the same thing as the switch in Settings, so the two
cannot disagree, and off that comes back is the press that did nothing.

One rule decides all of it (`openMicOn`), asked once per card inside
`Notch.show` where every card is drawn. Twenty-odd `show` calls each deciding
for themselves is twenty-odd chances for the one that gets forgotten to be the
one somebody has to click. It does not start over a microphone already open,
which would tear the first down mid-sentence, nor over Grove reading aloud,
which would hear itself.

**Never in front of a confirmation.** Every other prompt's worst answer is a
wrong sentence; a confirmation's worst answer is a purchase. A yes stays two
deliberate keys (⌘K then Return) or a press on the card. `npm run verify`
checks it — this is the easy thing to break, because "on by default" is how the
feature was asked for and the confirm card is a card like the others, so a
later tidy-up treating them all alike would read as consistency.

**The window follows the panel.** A transparent window still takes clicks, so
it is exactly the visible panel while open and full size but mouse-blind while
closed. Making it permanently full size swallowed clicks under the panel's
empty corners.

`mac.music` and `mac.open` are the phone's abilities for it, separate from
`mac.do` (the older agent bridge over HTTP). **`mac.use` drives a website**
(`mac/Sources/Grove/Agent.swift`): their own Chrome, so their own sign-ins,
read → model → one move → read again, bounded at a minute a run so the phone
always gets a sentence. It comes back done, with a question (spoken with the
mic open; the answer re-runs it, and the task id is remembered so a dropped id
still lands), or with a summary for a yes. **Code decides the press**: a click
whose label reads like buy, send, submit, book, apply or delete becomes a
confirmation whatever the model called it, only a confirmed re-run sends
`approve`, the approval is for that element on that page, and password and card
fields are never typed into. This is the first ability that can spend money,
and it can only do it through the same yes as `mail.send`.

**How a run stays on track** is general, not per site. A task opens its own
tab, because starting on whatever was in front is how "text my brother" was
sent on Instagram. The first move writes a plan that rides with every move
after. Each click, type or key press is checked against the page it was meant
to change, and the model is told when nothing changed, which is how it
tells a missed press from a working one. The page reader goes into shadow
roots and reads tile and cell states, so a game board is visible at all.
`keys` sends real key presses for pages that listen to the keyboard. Moves are
chosen by `gemini-flash-latest` with thinking, under a second a move, with the
lite model as fallback. Every yes names the button it will press, and a press
already approved is never asked for twice. Runs started on the Mac get four
minutes; the phone's get one, because it is waiting.

**The Mac knows them, cheaply.** The phone sends what Grove remembers with its
colours, and only when it has changed. The Mac seals it with AES-GCM under a
Keychain key, this-device-only (`Vault.swift`, one file in Application
Support/Grove). Only the call that decides an ask reads it, and only the lines
that bear on it, capped at about 1200 characters. That call writes the choice
into the goal ("put on Interstellar, they like Nolan"), so the browser's moves
never carry the memory at all.

**A task picks its tab; it is not handed a new one.** A new tab every time
fixed "text my brother" landing on Instagram and caused the opposite failure:
YouTube open, "now play this song", a second YouTube. So a task starts with no
tab and its first move sees their open ones, marked in front and last task's,
and takes one already on the right site or opens a new one. Readiness asks
Chrome, never a remembered tab: checking the last task's tab after it was
closed failed every task for an afternoon, each reported as Automation being
off. A tab closed mid-task is noticed and replaced, not fatal.

**Chess is a board, not buttons.** The reader names every piece by square
(chess.com classes, lichess transforms) and `move` turns squares into a drag:
page events first, a real mouse drag if the page ignores them. A board found
makes the run a game, which goes until it ends (forty minutes, five hundred
steps), and waiting on the opponent watches the board instead of calling the
model. The loop guard compares the whole move, from and to included; it
compared label and text only, so every chess move looked like the same one
and the third was called going in circles. It plays legal, weak chess.

A phone run answers the phone after fifty seconds with `working` and carries
on; a song not in the library plays on YouTube rather than opening Music's
search, which played nothing. Library search tries title and artist split
both ways, since "Feel Good Inc. Gorillaz" is no field's value.

**The Mac remembers the last twenty minutes, in layers.** "Open YouTube",
then "put on the Fred again set": the second sentence used to be decided as
if nothing had come before, so it opened another YouTube or played the set in
Music. `Recent.swift` keeps what was said, what Grove did and how it ended
(and where), in memory only, and it rides with every decision and with the
browser agent's first move. The decision writes the place into the goal ("in
the YouTube tab already open") rather than leaving "this" to be guessed.

**Asking is a field, not an option.** Offered "ask" beside "do", the model
chose "do" and started a chess game nobody said it should play. So every
"do" fills `question` by `Thinking.askRule` (theirs, consequential, not
already settled), and a question means nothing starts. The same rule is in
the agent's brief, so a fork found mid-task is asked the same way. "I'll
play" sets the game up and stops; "stop" or "I've got it" is a `stop`
decision. A new task stops a running one first: two loops once drove the
same tab.

**Sight for what text cannot carry.** A page that is mostly canvas, video
or frame, or a model that asks to `look`, gets a picture of the Chrome
window (`screencapture -l`, Screen Recording) and may click a point on it.
A script click that changes nothing is pressed again with the real mouse,
only then, so a click that worked is never doubled.

**Stop is a generation, not a flag.** Every start, resume or stop moves
`current` on, and a run whose number is stale ends at its next step. The flag
it replaced was reset by the next run to start: Stop pressed six times while
a chess game kept moving, and closing its tab sent it back to chess.com.

**The phone hears everything the Mac does.** `news {what, state, said, task,
speak}` goes to the phone when any Mac job ends and for every ask decided at
the Mac, so the phone, which is what talks to the glasses, has the context
for the next sentence. It is spoken only when the phone started the job and
had stopped waiting, and only while Grove is resting; a question opens the
window, since it is part of a job they asked for. News and job results are
held in an outbox through a reconnect rather than lost to one.

**An action needs the words that asked for it.** Every non-read tool takes a
required `asked` quote, and `askedFor` checks it against this sentence and
the one before. "goon session" became calendar events whenever the model
did not understand; now an action nobody's words ask for is refused before
it runs and the model is told to ask_back. The opening glance is a greeting
for the hour and never remarks on Grove's own work.

**A done is checked by a reader that did not do the work.** The mover is
generous about its own work: five moves of 2048 called playing it, a
crossword answer typed into a hidden box called filled in. `Agent.check`
reads the goal, what happened and the page (and the window, with Screen
Recording) and only "achieved" is accepted; three refusals are said as a
failure. A done after a move that changed nothing, or with no move at all,
is sent back to look first.

**Grove learns sites** (`Lessons.swift`). A task that took some doing ends
with one lite call that writes what is worth knowing next time — how a site
works, what to close first, where a frame lives — sealed by site in the
vault and handed to every later task there. Nothing about the person, and
nothing about Grove's own plumbing (a JavaScript refusal once taught
"handle permission blocks" to nytimes.com).

**The reader reads where the page is.** Text came from the top of the page
whatever was scrolled to, so the ingredients of a recipe were never in it;
it is now taken from the scroll position, and `find` searches the whole page
like ⌘F. Popups are named and their buttons listed first; frames from other
sites are listed by address, since their insides cannot be read. Named keys
(ArrowDown) are pressed, not typed. Text a page ignores is typed for real.
Every Chrome call is bounded at twelve seconds, and tabs in a profile where
JavaScript is off are not offered.

**Cheap by default, deep when it says so.** The decision used to get "whatever
fits" of the memory on every ask, which put a favourite philosopher in the room
for every sentence. It now gets only the lines sharing a word with the sentence,
and may reply `need` for the whole memory or a picture of the window in front,
one extra call, only then. It is told a memory line is not news about today, and
"I do not know" is an answer.

**What they say at the Mac is what they told Grove** (`Told.swift`). It reached
nothing: "I'm working on a psych midterm" was gone by morning, and an apology for
a wrong claim changed nothing stored. So a decision carries `remember` and
`wrong`; they apply at once, sealed here, and go to the phone (`fact`, and `heard`
for the long memory), held through a reconnect. `memory.correct` is the phone's
half. `demoMemory.ts` is why so much of it read as invention: filled on a real
account, the sample life came back as fact, so Settings offers to clear it when
it is there, matched on the exact sample words.

**Apps are apps** (`Native.swift`). `open` is its own kind and never reaches the
browser agent; a site is focused where it is already open. The agent can work in
any Mac app by sight: `app`, then a picture each step, real clicks and paste. In
anything that reaches a person, words marked for a person hold every later press
for a yes, in code, since a picture of a send button has no label to check.
WhatsApp goes through its own link when Contacts has a number, by sight when not.

**Opening Grove on the phone opens the microphone**, with a chime and the long
window, only on really arriving from the background or launching, never over a
turn or during the intro. This is them picking it up, which is a different thing
from Grove starting a conversation.

**Messages is a catalogue, and readable** (`Inbox.swift`). Contacts knows who
was saved; Messages knows who they talk to, so its people, names and handles
only, answer when Contacts cannot. The messages themselves are read from
`chat.db` on request, with Full Disk Access: a recent handful for one answer,
kept nowhere, and not in the long memory, because they are other people's words.

**A yes from the keyboard is two keys.** ⌘K arms and shows what it approves, for
eight seconds; Return says yes, Esc says no. A Return alone is someone typing and
must never send anything, and a question must have been up a full second, so a
press landing as it appears cannot approve what nobody has read.

**The Mac reports back like someone doing a job for you.** Results and questions
are spoken on the phone when the job came from the phone and outlived its wait,
when they have left the Mac, or when it ran over twenty seconds; otherwise they
reach the Talk screen with a tap. Long jobs give word at twenty-five seconds, then
less and less. What must be said is acknowledged and resent until it arrives (a
broadcast is fire and forget), and waits for Grove to finish its sentence.

**Typing replaces.** What a `type` puts in a box is what the box says afterwards,
and it is read back to check. Rich editors (Instagram's, Slack's) keep their own
copy of the text and ignore a script replacing it, which turned revising a
message into the old words, the new ones and a run of Backspaces; when the box
does not say what it should, it is clicked, selected, cleared and pasted by hand.

**Stop is done in code** (`cancelling` in closing.ts, and askFree on the Mac).
"Never mind" always, and a bare "stop" when something is going, stops speech, a
pending yes, a plan, the Mac's job and the reading, with a word and no model.
Through the model it cost a "one second" before the "stopped".

**Pause reaches whatever is playing** (`Player.swift`): Music, video in Chrome,
Spotify, then the system play/pause key when something is still making sound.
It says "nothing's playing" rather than "paused" when nothing was, and logs each.

**With the Mac there, nothing opens on the phone.** `food.order`, `shop.order`
and `message.compose` check `macReachable()` first and hand the whole job to
`mac.use` (`onTheMac`), where the cart, the checkout and the send each take a
yes on the real button. Calendar, mail and reminders open nothing and are
unchanged; calls, directions and rides stay on the phone because they are
about where the phone is.

**Music asks once where it plays** (`place.ts`, `musicRoute` in brain.ts). With
the Mac there and nothing chosen, a play is answered with "Your Mac or your
phone?"; after that a play aimed at the other device is moved to the chosen
one. `music.where` changes it, and with move "yes" carries the song across:
the Mac's `music.now` reads what is playing, it is paused there and found here.

**A choice is named by its words, and ticked once.** Uber Eats' options were
read as `52467a0e-…`: a radio button has no text of its own, so the reader fell
back to its value, an id, and the agent chose blind. Controls are named by their
label (`labels`, `aria-labelledby`, the wrapping label, the row around them) and
never by an id-shaped value, with "checked" or "not checked" from the control
itself; a control hidden at 1px is listed as the label you would press. And a
tick changes a property, not the page, so the real-click fallback compares
checked states and field values as well as mutations: it used to tick a box,
see nothing change, and click again, unticking it.

Texts go through Messages, not a website (`agent.message`): the person is
found in Contacts by name or relation, a pick among several is remembered,
and the exact words are read back before sending.

**GIF reactions** are a toy, off until switched on in the notch's settings.
The search words ride on the decision already being made (`gif` in
`Thinking.decide`), so a reaction costs one GIF search and no model call, and
it plays in its own corner window (`Popup.swift`) rather than on the card,
which is for what happened. Searched on GIPHY with `GIPHY_API_KEY` from
`.env`, written by `build.sh` into the built Info.plist only.

What is said on the phone reaches the Mac's GIFs too (`said`, only while
connected, kept nowhere): the same rule picks a face or none, at most one a
minute, never over a reaction already up, never to a locked screen. Searches
drop filler and keep the front, because the action comes first: the old
fallback kept the last two words and searched "at chessboard".

**It can see what you are doing, roughly** (`Context.swift`): the app in
front, its window title, and the song in Music, a few hundred characters on
every ask and nothing read from inside a window. "What do you think of this
song" used to be answered about the clipboard, because a word gate decided
"this" meant what was copied; now the clipboard is used only when it is named,
and the model reads "this" against the screen. Opening the notch gets a
one-line remark on the same picture in place of the greeting, only when
something changed and never twice in three minutes.

Chrome needs View › Developer › Allow JavaScript from Apple Events ticked once.
It is a security setting, so Grove says where it is and does not flip it.

### Grove as a conduit: handing a job to another AI

`mac/Sources/Grove/Delegates.swift`. Grove is one lite model with a calendar
and a pair of hands. It is not the best thing to ask for a thousand lines of
code, a long piece of research or an image, and pretending otherwise produces
the worst answer in the app: a confident paragraph from a lite model where
somebody wanted the real thing. Their Chrome is already signed in to things
that *are* good at those, and they are already paying for them.

So "ask Claude to write the cover letter" is a browser job like any other —
open the site, type into the box, press Return — and the agent could already
do every one of those steps. Three things made it do them badly:

- **It answered instead of asking.** A model handed a question answers it;
  that is what a model is for. Nothing said that naming another assistant is
  an instruction about *where the work happens*, so the one reply they had
  ruled out is the one they got. `Delegates.rule` is in the decision's brief.
- **It called it done once the prompt was typed.** The same generosity as five
  moves of 2048 called playing it. A prompt sitting in a composer looks
  exactly like a finished job if nothing says otherwise, so the answer — the
  entire point — was never waited for and never read back.
- **It paid a model call for every two seconds of somebody else's thinking.**
  `Browser.awaitWritten` watches instead, the same trade as `awaitBoard`:
  finished is measured as *stopped growing*, not as any site's own "it is
  writing" marker, because every one of those is a different class name on a
  different div and text that has stopped getting longer has stopped
  everywhere. Two quiet polls, because these answers arrive in bursts. It
  waits for the answer to *begin* too — the length right after Return is the
  prompt sitting in the box, which is already "not growing".

It is not a second brain: nothing in the file decides anything. A delegate is
a destination plus a page of notes about that destination, handed to the same
mover, with the same confirmations in front of anything irreversible. A
delegation may never set `confirmed`, and `npm run verify` checks it.

**The whole risk is a false positive**, because the note tells the mover to go
to claude.ai and getting it in the middle of an Uber Eats order is worse than
never having the feature. So a hand-off needs a verb of handing over
**immediately in front of the name**: looking for the verb anywhere in the
sentence turns "use the cursor keys to move" into a hand-off to an editor,
because it contains "use" and it contains "cursor". A missed delegation just
runs as an ordinary browser task, which is what happened before the file
existed; a false one derails a job somebody actually asked for.

Read from the goal **Grove itself wrote**, which is the same licence the
hand-over phrase has: a phrase may decide something here only because it is
this app's own output and not somebody's speech. And the seam comes off what
is handed over — the goal reads "Ask Claude to write a cover letter", and
pasting that whole sentence into Claude is asking Claude to ask Claude.
Failing to find the seam sends the whole goal instead, which reads oddly and
still asks for the right thing: a clumsy fallback that cannot be wrong beats a
clever rewrite that can.

A delegation gets four minutes rather than the phone's one, because most of it
is somebody else writing.

### What costs nothing is not what a lite model can skip

`gemini-flash-lite-latest` has no thinking to configure, and it does not
ignore `thinkingConfig` — it refuses the whole request, 400
INVALID_ARGUMENT, before reading a word of it. The browser agent sent it
`{"thinkingBudget": 0}` on its fallback leg, which exists for when the better
model is slow or down, so it could only ever be reached on the one day it
mattered and it always failed there. On screen: "I couldn't work out the next
step on your Mac". In the log: no move from either model, which reads like the
network rather than like a field we sent ourselves.

**A dead fallback is the worst kind of dead code**: it type-checks, it is
never reached on a good day, and it is missing on the bad one.

### A panel is as tall as what is in it

Every notch state sets a height, and a height set by hand is a guess about
content that has since changed. The two states that grew a typing box were
raised by hand to make room and then kept the raised number when the box
turned out shorter than the guess — a third of the card was empty glass under
the box, which reads as the panel having failed to draw rather than as a panel
with nothing more to say. `fit(max)` was already there for the answer states:
the hand-set number stops being the height and becomes the ceiling.

### The decision stays on the lite model, measured

Asked to improve the reasoning behind "what is a cool thing I could do",
the obvious move is the bigger model. Measured against the real brief on ten
sentences: `gemini-flash-latest` is **50% slower** (2.3s against 1.5s) and
was the one that offered chess for "play a game with me". The chess bias was
already fixed by the rule in the brief, not by model size. Left alone.

### Working beside them, not on top of them

A run used to open its tab in whatever Chrome window was in front — theirs,
with their tabs in it — and in Chrome a new tab becomes the active one. So
starting a job took over what they were reading, and every later step scrolled
and clicked inside the window they were trying to use. Then the first real
click left Chrome in front for the rest of the task, so the next forty steps,
which needed nothing at all, looked exactly like Grove hogging the machine.

Three things, each a different half of getting out of the way:

- **Its own window** (`Browser.ownWindow`), made once and kept. Their tabs are
  never touched and their scroll positions survive. **A tab they chose is
  still theirs**: the model may take one with `tab` when the job belongs there
  ("play this in the YouTube I already have open"), which is a different thing
  from Grove helping itself to the front window. If Grove's own window
  inherits a profile with JavaScript from Apple Events off it cannot be read,
  and only then does it fall back to a tab in one of theirs.
- **The screen is borrowed and given back** (`Browser.borrow`). Most of a run
  needs nothing in front: a click or a key sent into the tab is invisible and
  free. Only the fallbacks need the screen — a page that ignores a scripted
  click, a game on a canvas, a picture of the window — and those are a real
  mouse and real keys, which go wherever the system is pointing.
- **And they wait for a gap.** Taking the keyboard out from under somebody
  mid-sentence puts their words in Grove's window, and the cost of that is not
  a lost keystroke, it is having to go back and find what it broke. A second
  and a half of stillness is the signal; typing has one constantly. It gives
  up after ten seconds and goes anyway, because somebody typing without a
  pause for ten seconds is working, and a task that waits for them for ever
  has quietly failed rather than been polite.

An app driven by sight (`desk`) waits for the same gap and then **keeps** the
focus, because working in a Mac app by sight genuinely needs it in front for
several steps together and handing it back between each would fight the job.

Two things here were measured rather than reasoned about, and both read
perfectly sensibly in the version that did not work:

- **`kCGAnyInputEventType` counts synthetic events.** The obvious reading is
  that it measures their hands. It does not: seventy-two seconds of genuine
  stillness, one key posted by Grove, and it came back 0.6. Left like that the
  only thing reliably resetting the gap would have been Grove's own last
  click, so every real click waited a second and a half for itself and the
  feature read as Grove being slow rather than polite. So the last event's
  moment is compared against the last one Grove posted, and if they are the
  same moment it is Grove's and does not count.
- **`NSRunningApplication.activate()` does nothing** when the caller is not
  itself in front, and reports success. Measured: Terminal in front, Chrome
  taken, `activate()` called, Terminal still not back. The focus goes back
  through System Events by unix id — which works, which Grove already holds
  Accessibility for, and which needs no per-app Automation permission, so
  giving the screen back never produces a prompt.

### Phone or Mac, without being told

Every Mac request used to need "on my Mac". "Play wordle" went nowhere, and
"order the green curry instead" went to the phone's food hand-off while the Mac
sat on the Uber Eats cart it had been building. **Nothing in the turn said what
the Mac was doing**, so every sentence was read as if the conversation had just
started.

So `macContext()` (mac.ts) puts a few lines of fact into the per-turn context:
whether the Mac can be reached, and what it last did with its state and task
id, for half an hour. The rules for using them ("Phone or Mac" in `TOOL_RULES`)
are in the cached half. **The phone is the default.** The Mac is for what needs
a screen and a signed-in browser, and a sentence that carries on Mac work stays
there, as `answer` plus `task` on `mac.use`. That resumes the same task in the
same tab, which the Mac keeps for ten minutes after its last step. Past that,
`mac.use` restarts it instead of saying "I lost track".

**A Mac that cannot be reached is explained by the model, not a canned line.**
The context says so, and the model, told nothing can be done on it, answers
about this job and reaches for a phone tool if one fits ("order me a burrito"
falls back to the Uber Eats hand-off). If it calls a Mac tool anyway, brain.ts
hands the call back as a result rather than running it, so the reply is still
the model's. That costs one more round, only on that path. `macReachable()`
sends one hello and waits three seconds before saying no, because the
heartbeat is a minute and a Mac opened thirty seconds ago otherwise reads as
asleep.

Measured live: wordle and Instagram reach the Mac unprompted; calendar and
"play some music" stay on the phone. That last one needed the phone music tool
to say it is the default, since "the Mac is on" was being read as a reason.
Carrying on with a pending order and "finish the rest of them" both resumed
the right task. With the Mac asleep, all three replies said so in their own
words with no extra call.

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

It also **checks itself**. Several sections read a stretch of source between
two landmarks, and the most expensive failure a harness can have is not a
check that breaks — you see those — but one that silently stops checking and
keeps printing `ok`. That happened here: a slice lost its end landmark to an
unrelated edit, `indexOf` returned -1, and `slice(start, -1)` returned most of
the file. That was the *lucky* direction; lose the start landmark instead and
the slice is empty, every "this region does not contain X" passes against
nothing, and the guard between an offer and a payment reports success while
guarding air. So every such read goes through `between()`, which asserts both
ends and an expected size and returns null rather than guessing, every caller
is written `region !== null && …`, and a section feeds `between()` a missing
landmark to prove it fails rather than passes.

The same fault turned up twice more, both times found by running the fix rather
than reading it. A check let Settings off by pointing at the shared `Screen`
wrapper, which holds no `TextInput` and so was never itself checked — deleting
the keyboard handling from `Screen` broke every screen using it while every
check printed `ok`. **A delegation is only worth accepting if the delegate is
the thing being asserted.** And the verdict at the bottom of the file was
reached synchronously, so an `async` section scheduled its checks and
`process.exit` ran first: thirteen checks printed a heading and nothing else,
with the tally unaffected. Async sections are registered with `laterSection`
and awaited before the count is read.

That one was worth fixing rather than avoiding, because **an ability is an
async function, and the only way to assert what one does rather than what its
source looks like is to run it.** It is how "memory before contacts" is
checked at all: `findContact` is made to throw, and the send has to succeed
anyway. Grepping for two calls cannot tell which runs first.

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
