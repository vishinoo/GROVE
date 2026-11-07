# Grove: how it is built

A map of the whole system, for finding and fixing things. `AGENTS.md` explains
*why* each decision was made; this file says *where things are and how they
connect*. File paths are relative to the repo root.

As of 6 November 2026, on `main` at `96ccc05`, plus uncommitted work in the
tree (maths tool, Mac modes).

---

## 1. The shape of it

```
                ┌─────────────────────────── iPhone ───────────────────────────┐
 ring (BLE  ──► │ grove-remote (Swift)  ──►  agent.tsx  ──►  brain.ts          │
 media keys)    │ audio session, keys,       the state       one turn: the     │
                │ chimes, Music, ETA         machine         tool loop         │
 glasses    ◄──►│ listen.ts / speak.ts          │               │              │
 (BT headset)   │ (iOS recogniser / TTS)        │               ▼              │
                │                               │        abilities.ts ──► APIs │
                │ memory · life · vault ◄───────┘        (48 functions)        │
                │ (encrypted AsyncStorage)               lightModel.ts ──► Gemini
                └──────────────┬───────────────────────────────────────────────┘
                               │ Supabase Realtime broadcast (Phoenix over WebSocket)
                               │ channel grove-link-<48-char secret>
                ┌──────────────▼──────────── Mac ──────────────────────────────┐
                │ Link.swift ──► main.swift (AppDelegate) ──► Jobs / Agent /   │
                │                  ▲                           Native / Player │
                │ notch panel (WKWebView, panel.html)   Thinking.swift ──► Gemini
                │ ⌘K (Shortcut.swift)                    Agent.swift ──► Chrome │
                │ Grove window (Home.swift, home.html) — Modes                  │
                └──────────────────────────────────────────────────────────────┘
```

**There is no Grove server.** The phone calls Google and Gemini directly. The
only shared infrastructure is Noctus's Supabase project, and only the
phone↔Mac link uses it. The phone works fully with no Mac and no Noctus.

| Piece | Language / stack | Entry point |
|---|---|---|
| Phone app | Expo SDK 54, React Native 0.81, React 19, expo-router 6, TypeScript | `src/app/_layout.tsx` |
| Native iOS module | Swift, Expo Modules API | `modules/grove-remote/ios/GroveRemoteModule.swift` |
| Mac app | Swift 5.10, AppKit + WKWebView, SwiftPM, no Xcode project | `mac/Sources/Grove/main.swift` |
| Harness | Node, compiles `src/lib` with `tsc` and runs it | `scripts/verify.js` |

---

## 2. Repo map

```
src/
  app/                 screens (expo-router: the file path is the route)
    _layout.tsx        root: fonts, providers (SessionProvider, AgentProvider)
    index.tsx          gate: onboarding seen? → OTA check → (app)
    onboarding.tsx     3 slides + checklist + "who's in your life" box
    login.tsx          Noctus sign-in (optional; only for the Mac link)
    logs.tsx           what was asked / said / which connection
    (app)/_layout.tsx  bottom tabs: index, sparks, settings
    (app)/index.tsx    Talk screen: orb, captions, result cards, typed box
    (app)/sparks.tsx   the MEMORY screen (the file name is historical)
    (app)/settings.tsx voice, model key, connections, Mac, self-check
  context/
    agent.tsx          THE state machine: press → listen → think → speak (2,883 lines)
    session.tsx        who you are, what's connected
  lib/                 everything with no React in it (so the harness can load it)
  components/          orb, field shader (Skia), glass cards, memory map, ui kit
  constants/theme.ts   palettes, type, radii
modules/grove-remote/  local Expo module (index.ts = JS face, ios/ = Swift)
mac/                   the Mac app (build.sh, Package.swift, Sources/Grove/*.swift)
scripts/verify.js      the harness (~1,600 checks)
app.json / app.config.js / eas.json   Expo + EAS config
```

---

## 3. Phone: one spoken turn, end to end

This is the path to trace when something "doesn't respond".

