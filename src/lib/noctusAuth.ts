/**
 * "Log in with Noctus".
 *
 * There is no separate Grove account. Noctus authenticates through Supabase
 * and its API verifies that Supabase JWT (Backend/middleware/auth.js), so
 * signing in here against the same Supabase project means a Grove user *is*
 * a Noctus user — their tools and connected integrations come with them.
 *
 * SETUP NOTE — before the OAuth/magic-link buttons work, Noctus's Supabase
 * project needs this app's redirect registered under
 * Authentication -> URL Configuration -> Redirect URLs:
 *
 *     grove://auth-callback
 *     exp://<lan-ip>:8081/--/auth-callback     (during development)
 *
 * Until that's added, Supabase rejects the redirect and the browser closes
 * with no session. The dev sign-in below needs no Supabase config at all.
 */

import 'react-native-url-polyfill/auto';

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { secureSessionStorage } from './secureStorage';

const SUPABASE_URL = process.env.EXPO_PUBLIC_NOCTUS_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_NOCTUS_SUPABASE_ANON_KEY ?? '';

/**
 * The dev bypass is gated on `__DEV__` as well as the env flag, deliberately.
 * `EXPO_PUBLIC_*` values are inlined at build time, so a release built on a
 * machine with ALLOW_DEV_LOGIN=1 in .env would otherwise ship a one-tap
 * "sign in as the dev user" button. `__DEV__` is false in any production
 * bundle, so this is always false there and the button never renders.
 *
 * Verified against a production `expo export`: the bundle prelude sets
 * `__DEV__=false` and the ALLOW_DEV_LOGIN comparison is folded out entirely.
 * The button's JSX does still sit in the bundle as unreachable code — Metro
 * doesn't propagate this constant across modules — so scanning a build for
 * the string "Continue as dev" will find it. Unreachable, not absent.
 */
export const DEV_LOGIN_ENABLED = __DEV__ && process.env.EXPO_PUBLIC_ALLOW_DEV_LOGIN === '1';

/** The literal token Noctus accepts when DEV_AUTH_BYPASS=true. */
export const DEV_TOKEN = 'dev-token';

export function isSupabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) {
    if (!isSupabaseConfigured()) {
      throw new Error(
        'Noctus sign-in is not configured. Set EXPO_PUBLIC_NOCTUS_SUPABASE_URL and EXPO_PUBLIC_NOCTUS_SUPABASE_ANON_KEY in .env.'
      );
    }
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storage: secureSessionStorage,
        autoRefreshToken: true,
        persistSession: true,
        // There is no browser URL to read a session out of in a native app;
        // we hand the callback URL to setSessionFromUrl ourselves.
        detectSessionInUrl: false,
      },
    });
  }
  return client;
}

export const redirectTo = Linking.createURL('auth-callback');


/* ------------------------------------------------------- trusting a token */

/**
 * Decodes a JWT's payload. This does NOT verify the signature — it can't, the
 * signing key lives on Supabase — and nothing here treats the result as proof
 * of anything. It exists only to read `iss` so we can refuse a token that
 * plainly didn't come from our own project before handing it to Supabase,
 * which does verify it properly.
 *
 * Hand-rolled base64url rather than `atob`, which isn't guaranteed on every
 * engine this bundle runs on.
 */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64Url(input: string): string {
  const normalised = input.replace(/-/g, '+').replace(/_/g, '/');
  let bits = 0;
  let accumulator = 0;
  let out = '';

  for (const char of normalised) {
    const index = B64_ALPHABET.indexOf(char);
    if (index === -1) continue; // padding and stray characters
    accumulator = (accumulator << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((accumulator >> bits) & 0xff);
    }
  }
  return out;
}

function jwtIssuer(token: string): string | null {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(segments[1])) as { iss?: unknown };
    return typeof payload.iss === 'string' ? payload.iss : null;
  } catch {
    return null;
  }
}

/**
 * Refuses a token that wasn't issued by the Supabase project this build is
 * configured against.
 *
 * Without this, anything that can hand us a URL — another app registering the
 * same custom scheme, a web page firing `grove://auth-callback#access_token=…`,
 * or a user pasting a link someone sent them — could install a session we then
 * treat as the user's own. Everything they went on to do, and everything their
 * tools touched, would land in the attacker's Noctus account. Comparing hosts rather than whole strings so a trailing slash or a
 * changed path segment on Supabase's side doesn't lock people out.
 */
function assertIssuedByNoctus(accessToken: string): void {
  const issuer = jwtIssuer(accessToken);
  if (!issuer) throw new Error('That sign-in link is not a valid Noctus token.');

  let issuerHost: string;
  let expectedHost: string;
  try {
    issuerHost = new URL(issuer).host;
    expectedHost = new URL(SUPABASE_URL).host;
  } catch {
    throw new Error('That sign-in link is not a valid Noctus token.');
  }

  if (!issuerHost || issuerHost !== expectedHost) {
    throw new Error('That sign-in link came from somewhere other than Noctus, so it was ignored.');
  }
}

