/**
 * The horizon.
 *
 * The top of the Talk screen is a field of colour — dusk over water, cool at
 * altitude and burning at the waterline — and under it is a halftone sea: a
 * fixed grid of dots, full at the surface and shrinking to nothing below. The horizon rises
 * when Grove is listening and sinks when it is not. It is the only thing in
 * the app that moves of its own accord.
 *
 * WHY THIS REPLACED THE ORB
 *
 * A sphere is a thing you look AT. This app is worn: you are walking, the
 * phone is in a pocket, and the question is whether it heard you. A horizon
 * answers that from across a room, and it answers it at the top of the screen
 * where your eye already is, rather than asking you to find a small object in
 * the middle of a page.
 *
 * HOW IT IS DRAWN, AND WHY IT IS CHEAP
 *
 * The dots never move. The wave moves through them: a dot is drawn at the
 * size its depth below the surface asks for, which is what makes it read as
 * print rather than as particles.
 *
 * A true halftone sizes every dot every frame — well over a thousand circles.
 * Instead each depth is one `<Pattern>` of dots at one size, filling the region
 * below the surface pushed down by that depth. The layers are painted top to
 * bottom and every tile has a paper-coloured ground, so each deeper layer
 * paints over the bigger dots above it. Exactly two path strings are rebuilt
 * per frame — the sky and the water — and every layer reuses the water.
 *
 * Each layer is pushed down by a whole number of tiles. Anything else slides
 * the grid between layers and the dots stop lining up into rows.
 *
 * Both path strings are built in Reanimated worklets, so the wave runs on the
 * UI thread and a slow turn never stutters it.
 */

import { useMemo } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, G, LinearGradient, Path, Pattern, Rect, Stop } from 'react-native-svg';

import { skyFor } from '@/constants/theme';
import { useIsNight, usePalette } from '@/hooks/use-palette';
import type { AgentState } from '@/context/agent';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * Four components, co-prime-ish in both wavelength and rate, so no two crests
 * line up twice in an afternoon.
 *
 * None of them leads. The first version had one wave the width of the screen
 * at full strength and the rest at half or less, which is a single swell with
 * ripples on it — one crest always towering over the others. These are close
 * enough in strength, and short enough, that three or four crests share the
 * width.
 */
const PARTS = [
  { k: 1.6, w: 0.55, p: 0.0, a: 0.6 },
  { k: 2.7, w: 0.81, p: 1.7, a: 0.55 },
  { k: 4.1, w: 1.19, p: 3.1, a: 0.4 },
  { k: 6.3, w: 1.63, p: 5.2, a: 0.2 },
];
const PARTS_SUM = PARTS.reduce((t, P) => t + P.a, 0);

/**
 * The halftone grid.
 *
 * TILE is the pitch, and the dots sit on its corners and its centre — a
 * diagonal grid, which is how print screens are set and why it does not read
 * as graph paper. DOT is the radius at the surface, just short of the dots
 * touching. Below that, one layer per tile, each a little smaller, then paper.
 */
const TILE = 6;
const DOT = 1.9;
const DEPTHS = 11;

/**
 * How high the crest rises, as a fraction of the band.
 *
 * Not free. The deepest dots sit at mid + AMPLITUDE*amp*1.43 + DEPTHS*TILE,
 * and past the bottom of the band the sea is cut off square. At the worst case
 * here — listening, mid 0.79, talking loudly — that lands within a few points
 * of the edge on a small phone, where the dots are already too small to see.
 */
const AMPLITUDE = 0.05;

/**
 * Samples across the width.
 *
 * Thirty-four is enough to carry the 6.3 harmonic without aliasing and not
 * nearly enough to look curved: at a 390-point width that is eleven pixels a
 * segment, and every crest came to a visible corner. Seventy-six puts a joint
 * every five pixels, which reads as a curve.
 */
const STEPS = 76;

