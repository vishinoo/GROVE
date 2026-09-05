/**
 * The things Grove may reach into.
 *
 * Six, not sixty. This list used to be computed by unioning every OAuth
 * provider Noctus offers with every binding its 74 agents asked for, which
 * produced Shopify, QuickBooks, Xero and Zapier on a screen belonging to a
 * personal assistant. It is now written down, because "what should a Life OS be
 * able to touch" is a product decision, not a query result.
 *
 * TWO KINDS, AND THE DIFFERENCE MATTERS
 *
 *   'device'   An iOS permission. Granted on the phone, instantly, with no
 *              account involved. Never appears in /api/credentials, so it must
 *              not be looked up there — it is asked for at the point of use.
 *   'account'  OAuth, brokered by Noctus. Involves a browser round trip and
 *              can be revoked server-side.
 *
 * Conflating the two is how you end up with a "Connect" button that opens a
 * browser to ask for permission to read the calendar that is already on the
 * phone.
 */

import type { AppIconName } from '@/components/app-icon';

export type ConnectionKind = 'device' | 'account';

export type Connection = {
  /**
   * The key that comes back from /api/credentials once this is connected.
   *
   * NOT the same as the provider you start the flow with, and conflating them
   * is a bug you only see after a successful connect: Noctus's Google callback
   * stores three bindings — `email`, `calendar` and `sheets` — and never one
   * called `google`. A row keyed on the provider therefore stays on "Connect"
   * forever, no matter how many times you complete the consent screen.
   */
  key: string;
  /**
   * What to hand /api/oauth/:provider/url. Only set for account connections,
   * and only different from `key` where one consent grants several bindings.
   */
  provider?: string;
  label: string;
  /** What Grove does with it, in the fewest words that are still true. */
  what: string;
  icon: AppIconName;
  kind: ConnectionKind;
  /**
   * Abilities that become usable once this is connected. Empty means the
   * ability behind it has not been built yet, which the UI says out loud.
   */
  unlocks: string[];
  /**
   * Set when the platform simply does not allow this, ever. Not a "not yet" —
   * a permanent no, stated rather than left for someone to discover.
   */
  impossible?: string;
  /** A caveat worth reading before connecting. */
  note?: string;
};

export const CONNECTIONS: Connection[] = [
  {
    key: 'calendar',
    label: 'Calendar',
    what: 'Your day, and what to move',
    icon: 'calendar',
    kind: 'device',
    unlocks: ['calendar.read', 'calendar.move'],
  },
  {
    key: 'reminders',
    label: 'Reminders',
    what: 'Thoughts caught mid-walk',
    icon: 'reminders',
    kind: 'device',
    unlocks: ['reminders.add'],
  },
  {
    key: 'music',
    label: 'Music',
    what: 'Play, queue, skip',
    icon: 'music',
    kind: 'device',
    unlocks: ['music.play'],
  },
  {
    key: 'email',
    provider: 'google',
    label: 'Mail',
    what: 'Sends mail you dictate',
    icon: 'mail',
    kind: 'account',
    unlocks: ['mail.send'],
    // Worth stating on the row, because "connected" and "can read your inbox"
    // are not the same thing here. Noctus asks Google for gmail.send and not
    // for any read scope, so a connected account can send and cannot search.
    note: 'Sending only — reading your inbox needs a wider Google scope on Noctus.',
  },
  {
    key: 'maps',
    label: 'Maps',
    what: 'When to leave',
    icon: 'maps',
    kind: 'device',
    unlocks: [],
  },
  {
    key: 'messages',
    label: 'Messages',
    what: 'Read out, and answered',
    icon: 'messages',
    kind: 'device',
    unlocks: [],
    // Worth stating plainly rather than shipping a button that cannot work.
    // There is no public API for reading iMessage or SMS on iOS, and no
    // entitlement that grants one. Same category as waking the app from
    // terminated with a ring press.
    impossible: 'iOS gives no app access to your messages. Nothing can change that.',
  },
];

export function connectionByKey(key: string): Connection | undefined {
  return CONNECTIONS.find((c) => c.key === key);
}

/** The account-backed ones, which are the only keys Noctus knows about. */
export function accountKeys(): string[] {
  return CONNECTIONS.filter((c) => c.kind === 'account').map((c) => c.key);
}

/** What to start the consent flow with, which is not always the stored key. */
export function providerFor(connection: Connection): string {
  return connection.provider ?? connection.key;
}
