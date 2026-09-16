# Grove

A companion app for a pair of Bluetooth AI glasses and a ring. One agent, spoken
to hands-free, that reaches for Noctus tools when a job needs one.

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
- `src/lib/lightModel.ts` — no longer holds a key. The model call goes through
  `POST /api/grove/chat` on Noctus, which holds the secret and forwards. It was
  a bundled `EXPO_PUBLIC_*` key until 2026-09-07; that was documented as testing
  only and stopped being acceptable when a build reached TestFlight. Everything
  outside this file is provider-agnostic, so swapping provider is still one file.
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
