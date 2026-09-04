/**
 * Grove's design tokens.
 *
 * The whole palette comes out of the logo, which is two colours and nothing
 * else: a black mark on warm paper. That constraint is the design — Grove is
 * a companion to a piece of hardware you are wearing, not an app you look at,
 * so the screen's job is to report state legibly at a glance and then get out
 * of the way.
 *
 * Two rules hold the look together:
 *
 *   MONOCHROME    Everything structural is ink on paper. There are no
 *                 decorative colours, no per-object identity colours, and
 *                 nothing is tinted to look friendly.
 *
 *   ONE SIGNAL    Colour means live hardware, and only that. `signal` marks a
 *                 device that is actually connected and a session that is
 *                 actually listening; `alert` marks something a person has to
 *                 fix. Both are rationed to dots, hairlines and short labels —
 *                 never a fill, never a background. If colour ever starts
 *                 meaning "this is a button", the signal stops working.
 */

import { Platform } from 'react-native';

export const Colors = {
  light: {
    /** The logo's own ground. Every screen sits on this. */
    paper: '#EFE9E1',
    /** Cards and sheets: lifted off the paper, not stamped onto it. */
    raised: '#F8F5F1',
    /** Pressed/inset wells — the inverse of raised. */
    sunken: '#E5DED4',
    /** The logo's own black, reserved for the mark and for primary fills. */
    mark: '#000000',
    /** Body ink. Fractionally warm so it doesn't vibrate against the paper. */
    ink: '#12100D',
    inkSoft: '#5A544A',
    muted: '#8F877A',
    line: 'rgba(18,16,13,0.13)',
    lineStrong: 'rgba(18,16,13,0.26)',
    /** Live hardware, live microphone. Never a background. */
    signal: '#1B7F4C',
    /** Something the user has to fix. Never a background. */
    alert: '#B3341F',
    shadow: '#12100D',
  },
  dark: {
    paper: '#0D0C0A',
    raised: '#171512',
    sunken: '#080706',
    mark: '#EFE9E1',
    ink: '#EFE9E1',
    inkSoft: '#A79F92',
    muted: '#777064',
    line: 'rgba(239,233,225,0.14)',
    lineStrong: 'rgba(239,233,225,0.28)',
    signal: '#3FBE7C',
    alert: '#E4674F',
    shadow: '#000000',
  },
} as const;

export type ThemeName = keyof typeof Colors;
/** Widened so light and dark are one shape rather than two literal types. */
export type Palette = { [K in keyof (typeof Colors)['light']]: string };

/**
 * Corner radii.
 *
 * Tighter than an app that wants to feel soft. Grove reports on hardware, so
 * it reads better as instrument panel than as chat client — the only fully
 * round things are the trigger and the status dots.
 */
export const Radius = {
  control: 14,
  card: 18,
  sheet: 26,
  well: 12,
  pill: 999,
} as const;

export const Space = {
  screenX: 20,
  gutter: 12,
  row: 14,
  section: 28,
} as const;

/**
 * Elevation is deliberately almost absent.
 *
 * Structure is carried by hairlines and by the paper/raised step, because a
 * shadow-led interface reads as decorative and this one has to read as
 * instrumentation. `lift` exists for the two things that genuinely float over
 * content: the tab dock and the trigger.
 */
export const Elevation = {
  lift: Platform.select({
    ios: {
      shadowColor: '#12100D',
      shadowOpacity: 0.1,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 6 },
    default: {},
  }),
  liftSm: Platform.select({
    ios: {
      shadowColor: '#12100D',
      shadowOpacity: 0.07,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
    },
    android: { elevation: 2 },
    default: {},
  }),
} as const;

export const Fonts = {
  display: 'BricolageGrotesque_800ExtraBold',
  displaySemi: 'BricolageGrotesque_600SemiBold',
  body: 'InstrumentSans_400Regular',
  bodyMedium: 'InstrumentSans_500Medium',
  bodySemi: 'InstrumentSans_600SemiBold',
  mono: 'SpaceMono_400Regular',
} as const;

/**
 * The uppercase micro-label the machine reports in: device names, tool ids,
 * signal strength, diagnostics. Mono because most of what it carries is
 * identifiers and numbers, and those should not reflow as they change.
 */
export const monoLabel = {
  fontFamily: Fonts.mono,
  fontSize: 9.5,
  letterSpacing: 1.3,
  textTransform: 'uppercase' as const,
};

export const Type = {
  /** The one big word on the Talk screen: "Listening", "Thinking". */
  state: { fontFamily: Fonts.display, fontSize: 34, letterSpacing: -1.4 },
  screenTitle: { fontFamily: Fonts.display, fontSize: 27, letterSpacing: -1.1 },
  cardTitle: { fontFamily: Fonts.displaySemi, fontSize: 15.5, letterSpacing: -0.2 },
  body: { fontFamily: Fonts.body, fontSize: 14.5, lineHeight: 21 },
  bodySm: { fontFamily: Fonts.body, fontSize: 12.5, lineHeight: 18 },
  /** What Grove last said, shown large enough to read across a room. */
  caption: { fontFamily: Fonts.body, fontSize: 16, lineHeight: 24 },
} as const;
