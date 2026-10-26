import AsyncStorage from '@react-native-async-storage/async-storage';
import { Redirect, Tabs } from 'expo-router';
import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Field, useField } from '@/components/field';
import { Icon, type IconName } from '@/components/icon';
import { useAgent } from '@/context/agent';
import { rememberIntro } from '@/lib/consolidate';
import { takeIntro } from '@/lib/firstRun';
import { Elevation, Fonts, Radius } from '@/constants/theme';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';

/** The travelling marker behind the current tab. */
const BUBBLE = 38;

/**
 * Labels until each tab has been opened once.
 *
 * Icons alone are right for someone who knows them and a guess for someone
 * who does not, and the middle one in particular is a picture of a graph that
 * could mean anything. So the words stay until every tab has been visited,
 * and then go — the bar earns its quiet by having explained itself first.
 */
const LEARNED_KEY = 'grove.dock.visited';
const LABELLED = { width: 64, height: 46 };

/**
 * Three, not four.
 *
 * Connections was a place you went once, when something stopped working, and
 * then never again — a permanent quarter of the bar for a screen nobody
 * opens twice. It lives inside Settings now, next to the self-check, which is
 * the other thing you only open when something is wrong.
 *
 * The middle one is labelled Memory, not Sparks. Sparks was what the screen
 * used to hold; what it holds now is the map of what Grove did, what is still
 * open and what it knows about you, and a name has to say where it goes.
 */
const TABS: { name: string; label: string; icon: IconName }[] = [
  { name: 'index', label: 'Talk', icon: 'talk' },
  { name: 'sparks', label: 'Memory', icon: 'map' },
  { name: 'settings', label: 'Settings', icon: 'settings' },
];

export default function AppLayout() {
  const { status } = useSession();
  // Signing out goes back through the intro, which ends on the login screen.
  if (status === 'signed-out') return <Redirect href="/onboarding" />;
  return <OnTheField />;
}

/**
 * One field behind all three tabs.
 *
 * Drawn here, once, rather than by each screen, so switching tabs never
 * restarts the water or moves it: Memory and Settings fade their glass in
 * over exactly the colour you were just looking at on Talk. The screens are
 * transparent for the same reason.
 */
function OnTheField() {
  const { state, persona, level } = useAgent();
  const { uid } = useSession();
  const { width, height } = useWindowDimensions();
  const field = useField(state, persona, level);

  // What someone wrote in the intro before there was an account to keep it in.
  useEffect(() => {
    if (!uid || uid === 'anon') return;
    const intro = takeIntro();
    if (intro) void rememberIntro(uid, intro).catch(() => undefined);
  }, [uid]);

  return (
    <View style={{ flex: 1, backgroundColor: '#0B0C12' }}>
      <StatusBar style="light" />
      <View style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="none">
        <Field uniforms={field.uniforms} palette={field.palette} width={width} fullHeight={height} />
      </View>
      <Tabs
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: 'transparent' } }}
        tabBar={(props) => <Dock {...props} />}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="sparks" />
        <Tabs.Screen name="settings" />
      </Tabs>
    </View>
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
 * Three tabs, and the current one marked by a bubble that travels to whatever
 * you tap next. Labelled until each has been opened once (see LEARNED_KEY),
 * then icons alone: after that the words are the wordiest thing on every
 * screen, naming glyphs you already know. The bubble is
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
  // Null until read, so a returning user never sees the labels flash in.
  const [visited, setVisited] = useState<string[] | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(LEARNED_KEY)
      .then((raw) => setVisited(raw ? (JSON.parse(raw) as string[]) : []))
      .catch(() => setVisited([]));
  }, []);

  const here = TABS[state.index]?.name;
  useEffect(() => {
    if (!visited || !here || visited.includes(here)) return;
    const next = [...visited, here];
    setVisited(next);
    AsyncStorage.setItem(LEARNED_KEY, JSON.stringify(next)).catch(() => {});
  }, [here, visited]);

  const labelled = visited !== null && TABS.some((tab) => !visited.includes(tab.name));
  const marker = labelled ? LABELLED : { width: BUBBLE, height: BUBBLE };

  const slot = width / TABS.length;
  const bubble = useSharedValue(0);

  // Driven from the navigator's own index, so the bubble follows a swipe or a
  // deep link as readily as a tap.
  useEffect(() => {
    if (!slot) return;
    bubble.value = withTiming(state.index * slot + slot / 2 - marker.width / 2, {
      duration: 420,
      easing: Easing.out(Easing.cubic),
    });
  }, [state.index, slot, bubble, marker.width]);

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
          height: labelled ? 60 : 56,
          flexDirection: 'row',
          alignItems: 'center',
          borderRadius: Radius.pill,
          backgroundColor: palette.glass,
          borderWidth: 1,
          borderColor: palette.glassLine,
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
              width: marker.width,
              height: marker.height,
              borderRadius: marker.height / 2,
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
            <Icon name={tab.icon} size={labelled ? 19 : 21} color={focused ? palette.ink : palette.muted} />
            {labelled ? (
              <Text
                style={{
                  fontFamily: Fonts.bodyMedium,
                  fontSize: 10.5,
                  marginTop: 3,
                  color: focused ? palette.ink : palette.muted,
                }}
              >
                {tab.label}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