1. **Press.** The ring sends a media key (play/pause/next) or, for the J09,
   moves the volume. iOS delivers it to Grove only because Grove is the
   "now playing" app: `grove-remote` holds an active `AVAudioSession` and
   loops rendered silence. The event arrives as `onRemoteCommand` →
   `src/lib/trigger.ts` → `press()` in `agent.tsx`.
   - The volume fallback is ignored while `thinking`/`working`, and every
     sound Grove makes calls `suppressVolumeTriggers()` first, so Grove's own
     chime can't count as a press.
2. **Listen.** `beginListening()` in `agent.tsx`, then `startListening()` in
   `src/lib/listen.ts`, which wraps `expo-speech-recognition`.
   - It passes `iosCategory` identical to `configureSession` in the Swift
     module, or the recogniser would make the audio session non-mixable and
     kill the music (verify compares the two files).
   - Music Grove is playing is paused first (`hushMusic`), because Bluetooth
     A2DP has no microphone. It is resumed when Grove returns to rest.
   - Timers: `GRACE_MS` 3000 (window after a reply), `ANSWER_MS` 12000 (after
     a question), `TRAILING_MS` 3600 (silence after a word), `SPEECH_TAIL_MS`
     500. The window starts counting at the first mic level reading.
3. **Pre-checks in code, before any model call** (`exchange()` in `agent.tsx`):
   - `closing.ts`: "enough" / "that's all" closes the window, with no reply.
   - `cancelling`: "never mind" or "stop" stops everything.
   - A pending confirmation: yes/no/"casual" is matched by regex here.
   - A pending offer: yes/no is handled here.
   - `stopSpeaking()` silences the last reply.
4. **The turn.** `askGrove()` in `grove.ts` delegates to `askWithTools()` →
   `runTurn()` in **`src/lib/brain.ts`**:
   - `system`: `systemFor(context)` (rules only, so it caches) + the register
     from `rapport.ts`.
   - `contents`: history + one user turn holding `[Context for this turn]`
     (clock, memory facts, roster, `bearing.ts` matches, rhythms, frictions,
     `macContext()`, music place, reading position) + the sentence. If
     `calc.ts` found arithmetic in the sentence itself, it adds
     `[Worked out exactly: …]`.
   - **Tool loop** (`MAX_ROUNDS = 4`). Each round calls `toolTurn()` in
     `lightModel.ts` with every usable ability as a Gemini function
     declaration (`tools.ts`), and the model returns:
     - `text`: a final answer, after two code checks:
       - a sum answered without the maths tool → sent back once (`checkedSum`);
       - a fresh-facts question (`needsFreshFacts`) answered from memory → a
         web search is forced and the model answers again.
     - `calls`:
       - `ask_back` ends the turn with a question.
       - `offer_next` is collected, not run.
       - Abilities with `reads: true` run inside the loop, and their `detail`
         goes back to the model as a tool result.
       - Anything else is handed back to `agent.tsx` unrun.
   - After the loop: `plainSpeech()` strips markdown, and `hoursIn()` /
     `agreesOnTime()` reject phrasing that changed a clock time.
5. **Acting.** `agent.tsx` runs the non-read ability with `runAbility()`,
   which has a 20 s timeout (150 s for `slow`, or a custom `timeoutMs`). If
   the result is `needsConfirming`, it speaks the read-back, arms a
   **25-second** confirmation (the clock starts when speech ends), and waits
   for a press or a spoken yes.
6. **Speaking.** `utter(text, listenAfter)` → `speak()` in
   `src/lib/speak.ts`, using `expo-speech` and the chosen `persona.voiceId`.
   Then the mic reopens for `GRACE_MS`, or `ANSWER_MS` after a question. A
   window Grove opened itself makes no chime (`quietListen`).
7. **Afterwards.** `consolidate.ts` buffers the turn, `transcript.ts` records
   it (capped at 30), `rhythms.ts` notes the time, and `rapport.ts` counts
   register.

States (`AgentState`): `asleep · idle · listening · thinking · speaking · working`.
Each change plays a sound and a haptic (`soundFor`, `buzz`).

---

## 4. The model layer: `src/lib/lightModel.ts`

**This is the only file that knows a provider.** Everything else calls `light*`
functions.

