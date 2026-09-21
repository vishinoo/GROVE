/**
 * The documents Grove has written, so it can point at one afterwards.
 *
 * Writing a document is not a read, so it runs outside the model's tool loop —
 * which means the model never sees the link that came back. "Write me a report
 * on those stocks" then "send that to Jason" was therefore two unrelated
 * requests, the second of which had nothing to send. This is the thread
 * between them: a short list of what was written, with links, that any later
 * turn can look up.
 *
 * On the phone, per account. The documents themselves live in Drive; this is
 * only the receipt.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type WrittenDoc = { title: string; url: string; at: string };

/** Enough to cover "that thing you wrote last week". */
const LIMIT = 40;

const KEY = 'grove:docs:v1';

function storageKey(uid: string): string {
  return `${KEY}:${uid}`;
}

export async function loadDocs(uid: string): Promise<WrittenDoc[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(uid));
    const parsed = raw ? (JSON.parse(raw) as WrittenDoc[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function rememberDoc(uid: string, title: string, url: string): Promise<void> {
  try {
    const next = [{ title, url, at: new Date().toISOString() }, ...(await loadDocs(uid))].slice(0, LIMIT);
    await AsyncStorage.setItem(storageKey(uid), JSON.stringify(next));
  } catch {
    // The document exists either way; losing the receipt costs a follow-up.
  }
}
