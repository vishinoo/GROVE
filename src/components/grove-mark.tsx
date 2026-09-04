/**
 * The mark.
 *
 * A redraw of grove_logo.png as vector, so it stays sharp at every size, takes
 * a colour instead of shipping two files, and can be inverted for dark mode
 * without a second asset. The proportions are lifted from the original's
 * 500×500 grid: a heavy geometric `g` whose descender closes into a rounded
 * bar, with the flag at the top right that stops it reading as a lowercase o.
 *
 * `boxed` draws it on its own paper square — the app icon, the splash and the
 * sign-in screen. Bare, it sits inline in a header.
 */

import Svg, { G, Path, Rect } from 'react-native-svg';

import { Colors } from '@/constants/theme';

type Props = {
  size?: number;
  /** The mark's own colour. Defaults to the logo's black. */
  color?: string;
  /** Draws the paper square behind it, as the logo file does. */
  boxed?: boolean;
  background?: string;
  /** Corner radius when boxed. 0 is the raw logo; the app icon is square. */
  radius?: number;
};

export function GroveMark({
  size = 40,
  color = Colors.light.mark,
  boxed = false,
  background = Colors.light.paper,
  radius = 0,
}: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 500 500">
      {boxed ? (
        <Rect x={0} y={0} width={500} height={500} rx={radius} ry={radius} fill={background} />
      ) : null}

      <G fill={color}>
        {/*
          One path, drawn as the logo is: the bowl and its counter, the throat
          that narrows into the stem, and the closed descender bar with its own
          counter. Even-odd fill is what punches the two counters out rather
          than needing separate shapes stacked over the top.
        */}
        <Path
          fillRule="evenodd"
          d="
            M318 76h68c0 34-19 54-52 62
            22 15 33 34 33 57 0 44-38 71-102 71h-42
            c-13 0-21 5-21 13 0 8 7 12 21 12h74
            c58 0 90 27 90 74 0 51-41 84-108 84H150
            c-40 0-68-25-68-61 0-24 12-43 34-54
            -16-11-24-26-24-44 0-21 12-38 34-48
            -22-14-33-33-33-57 0-49 42-76 119-76 14 0 27 1 39 3
            21-11 34-24 38-40z
            M245 152c-24 0-38 12-38 32 0 21 14 33 38 33 24 0 38-12 38-33 0-20-14-32-38-32z
            M199 338c-16 0-26 8-26 21 0 13 10 21 26 21h78c16 0 26-8 26-21 0-13-10-21-26-21h-78z
          "
        />
      </G>
    </Svg>
  );
}

/**
 * The mark as a status object.
 *
 * Used on the Talk screen, where the same glyph has to carry whether Grove is
 * awake. `dim` is the asleep state — present, legibly not listening.
 */
export function GroveGlyph({
  size = 28,
  dim = false,
  color = Colors.light.mark,
}: {
  size?: number;
  dim?: boolean;
  color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 500 500" opacity={dim ? 0.28 : 1}>
      <Path
        fill={color}
        fillRule="evenodd"
        d="
          M318 76h68c0 34-19 54-52 62
          22 15 33 34 33 57 0 44-38 71-102 71h-42
          c-13 0-21 5-21 13 0 8 7 12 21 12h74
          c58 0 90 27 90 74 0 51-41 84-108 84H150
          c-40 0-68-25-68-61 0-24 12-43 34-54
          -16-11-24-26-24-44 0-21 12-38 34-48
          -22-14-33-33-33-57 0-49 42-76 119-76 14 0 27 1 39 3
          21-11 34-24 38-40z
          M245 152c-24 0-38 12-38 32 0 21 14 33 38 33 24 0 38-12 38-33 0-20-14-32-38-32z
          M199 338c-16 0-26 8-26 21 0 13 10 21 26 21h78c16 0 26-8 26-21 0-13-10-21-26-21h-78z
        "
      />
    </Svg>
  );
}
