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

import * as api from '@/lib/noctusApi';
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

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<api.NoctusUser | null>(null);
  const [uid, setUid] = useState<string>('anon');
  const [connections, setConnections] = useState<string[]>([]);
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
      // A session we can't verify is not a session. Keep the user out rather
      // than showing an app that silently fails every action.
      setNotice(error instanceof Error ? error.message : 'Could not reach Noctus.');
      setStatus('signed-out');
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
      const { url } = await api.oauthUrl(bindingKey);
      await WebBrowser.openAuthSessionAsync(url, auth.redirectTo);
      await syncConnections();
    },
    [syncConnections]
  );

  const disconnect = useCallback(
    async (bindingKey: string) => {
      await api.disconnectIntegration(bindingKey);
      await syncConnections();
    },
    [syncConnections]
  );

  const reloadConnections = useCallback(() => syncConnections(), [syncConnections]);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user,
      uid,
      connections,
      notice,
      dismissNotice,
      signIn,
      signInWithEmail,
      finishSignIn,
      signInAsDev,
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
      connections,
      notice,
      dismissNotice,
      signIn,
      signInWithEmail,
      finishSignIn,
      signInAsDev,
      signOut,
      hydrate,
      connect,
      disconnect,
      reloadConnections,
    ]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
