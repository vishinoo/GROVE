/**
 * Does any of this actually work, on this phone, with this account?
 *
 * Everything here can be tested from a laptop except the half that matters
 * most: Gmail, Calendar, Drive and Contacts need a token that only ever lives
 * in the Keychain on the phone. So the tests come to the phone. Each check
 * makes the smallest real call it can — reads, never writes — and reports what
 * came back, in the words the person would need to fix it.
 *
 * Two rules keep this honest:
 *
 *   NO WRITES. A self-check that sends an email or creates a document to prove
 *   it can is a self-check nobody dares run twice. Permission to write is
 *   tested by asking what the sign-in was granted, not by using it.
 *
 *   THE REAL REASON. A failure says which API refused and what to do — the
 *   activation link when one is switched off, the reconnect when a scope was
 *   never granted. "Something went wrong" is what this exists to replace.
 */

import { openReminders } from './deviceCalendar';
import { capabilities } from './capabilities';
import * as google from './google';
import { isGoogleConnected, missingScopes } from './googleAuth';
import { lastModelTrouble, lightBrief, toolTurn } from './lightModel';
import { runAbility, abilityById } from './abilities';
import * as trigger from './trigger';

export type CheckResult = {
  name: string;
  /** What this proves, in one short line, when it passes. */
  ok: boolean;
  detail: string;
  /** Google's own switch-on link, when that is what is wrong. */
  link?: string;
  /** Not run, rather than failed — a check that needs something else first. */
  skipped?: boolean;
};

type Check = { name: string; run: () => Promise<Omit<CheckResult, 'name'>> };

