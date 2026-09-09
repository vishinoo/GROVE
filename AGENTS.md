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

- `src/lib/grove.ts` — two gates, and the difference between them is the whole
  safety story. `detectActIntent` decides whether a sentence causes something to
  happen; it refuses every question, is deliberately keyword-based, and is
  biased toward "no". A false negative costs a sentence; a false positive sends
  an email. `detectLookupIntent` is the narrower second gate: it admits
  questions that name something lookable, and abilities marked `reads` are the
  only ones it can ever run. It exists because refusing every question meant
  "what's on my calendar" was answered from the model's own head, which produced
  "nothing on" for a full calendar — a confident, specific lie, which is worse
  than any amount of hedging. **Never delegate either of these to a model.**
  When adding an ability, leave `reads` unset unless running it truly only
  reads: the default is the safe direction to be wrong in.
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

## Money

No ability spends any. Nothing buys, orders, books, or authorises a payment, and
nothing that does may be added without the person seeing the amount and
confirming it in that moment — not a setting, not a standing permission, a
confirmation at the time.

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