/** Pulls the tokens Supabase appends to the redirect and installs the session. */
async function setSessionFromUrl(url: string): Promise<Session> {
  const parsed = Linking.parse(url);
  const fragment = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
  const fragmentParams = new URLSearchParams(fragment);

  const access_token =
    (parsed.queryParams?.access_token as string | undefined) ??
    fragmentParams.get('access_token') ??
    undefined;
  const refresh_token =
    (parsed.queryParams?.refresh_token as string | undefined) ??
    fragmentParams.get('refresh_token') ??
    undefined;

  // PKCE flows come back with a single-use code instead of tokens.
  const code =
    (parsed.queryParams?.code as string | undefined) ?? fragmentParams.get('code') ?? undefined;

  if (access_token && refresh_token) {
    // The only branch that installs a token we were simply handed. The code
    // and token_hash branches below are both exchanged against our own
    // Supabase client, so a foreign one fails there on its own.
    assertIssuedByNoctus(access_token);
    const { data, error } = await supabase().auth.setSession({ access_token, refresh_token });
    if (error) throw error;
    if (!data.session) throw new Error('Noctus returned no session.');
    return data.session;
  }

  if (code) {
    const { data, error } = await supabase().auth.exchangeCodeForSession(code);
    if (error) throw error;
    if (!data.session) throw new Error('Noctus returned no session.');
    return data.session;
  }

  // Magic links carry a hashed one-time token rather than a session.
  const tokenHash =
    (parsed.queryParams?.token_hash as string | undefined) ??
    fragmentParams.get('token_hash') ??
    (parsed.queryParams?.token as string | undefined) ??
    undefined;
  if (tokenHash) {
    const type = ((parsed.queryParams?.type as string | undefined) ??
      fragmentParams.get('type') ??
      'magiclink') as 'magiclink' | 'email' | 'signup' | 'recovery';
    const { data, error } = await supabase().auth.verifyOtp({ token_hash: tokenHash, type });
    if (error) throw error;
    if (!data.session) throw new Error('That link did not return a session.');
    return data.session;
  }

  const described =
    (parsed.queryParams?.error_description as string | undefined) ??
    fragmentParams.get('error_description');
  throw new Error(described || 'Noctus sign-in did not return a session.');
}

/**
 * The "Log in with Noctus" button. Opens Noctus's Google consent screen in an
 * auth session and returns once it redirects back into the app.
 *
 * Returns null when the user backs out, which is not an error worth surfacing.
 */
export class SignInIncomplete extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInIncomplete';
  }
}

export async function signInWithNoctus(): Promise<Session | null> {
  const { data, error } = await supabase().auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo, skipBrowserRedirect: true },
  });
  if (error) throw error;
  if (!data?.url) throw new Error('Noctus did not return a sign-in URL.');

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo, {
    preferEphemeralSession: false,
  });

  if (result.type === 'cancel' || result.type === 'dismiss') {
    // The browser closed without ever reaching our redirect. Overwhelmingly
    // this means Supabase rejected `redirectTo` (it isn't in the project's
    // allowlist) and sent the user to the project's Site URL instead — the
    // tokens are appended to *that* page's URL rather than coming back here.
    throw new SignInIncomplete(
      'Noctus signed you in but sent you to its website instead of back here, because this app’s redirect isn’t allowlisted in Supabase yet. Copy the address bar from that page and paste it below to finish.'
    );
  }
  if (result.type !== 'success') return null;
  return setSessionFromUrl(result.url);
}

/**
 * Finishes sign-in from something the user pasted.
 *
 * Accepts whatever they can actually get hold of without any Supabase config
 * change: the full URL they were redirected to (tokens live in its fragment),
 * a magic-link URL carrying a token_hash, or a bare one-time code.
 */
export async function completeFromPasted(input: string, email?: string): Promise<Session> {
  const text = input.trim();
  if (!text) throw new Error('Paste the address you were sent to, or your code.');

  if (text.includes('://') || text.startsWith('#') || text.includes('access_token=')) {
    // setSessionFromUrl understands both the implicit fragment and PKCE code.
    return setSessionFromUrl(text.startsWith('#') ? `grove://x${text}` : text);
  }

  // A bare 6-8 character code from the email.
  if (!email) throw new Error('Enter the email you used, so the code can be checked against it.');
  const { data, error } = await supabase().auth.verifyOtp({
    email: email.trim(),
    token: text,
    type: 'email',
  });
  if (error) throw error;
  if (!data.session) throw new Error('That code did not return a session.');
  return data.session;
}

/** Email fallback — same identity, no Google account required. */
export async function sendNoctusMagicLink(email: string): Promise<void> {
  const { error } = await supabase().auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: true, emailRedirectTo: redirectTo },
  });
  if (error) throw error;
}

/**
 * Called by the deep-link handler when a magic link opens the app.
 *
 * The callback is identified by parsing the URL, not by searching it for a
 * substring: `grove://elsewhere?next=auth-callback` contains the word and is
 * not our callback. Under a custom scheme the target lands in `hostname`;
 * under Expo Go's `exp://host:port/--/auth-callback` it lands in `path`.
 *
 * Passing an unrelated URL to setSessionFromUrl would surface its "no session"
 * error as a sign-in failure on a link that was never a sign-in at all, so
 * anything that isn't the callback returns null and is ignored.
 */
export async function completeMagicLink(url: string): Promise<Session | null> {
  let parsed: Linking.ParsedURL;
  try {
    parsed = Linking.parse(url);
  } catch {
    return null;
  }

  const target = (parsed.hostname ?? parsed.path ?? '').replace(/^\/+|\/+$/g, '');
  // Expo Go prefixes the deep link path with `--/`.
  const normalised = target.replace(/^--\//, '');
  if (normalised !== 'auth-callback') return null;

  return setSessionFromUrl(url);
}

export async function getSession(): Promise<Session | null> {
  if (!isSupabaseConfigured()) return null;
  const { data } = await supabase().auth.getSession();
  return data.session;
}

export async function signOut(): Promise<void> {
  if (!isSupabaseConfigured()) return;
  await supabase().auth.signOut();
}

export function onAuthChange(fn: (session: Session | null) => void): () => void {
  if (!isSupabaseConfigured()) return () => {};
  const { data } = supabase().auth.onAuthStateChange((_event, session) => fn(session));
  return () => data.subscription.unsubscribe();
}
