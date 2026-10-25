import { createContext, useContext, useSyncExternalStore } from 'react';
import { Appearance } from 'react-native';

import { Colors, type Palette } from '@/constants/theme';

/**
 * Which palette the app is drawn in.
 *
 * This used to return `Colors.light` and nothing else, with a note saying the
 * dark palette existed and had never been looked at. It has been asked for, so
 * it is on.
 *
 * WHY THIS IS A STORE AND NOT A CONTEXT
 *
 * `usePalette` is called from the login screen, from onboarding, and from
 * components that render before any provider is mounted. A context would need
 * a provider above all of them, and the one piece of state involved is a
 * three-way enum. A module-level store with `useSyncExternalStore` reaches
 * everywhere, costs one subscription per component, and cannot be rendered
 * outside its provider because it has not got one.
 *
 * WHY "SYSTEM" DOES NOT WORK YET
 *
 * `app.json` carries `userInterfaceStyle: "light"`, which writes
 * `UIUserInterfaceStyle` into Info.plist and pins the whole app to light at
 * the OS level — `Appearance.getColorScheme()` then answers "light" on a phone
 * in dark mode, truthfully, because that is what the app asked for. It is
 * changed to "automatic" for the next build; until that build exists, choosing
 * Dark explicitly is the thing that works, and it works over the air because
 * it is only this module deciding which object to hand back.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

let choice: ThemeChoice = 'system';
const listeners = new Set<() => void>();

/** Called when the stored persona loads or changes. */
export function setThemeChoice(next: ThemeChoice | undefined): void {
  const want = next ?? 'system';
  if (want === choice) return;
  choice = want;
  for (const listener of listeners) listener();
}

export function themeChoice(): ThemeChoice {
  return choice;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // The system can change under a 'system' choice without anything in the app
  // happening, so that counts as a change to this store too.
  const watch = Appearance.addChangeListener(() => listener());
  return () => {
    listeners.delete(listener);
    watch.remove();
  };
}

function nightNow(): boolean {
  if (choice === 'dark') return true;
  if (choice === 'light') return false;
  return Appearance.getColorScheme() === 'dark';
}

export function useIsNight(): boolean {
  // The server snapshot is only reached by the web export, which has no
  // appearance to read and should render the same thing twice.
  return useSyncExternalStore(subscribe, nightNow, () => false);
}

/**
 * Glass, for screens drawn over the field.
 *
 * Memory and Settings sit on the same moving colour as Talk, dimmed, and
 * their cards are panes of frosted white over it rather than paper. Rather
 * than thread a second set of colours through every card, row and label,
 * a screen on the field says so once and everything inside it asks for the
 * palette as usual and gets this one. Light or dark does not apply there:
 * the field is the ground, and white is what reads on it.
 */
export const OnField = createContext(false);

const GLASS: Palette = {
  ...Colors.dark,
  paper: 'transparent',
  raised: 'rgba(255,255,255,0.08)',
  sunken: 'rgba(255,255,255,0.05)',
  mark: '#FFFFFF',
  onMark: '#0B0C12',
  ink: '#FFFFFF',
  inkSoft: 'rgba(255,255,255,0.82)',
  muted: 'rgba(255,255,255,0.66)',
  line: 'rgba(255,255,255,0.13)',
  lineStrong: 'rgba(255,255,255,0.22)',
  glass: 'rgba(20,22,30,0.55)',
  glassLine: 'rgba(255,255,255,0.14)',
};

export function usePalette(): Palette {
  const night = useIsNight();
  const glass = useContext(OnField);
  if (glass) return GLASS;
  return night ? Colors.dark : Colors.light;
}
