/**
 * Developer mode.
 *
 * The tools for showing Grove off and working on it — filling memory for a
 * demo, replaying the intro, signing out into the intro rather than the login
 * screen — are not for someone using Grove, and on a screen of real settings
 * they read as clutter at best and as a button that fills your memory with a
 * stranger's life at worst. So they sit behind one switch at the bottom of
 * Settings, off by default.
 *
 * Nothing here is sensitive, so it stays in AsyncStorage beside the intro
 * flag rather than in the vault. Held in a module-level store so the session
 * context, which is not under any screen, can ask it synchronously.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

const KEY = 'grove.devmode';

let on = false;
const listeners = new Set<() => void>();

void AsyncStorage.getItem(KEY)
  .then((value) => {
    on = value === '1';
    listeners.forEach((listener) => listener());
  })
  .catch(() => {});

export function isDevMode(): boolean {
  return on;
}

export function setDevMode(next: boolean): void {
  on = next;
  listeners.forEach((listener) => listener());
  void AsyncStorage.setItem(KEY, next ? '1' : '0').catch(() => {});
}

export function useDevMode(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => on,
    () => false
  );
}
