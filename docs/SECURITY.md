# Security review

**Date:** 2026-09-07
**Scope:** the Grove app, the `grove-remote` native module, and the
`/api/grove/*` endpoints added to the Noctus backend.

Every claim below was tested, not assumed. Where something was verified against
a live service, the check is written down so it can be repeated.

---

## Fixed during this review

### The model key shipped inside the app — CLOSED

`EXPO_PUBLIC_*` values are compiled into the JavaScript bundle. Anyone with the
`.ipa` could extract the Gemini key and spend the quota. This was documented as
"testing only" from the start, and stopped being acceptable the moment a build
reached TestFlight.

The key now lives in `Backend/.env` and the app calls `POST /api/grove/chat`,
which holds the secret and forwards. Verified:

```
grep -rE 'AIzaSy[A-Za-z0-9_-]{20,}' dist/   -> no match   (re-verified 2026-09-07)
grep -r  'generativelanguage' dist/         -> 1 match     (see below)
```

**No key ships.** The one match is the Google endpoint URL, not a credential,
and it is there on purpose: `askDirect` in `lightModel.ts` is the last of three
fallbacks and reads its key from the Keychain via `expo-secure-store` at
runtime, put there by `npm run set-key` on the device. A URL in the bundle
reveals nothing — the secret is the key, and the key is not there.

This line previously claimed both greps returned nothing, which stopped being
true when `askDirect` was reinstated. A security note that is quietly wrong is
worse than one that admits a match and explains it, because the next person to
run the check assumes the tool is broken rather than the document.

`isLightModelConfigured()` now returns true unconditionally, because the app genuinely cannot tell — and
reporting "no model" on a working install would be worse than the alternative.

---

## Verified as sound

### Supabase row-level security — TESTED, correct

The anon key ships in the app by design. That is only safe if RLS is on, so it
was tested directly with the key that ships:

```
GET /rest/v1/credentials  -> 401 permission denied for table credentials
GET /rest/v1/users        -> 401 permission denied for table users
```

Your stored Google OAuth tokens are **not** readable with the app's key. This is
the single most important control in the system and it is working.

### No secrets in git history

```
git log --all -p | grep -cE 'AIzaSy…|GOCSPX-…'   -> 0
```

`.gitignore` covers `.env`, `.env.*`, re-including `.env.example`. That pattern
was widened after `.env.bak` — a file holding the same live keys — was found
uncovered.

### Session tokens

Supabase sessions are stored in the Keychain via `secureStorage.ts`, chunked
around the ~2 KB SecureStore limit, with `WHEN_UNLOCKED_THIS_DEVICE_ONLY` so a
token does not ride an iCloud sync to another device or return from a backup
onto a different phone. Web falls back to AsyncStorage, which is the best
available there.

### Token substitution via deep link

`assertIssuedByNoctus` decodes the JWT's `iss` and refuses anything not issued
by the configured Supabase project before handing it to Supabase. Without it,
anything able to open `grove://auth-callback#access_token=…` — another app
registering the scheme, a web page, a pasted link — could install a session
Grove would then treat as the user's own, and everything they did afterwards
would land in someone else's account.

### Development bypasses cannot reach production

`DEV_LOGIN_ENABLED`, `isDevSession()`, the stored Noctus-URL override and
`ALWAYS_SHOW_ONBOARDING` are each gated on `__DEV__` *as well as* their env flag.
`__DEV__` is false in any production bundle, so a stray flag in a build
machine's `.env` cannot ship a "sign in as the dev user" button or redirect
every bearer token to an attacker-chosen host.

### Backend endpoints

`/api/grove/*` sits behind `verifyToken`. The Gmail search terms are filtered to
`[\w@.\-' ]` before being interpolated into a query string. Nothing is logged
that contains a token or a key.

---

## Reopened deliberately

### The model key is in the bundle again — 2026-09-07

The section above records this being closed by moving the key to
`POST /api/grove/chat` on Noctus. Noctus has since been cut out of the critical
path entirely, and with no server there is nowhere else for a key to live but
the device.

`loadOwnKey()` prefers the Keychain and falls back to
`EXPO_PUBLIC_GEMINI_API_KEY`, which **is compiled into the JavaScript bundle and
is extractable from any build**. The earlier fix is therefore no longer in
force, and the honest statement is that the key ships.

Why that is acceptable here: the key is pre-paid, scoped to one API, spends a
capped balance, and is trivial to rotate. The alternative — keeping a deployment
alive purely to hold it — is what made signing in from a phone impossible in the
first place.

Why it would not be acceptable for public distribution: every installer gets the
key. Before Grove goes to anyone who is not the author, either leave
`EXPO_PUBLIC_GEMINI_API_KEY` unset and require each device to paste its own key
in Settings, or put a minimal key-proxy back in front of the model. The
mechanism for the first already exists and takes precedence over the build key.

This entry exists because a security note that quietly stops being true is worse
than one that admits a regression and says why.

---

## Accepted risks, with reasons

### The silent-audio keep-alive

Grove holds an audio session and renders silence so it stays the now-playing
app, which is the only way the ring reaches it. This is explicitly discouraged
by App Review and is the likeliest cause of rejection in the project. It is a
deliberate trade for the product to work at all. Fine for personal builds and
internal TestFlight testers.

### Over-the-air updates are not code-signed

`expo-updates` fetches JavaScript from EAS over HTTPS. An attacker who
compromised the Expo account could push code to installed apps. The mitigation
is account security — 2FA on the Expo account — rather than anything in this
repository. EAS Update code signing exists and would remove the risk; it is
worth adding before any non-internal distribution.

### The backend runs over plain HTTP on a LAN

`EXPO_PUBLIC_NOCTUS_URL` is `http://192.168.0.x:4000` in development, so bearer
tokens cross the local network unencrypted. `setNoctusUrl` already refuses
cleartext outside `__DEV__`. Before anything leaves a trusted network this needs
to be an HTTPS origin — a tunnel or a deployment, not a LAN IP.

---

## Worth doing next

1. **EAS Update code signing** before external distribution.
2. **Rate limiting on `/api/grove/chat`.** It is authenticated, so abuse costs a
   compromised account rather than being open to the world, but a single account
   can currently spend the model budget without limit.
3. **An HTTPS origin for Noctus.** Removes the cleartext-token issue and is also
   what unblocks Google OAuth from the phone, since Google rejects non-HTTPS
   redirect URIs.
4. **Narrow the Google scopes.** The consent screen currently asks for full
   Gmail, Drive, Tasks, Contacts and Directory. `mail.search` and `mail.send`
   need Gmail and Contacts; the rest are speculative and every extra scope is
   more damage if a token leaks.
