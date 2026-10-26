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

/**
 * Whether a message is machine text rather than something a person said.
 *
 * "The operation couldn't be completed. (OSStatus error 560557684.)" was
 * appearing on the Talk screen, which is the one screen in the app with no
 * room for anything that is not a sentence Grove would say out loud. It came
 * from the recogniser's own error being passed straight to the caption.
 *
 * The test is for the shapes a framework produces and a person never does: an
 * OSStatus or NSError code, a reverse-DNS domain, an errno, a stack frame, an
 * HTTP status on its own. Anything matching is filed and never shown.
 *
 * Deliberately a test for machine text rather than a list of known errors. The
 * next one will have a different number in it, and a list of numbers is a list
 * of the ones that already got through.
 */
export function isOpaque(message: string): boolean {
  const text = message.trim();
  if (!text) return true;
  return (
    /OSStatus|NSError|NSCocoaErrorDomain|kAudio|AVAudioSession|errno|ENOENT|EPERM/i.test(text) ||
    /Domain=|\bCode=-?\d/.test(text) ||
    /\b(?:Type|Reference|Syntax|Range|URI|Eval)Error\b|is not a function|undefined is not an object/.test(text) ||
    /\berror\s+-?\d+/i.test(text) ||
    /\(\s*code[:\s]*-?\d+/i.test(text) ||
    /^[a-z]+(?:\.[a-z][\w-]*){2,}/i.test(text) ||
    /\bat\s+\S+\s+\(.*:\d+:\d+\)/.test(text) ||
    /^HTTP\s*\d{3}/i.test(text) ||
    // A sentence has a space in it. One long token is an identifier.
    !/\s/.test(text)
  );
}

/**
 * What to say about a failure, in words.
 *
 * Every raw message that reaches a person has to pass through here first. The
 * original still goes to troubles.ts, where a number *is* the useful part —
 * this is only about what gets said and shown.
 *
 * A message that already reads like a sentence is kept: most failures in Grove
 * are written by Grove and say the right thing already ("I can't see your
 * calendar from here"). Only the ones that are plainly machine text get
 * replaced, and they are replaced by what is actually true of each kind.
 */
export function plainFailure(problem: unknown, fallbackLine = 'That did not work.'): string {
  const message = String((problem as { message?: unknown } | null)?.message ?? problem ?? '').trim();
  if (message && !isOpaque(message)) return message;
  switch (failureKind(problem)) {
    case 'timeout':
      return 'That took too long to come back. Ask me again.';
    case 'offline':
      return 'I have no connection right now.';
    default:
      return fallbackLine;
  }
}
