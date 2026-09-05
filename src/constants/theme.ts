/**
 * Grove's design tokens.
 *
 * The palette is white, and that is a change of mind. It used to be warm paper
 * and black ink taken from the logo, which read as a printed instrument panel.
 * The trouble was that it had no room for the one thing Grove actually needs to
 * show: a soft, shifting mass of colour that means "I am listening to you".
 * Against warm paper that mass fought the ground. Against white it is the only
 * colour on the screen.
 *
 * Two rules hold the look together:
 *
 *   HAIRLINES, NOT SHADOWS   Structure comes from a one-pixel line and the
 *                            step between the page and a card. Almost nothing
 *                            is elevated; the two things that genuinely float
 *                            over content have `lift` and nothing else does.
 *
 *   COLOUR MEANS ONE THING   The orb, and the app icons. Everything structural
 *                            is ink on white. `signal` marks live hardware,
 *                            `alert` marks something to fix, and both are
 *                            rationed to dots and short labels — never a fill.
 *                            If colour starts meaning "this is a button", the
 *                            signal stops working.
 */

import { Platform } from 'react-native';

export const Colors = {
  light: {
    /**
     * The ground cards sit on. Deliberately not white: a white card on a white
     * page has no edge, and the card system is what makes the lists readable.
     */
    paper: '#F4F5F7',
    /** Cards, sheets, fields with content. */
    raised: '#FFFFFF',
    /** Inset wells — the text box, stepper buttons. */
    sunken: '#F6F7F9',
    /** Primary fills and the mark. */
    mark: '#16181D',
    ink: '#16181D',
    inkSoft: '#5B6069',
    muted: '#9096A0',
    line: '#E8EAEE',
    lineStrong: '#D7DAE0',
    /** Live hardware, live microphone. Never a background. */
    signal: '#22C55E',
    /** Something the user has to fix. Never a background. */
    alert: '#F59E0B',
    shadow: '#16181D',
  },
  dark: {
    paper: '#0D0E11',
    raised: '#17191E',
    sunken: '#101216',
    mark: '#F4F5F7',
    ink: '#F4F5F7',
    inkSoft: '#A2A8B3',
    muted: '#6E7480',
    line: '#252932',
    lineStrong: '#333843',
    signal: '#4ADE80',
    alert: '#FBBF24',
    shadow: '#000000',
  },
} as const;

export type ThemeName = keyof typeof Colors;
/** Widened so light and dark are one shape rather than two literal types. */
export type Palette = { [K in keyof (typeof Colors)['light']]: string };

/**
 * The orb's colours, and the gradients the app icons are built from.
 *
 * Kept here rather than inside the orb so that an app icon and the orb are
 * visibly from the same set — those are the only two places colour appears.
 */
export const Spectrum = {
  mint: '#5EEAD4',
  sky: '#7DD3FC',
  indigo: '#A5B4FC',
  violet: '#C4B5FD',
  pink: '#F9A8D4',
  green: '#86EFAC',
} as const;

export const Radius = {
  control: 14,
  card: 16,
  sheet: 28,
  well: 10,
  tile: 9,
  pill: 999,
};

export const Space = {
  screenX: 20,
  gutter: 12,
  row: 14,
  section: 28,
} as const;

/**
 * Elevation is deliberately almost absent.
 *
 * Structure is carried by hairlines and by the paper/raised step. `lift` exists
 * for the two things that genuinely float over content: the tab dock, and the
 * card the orb sits on.
 */
export const Elevation = {
  lift: Platform.select({
    ios: {
      shadowColor: '#16181D',
      shadowOpacity: 0.07,
      shadowRadius: 20,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 5 },
    default: {},
  }),
  liftSm: Platform.select({
    ios: {
      shadowColor: '#16181D',
      shadowOpacity: 0.05,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
    },
    android: { elevation: 2 },
    default: {},
  }),
} as const;

/**
 * One typeface, doing every job.
 *
 * This replaces three — Bricolage for display, Instrument for body, Space Mono
 * for labels. That set gave the app a bookish character that fought what it is:
 * something you glance at while walking. Hierarchy now comes from weight and
 * size, and it is two fewer network fonts to block first paint on.
 */
export const Fonts = {
  display: 'Inter_700Bold',
  displaySemi: 'Inter_600SemiBold',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemi: 'Inter_600SemiBold',
  mono: 'Inter_500Medium',
} as const;

/**
 * The small label above a group — "Connected", "Running", "Hardware".
 *
 * It used to be uppercase mono with wide tracking, which is the standard way
 * to make a label look technical and the standard way to make it hard to read
 * at a glance. Sentence case, medium weight, muted.
 */
export const monoLabel = {
  fontFamily: Fonts.bodySemi,
  fontSize: 11.5,
  letterSpacing: 0.1,
};

export const Type = {
  /** The one word under the orb: "Listening", "Thinking". */
  state: { fontFamily: Fonts.displaySemi, fontSize: 21, letterSpacing: -0.5 },
  screenTitle: { fontFamily: Fonts.display, fontSize: 26, letterSpacing: -0.9 },
  cardTitle: { fontFamily: Fonts.bodySemi, fontSize: 14.5, letterSpacing: -0.15 },
  body: { fontFamily: Fonts.body, fontSize: 14.5, lineHeight: 22 },
  bodySm: { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18 },
  /** What Grove last said. Centred under the orb, read at arm's length. */
  caption: { fontFamily: Fonts.body, fontSize: 15.5, lineHeight: 23 },
} as const;
