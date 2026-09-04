/**
 * Noctus API client.
 *
 * Grove never does the work itself when a tool covers it — it calls the tool,
 * agent runs on Noctus. This is the whole seam between the two systems.
 *
 * Auth is a Supabase JWT in an Authorization header, which is what
 * Backend/middleware/auth.js verifies. Endpoints and payload shapes here match
 * Noctus/Backend/routes/{agents,credentials,oauth,auth}.js.
 */

// `new URL()` below needs the polyfill; React Native's built-in is partial.
// Importing it here rather than relying on noctusAuth being loaded first.
import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEV_TOKEN, getSession } from './noctusAuth';

const NOCTUS_URL_KEY = 'grove.noctus_url';
const DEV_MODE_KEY = 'grove.dev_session';

const DEFAULT_NOCTUS_URL = process.env.EXPO_PUBLIC_NOCTUS_URL || 'https://www.noctusai.org';

/**
 * Every authenticated call sends the user's Supabase JWT to whatever this
 * returns, so a stored value is a standing instruction about where to send
 * credentials. In a release build the override is ignored outright: the field
 * that writes it is dev-only, but the value persists, and a URL set while
 * testing must not follow the app into production. Reading it unconditionally
 * also meant anything able to write one AsyncStorage key could redirect every
 * token to a host of its choosing.
 */
export async function getNoctusUrl(): Promise<string> {
  if (!__DEV__) return DEFAULT_NOCTUS_URL.replace(/\/$/, '');
  const stored = await AsyncStorage.getItem(NOCTUS_URL_KEY);
  return (stored?.trim() || DEFAULT_NOCTUS_URL).replace(/\/$/, '');
}

/**
 * Rejects anything that isn't an http(s) URL, and refuses cleartext outside
 * development — the placeholder in the login field is a plain `http://` LAN
 * address, and a bearer token does not belong on an unencrypted connection.
 */
export async function setNoctusUrl(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('Enter a Noctus URL.');

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('That is not a valid URL.');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The Noctus URL must start with https://.');
  }
  if (parsed.protocol === 'http:' && !__DEV__) {
    throw new Error('The Noctus URL must use https://.');
  }

  await AsyncStorage.setItem(NOCTUS_URL_KEY, trimmed);
}

/** Dev sign-in stands in for a Supabase session when the backend allows it. */
export async function setDevSession(on: boolean): Promise<void> {
  if (on) await AsyncStorage.setItem(DEV_MODE_KEY, '1');
  else await AsyncStorage.removeItem(DEV_MODE_KEY);
}

/**
 * Gated on `__DEV__` for the same reason the dev sign-in button is: this flag
 * makes every request authenticate with the literal string `dev-token`, and a
 * stored '1' must not be able to do that in a shipped build.
 */
export async function isDevSession(): Promise<boolean> {
  if (!__DEV__) return false;
  return (await AsyncStorage.getItem(DEV_MODE_KEY)) === '1';
}

async function authToken(): Promise<string | null> {
  if (await isDevSession()) return DEV_TOKEN;
  const session = await getSession();
  return session?.access_token ?? null;
}

export class NoctusError extends Error {
  status: number;
  /** Binding keys the call needs connected, when Noctus names them. */
  requiredBindings: string[];
  /** Noctus blocks activation and running until the account can be billed. */
  requiresPayment: boolean;
  constructor(
    message: string,
    status: number,
    requiredBindings: string[] = [],
    requiresPayment = false
  ) {
    super(message);
    this.name = 'NoctusError';
    this.status = status;
    this.requiredBindings = requiredBindings;
    this.requiresPayment = requiresPayment;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Public endpoints skip the token so they work before sign-in. */
  auth?: boolean;
  signal?: AbortSignal;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, signal } = options;
  const base = await getNoctusUrl();

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  if (auth) {
    const token = await authToken();
    if (!token) throw new NoctusError('Not signed in to Noctus.', 401);
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    // A cancelled request (screen unmounted mid-flight) is not a network
    // problem, and telling the user to check their connection would be wrong.
    if (cause instanceof Error && cause.name === 'AbortError') throw cause;
    throw new NoctusError("Couldn't reach Noctus. Check your connection.", 0);
  }

  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new NoctusError(
      payload?.error || `Noctus request failed (${response.status})`,
      response.status,
      Array.isArray(payload?.requiredBindings) ? payload.requiredBindings : [],
      payload?.requiresPayment === true || response.status === 402
    );
  }
  return payload as T;
}

/* ------------------------------------------------------------------ types */

export type NoctusUser = {
  uid?: string;
  email?: string;
  name?: string | null;
  avatar?: string | null;
  plan?: string;
};

