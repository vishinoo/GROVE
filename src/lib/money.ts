/**
 * What you have, what you have spent, and whether this is a good idea.
 *
 * Grove does not spend money and this file does not change that: nothing here
 * has a card, a basket or a checkout. It is a ledger and an opinion, which
 * between them answer the one money question a phone cannot — "should I buy
 * this?" — because answering it needs to know what you earn, what you have
 * already spent this month, and what you said you were saving for.
 *
 * WHY THE NUMBERS LIVE HERE AND NOT IN memory.ts
 *
 * A fact is a sentence. "You spent £80 on shoes" as a sentence can be read back
 * and cannot be added up, and a budget you cannot subtract from is a feeling
 * rather than a budget. Everything here is a number with a date on it, which
 * means the advice can be specific — "£240 of your £400 is gone and it's the
 * eleventh" — and specific is the only version of this worth having.
 *
 * WHAT IT WILL NOT DO
 *
 * It never says buy it. Partly because it does not know enough — it cannot see
 * your bank, only what you have told it — and mostly because an assistant that
 * encourages spending is a shopping channel. It says what the numbers are, what
 * they mean for the thing you said you wanted, and leaves the decision where it
 * belongs. Told to be blunt, it is blunt in the direction of not spending.
 *
 * AND IT ASKS FIRST
 *
 * Advice with a number missing is worthless, so the ability behind this asks
 * for the number rather than guessing: how much is it, and what are you working
 * with a month. Both answers are kept, so it only ever asks once.
 */

import { vault } from './vault';

export type Purchase = {
  id: string;
  /** What it was, in their words: "running shoes", "dinner at Rostizado". */
  what: string;
  /** Always positive. A refund is not modelled, because nobody tells you. */
  amount: number;
  /** A loose grouping in their own words — "food", "clothes", "going out". */
  category: string;
  at: string;
};

export type Money = {
  /** What they have to play with in a month, when they have said. */
  monthly?: number;
  /** Per-category limits, when they have set any: { food: 400 }. */
  caps?: Record<string, number>;
  /** ISO 4217, or whatever they called it. Set once, from the first mention. */
  currency: string;
  purchases: Purchase[];
};

/** Two years of spending is plenty, and small: a few bytes each. */
const LIMIT = 2000;

const KEY = 'grove:money:v1';

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

const EMPTY: Money = { currency: 'CAD', purchases: [] };