### Provider order, in `complete()`
1. **Ollama**, if `EXPO_PUBLIC_OLLAMA_URL` is set and `GET {url}/api/tags`
   answers (probed once).
2. **Gemini, direct, with the device's key**: `loadOwnKey()` (typed in
   Settings → "Thinking on its own", stored in SecureStore under
   `grove:own-model-key:v1`), else `EXPO_PUBLIC_GEMINI_API_KEY`.
3. **A Noctus backend**, only if `EXPO_PUBLIC_NOCTUS_URL` / `grove.noctus_url`
   is set. Blank by default.

### The Gemini calls

```
POST https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent
Header: x-goog-api-key: <key>
MODEL = EXPO_PUBLIC_GEMINI_MODEL || "gemini-flash-lite-latest"
```

| Function | Body specifics | Used for |
|---|---|---|
| `toolTurnOnce` | `systemInstruction`, `contents`, `tools:[{functionDeclarations}]`, temp 0.3, 700 tokens, **no grounding** | every turn |
| `askDirect` (via `complete`) | temp 0.7, 600 tokens by default; `tools:[{google_search:{}}]` when `search`; `responseMimeType: application/json` when `json` | all `light*` helpers |
| `lightBrief` | grounded; returns `{spoken, detail, grounded}`; parses a `LINKS:` line; told to list figures, never total them | `brief.web` |
| `lightDocument` / `lightPlan` / `lightResearch` | 3000 tokens, 75 s; plan → research ×≤5 in parallel → write | `doc.create` |
| `lightEmail` | its own call; greeting + body + signature added in code | `mail.send`, `mail.reply` |
| `lightConsolidate` / `lightCompact` | JSON | long memory, every ~12 turns |
| `lightFallback` | plain answer, with search | when the tool turn fails |
| `lightAfterAction` | ≤6 s | `phraseAction`: the line after an action |
| `lightSelection` | answers the Mac's ⌘K in the phone's voice | Mac link |

**Grounding** is read from `candidates[0].groundingMetadata`
(`groundingFrom()`) and reset before every call. An ungrounded `brief.web`
answer gets `[NOT FROM A SEARCH: …]` appended to its `detail`.

**Retries**: `toolTurn` retries once on a timeout, network error, 429 or 5xx,
then falls back to `lightFallback`. The failure kind is stored in
`modelTrouble` (`no-key`, `no-model`, `rate-limited`, `server`, `refused`,
`no-credit`), which `troubleLine()` turns into a sentence.

**Cost levers**: keep anything volatile out of `systemFor()` (the prompt
cache works on prefixes). `brief.web` is the only grounded path; grounding is
billed per query.

---

## 5. Abilities and tools

### `src/lib/abilities.ts` (4,486 lines)
Each ability is an object:

```ts
{ id, name, what, where: 'device'|…, wired, needs: string[],
  args: { name: { type, what, required } },
  reads?: boolean,        // only reads → may run inside the loop, reachable from a question
  slow?: boolean,         // 150 s limit
  timeoutMs?: number,
  examples: string[],     // must route back to this ability (verify)
  run(args) => Promise<{ ok, spoken, detail?, needsConfirming?, … }> }
```

The `ABILITIES` array registers them. Current IDs:

- **Calendar:** `gcal.read`, `calendar.read`, `calendar.find`, `calendar.add`,
  `calendar.move`, `calendar.remove`
- **Mail:** `mail.search`, `mail.summarise`, `mail.important`, `mail.send`,
  `mail.reply`, `link.send`
- **Docs:** `doc.find`, `doc.create`, `doc.recent`, `doc.append`
- **Reminders:** `reminders.add`, `reminders.read`
- **Music:** `music.play`, `music.recent`, `music.where`
- **Places:** `weather.now`, `maps.eta`, `maps.go`, `ride.request`
- **Ordering:** `food.order`, `shop.order`
- **People:** `contact.find`, `call.start`, `message.compose`
- **Memory:** `memory.search`, `memory.add`, `memory.done`, `memory.correct`,
  `memory.recall`, `memory.friction`, `person.brief`
