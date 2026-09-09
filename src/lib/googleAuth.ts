/**
 * Google, without a server in the middle.
 *
 * Grove used to reach Google through Noctus: the phone asked Noctus for a
 * consent URL, Google redirected back to Noctus, and Noctus held the tokens and
 * made every API call on the phone's behalf. That bought one real thing — a
 * client secret kept off the device — and cost a great deal more than it was
 * worth.
 *
 * WHY IT HAD TO GO
 *
 * A web OAuth client can only redirect to an https:// address, so the phone's
 * consent screen had to come home to a public server. On a laptop backend that
 * address is http://localhost:4000, which resolves *on the phone* to nothing at
 * all — so signing in from the phone could not work, at any point, no matter
 * what was registered. That is not a bug in the flow; it is the flow being the
 * wrong shape for a device.
 *
 * Installed apps solve this differently and have for years: an iOS OAuth client
 * has no secret to protect, so it does not need anywhere to hide one. It proves
 * itself with PKCE instead — a random verifier generated per attempt, of which
 * only a hash is sent up front — and Google redirects straight back into the
 * app through a custom URI scheme. No server, no public address, nothing to
 * keep deployed, and nothing that stops working when a trial expires.
 *
 * The tokens live in the Keychain on the one device that uses them, which is a
 * smaller blast radius than a database holding tokens for every user.
 */

import * as SecureStore from 'expo-secure-store';

/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * The iOS OAuth client. No secret, by design — Google does not issue one for
 * this client type, because a secret shipped inside an app is not a secret.
 */
const CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';

/**
 * Everything Grove reads or writes, asked for once.
 *
 * A second consent screen later is a second interruption and people decline
 * those, so the whole set is requested up front. Every scope here has an
 * ability behind it — nothing speculative, because every extra scope is more
 * damage if a token ever leaks.
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  // Full Gmail: Grove reads mail aloud and dictates replies, so send alone was
  // never enough.
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/calendar',
  // The one that makes "email Priya" work. Without it Grove has a name and no
  // address, and has to ask for something you obviously know.
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
];

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STORE_REFRESH = 'grove.google.refresh';
const STORE_ACCESS = 'grove.google.access';
const STORE_EXPIRY = 'grove.google.expiry';

/**
 * Where Google sends the browser back to.
 *
 * Google requires an iOS client's custom scheme to be its own client id with
 * the dotted parts reversed — it is not a free choice, and `grove://` is
 * rejected. Derived here rather than written down twice, because the same
 * string has to appear in the app's Info.plist and a mismatch between them
 * fails at the last step of the flow, after consent, which is the most
 * confusing place for it to fail.
 */
export function redirectUri(): string {
  return `${reversedClientId()}:/oauthredirect`;
}

export function reversedClientId(): string {
  return CLIENT_ID.split('.').reverse().join('.');
}

/** False when no iOS client id is configured, so the UI can say so plainly. */
export function isGoogleConfigured(): boolean {
  return CLIENT_ID.length > 0;
}

/* --------------------------------------------------------------- the flow */

type AuthSession = typeof import('expo-auth-session');

function authSession(): AuthSession | null {
  try {
    return require('expo-auth-session') as AuthSession;
  } catch {
    // Probed rather than statically imported, like every other native
    // dependency here: a static import is hoisted and would take the bundle
    // down on a build without the native half.
    return null;
  }
}

export class GoogleAuthUnavailable extends Error {}

/**
 * Runs the consent flow and stores what comes back.
 *
 * Returns false when the person backed out, which is an answer rather than a
 * failure and should not surface as an error.
 */
export async function connectGoogle(): Promise<boolean> {
  if (!isGoogleConfigured()) {
    throw new GoogleAuthUnavailable('No Google client id is configured for this build.');
  }
  const auth = authSession();
  if (!auth) {
    throw new GoogleAuthUnavailable('Google sign-in needs a development build.');
  }

  const discovery = {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: TOKEN_URL,
    revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
  };

  const request = new auth.AuthRequest({
    clientId: CLIENT_ID,
    scopes: SCOPES,
    redirectUri: redirectUri(),
    usePKCE: true,
    // Without this Google issues an access token and no refresh token, and
    // Grove stops working an hour later — which is exactly the moment nobody
    // is watching, since the whole point is being asked something at 7am.
    extraParams: { access_type: 'offline', prompt: 'consent' },
  });

  const result = await request.promptAsync(discovery);
  if (result.type !== 'success' || !result.params.code) return false;

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code: result.params.code,
    code_verifier: request.codeVerifier ?? '',
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(),
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) throw new Error('Google refused the sign-in. Try again.');

  const tokens = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokens.access_token) return false;

  await store(tokens.access_token, tokens.expires_in ?? 3600, tokens.refresh_token);
  return true;
}

async function store(access: string, expiresIn: number, refresh?: string): Promise<void> {
  // Sixty seconds of margin: a token that expires while the request is in
  // flight fails in someone's ear, and refreshing early costs nothing.
  const expiry = Date.now() + Math.max(expiresIn - 60, 0) * 1000;
  await SecureStore.setItemAsync(STORE_ACCESS, access);
  await SecureStore.setItemAsync(STORE_EXPIRY, String(expiry));
  // Google only returns a refresh token on the first consent, so an absent one
  // here must not wipe the one already held.
  if (refresh) await SecureStore.setItemAsync(STORE_REFRESH, refresh);
}

/**
 * A usable access token, refreshed if the stored one has expired.
 *
 * Null means "not connected" rather than "failed", so callers can say the one
 * useful thing — connect Google — instead of reporting a network error.
 */
export async function googleToken(): Promise<string | null> {
  try {
    const access = await SecureStore.getItemAsync(STORE_ACCESS);
    const expiry = Number((await SecureStore.getItemAsync(STORE_EXPIRY)) ?? 0);
    if (access && Date.now() < expiry) return access;

    const refresh = await SecureStore.getItemAsync(STORE_REFRESH);
    if (!refresh) return null;

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        refresh_token: refresh,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!response.ok) return null;

    const tokens = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!tokens.access_token) return null;
    await store(tokens.access_token, tokens.expires_in ?? 3600);
    return tokens.access_token;
  } catch {
    return null;
  }
}

export async function isGoogleConnected(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(STORE_REFRESH)) !== null;
  } catch {
    return false;
  }
}

export async function disconnectGoogle(): Promise<void> {
  for (const key of [STORE_ACCESS, STORE_EXPIRY, STORE_REFRESH]) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Nothing stored is the desired end state anyway.
    }
  }
}
