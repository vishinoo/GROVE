/**
 * Where the Noctus session actually lives.
 *
 * Supabase persists both halves of the session — the access token and the
 * long-lived refresh token — through whatever storage it is handed. Handing it
 * AsyncStorage puts the refresh token in an unencrypted SQLite file inside the
 * app container, and that token is the one worth stealing: it outlives the
 * access token and mints new ones on demand. So this adapter puts it in the
 * Keychain (iOS) / Keystore-backed store (Android) instead.
 *
 * Two things make that less than a one-line swap:
 *
 *   1. SecureStore rejects large values — iOS has historically refused
 *      anything over ~2048 bytes — and a Supabase session carrying a fat JWT
 *      goes past that. Values are therefore split across numbered keys, with
 *      the head key holding a chunk count instead of a value.
 *
 *   2. Web has no SecureStore at all, and this app builds for web. There the
 *      adapter falls through to AsyncStorage, which is the best available and
 *      no worse than what we had.
 *
 * Sessions written by an earlier build are migrated on first read rather than
 * abandoned — otherwise shipping this would silently sign everyone out and,
 * worse, leave the old plaintext token sitting on disk.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Well under the ~2048-byte figure iOS has been known to refuse, leaving room
 * for the key name and the platform's own overhead.
 */
const MAX_CHUNK_BYTES = 1536;

/**
 * Marks a head key whose real value is spread across `<key>.0…n-1`.
 *
 * The leading NUL is the point: it cannot occur in the JSON of a real Supabase
 * session, so a head key can never be mistaken for a value. It is written as an
 * escape rather than as a raw byte because a literal NUL makes this whole file
 * binary to git and grep — undiffable, unreviewable and unsearchable.
 *
 * It also still says "mosaic" after the rebrand, deliberately. This is not a
 * label, it is a sentinel already written into the Keychain of every device
 * that has signed in; renaming it would make existing chunked sessions
 * unreadable, signing those users out and stranding the old chunks on disk, in
 * exchange for a string nobody ever sees.
 */
const CHUNK_PREFIX = '\u0000mosaic.chunks:';

/**
 * Tokens should not ride an iCloud Keychain sync to the user's other devices,
 * and should not come back from an encrypted backup onto a different phone.
 * This is the strictest constant that still allows background token refresh
 * while the device is unlocked.
 */
const KEYCHAIN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** SecureStore exists on iOS and Android only; web falls back. */
const SECURE_AVAILABLE = Platform.OS === 'ios' || Platform.OS === 'android';

/**
 * UTF-8 byte length without TextEncoder, which isn't guaranteed present on
 * every engine this runs on. Surrogate pairs are counted once, as 4 bytes.
 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — the pair encodes to 4 bytes, so count it here and
      // skip its partner rather than counting each half as 3.
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Splits on character boundaries while measuring bytes, so a multi-byte
 * character is never cut in half and no chunk exceeds the platform limit.
 */
function splitByBytes(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const char of text) {
    const size = utf8Length(char);
    if (currentBytes + size > maxBytes && current) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [''];
}

const chunkKey = (key: string, index: number) => `${key}.${index}`;

/** Reads the chunk count from a head value, or null if it isn't a head. */
function chunkCount(head: string | null): number | null {
  if (!head || !head.startsWith(CHUNK_PREFIX)) return null;
  const count = Number.parseInt(head.slice(CHUNK_PREFIX.length), 10);
  return Number.isInteger(count) && count > 0 ? count : null;
}

async function secureGet(key: string): Promise<string | null> {
  const head = await SecureStore.getItemAsync(key, KEYCHAIN_OPTIONS);
  const count = chunkCount(head);
  if (count === null) return head;

  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const part = await SecureStore.getItemAsync(chunkKey(key, i), KEYCHAIN_OPTIONS);
    // A missing chunk means a half-written or half-wiped record. A truncated
    // session is worse than no session — it would fail to parse somewhere
    // further away from here — so discard the lot.
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join('');
}

/**
 * Clears any chunks left by a previous, longer value. Without this, shrinking
 * a value from four chunks to two would leave chunks 2 and 3 in the Keychain
 * holding a stale fragment of an old token.
 */
async function clearChunks(key: string, upTo: number): Promise<void> {
  for (let i = 0; i < upTo; i++) {
    await SecureStore.deleteItemAsync(chunkKey(key, i), KEYCHAIN_OPTIONS).catch(() => {});
  }
}

async function secureSet(key: string, value: string): Promise<void> {
  const previous = chunkCount(await SecureStore.getItemAsync(key, KEYCHAIN_OPTIONS)) ?? 0;

  if (utf8Length(value) <= MAX_CHUNK_BYTES) {
    await SecureStore.setItemAsync(key, value, KEYCHAIN_OPTIONS);
    await clearChunks(key, previous);
    return;
  }

  const parts = splitByBytes(value, MAX_CHUNK_BYTES);
  for (let i = 0; i < parts.length; i++) {
    await SecureStore.setItemAsync(chunkKey(key, i), parts[i], KEYCHAIN_OPTIONS);
  }
  // The head is written last: until it names the new count, a reader either
  // sees the old complete value or nothing, never a mix of both.
  await SecureStore.setItemAsync(key, `${CHUNK_PREFIX}${parts.length}`, KEYCHAIN_OPTIONS);
  if (previous > parts.length) await clearChunks(key, previous);
}

async function secureRemove(key: string): Promise<void> {
  const previous = chunkCount(await SecureStore.getItemAsync(key, KEYCHAIN_OPTIONS)) ?? 0;
  await SecureStore.deleteItemAsync(key, KEYCHAIN_OPTIONS).catch(() => {});
  await clearChunks(key, previous);
}

/**
 * Moves a session written by a build that used AsyncStorage directly, then
 * deletes the plaintext copy. Runs at most once per key: after the move there
 * is nothing left in AsyncStorage to find.
 */
async function migrateFromAsyncStorage(key: string): Promise<string | null> {
  const legacy = await AsyncStorage.getItem(key).catch(() => null);
  if (legacy === null) return null;
  try {
    await secureSet(key, legacy);
    await AsyncStorage.removeItem(key);
    return legacy;
  } catch {
    // If the Keychain write fails we must not delete the only copy — the user
    // would be signed out with no way back. Leave it and try again next time.
    return legacy;
  }
}

/**
 * The object handed to Supabase's `auth.storage`. The shape is theirs; the
 * three methods are all it calls.
 */
export const secureSessionStorage = {
  async getItem(key: string): Promise<string | null> {
    if (!SECURE_AVAILABLE) return AsyncStorage.getItem(key);
    try {
      const stored = await secureGet(key);
      if (stored !== null) return stored;
      return await migrateFromAsyncStorage(key);
    } catch {
      // A Keychain that won't answer shouldn't crash sign-in; report no
      // session and let the user log in again.
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    if (!SECURE_AVAILABLE) return AsyncStorage.setItem(key, value);
    await secureSet(key, value);
  },

  async removeItem(key: string): Promise<void> {
    if (!SECURE_AVAILABLE) return AsyncStorage.removeItem(key);
    // Clear both stores: a token left behind by a failed migration must not
    // survive a sign-out.
    await Promise.all([secureRemove(key), AsyncStorage.removeItem(key).catch(() => {})]);
  },
};
