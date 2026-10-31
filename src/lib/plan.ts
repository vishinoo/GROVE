/**
 * The rest of what they asked for.
 *
 * One sentence can ask for five things — "check my calendar, order dinner,
 * finish the presentation on my Mac, email it to my colleague, and put the
 * film back on" — and the model is good at this: asked for that, it comes
 * back with five tool calls, correctly split, each quoting the words that
 * asked for it, and routed to the right machine.
 *
 * The tool loop then ran the reads, reached the first thing that *does*
 * something, and returned. **The other three were dropped with nothing on
 * screen to say so**, which is the worst shape a failure can have here: it
 * looks exactly like Grove deciding those parts were not worth doing.
 *
 * So what is left is kept. This is the queue.
 *
 * WHY IT REPLAYS WORDS RATHER THAN RUNNING TOOLS
 *
 * A step is stored as **the words from their own sentence that asked for
 * it**, and carried out by handing those words back to `exchange` as though
 * they had just been said. Not because that is cheaper — it costs one model
 * call a step — but because the alternative is a second path that does
 * things, running beside the one that has always done them.
 *
 * Everything that guards an action lives on that path: the check that their
 * words actually asked for it, the confirmation, the press, the twenty-five
 * second expiry, the offer budget, the register. A queue that called
 * abilities directly would have to re-implement every one of them, and the
 * first one somebody forgot would be a plan that spent money without asking.
 * Replaying the words costs a model call and inherits all of it.
 *
 * WHAT A PLAN MAY NEVER DO
 *
 * - **Confirm anything.** `confirmed` is stripped on the way in and is never
 *   written on the way out. Every irreversible step stops and waits for its
 *   own press, exactly as it would if it had been the only thing asked for.
 *   A plan makes Grove finish a sentence; it does not make Grove trusted.
 * - **Survive the conversation.** A new sentence abandons it. "Prepare my
 *   evening" followed by "actually, what's the weather" is somebody changing
 *   their mind, not somebody queueing a sixth thing.
 * - **Outlive the moment.** It expires, because a queue left armed is the
 *   same booby trap as a confirmation left armed — and an evening prepared
 *   the next morning is not a feature.
 * - **Grow.** Capped, so a model having an enthusiastic afternoon cannot
 *   line up twenty actions off one sentence.
 */

/** A thing still to do, as the words that asked for it. */
export type Step = {
  /** The ability the model named. Kept for the harness and the screen. */
  tool: string;
  /** Their own words. This is what gets said back into the turn. */
  asked: string;
};

export type Plan = {
  steps: Step[];
  /** How many have been handed over. */
  at: number;
  /** When the sentence was said. */
  made: number;
};

/**
 * Four, so the five-part sentence this exists for finishes: the first action
 * runs in the turn itself and four wait. Past that it is not a request, it
 * is a model writing itself a to-do list.
 */
export const MOST_STEPS = 4;

/**
 * Eight minutes. Long enough for a step to need a press, be read back, and
 * be pressed; short enough that nothing from one conversation reaches the
 * next one.
 */
export const PLAN_LIFE_MS = 8 * 60_000;

/** Never set by a plan, whatever the model called the argument. */
const NEVER = new Set(['confirmed', 'draft', 'new_email']);

type Call = { name: string; args?: unknown };
type Known = { id: string; reads?: boolean };

/**
 * What is left of a turn's calls, as a plan, or null if nothing is.
 *
 * `rest` is everything the model asked for after the one the turn is about
 * to carry out. A call survives only if it names an ability that exists, is
 * allowed here, is not a pure read — the reads already ran inside the loop —
 * and quotes the words that asked for it. A step with no quote cannot be
 * replayed, and inventing one would be Grove putting words in their mouth.
 */
export function planFrom(rest: Call[], known: Known[], idFor: (name: string) => string | null, now = Date.now()): Plan | null {
  const steps: Step[] = [];
  const seen = new Set<string>();
  for (const call of rest) {
    if (steps.length >= MOST_STEPS) break;
    const id = idFor(call.name);
    const ability = id ? known.find((a) => a.id === id) : null;
    if (!ability || ability.reads) continue;

    const args = (call.args ?? {}) as Record<string, unknown>;
    if (Object.keys(args).some((k) => NEVER.has(k.toLowerCase()))) {
      // A model that tried to confirm its own queue does not get a quieter
      // version of that; the step goes.
      continue;
    }
    const asked = String(args.asked ?? '').trim();
    if (asked.length < 3) continue;

    // The same words twice is one step. A model asked for five things
    // sometimes names one of them twice, and doing it twice is worse than
    // not doing it at all when the thing is an order.
    const key = `${ability.id}:${asked.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    steps.push({ tool: ability.id, asked });
  }
  return steps.length ? { steps, at: 0, made: now } : null;
}

/** The next thing to say back, or null if there is nothing left or it is stale. */
export function nextStep(plan: Plan | null, now = Date.now()): Step | null {
  if (!plan) return null;
  if (now - plan.made > PLAN_LIFE_MS) return null;
  return plan.steps[plan.at] ?? null;
}

/** Marks the current step handed over. */
export function advance(plan: Plan): Plan {
  return { ...plan, at: plan.at + 1 };
}

/** What is still owed, for the screen and for the model's own context. */
export function remaining(plan: Plan | null, now = Date.now()): Step[] {
  if (!plan || now - plan.made > PLAN_LIFE_MS) return [];
  return plan.steps.slice(plan.at);
}
