/**
 * One place that knows who you are, what Grove can reach, and what's
 * connected. Screens read from here rather than each holding their own copy.
 *
 * Auth is unchanged from when this app had a crew: there is still no Grove
 * account. Noctus authenticates through Supabase and its API verifies that
 * JWT, so a Grove user *is* a Noctus user, and their tools and integrations
 * come with them.
 */

import type { Session } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import * as SecureStore from 'expo-secure-store';

import * as api from '@/lib/noctusApi';
import { grantDevice, isDevicePermission } from '@/lib/devicePermissions';
import { connectGoogle, disconnectGoogle, isGoogleConnected } from '@/lib/googleAuth';
import * as auth from '@/lib/noctusAuth';

type Status = 'loading' | 'signed-out' | 'signed-in';

type SessionValue = {
  status: Status;
  user: api.NoctusUser | null;
  /** Namespace for anything stored locally against this account. */
  uid: string;
  /** Noctus binding keys with a live credential, e.g. ['gmail','calendar']. */
  connections: string[];
  /** Non-fatal problem worth showing, e.g. Noctus unreachable. */
  notice: string | null;
  dismissNotice: () => void;

  signIn: () => Promise<void>;
  signInWithEmail: (email: string) => Promise<void>;
  /** Finish sign-in from a pasted callback URL or one-time code. */
  finishSignIn: (pasted: string, email?: string) => Promise<void>;
  signInAsDev: () => Promise<void>;
  /** Use Grove with no account at all. Not a bypass — see below. */
  continueLocally: () => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;

  /** Opens the consent screen for one integration, then re-reads what's live. */
  connect: (bindingKey: string) => Promise<void>;
  disconnect: (bindingKey: string) => Promise<void>;

  reloadConnections: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside <SessionProvider>');
  return value;
}

/**
 * Who "you" are on a phone with no accounts.
 *
 * uid keys everything stored per person — memory, sparks, the transcript — so
 * it has to be stable across launches or Grove forgets you every time it opens.
 * A random id minted once and kept in the Keychain does that without needing
 * anyone to sign in to anything.
 */
