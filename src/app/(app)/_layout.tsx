import { Redirect, Tabs } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { Elevation, Fonts, Radius } from '@/constants/theme';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';

const TABS: { name: string; label: string; icon: IconName }[] = [
  { name: 'index', label: 'Talk', icon: 'talk' },
  { name: 'tools', label: 'Tools', icon: 'tools' },
  { name: 'connections', label: 'Connect', icon: 'plug' },
  { name: 'settings', label: 'Settings', icon: 'settings' },
];

export default function AppLayout() {
  const { status } = useSession();
  if (status === 'signed-out') return <Redirect href="/login" />;

  return (
    <Tabs screenOptions={{ headerShown: false }} tabBar={(props) => <Dock {...props} />}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="tools" />
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

/** A floating card rather than a rail — it sits over content, not under it. */
function Dock({ state, navigation }: DockProps) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        {
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: Math.max(insets.bottom, 12),
          flexDirection: 'row',
          paddingVertical: 9,
          paddingHorizontal: 4,
          borderRadius: Radius.sheet,
          backgroundColor: palette.raised,
          borderWidth: 1,
          borderColor: palette.line,
        },
        Elevation.lift,
      ]}
    >
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
            style={{ flex: 1, alignItems: 'center', gap: 5, paddingVertical: 2 }}
          >
            <Icon name={tab.icon} size={19} color={focused ? palette.ink : palette.muted} />
            <Text
              style={{
                fontFamily: focused ? Fonts.bodySemi : Fonts.bodyMedium,
                fontSize: 10,
                color: focused ? palette.ink : palette.muted,
              }}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