export type NoctusAgentTemplate = {
  id: string;
  title: string;
  description: string;
  category?: string;
  tags?: string[];
  requiredBindings?: string[];
  icon?: string;
};

export type NoctusSpark = {
  id: string;
  title: string;
  description?: string;
  category?: string;
  agentIds?: string[];
  kpiLabels?: string[];
};

export type NoctusInstance = {
  instanceId: string;
  agentId: string;
  title?: string;
  status?: string;
  description?: string;
  category?: string;
  bindings?: Record<string, unknown>;
  installedAt?: string;
};

/* --------------------------------------------------------------- catalogue */

/** Public — the app can show the catalogue before anyone signs in. */
export function fetchSparks(signal?: AbortSignal): Promise<{ sparks: NoctusSpark[] }> {
  return request('/api/agents/sparks', { auth: false, signal });
}

export function fetchBuiltinAgents(
  signal?: AbortSignal
): Promise<{ agents: NoctusAgentTemplate[] }> {
  return request('/api/agents/builtin', { auth: false, signal });
}

export function fetchOAuthProviders(signal?: AbortSignal): Promise<Record<string, boolean>> {
  return request('/api/oauth/providers', { auth: false, signal });
}

/* ---------------------------------------------------------------- account */

export function fetchMe(): Promise<{ user: NoctusUser }> {
  return request('/api/auth/me');
}

/** Noctus creates the user row on first sign-in from a new client. */
export function syncAccount(displayName?: string): Promise<{ user: NoctusUser }> {
  return request('/api/auth/sync', { method: 'POST', body: { displayName } });
}

/* ----------------------------------------------------------------- crew */

export function fetchMyInstances(signal?: AbortSignal): Promise<{ agents: NoctusInstance[] }> {
  return request('/api/agents/my', { signal });
}

/**
 * Adding a Grove tool creates a custom spark on Noctus: a named bundle of
 * whichever built-in agents cover the job. The user never sees the bundle —
 * they see one agent with a face and a name.
 */
export function createCustomSpark(input: {
  title: string;
  description: string;
  category?: string;
  agentIds: string[];
}): Promise<{ sparkId: string; newInstalls: number; results: { instanceId: string }[] }> {
  return request('/api/agents/create-custom-spark', { method: 'POST', body: input });
}

export function installSpark(sparkId: string): Promise<unknown> {
  return request(`/api/agents/install-spark/${encodeURIComponent(sparkId)}`, { method: 'POST' });
}

/** One node's result inside a run. Shape comes from engine/executor.js. */
export type RunStep = {
  nodeId?: string;
  label?: string;
  type?: string;
  success?: boolean;
  error?: string;
  output?: unknown;
  result?: unknown;
  skipped?: boolean;
  note?: string;
};

export type RunResult = {
  executionId?: string;
  success?: boolean;
  error?: string;
  requiresPayment?: boolean;
  duration?: number;
  steps?: RunStep[];
};

export function runInstance(instanceId: string, input?: unknown): Promise<RunResult> {
  return request(`/api/agents/my/${encodeURIComponent(instanceId)}/run`, {
    method: 'POST',
    body: input ?? {},
  });
}

/** Everything an agent has produced, newest first — its visible output. */
export function fetchInstanceLogs(
  instanceId: string,
  signal?: AbortSignal
): Promise<{ logs: (RunResult & { id?: string; timestamp?: string })[] }> {
  return request(`/api/agents/my/${encodeURIComponent(instanceId)}/logs`, { signal });
}

/** Connect a binding so an agent can leave pending_setup and actually run. */
export function setBinding(
  instanceId: string,
  bindings: Record<string, unknown>
): Promise<unknown> {
  return request(`/api/agents/my/${encodeURIComponent(instanceId)}/binding`, {
    method: 'PATCH',
    body: { bindings },
  });
}

export function removeInstance(instanceId: string): Promise<unknown> {
  return request(`/api/agents/my/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
}

/* --------------------------------------------------------- integrations */

/** The integration layer: which of the user's connections are live. */
export function fetchConnections(signal?: AbortSignal): Promise<{ connected: string[] }> {
  return request('/api/credentials', { signal });
}

export function disconnectIntegration(bindingKey: string): Promise<unknown> {
  return request(`/api/credentials/${encodeURIComponent(bindingKey)}`, { method: 'DELETE' });
}

/** Consent URL for a provider — opened in an auth session, then re-fetched. */
export function oauthUrl(
  provider: string,
  params?: Record<string, string>
): Promise<{ url: string }> {
  const query = params ? `?${new URLSearchParams(params).toString()}` : '';
  return request(`/api/oauth/${encodeURIComponent(provider)}/url${query}`);
}