- **Your day:** `day.brief`, `now.context`
- **Web and maths:** `brief.web`, `maths.work`
- **Reading:** `reading.go`
- **Mac:** `mac.use`, `mac.do`, `mac.music`, `mac.open`, `mac.read`,
  `mac.inbox`, `mac.note`

### `src/lib/tools.ts`
- `declarationFor(ability)` builds a Gemini function declaration. Every
  non-read ability gets a required `asked` argument: a quote of the user's
  words, which `askedFor()` checks against this sentence and the previous one.
- `toolNameFor` / `abilityIdFor`: `brief.web` ⇄ `brief_web`. Matching ignores
  separators, because the model sends back `brief__web`, `briefWeb` and so on.
- `confirmed`, `draft` and `new_email` are never declared, and are stripped if
  they appear in a call.

### The safety rules, all enforced in code
- **Irreversible actions** return `needsConfirming`. One press confirms; two
  presses, silence or 25 s cancels.
- **Never confirmed by the model**: `confirmed`, `draft` and `new_email` can't
  be set by it, or by an offer (`offers.ts`) or a plan (`plan.ts`).
- **Paid apps** (`ride`, `food`, `shop`, `mac.use` purchases) must confirm and
  must not be `reads`.
- **`link.send`** is the one write with no confirmation: it can only send to
  `google.me()`, and takes no address argument.

### Multi-step and follow-ons
- `plan.ts`: one sentence with several actions becomes up to 4 steps, kept as
  the user's own words and replayed through `exchange()`. They expire after
  8 minutes.
- `offers.ts`: the model's `offer_next` is gated by `offerFrom`. Limits: 4 a
  day, 2 turns apart, rest periods after declines (`REST_DAYS`).
- `attention.ts` and `interrupt.ts`: unprompted lines (leave-by, starting
  soon, overdue), scored and budgeted at 3 a day.

---

## 6. External APIs the phone calls

All Google calls go through `src/lib/google.ts` with a bearer token from
`googleToken()`. They are retried once on a timeout, network error, 429 or
5xx, and never on a 401, 403 or 400.

| API | Endpoint | Used by |
|---|---|---|
| OAuth (PKCE, iOS client) | `accounts.google.com/o/oauth2/v2/auth`, `oauth2.googleapis.com/token` / `revoke` / `tokeninfo` | `googleAuth.ts` |
| Gmail | `gmail.googleapis.com/gmail/v1/users/me/messages` (list/get), `/messages/send`, `/profile` | mail.* |
| Calendar | `www.googleapis.com/calendar/v3/calendars/primary/events[/id]` | gcal.read, calendar.* (plus the device calendar via expo-calendar) |
| Docs | `docs.googleapis.com/v1/documents[/{id}:batchUpdate]` | doc.create / doc.append; `layout()` turns `## ` and `- ` into styles |
| Drive | `www.googleapis.com/drive/v3/files`, `upload/drive/v3/files` (fallback: HTML upload converted to a Doc) | doc.find, createDoc fallback |
| People | `people.googleapis.com/v1/people:searchContacts` | contact lookup |
| Userinfo | `www.googleapis.com/oauth2/v2/userinfo` | `me()`, signature |
| Gemini | see §4 | everything |
| Open-Meteo | `geocoding-api.open-meteo.com/v1/search`, `api.open-meteo.com/v1/forecast` | weather.now |
| ipwho.is | `ipwho.is/` | town from the network, when none is known (`cityFromNetwork`) |
| Hand-offs (open only, no API) | `m.uber.com/ul/`, `ubereats.com`, `doordash.com`, `amazon.*`, `instacart.*`, `walmart.*`, `costco.*`, `maps.apple.com` | ride/food/shop/maps.go |

**OAuth details** (`googleAuth.ts`):
- The redirect scheme is the client ID reversed, from
  `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`. It is derived in both `app.config.js`
  and `googleAuth.ts`.
- Tokens are kept in SecureStore: `grove.google.access`, `.refresh`,
  `.expiry`, `.scopes`.
- `missingScopes(job)` compares the stored scopes against `SCOPE_FOR`.
  `google.allowed(job)` is checked before doing any work, including before a
  confirmation.
