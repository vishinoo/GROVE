/**
 * The orb.
 *
 * There is one control in Grove and this is it. Everything the app can be told
 * to do goes through a press — on the ring, or here when the phone is in your
 * hand — so it has to report the machine's real state clearly enough to read at
 * arm's length, and be honest when the ring cannot reach it.
 *
 * HOW IT IS BUILT, AND WHY NOT THE OBVIOUS WAY
 *
 * On the web this is four heavily blurred circles drifting on their own clocks.
 * React Native has no `filter: blur()`, and `expo-blur` is the wrong tool — it
 * blurs what is *behind* a view, not the view itself. react-native-svg does
 * carry `FeGaussianBlur`, but filter support is uneven across platforms and a
 * silently-unfiltered blob would render as four hard discs.
 *
 * So the softness is baked into the paint instead: each lobe is a radial
 * gradient running from full colour at the centre to the same colour at zero
 * opacity at the edge, which is what a blurred circle looks like anyway. No
 * filters, no native module, identical on every platform.
 *
 * The four lobes drift on periods that do not divide evenly — 11, 13, 17 and 15
 * seconds — so the mass never repeats the same arrangement of colour. That is
 * the difference between something that looks alive and something that looks
 * like it is pulsing on a timer.
 *
 * While listening, the whole thing scales with real microphone level rather
 * than on a loop. That distinction matters more than it sounds: a decorative
 * pulse tells you the app thinks it is listening, whereas a mass that moves
 * with your voice tells you sound is genuinely arriving — which is exactly what
 * breaks when Bluetooth glasses connect for playback but not for capture.
 */

import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';

import { Spectrum, Type } from '@/constants/theme';
import type { AgentState } from '@/context/agent';
import { usePalette } from '@/hooks/use-palette';

/** What the word under the orb says in each state. */
const CAPTION: Record<AgentState, string> = {
  asleep: 'Asleep',
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  working: 'Working',
};

type Lobe = {
  colour: string;
  /** Radius as a fraction of the box. */
  r: number;
  /** Drift extent, and how long one full circuit takes. */
  travel: number;
  period: number;
  phase: number;
};

/**
 * Deliberately co-prime-ish periods. Four lobes on 11/13/17/15 seconds take
 * over six hours to return to the same arrangement.
 */
const LOBES: Lobe[] = [
  { colour: Spectrum.mint, r: 0.30, travel: 0.11, period: 11000, phase: 0 },
  { colour: Spectrum.indigo, r: 0.28, travel: 0.10, period: 13000, phase: 0.25 },
  { colour: Spectrum.pink, r: 0.26, travel: 0.12, period: 17000, phase: 0.5 },
  { colour: Spectrum.green, r: 0.29, travel: 0.09, period: 15000, phase: 0.75 },
];

