# Grove

A companion app for a pair of Bluetooth AI glasses and a ring. One agent, spoken
to hands-free, that reaches for a tool when a job needs one.

You press the ring, say something, and Grove answers into your glasses. The
phone stays in your pocket.

---

## The five things worth knowing before you read any code

**1. There is no Bluetooth code in this app, and there should not be.**
The "AI glasses" are an ordinary Bluetooth headset. iOS routes the microphone
and speaker to them once paired, so `src/lib/speak.ts` speaks into whatever the
current audio route is and never knows what that route is. The one thing worth
checking is A2DP versus HFP — glasses connected for playback only will play
Grove's voice into your ear while the *phone* listens, which is surfaced on the
Talk screen rather than left to be discovered.

**2. The ring is a media remote, not a peripheral we talk to.**
iOS gives no third-party app access to a Bluetooth HID device's key presses, in
the foreground or out of it. What it does give is the remote command centre —
the transport controls on a headset — delivered to whichever app is currently
"now playing". So Grove becomes that app: `modules/grove-remote` holds an audio
session, renders silence to keep it alive, and publishes now-playing info.
A cheap BLE ring that pairs as a media remote then reaches Grove for free, with
the screen locked and the phone pocketed.

**3. Grove cannot be woken from a terminated state.**
No API, no entitlement, no workaround. Backgrounded is fine, locked is fine,
force-quit is not. Do not promise otherwise in copy.

**4. Three decisions are local, keyword-based, and never given to a model.**
`detectActIntent` in `src/lib/grove.ts` decides whether a sentence causes
something to *happen*. `parseSchedule` in `src/lib/sparks.ts` decides whether it
keeps happening. Both are deliberately boring and biased toward "no": a false
negative costs one more sentence, a false positive sends mail you did not write
or wakes you at seven every morning for something you asked once.

`detectLookupIntent` is the third, and it is narrower rather than looser. A
question never sets off an action, but a question that names something lookable
— your calendar, the weather, how long the drive is — may run an ability marked
`reads`, and nothing else. Without it Grove answered "what's on my calendar"
from its own head and told you the day was empty while you were looking at it.

**5. Anything native is probed at runtime, never statically imported.**
`src/lib/capabilities.ts` uses `require` inside `try`/`catch`. A static import is
hoisted and evaluated before anything else runs, so on a build without the native
half it takes the whole bundle down before the first screen renders. The payoff
is that every route stays bundlable without a device build. Do not "clean this
up" into static imports.

---

## Getting it running

```bash
nvm use                 # Node 20 (see .nvmrc)
npm install
cp .env.example .env    # then fill it in — see below
npm run check-model     # confirms Grove has a model it can reach
npm start
```

You also need the Noctus backend running, which is a separate repository:

```bash
cd ../NOCTUS/Backend && npm run dev     # dev, not start — it has --watch
```

`EXPO_PUBLIC_NOCTUS_URL` must be this machine's **LAN IP**, not `localhost` — a
phone cannot resolve `localhost` to your Mac. It drifts when the DHCP lease
renews; if Grove says it cannot reach Noctus, check that first:

```bash
ipconfig getifaddr en0
```

### What works without a device build

`expo-calendar` ships inside Expo Go, so calendar, reminders, weather, mail and
memory all work by typing to Grove on your phone or in a browser. Listening and
the ring do not: those need native code Expo Go does not carry.

### Builds

| Profile | What it is | When |
|---|---|---|
| `development` | Loads JS from Metro. Instant reload, tethered to your Wi-Fi. | Working at your desk |
| `preview` | JS embedded, installs by link. Runs anywhere. | Testing on the go |
| `production` | Store distribution. | TestFlight |

```bash
eas build --profile preview --platform ios
eas update --branch preview --message "what changed"   # JS only, ~30 seconds
```

Only *native* changes need a rebuild. Anything in `src/` can go over the air.

---

## How a turn works

```
ring press ─▶ listen.ts ─▶ grove.ts ─────────────────────────▶ speak.ts
                              │
                    ┌─────────┴─────────┐
                    │                   │
              local rules          light model
         (act? recurrence?)     (answer + which ability)
                    │                   │
                    └─────────┬─────────┘
                              ▼
                        abilities.ts
                    ┌─────────┴─────────┐
                 device                server
          calendar, reminders,    weather, mail,
          music, maps             the model itself
                                        │
                                     Noctus
```

Two tiers, cheapest first. Tier 0 is free and local. Tier 1 is the only model
call, and it goes through Noctus so no key ships in the app.

---

## Where things live

```
src/
  app/            Screens. expo-router, so the file tree IS the routes.
    (app)/        Signed-in: Talk, Sparks, Connections, Settings
    login.tsx     "Log in with Noctus" — there is no Grove account
    onboarding.tsx
  lib/            Everything that is not a screen. Start here.
    grove.ts        The brain. One turn, end to end.
    abilities.ts    What Grove can do. Add a function, not an agent.
    sparks.ts       Standing instructions and their triggers.
    memory.ts       Durable facts, capped, subject-keyed.
    modes.ts        Situations: manner + allowed abilities + rate control.
    capabilities.ts Runtime probe for native modules.
    listen.ts       The ear.        speak.ts   The mouth.
    trigger.ts      The ring.       persona.ts How Grove talks.
    deviceCalendar.ts  EventKit.    connections.ts  What it may reach.
    noctusApi.ts    Auth + OAuth.   net.ts     One authed call.
  components/     Orb, app icons, the shared UI kit.
  context/        session (who you are) and agent (what Grove is doing).
modules/
  grove-remote/   Local Swift module: audio session, ring, music, MapKit.
docs/superpowers/specs/   Design notes and the roadmap.
scripts/          check-model, set-key, check-node.
```

### Adding an ability

One function in `src/lib/abilities.ts`. It needs an id, a sentence describing
it, argument descriptions the router fills from speech, and `where`:

- `server` — Noctus can run it at 07:00 with the phone in a drawer.
- `device` — needs the phone awake. No server can play a song into your glasses.

That field decides what can ever be scheduled, so get it right.

Set `wired: false` while the implementation does not exist. An ability that is
declared but not built must *say so* — silently doing nothing is the worst
failure shape for something you talk to, because you find out mid-walk.

---

## Checks

All four must pass before a commit that touches dependencies.

```bash
npx tsc --noEmit
npx expo lint
npx expo export --platform web    # catches bad imports on every route
npx expo install --check
```

There is no test runner. Pure logic is covered by node scripts run against
`tsc` output — see `scripts/` and the pattern in the git history. This was a
deliberate trade to avoid a test-framework dependency; if you add one, `jest-expo`
is the option that fits.

---

## Things that are true and stay true

- **Expo SDK 54 is pinned.** The dependency tree is aligned and
  `npx expo install --check` is clean. Bump the SDK as its own change, never
  alongside feature work.
- **Grove keeps its audio session alive by playing silence.** This is what makes
  the ring work, and it is the single most likely cause of an App Store
  rejection in the whole project. Fine for personal builds and TestFlight
  internal testers. If Grove is ever submitted publicly, that is the thing to
  argue for or replace.
- **iOS will never let Grove read your Messages or another app's
  notifications.** No API, no entitlement. Stop planning around it.

See `AGENTS.md` for the same ground rules in the form the codebase's own
tooling reads, and `docs/superpowers/specs/` for design notes.
