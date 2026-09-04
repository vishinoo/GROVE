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

## Where the rules live

- `src/lib/grove.ts` — `detectActIntent` decides whether a sentence causes
  something to happen. It gates every tool run and is deliberately keyword-based
  and biased toward "no". A false negative costs a sentence; a false positive
  sends an email. **Never delegate this to a model.**
- `src/lib/persona.ts` — the manner is user-authored and goes into a system
  prompt, so `mannerDirective` wraps it to quarantine it as style-only. It is a
  guard, not a guarantee; keep the framing when editing.
- `src/lib/lightModel.ts` — ships a provider key in the bundle. Testing only;
  the fix is a `/api/chat/light` endpoint on Noctus. Everything outside that file
  is provider-agnostic, so the swap is one file.

## Checks

```bash
npx tsc --noEmit
npx expo lint
npx expo export --platform web    # catches bad imports across every route
npx expo install --check
```