/**
 * Height and agitation per state.
 *
 * Nothing here changes hue. A palette that doubled as the status would stop
 * telling you anything, and the whole point of a horizon is that its position
 * is the message.
 */
const MOOD: Record<AgentState, { amp: number; rate: number; mid: number }> = {
  asleep: { amp: 0.5, rate: 0.16, mid: 0.74 },
  idle: { amp: 0.9, rate: 0.26, mid: 0.78 },
  listening: { amp: 1.3, rate: 0.74, mid: 0.79 },
  thinking: { amp: 0.85, rate: 1.7, mid: 0.785 },
  working: { amp: 1.1, rate: 0.3, mid: 0.785 },
  speaking: { amp: 1.25, rate: 0.98, mid: 0.79 },
  noting: { amp: 1.0, rate: 0.5, mid: 0.785 },
};

/**
 * The word under the horizon.
 *
 * The height of the sky says what is happening without being read; this says
 * it for the times you are actually looking. Both, or neither — a state you
 * can see and cannot name is a mood, not a status.
 */
export const STATE_WORD: Record<AgentState, string> = {
  asleep: 'Asleep',
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  working: 'Working',
  noting: 'Taking notes',
};

export function Horizon({
  state,
  width,
  height = 280,
  onPress,
  sky: chosen,
  level = 0,
}: {
  state: AgentState;
  width: number;
  height?: number;
  onPress?: () => void;
  /** A key from SKIES. Unset follows the light or dark scheme. */
  sky?: string;
  /** Microphone level, 0-1. The sea gets rougher as you talk into it. */
  level?: number;
}) {
  // The app's own choice, not the OS's — the OS is pinned to light until the
  // next build, and the sky has to agree with the rest of the screen.
  const night = useIsNight();
  const palette = usePalette();
  const sky = skyFor(chosen, night);
  const mood = MOOD[state] ?? MOOD.idle;

  /**
   * Its own clock, advanced by the current rate rather than scaled from a
   * global one — changing the rate then speeds the wave up from where it is
   * instead of jumping it to a different part of the cycle.
   */
  const clock = useSharedValue(0);
  const amp = useSharedValue(mood.amp);
  const mid = useSharedValue(mood.mid);
  const rate = useSharedValue(mood.rate);

  amp.value = withTiming(mood.amp, { duration: 700, easing: Easing.out(Easing.cubic) });
  mid.value = withTiming(mood.mid, { duration: 900, easing: Easing.out(Easing.cubic) });
  rate.value = withTiming(mood.rate, { duration: 700 });

  /*
    Both halves of the conversation move the water.

    Listening is the easy one: the microphone level is already measured, so
    the sea gets rougher as you talk into it. Speaking has no level to read —
    the voice is going out, not coming in — so it is a swell of its own, fast
    enough to read as a voice and slow enough not to look like a glitch.

    Without this the horizon only changed when the state did, which made a
    whole conversation look like four still pictures.
  */
  const live = useSharedValue(0);
  const swell = useSharedValue(0);
  live.value = withTiming(Math.max(0, Math.min(1, level)), { duration: 90 });

  const talking = state === 'speaking';
  const hearing = state === 'listening' || state === 'noting';

  useFrameCallback((frame) => {
    'worklet';
    const dt = Math.min(0.05, (frame.timeSincePreviousFrame ?? 16) / 1000);
    clock.value += dt * rate.value;

    const want = talking
      ? 0.3 + 0.26 * Math.sin(clock.value * 7.5)
      : hearing
        ? live.value * 0.85
        : 0;
    swell.value += (want - swell.value) * Math.min(1, dt * 9);
  }, true);

  /**
   * Both path strings, built in one pass.
   *
   * The sky has to walk the surface RIGHT TO LEFT. Reusing the left-to-right
   * line for it — which is what the first version did — makes the outline
   * cross itself between the top corners and the first surface point, and SVG
   * fills that as two triangles meeting in the middle. It renders as a bowtie,
   * which is exactly what shipped.
   *
   * The water runs left to right and drops past the bottom of the band, so a
   * layer pushed down by its depth still reaches the edge.
   */
  const paths = useDerivedValue(() => {
    'worklet';
    const base = height * mid.value;
    // Half the swell it used to get: doubling the height on a loud sentence
    // was the other reason one crest kept towering over the rest.
    const a = height * AMPLITUDE * amp.value * (1 + swell.value * 0.5);

    const at = (i: number) => {
      'worklet';
      const x = i / STEPS;
      let s = 0;
      for (let j = 0; j < 4; j++) {
        const P = PARTS[j];
        s += P.a * Math.sin(x * P.k * 6.283 + clock.value * P.w + P.p);
      }
      // Soft-limited, so the rare moment every component agrees rounds off
      // instead of spiking: the small swells come up, the big ones level out.
      const n = s / PARTS_SUM;
      return { x: x * width, y: base + ((n * 1.8) / (1 + 0.8 * Math.abs(n))) * a };
    };

    let surface = '';
    let back = '';
    for (let i = 0; i <= STEPS; i++) {
      const pt = at(i);
      surface += (i === 0 ? 'M' : 'L') + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1);
      const r = at(STEPS - i);
      back += 'L' + r.x.toFixed(1) + ' ' + r.y.toFixed(1);
    }

    const floor = (height + DEPTHS * TILE).toFixed(1);
    return {
      water: surface + 'L' + width.toFixed(1) + ' ' + floor + 'L0 ' + floor + 'Z',
      sky: 'M0 0L' + width.toFixed(1) + ' 0' + back + 'Z',
    };
  });

  const waterProps = useAnimatedProps(() => ({ d: paths.value.water }));
  const skyProps = useAnimatedProps(() => ({ d: paths.value.sky }));

  /**
   * Built once. These never change, and rebuilding a dozen objects a frame to
   * hand them identical numbers is how a cheap thing becomes expensive.
   *
   * The last depth has no dot: it is the paper the sea fades into.
   */
  const depths = useMemo(
    () =>
      Array.from({ length: DEPTHS + 1 }, (_, j) => ({
        id: `grove-dot-${j}`,
        dy: j * TILE,
        r: j === DEPTHS ? 0 : DOT * Math.pow(1 - j / DEPTHS, 0.85),
      })),
    []
  );

  const half = TILE / 2;
  const band = (
    <Svg width={width} height={height} pointerEvents="none">
      <Defs>
        <LinearGradient id="grove-sky" x1="0" y1="0" x2="0" y2="1">
          {sky.stops.map((colour, i) => (
            <Stop key={colour} offset={i / (sky.stops.length - 1)} stopColor={colour} />
          ))}
        </LinearGradient>
        {depths.map((d) => (
          <Pattern
            key={d.id}
            id={d.id}
            patternUnits="userSpaceOnUse"
            x={0}
            y={0}
            width={TILE}
            height={TILE}
          >
            <Rect width={TILE} height={TILE} fill={palette.paper} />
            {d.r > 0 &&
              [
                [half, half],
                [0, 0],
                [TILE, 0],
                [0, TILE],
                [TILE, TILE],
              ].map(([cx, cy]) => (
                <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={d.r} fill={sky.grain} />
              ))}
          </Pattern>
        ))}
      </Defs>

      {depths.map((d) => (
        <G key={d.id} translateY={d.dy}>
          <AnimatedPath animatedProps={waterProps} fill={`url(#${d.id})`} />
        </G>
      ))}

      <AnimatedPath animatedProps={skyProps} fill="url(#grove-sky)" />
    </Svg>
  );

  if (!onPress) return <View>{band}</View>;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Talk to Grove"
      // The whole sky is the button. On a screen you reach for while walking,
      // a small target in the middle of it would be the wrong one.
      style={{ width, height }}
    >
      {band}
    </Pressable>
  );
}
