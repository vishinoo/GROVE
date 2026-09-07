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

## Noctus is plumbing, not a brain

Grove used to send every turn to Indy and pick from a catalogue of 74 Noctus
agents. Both are gone. That catalogue was a *business* catalogue — 15 Marketing,
10 Operations, 8 Finance, 6 Sales — and three of its seventy-four resembled
anything a person does with their own day.

Noctus now does three things and has no opinion about what Grove can do:
authenticate the user, broker OAuth, and run scheduled sparks. `noctusApi.ts`
holds only those; there is no agent endpoint left in `src/`.

What Grove can do lives in `src/lib/abilities.ts`, as functions. Each declares
`where`: `server` runs at 07:00 with the phone asleep, `device` needs the phone
awake. **That line decides what can be scheduled**, and the UI must say so
rather than let a briefing quietly not arrive. See
`docs/superpowers/specs/2026-09-05-life-os-design.md`.

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

## Checks

```bash
npx tsc --noEmit
npx expo lint
npx expo export --platform web    # catches bad imports across every route
npx expo install --check
```
