import { Redirect, Tabs } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { Elevation, Radius } from '@/constants/theme';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';

/** The travelling marker behind the current tab. */
const BUBBLE = 38;

const TABS: { name: string; label: string; icon: IconName }[] = [
  { name: 'index', label: 'Talk', icon: 'talk' },
  { name: 'sparks', label: 'Sparks', icon: 'map' },
  { name: 'connections', label: 'Connect', icon: 'plug' },
  { name: 'settings', label: 'Settings', icon: 'settings' },
];

export default function AppLayout() {
  const { status } = useSession();
  if (status === 'signed-out') return <Redirect href="/login" />;

  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <Dock {...props} />}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="sparks" />
      <Tabs.Screen name="connections" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}

/**
 * Only the slice of the tab-bar props this dock actually uses. Typed
 * structurally so the app doesn't take a dependency on the navigator package
 * for one type import.
 */
type DockProps = {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    emit: (event: {
      type: 'tabPress';
      target: string;
      canPreventDefault: true;
    }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
};

/**
 * The dock.
 *
 * Four tabs, no labels, and the current one marked by a bubble that travels
 * to whatever you tap next.
 *
 * The labels went because they were the wordiest thing on every screen and
 * named four glyphs that the rest of the phone already taught. The bubble is
 * not decoration either: a tab bar where only the icon colour changes reads
 * as four buttons, and one where a single object slides between them reads as
 * one control with a position.
 *
 * There is no real blur here. `expo-blur` is a native module, and adding one
 * would turn every future design change into a new device build instead of an
 * over-the-air update — which is a bad trade for a background.
 */
function Dock({ state, navigation }: DockProps) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [width, setWidth] = useState(0);

  const slot = width / TABS.length;
  const bubble = useSharedValue(0);

  // Driven from the navigator's own index, so the bubble follows a swipe or a
  // deep link as readily as a tap.
  useEffect(() => {
    if (!slot) return;
    bubble.value = withTiming(state.index * slot + slot / 2 - BUBBLE / 2, {
      duration: 420,
      easing: Easing.out(Easing.cubic),
    });
  }, [state.index, slot, bubble]);

  const riding = useAnimatedStyle(() => ({ transform: [{ translateX: bubble.value }] }));

  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[
        {
          position: 'absolute',
          left: 18,
          right: 18,
          bottom: Math.max(insets.bottom, 13),
          height: 56,
          flexDirection: 'row',
          alignItems: 'center',
          borderRadius: Radius.pill,
          backgroundColor: palette.raised,
          borderWidth: 1,
          borderColor: palette.line,
        },
        Elevation.lift,
      ]}
    >
      {width > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            riding,
            {
              position: 'absolute',
              left: 0,
              width: BUBBLE,
              height: BUBBLE,
              borderRadius: BUBBLE / 2,
              backgroundColor: palette.sunken,
            },
          ]}
        />
      ) : null}

      {TABS.map((tab, index) => {
        const focused = state.index === index;
        const route = state.routes[index];

        return (
          <Pressable
            key={tab.name}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={tab.label}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
            }}
            style={{ flex: 1, alignItems: 'center', justifyContent: 'center', height: '100%' }}
          >
            <Icon name={tab.icon} size={21} color={focused ? palette.ink : palette.muted} />
          </Pressable>
        );
      })}
    </View>
  );
}
