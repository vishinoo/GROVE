/**
 * A screen of glass over the field.
 *
 * The tab layout draws one field behind all three tabs, so going from Talk to
 * Memory does not change the water — same colours, same place, still moving.
 * What changes is that the field dims and the panes of this screen fade in
 * over it, as if they had been there all along and the light came up.
 *
 * Everything inside asks `usePalette()` as usual and is handed the glass
 * palette (see OnField), so a card here is frosted white on colour without
 * any card knowing it is on the field.
 */

import { useFocusEffect } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { OnField } from '@/hooks/use-palette';

export function Glass({
  children,
  plain = false,
}: {
  children: ReactNode;
  /**
   * Talk: the field itself, undimmed, in the ordinary palette. It still
   * fades in and out with focus like the others.
   */
  plain?: boolean;
}) {
  const shown = useSharedValue(0);
  const [here, setHere] = useState(false);

  // Every arrival, not just the first: the fade is how you can tell you have
  // moved, since the field behind does not. And out again on leaving — the
  // screens are transparent so the field shows through them, which means a
  // tab you have left would otherwise still be drawn under the one you are on.
  useFocusEffect(
    useCallback(() => {
      setHere(true);
      shown.value = 0;
      shown.value = withTiming(1, { duration: 360, easing: Easing.out(Easing.cubic) });
      return () => {
        setHere(false);
        shown.value = withTiming(0, { duration: 160 });
      };
    }, [shown])
  );

  const fade = useAnimatedStyle(() => ({ opacity: shown.value }));

  if (plain) {
    return (
      <Animated.View style={[{ flex: 1 }, fade]} pointerEvents={here ? 'auto' : 'none'}>
        {children}
      </Animated.View>
    );
  }

  return (
    <OnField.Provider value>
      <View style={{ flex: 1 }} pointerEvents={here ? 'auto' : 'none'}>
        {/* Light at the top, where the field still shows as a sky, and dim
            enough lower down for a page of white text to read. */}
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, fade]}>
          <Svg width="100%" height="100%">
            <Defs>
              <LinearGradient id="grove-glass-dim" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#090A0F" stopOpacity={0.18} />
                <Stop offset="0.3" stopColor="#090A0F" stopOpacity={0.62} />
                <Stop offset="0.75" stopColor="#090A0F" stopOpacity={0.8} />
                <Stop offset="1" stopColor="#090A0F" stopOpacity={0.86} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="100%" height="100%" fill="url(#grove-glass-dim)" />
          </Svg>
        </Animated.View>
        <Animated.View style={[{ flex: 1 }, fade]}>{children}</Animated.View>
      </View>
    </OnField.Provider>
  );
}