export function Orb({
  state,
  level,
  size = 200,
  onPress,
  showCaption = true,
  tint,
  palette,
}: {
  state: AgentState;
  /** Microphone level, 0–1. Only meaningful while listening. */
  level: number;
  size?: number;
  onPress?: () => void;
  showCaption?: boolean;
  /**
   * The current mode's colour, pulled through one lobe so the orb says which
   * mode you are in without a label. Subtle on purpose: the orb's job is still
   * to report what Grove is doing, and a mode should not repaint it.
   */
  tint?: string;
  /**
   * The mode's whole palette, four colours, replacing the default spectrum.
   * A mode should be visible at a glance rather than as a tinted edge.
   */
  palette?: string[];
}) {
  const theme = usePalette();
  const asleep = state === 'asleep';

  /** Drives every lobe's drift. One clock, four different readings of it. */
  const drift = useSharedValue(0);
  /** Overall breathing: follows the voice while listening, a slow swell otherwise. */
  const swell = useSharedValue(0);

  useEffect(() => {
    drift.value = withRepeat(
      withTiming(1, { duration: 60000, easing: Easing.linear }),
      -1,
      false
    );
    return () => cancelAnimation(drift);
  }, [drift]);

  useEffect(() => {
    if (state === 'listening') {
      // The orb IS the microphone. Driven by level, not animated on a loop.
      swell.value = withTiming(level, { duration: 90, easing: Easing.out(Easing.quad) });
      return;
    }
    cancelAnimation(swell);

    if (state === 'thinking' || state === 'working' || state === 'speaking') {
      const beat = state === 'speaking' ? 420 : 700;
      swell.value = withRepeat(
        withSequence(
          withTiming(0.7, { duration: beat, easing: Easing.inOut(Easing.quad) }),
          withTiming(0.2, { duration: beat, easing: Easing.inOut(Easing.quad) })
        ),
        -1
      );
      return;
    }
    swell.value = withTiming(asleep ? 0 : 0.18, { duration: 400 });
  }, [state, level, swell, asleep]);

  const massStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.9 + swell.value * 0.18 }],
    opacity: asleep ? 0.16 : 0.75 + swell.value * 0.25,
  }));

  const body = (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View style={[{ width: size, height: size, position: 'absolute' }, massStyle]}>
        <OrbPaint size={size} drift={drift} grey={asleep} tint={tint} palette={palette} />
      </Animated.View>
    </View>
  );

  return (
    <View style={{ alignItems: 'center', gap: 14 }}>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            state === 'listening'
              ? 'Stop listening'
              : state === 'speaking'
                ? 'Interrupt Grove'
                : 'Talk to Grove'
          }
          accessibilityState={{ busy: state === 'thinking' || state === 'working' }}
          onPress={onPress}
          // The hit area is the whole orb, which is well past the 44pt minimum.
          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}

      {showCaption ? (
        <Text style={[Type.state, { color: asleep ? theme.muted : theme.ink }]}>
          {CAPTION[state]}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The paint itself.
 *
 * Each lobe gets its own radial gradient with a transparent outer stop, which
 * is what makes the edges soft without a blur filter. They are drawn on one
 * SVG so they overlap and mix rather than stacking as discrete discs.
 */
function OrbPaint({
  size,
  drift,
  grey,
  tint,
  palette,
}: {
  size: number;
  drift: SharedValue<number>;
  grey: boolean;
  tint?: string;
  palette?: string[];
}) {
  const theme = usePalette();

  return (
    <View style={{ width: size, height: size }}>
      {LOBES.map((lobe, i) => (
        <LobeView
          key={i}
          lobe={{
            ...lobe,
            colour: grey
              ? theme.lineStrong
              : (palette?.[i] ?? (i === 1 && tint ? tint : lobe.colour)),
          }}
          size={size}
          drift={drift}
        />
      ))}
    </View>
  );
}

function LobeView({
  lobe,
  size,
  drift,
}: {
  lobe: Lobe;
  size: number;
  drift: SharedValue<number>;
}) {
  const d = size * lobe.travel;

  // The tint changes when the mode does, and snapping between two colours mid
  // drift reads as a glitch rather than a change. Reanimated cannot interpolate
  // a colour on the UI thread here without more machinery than this is worth,
  // so the lobe cross-fades: the new colour comes up over the old one.
  const fade = useSharedValue(1);
  useEffect(() => {
    fade.value = 0;
    fade.value = withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) });
  }, [lobe.colour, fade]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  const style = useAnimatedStyle(() => {
    // Each lobe reads the same clock at its own rate and offset, so they never
    // line up. Two sinusoids at different multiples trace a slow lissajous
    // rather than a circle, which reads as drift rather than orbit.
    const t = (drift.value * 60000) / lobe.period + lobe.phase;
    const a = t * Math.PI * 2;
    return {
      transform: [
        { translateX: Math.cos(a) * d },
        { translateY: Math.sin(a * 1.37) * d },
      ],
    };
  });

  const r = size * lobe.r;
  const id = `lobe-${lobe.colour.replace('#', '')}`;

  return (
    <Animated.View style={[{ position: 'absolute', inset: 0 }, style]} pointerEvents="none">
      <Animated.View style={[{ flex: 1 }, fadeStyle]}>
      <Svg width={size} height={size}>
        <Defs>
          <RadialGradient id={id} cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={lobe.colour} stopOpacity={0.95} />
            <Stop offset="45%" stopColor={lobe.colour} stopOpacity={0.55} />
            <Stop offset="100%" stopColor={lobe.colour} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={r} fill={`url(#${id})`} />
      </Svg>
      </Animated.View>
    </Animated.View>
  );
}