/** Bounded, because a check that hangs is a diagnostics screen that hangs. */
async function within<T>(ms: number, work: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

const CHECKS: Check[] = [
  {
    name: 'Thinking',
    run: async () => {
      const turn = await within(
        20_000,
        toolTurn('Reply with the single word: ready.', [{ role: 'user', parts: [{ text: 'ping' }] }], []),
        { kind: 'nothing' as const }
      );
      if (turn.kind === 'text') return { ok: true, detail: 'The model answered.' };
      // The reason, where there is one. "No answer from the model" sent
      // someone hunting a connection problem for a depleted account, which is
      // the one failure here that no amount of retrying can fix.
      switch (lastModelTrouble()) {
        case 'no-credit':
          return {
            ok: false,
            detail: 'The Gemini account is out of credit. Top it up in AI Studio — nothing that thinks will work until then.',
            link: 'https://ai.studio/projects',
          };
        case 'no-key':
          return { ok: false, detail: 'No model key. Add one in Settings.' };
        case 'no-model':
          return { ok: false, detail: 'The configured model has been retired. Change it in Settings.' };
        case 'rate-limited':
          return { ok: false, detail: 'Rate limited by Google. Try again in a few seconds.' };
        default:
          return { ok: false, detail: 'No answer from the model. Check your signal and try again.' };
      }
    },
  },
  {
    name: 'Web search',
    run: async () => {
      const found = await within(30_000, lightBrief('what day of the week is it today'), null);
      return found
        ? { ok: true, detail: found.spoken.slice(0, 80) }
        : { ok: false, detail: 'Search did not come back. Usually signal; try again in a moment.' };
    },
  },
  {
    name: 'Weather',
    run: async () => {
      const ability = abilityById('weather.now');
      if (!ability) return { ok: false, detail: 'Missing.' };
      const outcome = await runAbility(ability, {});
      return { ok: outcome.ok, detail: outcome.spoken };
    },
  },
  {
    name: 'Google sign-in',
    run: async () => {
      if (!(await isGoogleConnected())) {
        return { ok: false, detail: 'Not connected. Connect Google Workspace in Connections.' };
      }
      const address = await within(15_000, google.me(), null);
      return address
        ? { ok: true, detail: `Signed in as ${address}.` }
        : { ok: false, detail: google.explain('your account') };
    },
  },
  {
    name: 'Gmail, reading',
    run: async () => {
      const found = await within(20_000, google.searchMail({ limit: 1 }), null);
      if (found === null) return { ok: false, detail: google.explain('your inbox'), link: google.activationLink() ?? undefined };
      return { ok: true, detail: found.length > 0 ? `Newest: ${found[0].subject}` : 'Inbox reachable, nothing recent.' };
    },
  },
  {
    name: 'Gmail, sending',
    run: async () => {
      const missing = await missingScopes('sending mail');
      if (missing === null) return { ok: true, detail: 'Cannot tell until something is sent.' };
      return missing.length === 0
        ? { ok: true, detail: 'Permission granted.' }
        : { ok: false, detail: 'Never granted. Disconnect and reconnect Google, allowing everything.' };
    },
  },
  {
    name: 'Calendar',
    run: async () => {
      const events = await within(20_000, google.readCalendar(2), null);
      if (events === null) return { ok: false, detail: google.explain('your calendar'), link: google.activationLink() ?? undefined };
      return { ok: true, detail: `${events.length} event${events.length === 1 ? '' : 's'} in the next two days.` };
    },
  },
  {
    name: 'Calendar, changing',
    run: async () => {
      const missing = await missingScopes('your calendar');
      if (missing === null) return { ok: true, detail: 'Cannot tell until something is added.' };
      return missing.length === 0
        ? { ok: true, detail: 'Permission granted.' }
        : { ok: false, detail: 'Never granted. Reconnect Google, allowing everything.' };
    },
  },
  {
    name: 'Contacts',
    run: async () => {
      const found = await within(20_000, google.findContact('a'), null);
      return found === null
        ? { ok: false, detail: google.explain('your contacts'), link: google.activationLink() ?? undefined }
        : { ok: true, detail: 'Contacts reachable.' };
    },
  },
  {
    name: 'Drive and Docs',
    run: async () => {
      const found = await within(25_000, google.findDoc('a'), null);
      if (found === null) {
        return { ok: false, detail: google.explain('your documents'), link: google.activationLink() ?? undefined };
      }
      const missing = await missingScopes('writing documents');
      return missing && missing.length > 0
        ? { ok: false, detail: 'Can read, but writing was never granted. Reconnect Google.' }
        : { ok: true, detail: 'Drive reachable, and writing is allowed.' };
    },
  },
  {
    name: 'Reminders',
    run: async () => {
      const open = await within(15_000, openReminders(5), null);
      return open === null
        ? { ok: false, detail: 'No access. Allow Reminders for Grove in iOS Settings.' }
        : { ok: true, detail: `${open.length} outstanding.` };
    },
  },
  {
    name: 'Listening',
    run: async () => {
      const { speech, remote } = capabilities();
      if (!speech) return { ok: false, detail: 'This build cannot listen — it needs a development build.' };
      return { ok: true, detail: remote ? 'Microphone and audio session are here.' : 'Microphone here; no audio session.' };
    },
  },
  {
    name: 'The ring',
    run: async () => {
      if (!capabilities().remote) return { ok: false, detail: 'Not in this build.' };
      return trigger.isArmed()
        ? { ok: true, detail: `Armed. ${trigger.hasHeardRing() ? 'A press has been seen.' : 'No press seen yet.'}` }
        : { ok: false, detail: 'Not armed. Reopen Grove, and check the glasses are connected.' };
    },
  },
];

/** Runs every check in order, handing each result back as it lands. */
export async function runSelfCheck(onResult: (result: CheckResult) => void): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    let outcome: Omit<CheckResult, 'name'>;
    try {
      outcome = await check.run();
    } catch (error) {
      // A check that throws is a failure like any other, and saying which one
      // threw beats a screen that stops halfway with no explanation.
      outcome = { ok: false, detail: error instanceof Error ? error.message : 'Threw an error.' };
    }
    const result = { name: check.name, ...outcome };
    results.push(result);
    onResult(result);
  }
  return results;
}
