/**
 * Logs.
 *
 * What you asked, what Grove said, and which connection each one went
 * through. It used to be a page under the Talk screen, then a sheet over it;
 * both put a record you read once a week on the screen you use every few
 * minutes. It lives behind Settings now, next to the other things you only
 * open when you want to check something worked.
 */

import { router } from 'expo-router';
import { Pressable, Text } from 'react-native';

import { Icon } from '@/components/icon';
import { LogRow } from '@/components/log-row';
import { Screen } from '@/components/ui';
import { Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { usePalette } from '@/hooks/use-palette';
import { LIMIT } from '@/lib/transcript';

export default function Logs() {
  const palette = usePalette();
  const { activity } = useAgent();

  return (
    <Screen
      title="Logs"
      subtitle={`The last ${LIMIT} things you asked, and what each one used.`}
      action={
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
        >
          <Icon name="back" size={20} color={palette.ink} />
        </Pressable>
      }
    >
      {activity.length === 0 ? (
        <Text style={[Type.body, { color: palette.muted }]}>
          Nothing yet. Each thing you ask Grove shows up here, with the connection it used.
        </Text>
      ) : (
        activity.map((entry) => <LogRow key={entry.id} entry={entry} />)
      )}
    </Screen>
  );
}
