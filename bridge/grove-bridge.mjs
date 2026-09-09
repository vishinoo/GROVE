#!/usr/bin/env node
/**
 * Grove's hands on this Mac.
 *
 * Grove runs on a phone. It can talk, look things up and reach Google; what it
 * cannot do is use a computer — and "go and research this properly", "start the
 * assignment", "fix that script" are all things a person means literally. This
 * is the missing half: a small server that takes a task from Grove and hands it
 * to the Claude Code CLI already installed here, which can read, write and run
 * things inside one folder.
 *
 * WHAT THIS ACTUALLY IS, SAID PLAINLY
 *
 * It is a service that executes AI-directed commands on your machine. That is
 * the point of it and also the entire risk, so it is built to be boring about
 * safety rather than clever:
 *
 *   A SHARED SECRET IS REQUIRED. No token, no work — not a 403 with a hint,
 *   just nothing. The token lives in an environment variable on this side and
 *   .env on the app's, and never travels in a URL, where it would end up in
 *   somebody's access log.
 *
 *   ONE FOLDER. Everything runs inside GROVE_BRIDGE_DIR and nowhere else. The
 *   default is a scratch directory — deliberately not your home, and not a
 *   repository you care about — because an agent working from a misheard
 *   sentence should not be doing it among things that matter.
 *
 *   BOUND IN TIME. A task is killed at GROVE_BRIDGE_TIMEOUT. An agent left
 *   running is an agent nobody is watching.
 *
 *   WRITTEN DOWN. Every task and every result is appended to a log in that
 *   folder, because the only way to trust this is to be able to read what it
 *   did while you were not looking.
 *
 * Grove asks for a press before any of this is reached. That confirmation is
 * the other half of the safety story and it lives in the app, not here — this
 * end assumes every request that arrives was already meant.
 *
 *   export GROVE_BRIDGE_TOKEN="$(openssl rand -hex 24)"
 *   node bridge/grove-bridge.mjs
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.GROVE_BRIDGE_PORT ?? 4599);
const TOKEN = process.env.GROVE_BRIDGE_TOKEN ?? '';
const WORK_DIR = process.env.GROVE_BRIDGE_DIR ?? path.join(homedir(), 'Grove-agent');
const TIMEOUT_MS = Number(process.env.GROVE_BRIDGE_TIMEOUT ?? 240_000);
const LOG = path.join(WORK_DIR, 'grove-bridge.log');

if (!TOKEN || TOKEN.length < 16) {
  console.error(
    'GROVE_BRIDGE_TOKEN must be set, and at least 16 characters.\n\n' +
      'This service runs an AI agent on your machine. Without a secret, anything\n' +
      'on your network could use it.\n\n' +
      '  export GROVE_BRIDGE_TOKEN="$(openssl rand -hex 24)"\n'
  );
  process.exit(1);
}

/** Compared in full every time, so the token cannot be guessed a byte at a time. */
function sameToken(given) {
  if (typeof given !== 'string' || given.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i += 1) {
    diff |= given.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

async function note(line) {
  try {
    await appendFile(LOG, `${new Date().toISOString()}  ${line}\n`);
  } catch {
    // A log that cannot be written is not a reason to refuse the work, but it
    // is a reason to say so where someone will see it.
    console.error('could not write to the log');
  }
}

/** Hands the task to Claude Code, in the work folder, bounded. */
function runAgent(task) {
  return new Promise((resolve) => {
    const child = execFile(
      'claude',
      ['-p', task],
      { cwd: WORK_DIR, timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          resolve({
            ok: false,
            text: error.killed
              ? 'That took too long, so I stopped it.'
              : String(stderr).trim().slice(0, 600) || 'That did not run.',
          });
          return;
        }
        resolve({ ok: true, text: String(stdout).trim() });
      }
    );
    child.on('error', () =>
      resolve({ ok: false, text: 'The Claude Code CLI is not installed on this machine.' })
    );
  });
}

const server = createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // Says nothing about the token, the folder, or whether the CLI is here.
  if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true });

  if (req.method !== 'POST' || req.url !== '/task') return send(404, {});

  const header = req.headers.authorization ?? '';
  if (!sameToken(header.replace(/^Bearer\s+/i, ''))) {
    await note('REFUSED — bad or missing token');
    return send(401, {});
  }

  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    // A task is a sentence, not a payload.
    if (raw.length > 8_000) return send(413, {});
  }

  let task = '';
  try {
    task = String(JSON.parse(raw).task ?? '').trim();
  } catch {
    return send(400, {});
  }
  if (!task) return send(400, {});

  await note(`TASK  ${task}`);
  const result = await runAgent(task);
  await note(`${result.ok ? 'DONE' : 'FAIL'}  ${result.text.slice(0, 300).replace(/\n/g, ' ')}`);
  send(200, { ok: result.ok, text: result.text.slice(0, 4000) });
});

await mkdir(WORK_DIR, { recursive: true });
server.listen(PORT, () => {
  console.log(`Grove bridge listening on :${PORT}`);
  console.log(`  working folder  ${WORK_DIR}`);
  console.log(`  log             ${LOG}`);
  console.log('  every task needs the token, and Grove asks you to confirm first.');
});