async function localIdentity(): Promise<string> {
  const KEY = 'grove.local.uid';
  try {
    const held = await SecureStore.getItemAsync(KEY);
    if (held) return held;
    const minted = `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await SecureStore.setItemAsync(KEY, minted);
    return minted;
  } catch {
    // A phone that will not keep an id still has to work, and a fixed one is
    // right for the single-user case this fallback already assumes.
    return 'local';
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<api.NoctusUser | null>(null);
  const [uid, setUid] = useState<string>('anon');
  const [connections, setConnections] = useState<string[]>([]);
  /**
   * Device permissions Grove has been granted on this phone.
   *
   * Kept apart from `connections` because they come from somewhere else
   * entirely: /api/credentials knows about OAuth bindings and has never heard
   * of the calendar. Merged for display, so the screen shows one list.
   */
  const [granted, setGranted] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  /** Pulls the account, its connections and its tools after a session exists. */
  const hydrate = useCallback(async () => {
    try {
      const { user: account } = await api.syncAccount();
      setUser(account);
      setUid(account?.uid || account?.email || 'noctus-user');
      setStatus('signed-in');
      setNotice(null);
    } catch (error) {
      // "Rejected" and "unreachable" are not the same thing, and treating them
      // the same is why a restart could look like being signed out.
      //
      // Noctus runs on a LAN address in development. The machine sleeps, the
      // DHCP lease renews, the backend gets restarted — and every one of those
      // used to sign you out and send you back through Google, despite the
      // session in the Keychain being perfectly valid.
      //
      // A 401 means the token really is no good, so sign out. Anything else —
      // especially status 0, which is how noctusApi reports a failed
      // connection — means we do not know, so keep the session and say so.
      const rejected = error instanceof api.NoctusError && error.status === 401;
      setNotice(error instanceof Error ? error.message : 'Could not reach Noctus.');
      if (rejected) {
        setStatus('signed-out');
        return;
      }
      // Signed in, but nothing loaded. The notice explains why; the next
      // foreground retries.
      setStatus('signed-in');
      return;
    }

    let connected: string[] = [];
    try {
      const result = await api.fetchConnections();
      connected = result.connected ?? [];
    } catch {
      // Integrations are additive — a failure here shouldn't block the app.
    }
    setConnections(connected);
  }, []);

  const bootstrap = useCallback(async () => {
    if (await api.isDevSession()) {
      await hydrate();
      return;
    }
    // No backend configured means no account to sign in to, and a login screen
    // in front of a standalone app is a locked door with no building behind it.
    //
    // This is the last thing that made Noctus mandatory. Everything else moved
    // to the device — Google is signed in through the Keychain, the model is
    // called directly, abilities run here — but the app still refused to start
    // without a session from a server that might not exist any more. Grove is
    // one person's assistant on one phone; it does not need to know who you are
    // to read your calendar out.
    if (!(await api.hasNoctusConfigured())) {
      setUser(null);
      setUid(await localIdentity());
      setStatus('signed-in');
      return;
    }
    const session = await auth.getSession();
    if (session) await hydrate();
    else setStatus('signed-out');
  }, [hydrate]);

  useEffect(() => {
    // Reading the stored Noctus session is a subscription to an external
    // system, not derived state — the setState lands in a promise callback.
    void bootstrap();
  }, [bootstrap]);

  // A magic link opens the app with the session in the URL. It arrives as an
  // event when the app is already running, and as the initial URL when the
  // link cold-starts it — the second case needs asking for explicitly.
  useEffect(() => {
    let cancelled = false;

    const consume = async (url: string | null) => {
      if (!url || cancelled) return;
      try {
        const session = await auth.completeMagicLink(url);
        if (session && !cancelled) await hydrate();
      } catch (error) {
        if (!cancelled) setNotice(error instanceof Error ? error.message : 'Sign-in failed.');
      }
    };

    void Linking.getInitialURL().then(consume);
    const sub = Linking.addEventListener('url', ({ url }) => {
      void consume(url);
    });

    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [hydrate]);

  // Supabase refreshing or dropping a token should move the app with it.
  useEffect(() => {
    return auth.onAuthChange((session: Session | null) => {
      if (session) return;
      void (async () => {
        if (await api.isDevSession()) return;
        setStatus('signed-out');
        setUser(null);
        setConnections([]);
      })();
    });
  }, []);

  const signIn = useCallback(async () => {
    setNotice(null);
    const session = await auth.signInWithNoctus();
    if (session) await hydrate();
  }, [hydrate]);

  const signInWithEmail = useCallback(async (email: string) => {
    setNotice(null);
    await auth.sendNoctusMagicLink(email);
  }, []);

  const finishSignIn = useCallback(
    async (pasted: string, email?: string) => {
      setNotice(null);
      await auth.completeFromPasted(pasted, email);
      await hydrate();
    },
    [hydrate]
  );

  /**
   * Start using Grove without an account.
   *
   * Deliberately NOT the dev-login bypass, which is gated on __DEV__ and must
   * stay that way: that one mints a token for a real backend user, and shipping
   * it in a release build would be a way into somebody's data.
   *
   * This grants nothing. It takes the same path a fresh standalone install
   * already takes — a local id in the Keychain, no session, no server — and is
   * only reachable from the login screen because a build made before Grove went
   * standalone still points at a backend it may not be able to reach. Sitting
   * behind a login for an account system the app no longer needs is the actual
   * fault; this is the door out of it.
   */
  const continueLocally = useCallback(async () => {
    setUser(null);
    setUid(await localIdentity());
    setNotice(null);
    setStatus('signed-in');
  }, []);

  const signInAsDev = useCallback(async () => {
    setNotice(null);
    await api.setDevSession(true);
    await hydrate();
  }, [hydrate]);

  const signOut = useCallback(async () => {
    await api.setDevSession(false);
    await auth.signOut();
    setStatus('signed-out');
    setUser(null);
    // Reset the storage namespace too, so nothing can be written against the
    // previous account between sign-out and the next sign-in.
    setUid('anon');
    setConnections([]);
  }, []);

  /** Re-reads what's connected, then recomputes every tool against it. */
  const syncConnections = useCallback(async () => {
    // Google is held on this phone now, not in a table on a server, so it is
    // read from the Keychain rather than fetched. This is the whole shape of
    // the change: the answer to "is Google connected" no longer depends on a
    // backend being awake.
    try {
      const live = await isGoogleConnected();
      setGranted((held) =>
        live ? [...new Set([...held, 'email'])] : held.filter((k) => k !== 'email')
      );
    } catch {
      // A Keychain read that fails is not a disconnection.
    }
    try {
      const { connected } = await api.fetchConnections();
      setConnections(connected ?? []);
    } catch {
      // Keep whatever we last knew rather than blanking the list on a blip.
    }
  }, []);

  /**
   * Connects one integration.
   *
   * Deliberately re-reads regardless of how the browser closed. Noctus's OAuth
   * callback lands on Noctus's own pages, not back in the app, so the auth
   * session almost always reports "dismiss" even on a successful grant — going
   * by the result would report failure for something that worked.
   */
  const connect = useCallback(
    async (bindingKey: string) => {
      // A device permission is granted here, on the phone, with no account and
      // no browser. Sending one down the OAuth path is what produced "OAuth not
      // configured" on Calendar — a row that never needed an account at all.
      if (isDevicePermission(bindingKey)) {
        const outcome = await grantDevice(bindingKey);
        const ok = outcome === 'granted';
        setGranted((held) => (ok ? [...new Set([...held, bindingKey])] : held.filter((k) => k !== bindingKey)));
        // Thrown as the outcome word, not a sentence. The screen knows the
        // row's label and whether it can offer a way to Settings; this does
        // not, and a message assembled here would be wrong for two of the
        // three cases.
        if (!ok) throw new Error(outcome);
        return;
      }
      // Google signs in on the device, with no server in the middle. A web
      // OAuth client can only come home to an https:// address, which is why
      // signing in from the phone could never work against a laptop backend —
      // localhost resolves, on the phone, to nothing at all.
      if (bindingKey === 'google' || bindingKey === 'email') {
        const ok = await connectGoogle();
        setGranted((held) =>
          ok ? [...new Set([...held, 'email'])] : held.filter((k) => k !== 'email')
        );
        if (!ok) throw new Error('Sign-in was cancelled.');
        return;
      }

      const { url } = await api.oauthUrl(bindingKey);
      await WebBrowser.openAuthSessionAsync(url, auth.redirectTo);
      await syncConnections();
    },
    [syncConnections]
  );

  const disconnect = useCallback(
    async (bindingKey: string) => {
      // Signing out of Google is deleting the tokens from this Keychain. There
      // is no server holding a copy to revoke.
      if (bindingKey === 'google' || bindingKey === 'email') {
        await disconnectGoogle();
        setGranted((held) => held.filter((k) => k !== 'email'));
        return;
      }
      // iOS has no API to hand a permission back, so the honest thing is to
      // forget it here and say where it is actually revoked.
      if (isDevicePermission(bindingKey)) {
        setGranted((held) => held.filter((k) => k !== bindingKey));
        setNotice('Removed here. To revoke it fully, use iOS Settings › Grove.');
        return;
      }
      await api.disconnectIntegration(bindingKey);
      await syncConnections();
    },
    [syncConnections]
  );

  const reloadConnections = useCallback(() => syncConnections(), [syncConnections]);
  const dismissNotice = useCallback(() => setNotice(null), []);

  // One list to the screens: an OAuth binding and a granted permission are
  // both "Grove may reach this", however differently they were obtained.
  const merged = useMemo(() => [...new Set([...connections, ...granted])], [connections, granted]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user,
      uid,
      connections: merged,
      notice,
      dismissNotice,
      signIn,
      signInWithEmail,
      finishSignIn,
      signInAsDev,
      continueLocally,
      signOut,
      refresh: hydrate,
      connect,
      disconnect,
      reloadConnections,
    }),
    [
      status,
      user,
      uid,
      merged,
      notice,
      dismissNotice,
      signIn,
      signInWithEmail,
      finishSignIn,
      signInAsDev,
      continueLocally,
      signOut,
      hydrate,
      connect,
      disconnect,
      reloadConnections,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
