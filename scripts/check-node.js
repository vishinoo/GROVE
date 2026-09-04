/**
 * Expo SDK 57 needs Node >= 20.19.4. On older Node the failure is a stack
 * trace about `parseEnv is not a function` from deep inside @expo/env, which
 * says nothing about the actual problem. Fail here instead, with the fix.
 */

const REQUIRED = [20, 19, 4];

const current = process.versions.node.split('.').map(Number);

const tooOld =
  current[0] < REQUIRED[0] ||
  (current[0] === REQUIRED[0] && current[1] < REQUIRED[1]) ||
  (current[0] === REQUIRED[0] && current[1] === REQUIRED[1] && current[2] < REQUIRED[2]);

if (tooOld) {
  process.stderr.write(
    `\n  Grove needs Node ${REQUIRED.join('.')} or newer — you're on ${process.versions.node}.\n\n` +
      `  This project pins it in .nvmrc, but nvm's default alias may be older,\n` +
      `  so a fresh terminal starts on the wrong version. Run:\n\n` +
      `      nvm use 20\n\n` +
      `  To stop hitting this in every new terminal:\n\n` +
      `      nvm alias default 20\n\n`
  );
  process.exit(1);
}
