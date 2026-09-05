#!/usr/bin/env node
/**
 * Write the Gemini key into .env without going through an editor.
 *
 * Exists because a stale editor buffer silently reverted this file twice, and
 * a key that never reaches disk is indistinguishable, from inside the app, from
 * a key that is wrong. This touches exactly one line and leaves the rest alone.
 *
 *   node scripts/set-key.js AIza...
 */
const fs = require('fs');
const path = require('path');

const key = (process.argv[2] || '').trim();
const ENV = path.join(__dirname, '..', '.env');

if (!key) {
  console.error('Usage: node scripts/set-key.js <your-gemini-key>');
  process.exit(1);
}
if (!/^AIza[0-9A-Za-z_-]{10,}$/.test(key)) {
  console.error(`That does not look like a Gemini key (they start "AIza"). Got ${key.length} chars.`);
  process.exit(1);
}
if (!fs.existsSync(ENV)) {
  console.error('No .env found. Copy .env.example to .env first.');
  process.exit(1);
}

const lines = fs.readFileSync(ENV, 'utf8').split('\n');
let done = false;
const out = lines.map((line) => {
  if (line.startsWith('EXPO_PUBLIC_GEMINI_API_KEY=')) {
    done = true;
    return `EXPO_PUBLIC_GEMINI_API_KEY=${key}`;
  }
  return line;
});
if (!done) out.push(`EXPO_PUBLIC_GEMINI_API_KEY=${key}`);

fs.writeFileSync(ENV, out.join('\n'), 'utf8');
console.log(`Wrote ${key.length}-char key to .env`);
console.log('Now run:  npm run check-model');