- **If you change `SCOPES`, the user must disconnect and reconnect.**

Network helpers:
- `net.ts` `fetchJson`.
- `abort.ts` `timeoutSignal()`. Never use `AbortSignal.timeout` (it throws on
  React Native; verify bans it).
- `failure.ts` sorts timeout / offline / other, and turns opaque framework
  text into plain sentences.

---

## 7. Memory and storage

| Store | File | Key | What |
|---|---|---|---|
| Facts + goals | `memory.ts` | `grove:memory:v1` | ≤40 facts with subjects, sent with every turn. Goals are capped separately and shown under their own heading. |
| Long memory | `life.ts` | `grove:life:v1` | entities (people, projects, places, ideas) with facts, plus dated episodes. Searched, never sent whole. |
| Consolidation buffer | `consolidate.ts` | (in life) | raw turns, read every ~12 turns by `lightConsolidate`, then deleted |
| Frictions | `struggles.ts` | `grove:struggles:v1` | things that went wrong twice or more |
| Rhythms | `rhythms.ts` | `grove:rhythms:v1` | first and last words each day; weekly calendar habits |
| Register | `rapport.ts` | `grove:rapport:v1` | counts only (length, tone) |
| Offers ledger | `offers.ts` | `grove:offers:v1` | declines, rests, vetoes. Writes are queued. |
| Interruptions | `interrupt.ts` | `grove:interrupt:v1` | daily budget, the learned bar |
| Docs written | `docs.ts` | `grove:docs:v1` | titles and links |
| Listening history | `listening.ts` | `grove:listening:v1` | recently played |
| Troubles | `troubles.ts` | `grove:troubles:v1` | raw error codes, plus `where` |
| Persona | `persona.ts` | `grove:persona:v1` | name, manner, voiceId, speaksUp |
| Transcript | `transcript.ts` | — | last 30 exchanges |

**Encryption**: `src/lib/vault.ts`.
- AES-256-CTR (`aes-js`). The key is in the Keychain (`grove.vault.key.v1`),
  marked `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
- A value that isn't sealed is read as-is, then re-sealed. If encryption
  fails, the value is written unencrypted rather than lost.
- Verify fails if any of these stores uses AsyncStorage directly.

**Identity**: with no backend, `localIdentity()` mints a UID into the
Keychain (`grove.local.uid`). Memory and transcript are keyed by it.

**Selection** (`bearing.ts`): IDF-weighted word overlap between the sentence
and memory. Up to 6 lines, each with its nearest neighbour of the same kind.
No embeddings.

---

## 8. Audio, ring and glasses: `modules/grove-remote`

JS face in `index.ts`; Swift in `ios/GroveRemoteModule.swift`.

| Function | What it does |
|---|---|
| `activate(playSilence)` / `deactivate()` | configure and hold the audio session (`.playAndRecord`, mixable); loop silence so Grove stays "now playing" |
| `setKeepAlive(bool)` | play or pause the silence |
| `getRoute()` + `onRouteChange` | which output and input is live; drives "glasses connected" and "playback only" (A2DP vs HFP) |
| `onRemoteCommand` | ring and media-key presses |
| `onInterruption` | another app took the session |
| `setVolumeTrigger(bool)` | the J09 fallback: a volume change counts as a press |
| `playChime('listen'|'stop'|'done')`, `startWorking`/`stopWorking` | synthesised WAVs, no bundled files. "working" is the filtered-noise wave (`waveSamples`). |
| `playMusic`, `controlMusic`, `nowPlaying` | Apple Music on the phone |
| `travelTime(dest, driving)` | MapKit ETA |
| `requestMicrophone/MusicAccess/LocationAccess` | permissions |

**Reduced mode**: every native dependency is loaded with a lazy `require`
inside `try`/`catch` and probed in `capabilities.ts`. Never convert these to
static imports.

**iOS limits**: no background key presses, and no wake from terminated.
Force-quit means the ring is dead until the app is opened. Looping silence is
the most likely App Store rejection.

---

## 9. Phone ↔ Mac link

- **Phone**: `src/lib/mac.ts` (supabase-js Realtime).
- **Mac**: `mac/Sources/Grove/Link.swift`, which speaks the Phoenix protocol by
  hand over `URLSessionWebSocketTask`: join with the access token, heartbeat
  every 25 s, renew the token before it expires.
- **Auth**: both devices sign in with Google through Noctus's Supabase project.
  - Phone: `noctusAuth.ts`, redirect `grove://auth-callback`.
  - Mac: `Account.swift`, PKCE, redirect `grove-mac://auth-callback`.
  - Both redirects must be on Supabase's Redirect URL allowlist.
