/**
 * The icon set: 24×24, hairline strokes, one colour.
 *
 * Drawn to sit beside Bricolage rather than the old set's rounder shapes —
 * flatter caps, squarer joins, less bounce. Two of these are hardware and are
 * drawn as the objects themselves (a frame, a band) rather than as generic
 * Bluetooth marks, because "are my glasses on" is the question the Talk screen
 * exists to answer at a glance.
 */

import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type IconName =
  | 'talk'
  | 'tools'
  | 'plug'
  | 'settings'
  | 'glasses'
  | 'ring'
  | 'check'
  | 'plus'
  | 'minus'
  | 'chevron'
  | 'back'
  | 'down'
  | 'alert'
  | 'trash'
  | 'person'
  | 'refresh'
  | 'send'
  | 'keyboard'
  | 'stop'
  | 'noctus';

const STROKE: Partial<Record<IconName, { d: string; w?: number }>> = {
  // A waveform, not a microphone: Grove is the thing talking as much as
  // listening, and a mic glyph reads as "you are being recorded".
  talk: { d: 'M3 10.5v3M7.5 6v12M12 3v18M16.5 7.5v9M21 10.5v3', w: 2 },
  tools: { d: 'M14.5 3.5l6 6-3 3-6-6 3-3zM10 9l5 5-7.5 7.5-5-5L10 9z', w: 1.8 },
  plug: { d: 'M9 3v6M15 3v6M6 9h12v3a6 6 0 0 1-12 0V9zM12 18v3', w: 1.8 },
  settings: { d: 'M4 7h16M4 12h16M4 17h16M9 4.5v5M16 9.5v5M7 14.5v5', w: 1.8 },
  check: { d: 'M4 12.5l5.5 5.5L20 6.5', w: 2.2 },
  plus: { d: 'M12 5v14M5 12h14', w: 2.2 },
  minus: { d: 'M5 12h14', w: 2.2 },
  chevron: { d: 'M9 5l7 7-7 7', w: 2.1 },
  back: { d: 'M15 5l-7 7 7 7', w: 2.1 },
  down: { d: 'M5 9l7 7 7-7', w: 2.1 },
  alert: { d: 'M12 4v9M12 17.5v.5', w: 2.2 },
  trash: { d: 'M4 6h16M9 6V3.5h6V6M6 6l1 15h10l1-15M10 10.5v6M14 10.5v6', w: 1.7 },
  refresh: { d: 'M20 6v5h-5M4 18v-5h5M19 11a7 7 0 0 0-12.5-3M5 13a7 7 0 0 0 12.5 3', w: 1.9 },
  send: { d: 'M12 20V5M6 11l6-6 6 6', w: 2.2 },
  keyboard: {
    d: 'M3 7h18v10H3V7zM7 11h.01M11 11h.01M15 11h.01M8 14.5h8',
    w: 1.8,
  },
  stop: { d: 'M7.5 7.5h9v9h-9z', w: 2 },
};

/** Noctus's own mark, traced from its logo. Filled, not stroked. */
const NOCTUS_STAR =
  'M50.5 0.0 L50.5 65.0 L79.8 75.1 L38.3 73.1 L13.5 100.0 L25.6 69.2 L0.0 52.3 L35.5 59.6 L38.6 59.6 L50.5 0.0 Z';

export function Icon({
  name,
  size = 20,
  color,
}: {
  name: IconName;
  size?: number;
  color: string;
}) {
  if (name === 'noctus') {
    return (
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Path d={NOCTUS_STAR} fill={color} />
      </Svg>
    );
  }

  // Two lenses and a bridge — the object, so the row reads as hardware.
  if (name === 'glasses') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Circle cx="6" cy="13" r="3.6" stroke={color} strokeWidth={1.7} fill="none" />
        <Circle cx="18" cy="13" r="3.6" stroke={color} strokeWidth={1.7} fill="none" />
        <Path
          d="M9.6 13c.8-1 1.6-1.5 2.4-1.5s1.6.5 2.4 1.5M2.4 13c0-3 .8-5 2.4-6M21.6 13c0-3-.8-5-2.4-6"
          stroke={color}
          strokeWidth={1.7}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    );
  }

  // A band seen at an angle, with the button on its face.
  if (name === 'ring') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Circle cx="12" cy="13.5" r="6.5" stroke={color} strokeWidth={1.7} fill="none" />
        <Circle cx="12" cy="13.5" r="3" stroke={color} strokeWidth={1.7} fill="none" />
        <Rect
          x="9.5"
          y="3"
          width="5"
          height="3.4"
          rx="1.2"
          stroke={color}
          strokeWidth={1.7}
          fill="none"
        />
      </Svg>
    );
  }

  if (name === 'person') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Circle cx="12" cy="8" r="3.6" stroke={color} strokeWidth={1.8} fill="none" />
        <Path
          d="M4.5 20a7.5 7.5 0 0 1 15 0"
          stroke={color}
          strokeWidth={1.8}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    );
  }

  const spec = STROKE[name];
  if (!spec) return null;

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {/* The exclamation's dot, which a single stroke path can't express. */}
      {name === 'alert' ? <Circle cx="12" cy="18" r="1.15" fill={color} /> : null}
      <Path
        d={spec.d}
        stroke={color}
        strokeWidth={spec.w ?? 1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}
