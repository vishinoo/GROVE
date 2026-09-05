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
  key: string;
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
    key: 'google',
    label: 'Mail',
    what: 'The three that matter',
    icon: 'mail',
    kind: 'account',
    unlocks: ['mail.search'],
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
