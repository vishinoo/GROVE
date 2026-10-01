/**
 * Keeping the memory unreadable to everything but Grove.
 *
 * Everything Grove remembers — who is in your life, what happened, what you
 * said you did not understand, what you spent, and the handful of verbatim
 * turns waiting to be consolidated — goes into AsyncStorage, which on iOS is a
 * plain SQLite file inside the app container. Readable by anything that can
 * read that container: a file browser on a jailbroken phone, and an
 * unencrypted desktop backup.
 *
 * That is a worse exposure here than in most apps, because of what this app is.
 * Grove listens while you walk around. The buffer in life.ts holds sentences
 * you said out loud, verbatim, until a model has read them. A mail subject
 * line, a professor's name and "£140 on dinner" are not secrets individually
 * and are a fairly complete picture of someone together.
 *
 * So the values are encrypted with AES-256 in counter mode, under a key that
 * lives in the Keychain and nowhere else.
 *
 * WHY THE KEY'S FLAGS ARE THE WHOLE POINT
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` is what makes this worth doing. The key
 * never rides an iCloud Keychain sync and never comes back from a backup onto
 * a different phone — so a restored backup contains the memory and no way to
 * read it. Without that flag this is busywork: the key would travel with the
 * data it protects.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not protect you from a running, unlocked phone with Grove open. It
 * cannot: the app has to be able to read its own memory, so anything with the
 * app's identity can too. This raises the cost of getting at the data from
 * "copy a file" to "run code as this app", which is the honest description and
 * the one that belongs in Settings.
 *
 * NO MESSAGE AUTHENTICATION, DELIBERATELY
 *
 * There is no MAC, so this detects nothing and prevents nobody from flipping
 * bits in the ciphertext. Confidentiality is the goal; nobody is attacking a
 * memory file to corrupt it, and if the bytes do change, the plaintext fails
 * to parse — which every store here already treats as a corrupt archive and
 * recovers from by forgetting. Adding a hand-rolled MAC would be one more
 * thing to get wrong for no threat anyone faces.
 *
 * TWO RULES THAT MATTER MORE THAN THE CRYPTO
 *
 *   1. **A value that is not encrypted yet is read as it is.** Everything
 *      written by a build before this one is plaintext, and refusing to read it
 *      would wipe the memory of every existing install. It is re-written
 *      encrypted on the spot, so a store that is only ever read still gets
 *      migrated rather than sitting in the clear for ever.
 *
 *   2. **A write that cannot be encrypted is written in the clear.** If the
 *      Keychain will not answer, the choice is between losing what someone just
 *      told Grove and storing it the way it was stored last week. Losing a
 *      memory to protect it is the wrong trade, and the next successful write
 *      encrypts it.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

/** Marks a value this file wrote. Anything else is plaintext from before. */
const TAG = 'gv1:';

const KEY_NAME = 'grove.vault.key.v1';

/** See the note above: these flags are what makes the encryption meaningful. */
const KEYCHAIN: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** SecureStore is iOS and Android only, and this app builds for web. */
const SECURE_AVAILABLE = Platform.OS === 'ios' || Platform.OS === 'android';

/**
 * aes-js ships no types, so the small corner of it used here is declared.
 *
 * Narrow on purpose: naming only what this file calls means a version that
 * moved something would fail to compile rather than fail at runtime, in the
 * one place where failing at runtime means a memory nobody can read.
 */
type Aes = {
  utils: {
    utf8: { toBytes: (text: string) => Uint8Array; fromBytes: (bytes: Uint8Array) => string };
  };
  Counter: new (iv: Uint8Array) => object;
  ModeOfOperation: {
    ctr: new (
      key: Uint8Array,
      counter: object
    ) => { encrypt: (bytes: Uint8Array) => Uint8Array; decrypt: (bytes: Uint8Array) => Uint8Array };
  };
};

/**
 * Loaded with a lazy require inside a try, like every other dependency here.
 *
 * aes-js is pure JavaScript and has no native half, so this is not the
 * reduced-mode probe protecting a device build — it is the same discipline
 * applied for the same reason: a module that fails to load must degrade this
 * file to plaintext rather than take the bundle down before the first screen.
 */