- **Channel**: `grove-link-<secret>`. The 48-character secret is in the
  account's `user_metadata.grove_link`; whichever device signs in first creates
  it. The phone can skip signing in by typing the Mac's six-digit code
  (`pairWithCode`); the secret is then stored in SecureStore as
  `grove.mac.secret`. It is a broadcast channel, not a private one: private
  channels fail with "MissingPartition".
- **Messages** (JSON, each with `from` and `t`):

```
phone → mac   hello {}   settings {colour,label,stops,speed,warp,name,manner,about}
              job {id, kind, args}   thought {id, kind, text}   said {heard, replied}
mac → phone   welcome {mac}   done {id, ok, spoken, state?, task?, detail?}
              think {id, instruction, text}   news {what, state, said, task?, speak}
              heard {said, replied}   fact {line, wrong}
```

- **Liveness**: the phone sends hello every minute. "Connected" means the
  phone was heard from in the last 2.5 minutes. `macReachable()` sends a hello
  and waits 3 s for a reply.
- Results the phone must hear are acknowledged and resent, and survive a
  reconnect in an outbox.
- **Job kinds** the Mac accepts (dispatched in `run(_ job:)` in `main.swift`):
  - `agent.start`, `agent.answer`, `agent.stop`: the browser agent. A goal
    naming "<mode> mode" runs the mode instead.
  - `mode.start`, `mode.stop` (arg `name`).
  - `music.play/pause/resume/next/previous/shuffle/now`, `volume.up/down`.
  - `open.url`, `open.app`.
  - `messages.read`, `screen.read`, `note.add`.

---

## 10. The Mac app: `mac/`

**Build**:
- `mac/build.sh`: `swift build -c release` → wraps the binary in
  `mac/build/Grove.app` → copies the SwiftPM resource bundle → writes keys
  from `.env` into the **built** Info.plist only (`GroveGeminiKey`,
  `GroveModel`, `GroveGiphyKey`, `GroveSupabaseURL`, `GroveSupabaseAnon`) →
  signs with "Grove Local Signing", if `make-signing-identity.sh` was run.
- `--run` quits the running copy and relaunches it.
- The app is `LSUIElement`: no Dock icon.
- The log is at `~/Library/Logs/Grove/grove.log`. Look here first.
- Rebuilding changes the binary, so expect a one-off keychain prompt for
  `grove.memory.key`.

**Files, by job**:

