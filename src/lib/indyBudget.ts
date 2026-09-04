/**
 * What's left of the hour's Indy messages.
 *
 * Indy is capped per account per hour by plan — two an hour on free — and the
 * endpoint reports the state of that cap on every response: `remaining` counts
 * down, and `rateLimited` marks the point where it has run out.
 *
 * Both were previously discarded, which had a visible consequence. A capped
 * request comes back 200 OK with `rateLimited: true` and a `reply` that reads
 * "You've used all 2 Indy messages for this hour…" — so that notice was being
 * spoken aloud as though Grove had said it, in Grove's own voice, mid-
 * conversation. Reading the flag lets the caller keep the cheap tier's answer
 * instead, and stop spending requests it already knows will be refused.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STATE_KEY = 'grove.indy_budget';

/** The cap resets hourly, so a block is never worth holding longer. */
const BLOCK_MS = 3_600_000;

type BudgetState = {
  /** Messages left this hour, as Indy last reported it. */
  remaining: number | null;
  /** Epoch ms after which it's worth trying Indy again. */
  blockedUntil: number | null;
};

const EMPTY: BudgetState = { remaining: null, blockedUntil: null };

export async function readBudget(): Promise<BudgetState> {
  try {
    const raw = await AsyncStorage.getItem(STATE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<BudgetState>;
    return {
      remaining: typeof parsed.remaining === 'number' ? parsed.remaining : null,
      blockedUntil: typeof parsed.blockedUntil === 'number' ? parsed.blockedUntil : null,
    };
  } catch {
    return EMPTY;
  }
}

async function write(state: BudgetState): Promise<void> {
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state)).catch(() => {});
}

/**
 * Whether it's worth spending a request on Indy at all. A block that has
 * expired is cleared here rather than left to accumulate.
 */
export async function isIndyBlocked(): Promise<boolean> {
  const state = await readBudget();
  if (state.blockedUntil === null) return false;
  if (Date.now() >= state.blockedUntil) {
    await write({ remaining: null, blockedUntil: null });
    return false;
  }
  return true;
}

/** Called with whatever the endpoint reported on its last response. */
export async function recordIndyResponse(input: {
  remaining?: unknown;
  rateLimited?: unknown;
}): Promise<void> {
  const remaining = typeof input.remaining === 'number' ? input.remaining : null;

  if (input.rateLimited === true) {
    await write({ remaining: 0, blockedUntil: Date.now() + BLOCK_MS });
    return;
  }

  // Reaching zero is the same situation as being told outright, one request
  // earlier — so stop there rather than spending one more to be told.
  if (remaining !== null && remaining <= 0) {
    await write({ remaining: 0, blockedUntil: Date.now() + BLOCK_MS });
    return;
  }

  await write({ remaining, blockedUntil: null });
}

/** Clears the block, e.g. after a plan change or a sign-in as someone else. */
export async function resetBudget(): Promise<void> {
  await AsyncStorage.removeItem(STATE_KEY).catch(() => {});
}
