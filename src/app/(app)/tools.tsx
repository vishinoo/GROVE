/**
 * Tools.
 *
 * Noctus's catalogue, seen as a set of things Grove can reach for. Ordered by
 * usefulness rather than alphabetically — ready first, then blocked, then the
 * rest — because the two questions this screen answers are "what can Grove
 * actually do right now" and "why can't it do the other thing".
 *
 * A blocked tool names its missing integration and links straight to Connect.
 * That path is the whole reason Connect is a separate tab: a dead end with an
 * explanation is still a dead end unless the fix is one tap away.
 */

import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/icon';
import { Card, Dot, Empty, Mono, Notice, Screen, Section } from '@/components/ui';
import { Radius, Type } from '@/constants/theme';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { readable } from '@/lib/persona';
import { byCategory, type Tool } from '@/lib/tools';

export default function Tools() {
  const palette = usePalette();
  const { tools, loadingTools, reloadTools, notice, dismissNotice } = useSession();

  const ready = tools.filter((t) => t.state === 'ready').length;
  const groups = byCategory(tools);

  return (
    <Screen
      title="Tools"
      subtitle={
        tools.length === 0
          ? undefined
          : `${ready} of ${tools.length} ready to use. Grove picks one when it fits what you asked.`
      }
      action={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh tools"
          onPress={() => void reloadTools()}
          style={({ pressed }) => ({ padding: 6, opacity: pressed ? 0.5 : 1 })}
        >
          {loadingTools ? (
            <ActivityIndicator size="small" color={palette.muted} />
          ) : (
            <Icon name="refresh" size={19} color={palette.inkSoft} />
          )}
        </Pressable>
      }
    >
      {notice ? <Notice text={notice} onDismiss={dismissNotice} /> : null}

      {tools.length === 0 && !loadingTools ? (
        <Empty text="Nothing in the catalogue yet. Pull refresh, or check that Noctus is reachable in Settings." />
      ) : null}

      {groups.map((group) => (
        <Section key={group.category} label={group.category}>
          {group.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </Section>
      ))}
    </Screen>
  );
}

function ToolRow({ tool }: { tool: Tool }) {
  const palette = usePalette();
  const router = useRouter();
  const { addTool, removeTool } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (tool.instanceId) await removeTool(tool);
      else await addTool(tool);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That didn’t work.');
    } finally {
      setBusy(false);
    }
  }, [tool, addTool, removeTool]);

  const tone = tool.state === 'ready' ? 'live' : tool.state === 'blocked' ? 'alert' : 'off';

  return (
    <Card style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ paddingTop: 5 }}>
          <Dot tone={tone} />
        </View>

        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[Type.cardTitle, { color: palette.ink }]}>{tool.name}</Text>
          <Text style={[Type.bodySm, { color: palette.muted }]} numberOfLines={3}>
            {tool.what}
          </Text>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={tool.instanceId ? `Remove ${tool.name}` : `Add ${tool.name}`}
          disabled={busy}
          onPress={toggle}
          style={({ pressed }) => ({
            width: 36,
            height: 36,
            borderRadius: Radius.well,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: tool.instanceId ? 'transparent' : palette.mark,
            borderWidth: 1,
            borderColor: tool.instanceId ? palette.line : palette.mark,
            opacity: busy ? 0.4 : pressed ? 0.7 : 1,
          })}
        >
          {busy ? (
            <ActivityIndicator size="small" color={palette.muted} />
          ) : (
            <Icon
              name={tool.instanceId ? 'minus' : 'plus'}
              size={17}
              color={tool.instanceId ? palette.inkSoft : palette.paper}
            />
          )}
        </Pressable>
      </View>

      {tool.state === 'blocked' && tool.missing.length > 0 ? (
        <Pressable
          onPress={() => router.navigate('/connections')}
          accessibilityRole="button"
          accessibilityLabel={`Connect ${readable(tool.missing)}`}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginTop: 11,
            paddingTop: 11,
            borderTopWidth: 1,
            borderTopColor: palette.line,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={[Type.bodySm, { color: palette.alert, flex: 1 }]}>
            Needs {readable(tool.missing)} connected.
          </Text>
          <Mono color={palette.alert}>Connect</Mono>
          <Icon name="chevron" size={13} color={palette.alert} />
        </Pressable>
      ) : null}

      {error ? (
        <Text style={[Type.bodySm, { color: palette.alert, marginTop: 9 }]}>{error}</Text>
      ) : null}
    </Card>
  );
}
