import { Colors, type Palette } from '@/constants/theme';

/**
 * Grove is light-only, for now.
 *
 * The dark palette in theme.ts is written and every token resolves against it,
 * so switching is a one-line change here — but it has never been looked at on
 * a device, and shipping an untested inversion of a design whose whole point is
 * a single signal colour is a good way to lose that signal.
 *
 * Turn this into `useColorScheme()` once the dark direction has had a pass.
 */
export function usePalette(): Palette {
  return Colors.light;
}

export function useIsNight(): boolean {
  return false;
}
