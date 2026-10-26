/**
 * A fetch deadline that exists on a phone.
 *
 * `AbortSignal.timeout(ms)` is the obvious way to bound a fetch and it is not
 * there. React Native replaces the global `AbortSignal` with the one from the
 * `abort-controller` package — see `setUpXHR.js`, which calls
 * `polyfillGlobal('AbortSignal', ...)` unconditionally — and that polyfill
 * predates the static helpers. `AbortSignal.timeout` is `undefined`, so
 * calling it throws `TypeError: AbortSignal.timeout is not a function`,
 * synchronously, before the request is even made.
 *
 * WHAT THAT COST
 *
 * The throw lands inside the caller's own `try`, which treats it as the
 * network having failed — so the failure is total, instant, and wears the
 * costume of a connectivity problem. Weather said "the weather service is not
 * answering" on every call, on full signal, with Open-Meteo up, and no retry
 * could ever help because the retry threw in the same place. It also silently
 * disabled the Drive fallback for documents and the scope check behind
 * Connections.
 *
 * Nothing catches this but a device. It type-checks — the DOM lib declares
 * `AbortSignal.timeout` — and it works everywhere the harness runs: Node has
 * it, and so does the browser `npx expo export --platform web` builds for.
 * That is why `npm run verify` now bans the call outright, which is the only
 * check that can see it.
 */

/**
 * Aborts after `ms`, like `AbortSignal.timeout` where that exists.
 *
 * The timer is left armed deliberately. Aborting a controller whose request
 * has already settled does nothing, and clearing it would mean handing every
 * call site a second value to remember to use — which is the kind of API that
 * gets half-adopted and then lies about its deadlines.
 */
export function timeoutSignal(ms: number): AbortSignal {
  // Used where it genuinely exists: Node for the harness, and a browser for
  // the web export. Only React Native lacks it, and only at runtime.
  const native = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout;
  if (typeof native === 'function') return native.call(AbortSignal, ms);

  const controller = new AbortController();
  // Aborting a request that has already settled is a no-op, which is what
  // makes leaving the timer armed safe.
  setTimeout(() => controller.abort(), ms);
  // The rejection this produces is an AbortError, which `failureKind` already
  // sorts as a timeout — so a deadline reads as "that took too long" rather
  // than as "I have no connection", exactly as the native version does.
  return controller.signal;
}
