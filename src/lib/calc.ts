/**
 * Arithmetic, done exactly.
 *
 * The model is a language model: asked "what's 15 percent of 240" it said
 * thirty, having said thirty-six the day before. A wrong number said with
 * confidence is the worst kind of answer, and arithmetic is the one kind of
 * question where being right is free — so the sum is worked out here and
 * handed to the model as a fact, and the model's job is only to say it.
 *
 * Deliberately small: percentages and the four operations, with brackets and
 * powers, in digits or spoken words. Anything it cannot parse it leaves alone.
 */

const WORDS: [RegExp, string][] = [
  [/\bper ?cent\b/gi, '%'],
  [/\b(?:multiplied by|times)\b/gi, '*'],
  [/(\d)\s*x\s*(\d)/gi, '$1*$2'],
  [/\b(?:divided by|over)\b/gi, '/'],
  [/\bplus\b/gi, '+'],
  [/\bminus\b/gi, '-'],
  [/\bsquared\b/gi, '^2'],
  [/\bcubed\b/gi, '^3'],
  [/\bto the power of\b/gi, '^'],
];

function num(s: string): number {
  return Number(s.replace(/,/g, ''));
}

function format(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const rounded = Math.round(n * 1e6) / 1e6;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

/** Evaluates + - * / ^ and brackets. Throws on anything else. */
function evaluate(expr: string): number {
  const tokens = expr.match(/\d+(?:\.\d+)?|[-+*/^()]/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];

  const primary = (): number => {
    const t = next();
    if (t === '(') {
      const v = sum();
      if (next() !== ')') throw new Error('bracket');
      return v;
    }
    if (t === '-') return -primary();
    if (t === undefined || !/^\d/.test(t)) throw new Error('number');
    return Number(t);
  };
  const power = (): number => {
    const base = primary();
    if (peek() === '^') {
      next();
      return base ** power();
    }
    return base;
  };
  const product = (): number => {
    let v = power();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = power();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };

  const value = sum();
  if (i !== tokens.length) throw new Error('trailing');
  return value;
}

/**
 * The exact answer to any arithmetic in a sentence, as a line for the model,
 * or null when there is none.
 */
/**
 * Whether this sentence is asking for a sum at all.
 *
 * Without this, every sentence went through the parser and the parser is happy
 * to find arithmetic in things that are not arithmetic: "move my 2 - 3 pm
 * meeting" came out as -1, "book it for 9/23" as 0.39, "1/2 cup" as 0.5. A
 * calculation is asked for, in words, or is the whole sentence.
 */
const ASKS_FOR_MATHS =
  /\b(?:what(?:'s| is)|how much is|how many is|calculate|work out|equals?)\b|\bpercent\b|\b%\b|\b(?:times|multiplied by|divided by|plus|minus|squared|cubed|to the power of)\b/i;

/** A date, a time range, a fraction with a unit — numbers that are not a sum. */
const NOT_A_SUM = [
  /\b\d{1,2}\s*[-–]\s*\d{1,2}\s*(?:am|pm|o'?clock)\b/i,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
  /\b\d+\s*\/\s*\d+\s*(?:cup|cups|tsp|tbsp|inch|inches|mile|miles|kg|lb|lbs|litre|liter|split|ratio)\b/i,
  /\b\d{1,2}[:.]\d{2}\b/,
];

export function calculate(text: string): string | null {
  if (!ASKS_FOR_MATHS.test(text)) return null;
  if (NOT_A_SUM.some((pattern) => pattern.test(text))) return null;

  let t = text;
  for (const [pattern, to] of WORDS) t = t.replace(pattern, to);

  // "15% of 240", "15 % of 240".
  const pct = /(-?\d[\d,]*(?:\.\d+)?)\s*%\s*of\s*(-?\d[\d,]*(?:\.\d+)?)/i.exec(t);
  if (pct) {
    const value = (num(pct[1]) / 100) * num(pct[2]);
    return `${pct[1]}% of ${pct[2]} = ${format(value)}`;
  }

  // The longest run of numbers and operators with at least one operator in it.
  const runs = t.match(/[\d.,()\s]*\d[\d.,()\s]*(?:[-+*/^][\d.,()\s]*\d[\d.,()\s]*)+/g) ?? [];
  const run = runs.sort((a, b) => b.length - a.length)[0];
  if (!run) return null;
  // A date, a phone number or a score is not a sum — and all three are
  // written with the dash tight against the digits ("5-2", "780-555-0199").
  // Said out loud, subtraction arrives as "minus" and comes back spaced, so
  // this is tested before the spaces are taken out, or "10 minus 2" is skipped.
  if (/^\s*\d+(?:-\d+)+\s*$/.test(run)) return null;
  const expr = run.replace(/,(?=\d{3}\b)/g, '').replace(/\s+/g, '');
  if (!/[-+*/^]/.test(expr)) return null;
  try {
    const value = evaluate(expr);
    return Number.isFinite(value) ? `${expr} = ${format(value)}` : null;
  } catch {
    return null;
  }
}