| Area | Files |
|---|---|
| App shell, dispatch, menu bar | `main.swift` (AppDelegate: `askFree`, `run(job)`, `runAgent`, `begin`/`summon` for ⌘K, `refreshMenu`) |
| Notch panel | `Notch.swift` (borderless non-activating `KeyablePanel` + WKWebView) + `Resources/panel.html`. Swift↔JS: `window.webkit.messageHandlers.grove`. `notch.show(mode, data)` draws a card; `openMicOn` decides the mic. |
| Grove window (Modes) | `Home.swift` + `Resources/home.html`; `Modes.swift` (store: `~/Library/Application Support/Grove/modes.json`). Opening Grove from Finder → `applicationShouldHandleReopen` → `home.toggle()`. |
| ⌘K | `Shortcut.swift` (event tap; the `Shortcut.shared` list of apps that keep ⌘K), `Selection.swift` (AX selected text, replace), `Voice.swift` (on-device recognition) |
| Deciding | `Thinking.swift`: `decide()` → JSON `{kind: open|do|music|message|inbox|read|note|ask|stop|answer|need, …}` on Gemini lite. `Recent.swift` (last 20 minutes), `Context.swift` (front app, window title, song), `Told.swift` (remember/wrong → phone) |
| Browser agent | `Agent.swift`. `enum Browser` holds Chrome AppleScript helpers (`run`, `read`, `js`, `newTab`, `ownWindow`, `borrow`, `waitForAGap`). The loop: read page → model move (`go/click/type/keys/scroll/find/look/tab/move/app/back/wait/ask/confirm/done`) → act → check. Moves use `gemini-flash-latest` (with thinking for boards and recovery), falling back to lite. `Agent.check` verifies a "done". |
| Learning | `Lessons.swift` (per-site notes, sealed), `Services.swift` (which app they use for music, food and so on) |
| Hand-offs | `Delegates.swift` (ChatGPT default; Gemini for images; Higgsfield for video; Claude / Claude Code last; CLI run in Terminal) |
| Native apps / media | `Native.swift` (locate, focus, paste, WhatsApp), `Player.swift` (pause/play across Music, Chrome video, Spotify, system key), `Jobs.swift` (`Music` AppleScript, open.url/app) |
| Reading / screen / messages | `Speaker.swift`, `Screen.swift`, `Inbox.swift` (`chat.db`, needs Full Disk Access) |
| Small stuff | `Gifs.swift` + `Popup.swift` (GIPHY), `Say.swift` (one line in Grove's words), `Suggestions.swift`, `Permissions.swift`, `Commands.swift`, `Look.swift`, `Vault.swift` (AES-GCM, Keychain), `Script.swift` (NSAppleScript, one retry on -600/-609/-1708/-1712), `Log.swift` |

**Mac model calls**: the same Gemini endpoint (`Thinking.swift`,
`Agent.swift`), using the key from Info.plist. ⌘K text goes to the phone first
(`think`, answered by `lightSelection`); Gemini is the fallback when the phone
isn't connected.

**Modes** (`Modes.swift`):
- Steps are `playlist` (Music by name, or a Spotify link/URI), `video` (a
  YouTube link, or a search), `site` or `app`.
- `start` opens every page in one new Chrome window (its id is kept), minimises
  it after 4 s if `tuck` is on, launches apps without activating them (and
  records which ones weren't already running), and starts the playlist last.
- `stop` closes that window, pauses that player, and quits only the apps it
  launched.
- Phrases are matched in code: `Modes.heard()` in `askFree`, and
  `Modes.inGoal()` for phone goals.

---

## 11. Build, ship, run

| Task | Command |
|---|---|
| JS-only change to the phone | `eas update --branch preview` (OTA; picked up at the next launch, via the `updates.ts` gate) |
| Native change (Swift module, new native dep, Info.plist) | `eas build --profile preview --platform ios`, then install from the expo.dev link |
| Dev client | `eas build --profile development --platform ios`, then `npx expo start` |
| Mac app | `mac/build.sh --run` |
| Before committing | `npx tsc --noEmit && npx expo lint && npm run verify` (and `npx expo install --check` if deps changed) |

- `eas` is a global CLI; `npx eas` doesn't resolve.
- EAS profiles: `development` (channel `development`), `preview` (internal,
  channel `preview`; this is what the phone runs), `production`.
- `runtimeVersion` follows the app version, so an OTA only reaches binaries
  with a matching version.
- When comparing builds, quote the **iOS update ID** from Settings → Version,
  not the EAS group ID.
- `.env` is gitignored, so EAS builds take their `EXPO_PUBLIC_*` values from
  EAS environment variables.

**Environment variables**:

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_GEMINI_API_KEY`, `EXPO_PUBLIC_GEMINI_MODEL` | model key and model; the key is bundled (personal build) and can be overridden in Settings |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | OAuth, and the redirect scheme |
| `EXPO_PUBLIC_NOCTUS_SUPABASE_URL`, `EXPO_PUBLIC_NOCTUS_SUPABASE_ANON_KEY` | the Mac link |
| `EXPO_PUBLIC_NOCTUS_URL` | optional backend; blank by default |
| `EXPO_PUBLIC_OLLAMA_URL`, `EXPO_PUBLIC_OLLAMA_MODEL` | optional local model |
| `EXPO_PUBLIC_MAC_URL`, `EXPO_PUBLIC_MAC_TOKEN` | the old HTTP Mac bridge (`mac.do`) |
| `EXPO_PUBLIC_ALLOW_DEV_LOGIN`, `EXPO_PUBLIC_ALWAYS_ONBOARD` | development switches |
| `GIPHY_API_KEY` | Mac GIFs, via `build.sh` |

---

## 12. Testing

- **`npm run verify`**:
  - compiles `src/lib` to `$TMPDIR/grove-verify`, stubs anything native
    (`react-native`, `expo-*`, `@supabase`, `grove-remote`) with a recursive
    Proxy, and runs the real modules;
  - checks routing, gates, safety, cache shape, storage, keyboard handling and
    cross-language consistency;
  - reads regions of source with `between()`, which asserts both landmarks and
    a size. Async sections use `laterSection`.
- **Google is stubbed on the laptop.** To test against the real account, use
  Settings → **Does it all work?** on the phone (`selfCheck.ts`, read-only).
- **Live model tests**: compile through verify first, set `global.__DEV__ =
  false`, load `.env` into `process.env`, then call `brain.askWithTools([],
  text, {persona, facts: []})`. Run them under `caffeinate -i`.
- **Mac**: launch flags such as `open Grove.app --args --ask "text"`,
  `--agent "goal"`, `--job music.now`, `--peek`, `--gif URL`, `--react "…"`.

---

## 13. Where to look when…

| Symptom | Start here |
|---|---|
| Ring press does nothing | `trigger.ts` `isArmed`, `agent.tsx` `press()`. Was Grove force-quit? Is the volume fallback being suppressed? Check the `troubles` lines in Settings. |
| Mic opens, then closes immediately, or "audio input busy" | `listen.ts` `iosCategory` vs `configureSession` (Swift); A2DP vs HFP (`getRoute`); `hushMusic` |
| Music stops when the mic opens | same as above, plus `resumeMusic` on settling to rest |
| "I have no connection" on full signal | `failure.ts` `failureKind`; a newly added `AbortSignal.timeout`; `lightModel` `modelTrouble` |
| Wrong tool, or no tool | `brain.ts` `TOOL_RULES`; the ability's `what` and `args`; `tools.ts` name matching; the `askedFor` refusal |
| Made-up names or numbers | `lightBrief` prompt, grounding flag, `NOT FROM A SEARCH`; `maths.work`, `checkedSum` |
| Email won't send | `google.allowed('mail.send')` / `missingScopes`: reconnect Google. `lightEmail`; `confirmArgs` / `draft` |
| Docs fail | API disabled? `explain()` gives the activation link. Drive fallback in `createDoc`. |
| Mac "not reachable" | `mac.ts` `macReachable`; Mac log `link: joined`; same account on both; Supabase redirect allowlist |
| Mac job does the wrong thing | `Thinking.decide` (log `ask:` lines), `Recent.swift`, `Agent.swift` trail in the log |
| Mac can't read Chrome | Chrome → View → Developer → Allow JavaScript from Apple Events; Automation permission |
| ⌘K dead after a rebuild | signing identity (Accessibility is tied to the signature): run `make-signing-identity.sh`, rebuild |
| Update "didn't arrive" | it applies at the next launch through the `index.tsx` gate; compare iOS update IDs, not group IDs |
| Prompt costs jumped | something volatile got into `systemFor()`; verify's cache section |

---

## 14. Known sharp edges

- The Gemini key is bundled in the app (`EXPO_PUBLIC_*`). It's fine for a
  personal build, but move it behind a server before anyone else gets the app.
  Only `lightModel.ts` needs to change.
- The looping silence that keeps the ring working will likely be rejected by
  App Store review.
- Mac link secrets live in Supabase user metadata. Anyone with that account's
  session can join the channel.
- `agent.tsx` (2.9k lines) and `abilities.ts` (4.5k) are the hotspots. Most
  regressions start there.
- A plan step can't use the previous step's output yet (see "One sentence,
  five things" in `AGENTS.md`).
- Mac modes are new and have never been run end to end: the Chrome-window
  and Spotify AppleScript in particular.
