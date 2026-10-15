/**
 * The horizon.
 *
 * The top of the Talk screen is a field of colour — dusk over water, cool at
 * altitude and burning at the waterline — and its lower edge is not a line but
 * a band of grains dissolving into the paper underneath. The horizon rises
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
 * Every grain layer is the same curve, translated down. So exactly two path
 * strings are rebuilt per frame — the filled sky and the surface line — and
 * the eighteen layers are that one line re-rendered inside a `<G>` with a
 * static translate, a lower opacity and a different dash offset.
 *
 * The dashes are what make the grain. Varying `strokeDashoffset` per layer is
 * not decoration: identical offsets stack the dots into vertical stripes, and
 * the whole look collapses.
 *
 * Both path strings are built in Reanimated worklets, so the wave runs on the
 * UI thread and a slow turn never stutters it.
 */

import { useMemo } from 'react';
import { Pressable, View, useColorScheme } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, G, LinearGradient, Path, Stop } from 'react-native-svg';

import { Sky } from '@/constants/theme';
import type { AgentState } from '@/context/agent';

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * Four components, co-prime-ish in both wavelength and rate, so no two crests
 * line up twice in an afternoon.
 */
const PARTS = [
  { k: 1.0, w: 0.55, p: 0.0, a: 1.0 },
  { k: 2.3, w: 0.81, p: 1.7, a: 0.46 },
  { k: 3.7, w: 1.19, p: 3.1, a: 0.26 },
  { k: 6.1, w: 1.63, p: 5.2, a: 0.13 },
];

/** Grain layers. Eighteen is dense enough to read as sand rather than ripples. */
const LAYERS = 18;

/** How far the sand falls below the waterline, as a fraction of the band. */
const FALL = 0.22;

/** Samples across the width. Below about thirty the 6.1 harmonic aliases. */
const STEPS = 34;

/**
 * Height and agitation per state.
 *
 * Nothing here changes hue. A palette that doubled as the status would stop
 * telling you anything, and the whole point of a horizon is that its position
 * is the message.
 */
const MOOD: Record<AgentState, { amp: number; rate: number; mid: number }> = {
  asleep: { amp: 0.25, rate: 0.16, mid: 0.4 },
  idle: { amp: 0.55, rate: 0.26, mid: 0.5 },
  listening: { amp: 1.5, rate: 0.74, mid: 0.66 },
  thinking: { amp: 0.6, rate: 1.7, mid: 0.54 },
  working: { amp: 0.95, rate: 0.3, mid: 0.58 },
  speaking: { amp: 1.3, rate: 0.98, mid: 0.62 },
  noting: { amp: 0.8, rate: 0.5, mid: 0.56 },
};

export function Horizon({
  state,
  width,
  height = 250,
  onPress,
}: {
  state: AgentState;
  width: number;
  height?: number;
  onPress?: () => void;
}) {
  const night = useColorScheme() === 'dark';
  const sky = night ? Sky.night : Sky.day;
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

  useFrameCallback((frame) => {
    'worklet';
    const dt = Math.min(0.05, (frame.timeSincePreviousFrame ?? 16) / 1000);
    clock.value += dt * rate.value;
  }, true);

  /**
   * Both path strings, built in one pass.
   *
   * The fill has to walk the surface RIGHT TO LEFT. Reusing the left-to-right
   * line for it — which is what the first version did — makes the outline
   * cross itself between the top corners and the first surface point, and SVG
   * fills that as two triangles meeting in the middle. It renders as a bowtie,
   * which is exactly what shipped.
   */
  const paths = useDerivedValue(() => {
    'worklet';
    const base = height * mid.value;
    const a = height * 0.13 * amp.value;

    const at = (i: number) => {
      'worklet';
      const x = i / STEPS;
      let s = 0;
      for (let j = 0; j < 4; j++) {
        const P = PARTS[j];
        s += P.a * Math.sin(x * P.k * 6.283 + clock.value * P.w + P.p);
      }
      return { x: x * width, y: base + (s / 1.85) * a };
    };

    let line = '';
    for (let i = 0; i <= STEPS; i++) {
      const pt = at(i);
      line += (i === 0 ? 'M' : 'L') + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1);
    }

    let back = '';
    for (let i = STEPS; i >= 0; i--) {
      const pt = at(i);
      back += 'L' + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1);
    }

    return { line, fill: 'M0 0L' + width.toFixed(1) + ' 0' + back + 'Z' };
  });

  const lineProps = useAnimatedProps(() => ({ d: paths.value.line }));
  const skyProps = useAnimatedProps(() => ({ d: paths.value.fill }));

  /**
   * Built once. These never change, and rebuilding eighteen objects a frame
   * to hand them identical numbers is how a cheap thing becomes expensive.
   */
  const layers = useMemo(
    () =>
      Array.from({ length: LAYERS }, (_, j) => ({
        dy: (j / (LAYERS - 1)) * height * FALL,
        opacity: Math.pow(1 - j / LAYERS, 2.6),
        // Offset per layer, or the dots stack into vertical stripes.
        dash: (j * 1.37) % 4.2,
      })),
    [height]
  );

  const band = (
    <Svg width={width} height={height} pointerEvents="none">
      <Defs>
        <LinearGradient id="grove-sky" x1="0" y1="0" x2="0" y2="1">
          {sky.stops.map((colour, i) => (
            <Stop key={colour} offset={i / (sky.stops.length - 1)} stopColor={colour} />
          ))}
        </LinearGradient>
      </Defs>

      <AnimatedPath animatedProps={skyProps} fill="url(#grove-sky)" />

      {layers.map((layer) => (
        <G key={layer.dy} translateY={layer.dy} opacity={layer.opacity}>
          <AnimatedPath
            animatedProps={lineProps}
            stroke={sky.grain}
            strokeWidth={1.6}
            strokeLinecap="round"
            // A dash of almost nothing under a round cap is a dot. A real
            // dash length draws little capsules, which read as stitching.
            strokeDasharray="0.01 2.6"
            strokeDashoffset={layer.dash}
            fill="none"
          />
        </G>
      ))}
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
