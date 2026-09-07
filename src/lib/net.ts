/**
 * One authed call to Noctus, for the parts of Grove that no longer care what
 * Noctus is.
 *
 * Noctus has been reduced to plumbing: it brokers OAuth, holds the model key,
 * and runs scheduled sparks. Nothing in Grove reaches for a Noctus *agent* any
 * more. This is deliberately the whole surface — abilities and sparks talk
 * through here and know nothing else about the backend, so replacing it later
 * is a change to one file.
 */

import { getNoctusUrl, isDevSession, NoctusError } from './noctusApi';
import { DEV_TOKEN, getSession } from './noctusAuth';

async function token(): Promise<string> {
  if (await isDevSession()) return DEV_TOKEN;
  const session = await getSession();
  if (!session) throw new NoctusError('Not signed in.', 401);
  return session.access_token;
}

/**
 * Mobile networks are slow, but a spoken reply that takes this long is lost.
 *
 * Ten seconds, down from fifteen. This is the ceiling on how long Grove can sit
 * saying nothing, and fifteen seconds of silence reads as a crash — long enough
 * that people press the ring again, cancelling the turn they were waiting for.
 */
const TIMEOUT_MS = 10_000;

/**
 * For calls that go on to search the web before answering.
 *
 * Ten seconds is right for a lookup that should be instant and wrong for one
 * that includes a round trip to Google — that mismatch is why anything worth
 * searching for timed out. Callers opt in, so a slow path cannot become the
 * default by accident.
 */
const SLOW_TIMEOUT_MS = 25_000;

export async function fetchJson<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; slow?: boolean } = {}
): Promise<T | null> {
  const base = await getNoctusUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.slow ? SLOW_TIMEOUT_MS : TIMEOUT_MS);

  try {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Authorization: `Bearer ${await token()}`,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    // Callers speak to a person, so a network failure is a sentence, not a
    // stack trace. Returning null lets each one say something true.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
