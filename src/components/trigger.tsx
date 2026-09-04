/**
 * The button.
 *
 * There is one control in Grove and this is it. Everything the app can be told
 * to do goes through a press — on the ring, or here when the phone is in your
 * hand — so this has to report the machine's real state clearly enough to read
 * at arm's length, and it has to be honest when the ring can't reach it.
 *
 * The animation is driven by actual microphone level while listening rather
 * than by a loop. That distinction matters more than it sounds: a decorative
 * pulse tells you the app thinks it is listening, whereas a ring that moves
 * with your voice tells you sound is genuinely arriving — which is exactly the
 * thing that breaks when a pair of Bluetooth glasses connects for playback but
 * not for capture.
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
} from 'react-native-reanimated';

import { GroveGlyph } from '@/components/grove-mark';
import { Type } from '@/constants/theme';
import type { AgentState } from '@/context/agent';
import { usePalette } from '@/hooks/use-palette';

const SIZE = 188;

/** What the big word under the button says in each state. */
const CAPTION: Record<AgentState, string> = {
  asleep: 'Asleep',
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  working: 'Working',
};

export function Trigger({
  state,
  level,
  armed,
  onPress,
}: {
  state: AgentState;
  /** Microphone level, 0–1. Only meaningful while listening. */
  level: number;
  armed: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();

  /** Follows the voice while listening; breathes otherwise. */
  const halo = useSharedValue(0);
  /** A slow rotation while a tool runs, so "working" isn't mistaken for stuck. */
  const spin = useSharedValue(0);

  useEffect(() => {
    if (state === 'listening') {
      // Driven by level rather than animated: the ring IS the microphone.
      halo.value = withTiming(level, { duration: 90, easing: Easing.out(Easing.quad) });
      return;
    }

    cancelAnimation(halo);

    if (state === 'thinking' || state === 'working' || state === 'speaking') {
      halo.value = withRepeat(
        withSequence(
          withTiming(0.7, { duration: state === 'speaking' ? 380 : 620, easing: Easing.inOut(Easing.quad) }),
          withTiming(0.15, { duration: state === 'speaking' ? 380 : 620, easing: Easing.inOut(Easing.quad) })
        ),
        -1
      );
      return;
    }

    halo.value = withTiming(0, { duration: 320 });
  }, [state, level, halo]);

  useEffect(() => {
    if (state === 'working') {
      spin.value = withRepeat(withTiming(1, { duration: 2600, easing: Easing.linear }), -1);
    } else {
      cancelAnimation(spin);
      spin.value = withTiming(0, { duration: 200 });
    }
  }, [state, spin]);

  const haloStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + halo.value * 0.16 }],
    opacity: 0.1 + halo.value * 0.5,
  }));

  const arcStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value * 360}deg` }],
    opacity: spin.value > 0 ? 1 : 0,
  }));

  const asleep = state === 'asleep';
  const listening = state === 'listening';
  const accent = listening ? palette.signal : palette.mark;

  return (
    <View style={{ alignItems: 'center', gap: 18 }}>
      <View style={{ width: SIZE, height: SIZE, alignItems: 'center', justifyContent: 'center' }}>
        {/* The halo: the only thing on screen that moves with your voice. */}
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              width: SIZE,
              height: SIZE,
              borderRadius: SIZE / 2,
              backgroundColor: accent,
            },
            haloStyle,
          ]}
        />

        {/* An open arc, spinning, only while a tool is actually running. */}
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: 'absolute',
              width: SIZE - 14,
              height: SIZE - 14,
              borderRadius: (SIZE - 14) / 2,
              borderWidth: 2,
              borderColor: 'transparent',
              borderTopColor: palette.mark,
              borderRightColor: palette.mark,
            },
            arcStyle,
          ]}
        />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            listening ? 'Stop listening' : state === 'speaking' ? 'Interrupt Grove' : 'Talk to Grove'
          }
          accessibilityHint={
            armed ? undefined : 'The ring can’t reach Grove in this build. Press here instead.'
          }
          accessibilityState={{ busy: state === 'thinking' || state === 'working' }}
          onPress={onPress}
          style={({ pressed }) => ({
            width: SIZE - 42,
            height: SIZE - 42,
            borderRadius: (SIZE - 42) / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: asleep ? palette.raised : palette.mark,
            borderWidth: asleep ? 1 : 0,
            borderColor: palette.lineStrong,
            transform: [{ scale: pressed ? 0.96 : 1 }],
          })}
        >
          <GroveGlyph size={62} dim={asleep} color={asleep ? palette.muted : palette.paper} />
        </Pressable>
      </View>

      <Text style={[Type.state, { color: asleep ? palette.muted : palette.ink }]}>
        {CAPTION[state]}
      </Text>
    </View>
  );
}
