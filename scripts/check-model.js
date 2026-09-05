#!/usr/bin/env node
/**
 * Does Grove have a model it can actually talk to?
 *
 * This exists because the app can only report the symptom. When Grove says "no
 * model to think with", the cause is one of four things and they are
 * indistinguishable from inside the app: no key, a key that is rejected, a
 * model id that no longer exists, or a key with no quota. Each needs a
 * different fix, and guessing costs a Metro restart per attempt.
 *
 * Reads .env directly rather than importing anything, so it tells you what is
 * on disk — which is the thing that actually gets compiled into the bundle, and
 * not necessarily what your editor is showing you.
 *
 *   node scripts/check-model.js
 */

const fs = require('fs');
const path = require('path');

const ENV = path.join(__dirname, '..', '.env');

function readEnv() {
  if (!fs.existsSync(ENV)) return {};
  const out = {};
  for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const say = (s) => process.stdout.write(s + '\n');

async function checkGemini(key, model) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    ':generateContent';

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the word: ok' }] }],
        generationConfig: { maxOutputTokens: 8 },
      }),
    });
  } catch (e) {
    say(`  ✗ could not reach Google at all — ${e.message}`);
    return false;
  }

  const body = await response.text();

  if (response.ok) {
    let reply = '';
    try {
      const data = JSON.parse(body);
      reply = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
    } catch {
      /* the status is what matters */
    }
    say(`  ✓ ${model} answered${reply ? ` — "${reply}"` : ''}`);
    return true;
  }

  // The four failures, each named rather than lumped into "request failed".
  let reason = body.slice(0, 200);
  try {
    reason = JSON.parse(body).error?.message ?? reason;
  } catch {
    /* keep the raw text */
  }

  if (response.status === 400 && /API key not valid/i.test(reason)) {
    say(`  ✗ the key is rejected. Check it at https://aistudio.google.com/apikey`);
  } else if (response.status === 404) {
    say(`  ✗ "${model}" does not exist or is retired.`);
    say(`    This is the one that looks like a missing key from inside the app.`);
  } else if (response.status === 429) {
    say(`  ✗ out of quota for ${model}.`);
  } else if (response.status === 403) {
    say(`  ✗ the key is valid but not allowed to use ${model} (${reason})`);
  } else {
    say(`  ✗ HTTP ${response.status} — ${reason}`);
  }
  return false;
}

async function checkOllama(url, model) {
  try {
    const tags = await fetch(`${url.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!tags.ok) {
      say(`  ✗ ${url} answered ${tags.status}`);
      return false;
    }
    const names = (await tags.json()).models?.map((m) => m.name) ?? [];
    const has = names.some((n) => n === model || n.startsWith(model.split(':')[0]));
    say(`  ✓ reachable, ${names.length} model(s) pulled`);
    if (!has) {
      say(`  ✗ but "${model}" is not among them — run: ollama pull ${model}`);
      return false;
    }
    say(`  ✓ ${model} is pulled`);
    return true;
  } catch {
    say(`  ✗ nothing listening at ${url}`);
    say(`    Ollama binds localhost by default; the phone needs OLLAMA_HOST=0.0.0.0`);
    return false;
  }
}

(async () => {
  const env = readEnv();
  const key = env.EXPO_PUBLIC_GEMINI_API_KEY || '';
  const model = env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const deep = env.EXPO_PUBLIC_GEMINI_MODEL_DEEP || '';
  const ollamaUrl = env.EXPO_PUBLIC_OLLAMA_URL || '';
  const ollamaModel = env.EXPO_PUBLIC_OLLAMA_MODEL || 'llama3.2:1b';

  say('');
  say('Reading .env from disk (not from your editor).');
  say('');

  let anything = false;

  say(`Ollama  ${ollamaUrl || '(not set)'}`);
  if (ollamaUrl) anything = (await checkOllama(ollamaUrl, ollamaModel)) || anything;
  else say('  – skipped. Free and local if you want it: brew install ollama');
  say('');

  say(`Gemini  ${model}`);
  if (!key) {
    say('  ✗ EXPO_PUBLIC_GEMINI_API_KEY is empty on disk.');
    say('    If you just pasted it, your editor has not saved — check for a dot');
    say('    on the tab. Reload the file before saving, or you will overwrite');
    say('    the model id along with it.');
  } else {
    say(`  key present (${key.length} chars)`);
    anything = (await checkGemini(key, model)) || anything;
    if (deep) {
      say('');
      say(`Gemini  ${deep}  (deep tier)`);
      await checkGemini(key, deep);
    }
  }

  say('');
  if (anything) {
    say('Grove has a model. Restart Metro — EXPO_PUBLIC_* is compiled into the');
    say('bundle, so a hot reload will not pick this up.');
  } else {
    say('Grove has no model, and will say so rather than pretending.');
  }
  say('');
  process.exit(anything ? 0 : 1);
})();