function cipher(): Aes | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('aes-js') as Aes;
  } catch {
    return null;
  }
}

let keyBytes: Uint8Array | null = null;
let keyAsked = false;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * The key, minted once per install.
 *
 * Held in memory after the first read: this is called on every load of every
 * store, and a Keychain round trip per read would make opening the app
 * noticeably slower for no benefit — the key is already in this process.
 */
async function vaultKey(): Promise<Uint8Array | null> {
  if (keyBytes) return keyBytes;
  if (keyAsked && !keyBytes) return null;
  keyAsked = true;
  if (!SECURE_AVAILABLE) return null;

  try {
    const held = await SecureStore.getItemAsync(KEY_NAME, KEYCHAIN);
    if (held && held.length === 64) {
      keyBytes = hexToBytes(held);
      return keyBytes;
    }
    const minted = await Crypto.getRandomBytesAsync(32);
    const hex = bytesToHex(minted);
    await SecureStore.setItemAsync(KEY_NAME, hex, KEYCHAIN);
    keyBytes = minted;
    return keyBytes;
  } catch {
    // No Keychain means no encryption, and no encryption means plaintext —
    // which is where this app already was.
    return null;
  }
}

function utf8ToBytes(text: string, aes: Aes): Uint8Array {
  return aes.utils.utf8.toBytes(text);
}

function bytesToUtf8(bytes: Uint8Array, aes: Aes): string {
  return aes.utils.utf8.fromBytes(bytes);
}

async function seal(plain: string): Promise<string | null> {
  const aes = cipher();
  const key = await vaultKey();
  if (!aes || !key) return null;
  try {
    const nonce = await Crypto.getRandomBytesAsync(16);
    const ctr = new aes.ModeOfOperation.ctr(key, new aes.Counter(nonce));
    const sealed = ctr.encrypt(utf8ToBytes(plain, aes));
    return `${TAG}${bytesToHex(nonce)}:${bytesToHex(sealed)}`;
  } catch {
    return null;
  }
}

function unseal(stored: string): string | null {
  const aes = cipher();
  if (!aes || !keyBytes) return null;
  try {
    const [nonce, body] = stored.slice(TAG.length).split(':');
    if (!nonce || nonce.length !== 32 || body === undefined) return null;
    const ctr = new aes.ModeOfOperation.ctr(keyBytes, new aes.Counter(hexToBytes(nonce)));
    return bytesToUtf8(ctr.decrypt(hexToBytes(body)), aes);
  } catch {
    return null;
  }
}

/**
 * A drop-in for AsyncStorage, for the stores that hold someone's life.
 *
 * The same three methods with the same signatures, so a store adopts this by
 * changing one import. Deliberately not applied to everything: the persona,
 * the mode, whether the intro has been seen and the list of standing sparks are
 * settings rather than memories, and encrypting them would cost a decrypt on
 * every screen for nothing worth hiding.
 */
export const vault = {
  async getItem(key: string): Promise<string | null> {
    const stored = await AsyncStorage.getItem(key).catch(() => null);
    if (stored === null) return null;
    if (!stored.startsWith(TAG)) {
      // Written before this file existed, or by a write that could not reach
      // the Keychain. Readable as it is, and re-written sealed now rather than
      // whenever this store next happens to be written to.
      void seal(stored).then((sealed) => {
        if (sealed) void AsyncStorage.setItem(key, sealed).catch(() => {});
      });
      return stored;
    }
    // The key has to be in hand before unsealing, and the first read of a
    // launch is where it gets loaded.
    await vaultKey();
    return unseal(stored);
  },

  async setItem(key: string, value: string): Promise<void> {
    const sealed = await seal(value);
    await AsyncStorage.setItem(key, sealed ?? value);
  },

  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
  },
};

/**
 * Whether what is on disk is actually encrypted, for Settings to state rather
 * than claim. A promise about storage that nobody checked is how "end-to-end
 * encrypted" ends up in a changelog and nowhere else.
 */
export async function vaultReady(): Promise<boolean> {
  return (await vaultKey()) !== null && cipher() !== null;
}