export async function loadMoney(uid: string): Promise<Money> {
  try {
    const raw = await vault.getItem(storageKey(uid));
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<Money>;
    return {
      monthly: typeof parsed.monthly === 'number' ? parsed.monthly : undefined,
      caps: parsed.caps && typeof parsed.caps === 'object' ? parsed.caps : undefined,
      currency: typeof parsed.currency === 'string' ? parsed.currency : EMPTY.currency,
      purchases: Array.isArray(parsed.purchases) ? parsed.purchases : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

let queue: Promise<unknown> = Promise.resolve();

function update(uid: string, change: (money: Money) => Money): Promise<Money> {
  const run = queue.then(async () => {
    const next = change(await loadMoney(uid));
    const trimmed: Money = {
      ...next,
      purchases: [...next.purchases]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, LIMIT),
    };
    try {
      await vault.setItem(storageKey(uid), JSON.stringify(trimmed));
    } catch {
      // Losing one purchase costs a little accuracy in a total.
    }
    return trimmed;
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * A spoken amount, out of whatever they said.
 *
 * Written for speech, like every other parser in Grove: people say "eighty
 * bucks", "about 1.2k", "two hundred", "£80". Returns null rather than
 * guessing, because a wrong number here produces confident wrong advice, which
 * is worse than being asked again.
 */
/** The whole ledger and the budget with it, gone. */
export async function forgetAllMoney(uid: string): Promise<void> {
  await vault.removeItem(storageKey(uid)).catch(() => {});
}

export function readAmount(said: string): number | null {
  const text = said.toLowerCase().replace(/,/g, '');

  // "1.2k", "3k"
  const thousands = /(\d+(?:\.\d+)?)\s*k\b/.exec(text);
  if (thousands) return Math.round(Number(thousands[1]) * 1000);

  const digits = /(?:[$£€]\s*)?(\d+(?:\.\d{1,2})?)/.exec(text);
  if (digits) return Number(digits[1]);

  // Spoken numbers, up to the range anyone says out loud about one purchase.
  const WORDS: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90,
  };
  let total: number | null = null;
  let run = 0;
  for (const word of text.split(/[\s-]+/)) {
    if (word in WORDS) {
      run += WORDS[word];
      total = (total ?? 0) + 0;
    } else if (word === 'hundred') {
      run = (run || 1) * 100;
    } else if (word === 'thousand') {
      run = (run || 1) * 1000;
      total = (total ?? 0) + run;
      run = 0;
    } else if (word === 'and') {
      continue;
    } else if (run > 0) {
      break;
    }
  }
  const spoken = (total ?? 0) + run;
  return spoken > 0 ? spoken : null;
}

/** The symbol people expect to hear, from a code. */
export function symbolFor(currency: string): string {
  const known: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', CAD: '$', AUD: '$' };
  return known[currency.toUpperCase()] ?? '';
}

export function asMoney(amount: number, currency: string): string {
  const symbol = symbolFor(currency);
  const rounded = Math.round(amount * 100) / 100;
  const shown = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  return symbol ? `${symbol}${shown}` : `${shown} ${currency}`;
}

export async function setBudget(
  uid: string,
  monthly: number,
  category?: string,
  currency?: string
): Promise<Money> {
  return update(uid, (money) => {
    const next: Money = { ...money, ...(currency ? { currency } : {}) };
    const where = (category ?? '').trim().toLowerCase();
    if (!where) return { ...next, monthly };
    return { ...next, caps: { ...(next.caps ?? {}), [where]: monthly } };
  });
}

export async function spent(
  uid: string,
  what: string,
  amount: number,
  category = '',
  when = new Date()
): Promise<Money> {
  return update(uid, (money) => ({
    ...money,
    purchases: [
      {
        id: newId(),
        what: what.trim().slice(0, 120),
        amount: Math.abs(amount),
        category: category.trim().toLowerCase().slice(0, 40),
        at: when.toISOString(),
      },
      ...money.purchases,
    ],
  }));
}

export async function forgetPurchase(uid: string, id: string): Promise<Money> {
  return update(uid, (money) => ({
    ...money,
    purchases: money.purchases.filter((p) => p.id !== id),
  }));
}

/* ------------------------------------------------------------- totals */

function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export type Standing = {
  /** Spent since the first of the month. */
  thisMonth: number;
  /** By category, biggest first. */
  byCategory: { category: string; amount: number }[];
  /** What is left of the monthly figure, when one is set. */
  left: number | null;
  /** How far through the month it is, 0–1, so "halfway" can be said. */
  through: number;
  /** Their own median month, over the months with any record at all. */
  usualMonth: number | null;
};

export function standing(money: Money, now = new Date()): Standing {
  const from = startOfMonth(now).getTime();
  const mine = money.purchases.filter((p) => new Date(p.at).getTime() >= from);
  const thisMonth = mine.reduce((sum, p) => sum + p.amount, 0);

  const groups = new Map<string, number>();
  for (const p of mine) {
    const key = p.category || 'other';
    groups.set(key, (groups.get(key) ?? 0) + p.amount);
  }

  // Previous months, for "that's a heavy month for you".
  const months = new Map<string, number>();
  for (const p of money.purchases) {
    const key = p.at.slice(0, 7);
    if (key === now.toISOString().slice(0, 7)) continue;
    months.set(key, (months.get(key) ?? 0) + p.amount);
  }
  const totals = [...months.values()].sort((a, b) => a - b);
  const usualMonth = totals.length
    ? totals.length % 2
      ? totals[(totals.length - 1) / 2]
      : Math.round((totals[totals.length / 2 - 1] + totals[totals.length / 2]) / 2)
    : null;

  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return {
    thisMonth,
    byCategory: [...groups.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount),
    left: money.monthly === undefined ? null : Math.round((money.monthly - thisMonth) * 100) / 100,
    through: Math.min(now.getDate() / days, 1),
    usualMonth,
  };
}

/** Anything like this bought lately, which is the question behind "another one?". */
export function similar(money: Money, what: string, days = 90): Purchase[] {
  const words = what
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (words.length === 0) return [];
  const cutoff = Date.now() - days * 86_400_000;
  return money.purchases
    .filter((p) => new Date(p.at).getTime() >= cutoff)
    .filter((p) => {
      const haystack = `${p.what} ${p.category}`.toLowerCase();
      return words.some((w) => haystack.includes(w));
    })
    .slice(0, 6);
}

/**
 * Everything a model needs to have an opinion, as plain sentences.
 *
 * Deliberately all of it, including the gaps: "no monthly figure set" is itself
 * a reason to be careful, and hiding it produced advice that sounded certain
 * about a budget nobody had ever stated.
 */
export function moneyBlock(money: Money, now = new Date()): string {
  const s = standing(money, now);
  const c = money.currency;
  const lines = [
    money.monthly === undefined
      ? 'They have never told you what they have to spend in a month.'
      : `Monthly budget: ${asMoney(money.monthly, c)}.`,
    `Spent since the first: ${asMoney(s.thisMonth, c)}, and the month is ${Math.round(s.through * 100)}% through.`,
    s.left === null ? '' : `Left for the month: ${asMoney(s.left, c)}.`,
    s.byCategory.length
      ? `Where it went: ${s.byCategory.slice(0, 6).map((g) => `${g.category} ${asMoney(g.amount, c)}`).join(', ')}.`
      : 'Nothing recorded this month.',
    s.usualMonth === null ? '' : `A normal month for them is about ${asMoney(s.usualMonth, c)}.`,
    money.caps
      ? `Their own limits: ${Object.entries(money.caps).map(([k, v]) => `${k} ${asMoney(v, c)}`).join(', ')}.`
      : '',
  ];
  return lines.filter(Boolean).join('\n');
}
