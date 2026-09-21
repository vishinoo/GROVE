/**
 * What kind of failure a thrown error actually was.
 *
 * Everything that threw used to be reported as "no connection" unless it was
 * an `Error` named AbortError — and on a phone neither half of that test holds
 * reliably. React Native's fetch rejects an abort with a DOMException that is
 * not always an `Error`, and `AbortSignal.timeout` names its rejection
 * TimeoutError, not AbortError. So a slow answer, with the phone on full
 * signal, was announced as "I have no connection right now". Being told a
 * confident, wrong reason is worse than being told it broke: it sends you to
 * check your Wi-Fi.
 *
 * Only an error that says it is a network failure counts as offline. Anything
 * unrecognised is just an error, and is described as one.
 */
export type FailureKind = 'timeout' | 'offline' | 'error';

export function failureKind(problem: unknown): FailureKind {
  const name = String((problem as { name?: unknown } | null)?.name ?? '');
  const message = String((problem as { message?: unknown } | null)?.message ?? problem ?? '');
  if (/^(AbortError|TimeoutError)$/.test(name) || /abort|timed? ?out/i.test(message)) return 'timeout';
  if (/network request failed|internet connection|offline|could not connect|not connected|ENOTFOUND|ECONN|EAI_AGAIN/i.test(message)) {
    return 'offline';
  }
  return 'error';
}
