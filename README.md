# Grove

The voice in your glasses.

Grove is one agent you talk to hands-free. You press the button on your ring —
in a pocket, screen locked — say what you want, and hear the answer through your
glasses. When a job needs real work done, Grove reaches for a tool on
[Noctus](https://www.noctusai.org): your calendar, your mail, whatever you have
connected.

It is a companion to the hardware, not a destination. Most days you should not
open it.

## How the hardware actually works

Neither device needs a driver, and Grove contains no Bluetooth code.

**The glasses** are an ordinary Bluetooth headset as far as iOS is concerned.
Pair them in iOS Settings and the system routes microphone and speaker to them;
Grove just talks into whatever route is current. The one thing that can go wrong
is a pair that connects for playback but not for capture — Grove would speak into
your ear while the phone listened — so the Talk screen says **playback only**
when it sees that.

**The ring** reaches Grove as a media remote, the same signal a headset's
play/pause button sends. Grove holds an active audio session, which makes it the
system's "now playing" app, which is what makes iOS deliver those presses to it
with the screen locked.

### The limit, stated plainly

iOS does not let any third-party app be woken from a fully terminated state by a
button press. There is no API for it. **Grove has to be running for your ring to
work** — backgrounded, locked and pocketed are all fine; force-quit is not. In
practice Grove is a thing you start once and leave resident, which is what
"always on" means here.

Settings → Hardware → *What is my ring sending?* shows every raw signal iOS
delivers. If your ring's buttons appear there, they work. If nothing appears,
that ring is not a media remote and cannot reach Grove — check whether it starts
and stops music from the lock screen.

## Running it

Node 20+ is required. There's an `.nvmrc`.

```bash
nvm use
npm install
cp .env.example .env    # then fill in the values below
```

**Grove needs a development build.** Expo Go cannot carry speech recognition,
background audio, or the native module that receives the ring:

```bash
npx eas build --profile development --platform ios
npx expo start --dev-client
```

`npx expo start` on its own still works and is still useful — the app runs in
**reduced mode**, where you type to Grove and it speaks back through the phone.
Everything downstream of the microphone is real, which is what makes the app
developable without a device build. The Talk screen says so rather than
pretending.

## Configuration

| Variable | What it's for |
|---|---|
| `EXPO_PUBLIC_NOCTUS_URL` | Noctus base URL. Defaults to `https://www.noctusai.org`. |
| `EXPO_PUBLIC_NOCTUS_SUPABASE_URL` | Noctus's Supabase project — same value as Noctus Frontend's `VITE_SUPABASE_URL`. |
| `EXPO_PUBLIC_NOCTUS_SUPABASE_ANON_KEY` | Same as Noctus Frontend's `VITE_SUPABASE_ANON_KEY`. Public client key by design; the service key never belongs in an app. |
| `EXPO_PUBLIC_ALLOW_DEV_LOGIN` | `1` shows a dev sign-in button that sends the literal token `dev-token`. Needs `DEV_AUTH_BYPASS=true` on the Noctus backend. |
| `EXPO_PUBLIC_GEMINI_API_KEY` | Optional cheap tier. **Testing only** — see the warning in `src/lib/lightModel.ts`. |
| `EXPO_PUBLIC_OLLAMA_URL` | Preferred over Gemini when reachable, because it's free. LAN only. |

### One step that lives outside this repo

**Sign-in will not complete until Noctus's Supabase project allows this app's
redirect.** The URL scheme changed from `mosaic://` to `grove://` in this
rebrand, so an existing project needs the new one added. In the Supabase
dashboard, under *Authentication → URL Configuration → Redirect URLs*:

```
grove://auth-callback
exp://<your-lan-ip>:8081/--/auth-callback     # development only
```

Without these, Supabase rejects the redirect and the browser closes with no
session. The sign-in screen's *Finish sign-in* field recovers from exactly this
— paste the address the browser ended up on and it extracts the session. The dev
sign-in path needs no Supabase configuration at all.

## How it fits together

There is no Grove account. Noctus authenticates through Supabase and its API
verifies that JWT, so a Grove user *is* a Noctus user.

- **Sign-in** — `src/lib/noctusAuth.ts`. Google OAuth or an email magic link.
- **The brain** — `src/lib/grove.ts`. Three tiers, cheapest first: local rules
  decide whether a sentence should *do* something; a cheap model handles the
  conversation; Noctus's `/api/indy/chat` handles anything needing the real
  account. **No LLM key ships in this app** — a mobile client can't keep one
  secret.
- **Tools** — `src/lib/tools.ts`. Noctus's built-in agents, recast as
  capabilities the one agent reaches for. A tool is `ready`, `blocked` (installed
  but missing an integration) or `available`. That middle state is the one the
  UI works hardest to explain, because it fails silently in your ear.
- **The ear and mouth** — `src/lib/listen.ts`, `src/lib/speak.ts`. Recognition
  stays on-device by default; you are being listened to in public and shipping
  every utterance to Apple is the wrong default.
- **The ring** — `src/lib/trigger.ts` and `modules/grove-remote`.
- **The voice** — `src/lib/persona.ts`. You write how Grove talks in your own
  words in Settings. It shapes tone and length only, and is wrapped so it can't
  become permission to invent outcomes.

## The design

Two colours, from the logo: black on `#EFE9E1`. Everything structural is
monochrome, and colour means exactly one thing — **live hardware**. A green dot
is a device that is genuinely connected or a microphone that is genuinely open.
Nothing else is ever coloured, which is what keeps that signal readable.

## Checks

```bash
npx tsc --noEmit
npx expo lint
npx expo export --platform web    # catches bad imports across every route
npx expo install --check
```
