/**
 * Connections.
 *
 * The integrations Grove's tools depend on. This screen exists because the
 * failure it prevents is invisible: a tool that can't run because Gmail was
 * never connected fails silently in your ear, while you are walking, with no
 * screen being looked at.
 *
 * So each row carries the one fact that makes it worth acting on — how many
 * tools it would unblock. "Calendar — unblocks 3 tools" is a reason to connect
 * something; a bare list of logos is not.
 */

import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { Icon } from '@/components/icon';
import { Card, Dot, Empty, Mono, Notice, Screen, Section } from '@/components/ui';
import { Radius, Type } from '@/constants/theme';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { fetchOAuthProviders } from '@/lib/noctusApi';

type Integration = {
  key: string;
  label: string;
  connected: boolean;
  /** Tools that are installed and waiting on exactly this. */
  unblocks: number;
  /** Tools in the catalogue that would need it. */
  wantedBy: number;
};

export default function Connections() {
  const palette = usePalette();
  const { tools, connections, connect, disconnect, notice, dismissNotice } = useSession();

  const [providers, setProviders] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const available = await fetchOAuthProviders(controller.signal);
        // Noctus reports a map of provider → enabled; only the enabled ones
        // can actually complete a consent flow, so the rest are not offered.
        setProviders(Object.entries(available).filter(([, on]) => on).map(([key]) => key));
      } catch {
        // Falling back to what the tools themselves ask for still produces a
        // usable screen — it just can't list providers nothing needs yet.
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  /**
   * The union of what Noctus offers and what the installed tools ask for.
   *
   * Neither source alone is right: providers alone lists things no tool needs,
   * and tool bindings alone hides an integration until something that wants it
   * has already been added.
   */
  const integrations = useMemo<Integration[]>(() => {
    const keys = new Set<string>(providers);
    for (const tool of tools) for (const need of tool.needs) keys.add(need);

    const live = new Set(connections);

    return [...keys]
      .map((key) => ({
        key,
        label: prettify(key),
        connected: live.has(key),
        unblocks: tools.filter(
          (t) => t.state === 'blocked' && t.missing.includes(key) && t.missing.length === 1
        ).length,
        wantedBy: tools.filter((t) => t.needs.includes(key)).length,
      }))
      .sort(
        (a, b) =>
          Number(b.connected) - Number(a.connected) ||
          b.unblocks - a.unblocks ||
          b.wantedBy - a.wantedBy ||
          a.label.localeCompare(b.label)
      );
  }, [providers, tools, connections]);

  const act = async (integration: Integration) => {
    setWorking(integration.key);
    setError(null);
    try {
      if (integration.connected) await disconnect(integration.key);
      else await connect(integration.key);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That didn’t work.');
    } finally {
      setWorking(null);
    }
  };

  const connected = integrations.filter((i) => i.connected);
  const rest = integrations.filter((i) => !i.connected);

  return (
    <Screen
      title="Connections"
      subtitle="What Grove is allowed to reach on your behalf. Connecting one here unblocks the tools that need it."
    >
      {notice ? <Notice text={notice} onDismiss={dismissNotice} /> : null}
      {error ? <Notice text={error} onDismiss={() => setError(null)} /> : null}

      {loading && integrations.length === 0 ? (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator color={palette.muted} />
        </View>
      ) : null}

      {connected.length > 0 ? (
        <Section label="Connected">
          {connected.map((integration) => (
            <IntegrationRow
              key={integration.key}
              integration={integration}
              busy={working === integration.key}
              onPress={() => void act(integration)}
            />
          ))}
        </Section>
      ) : null}

      {rest.length > 0 ? (
        <Section label={connected.length > 0 ? 'Available' : undefined}>
          {rest.map((integration) => (
            <IntegrationRow
              key={integration.key}
              integration={integration}
              busy={working === integration.key}
              onPress={() => void act(integration)}
            />
          ))}
        </Section>
      ) : null}

      {!loading && integrations.length === 0 ? (
        <Empty text="Nothing to connect yet. Add a tool first — its integrations will appear here." />
      ) : null}
    </Screen>
  );
}

function IntegrationRow({
  integration,
  busy,
  onPress,
}: {
  integration: Integration;
  busy: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();

  const reason = integration.connected
    ? integration.wantedBy > 0
      ? `Used by ${integration.wantedBy} ${integration.wantedBy === 1 ? 'tool' : 'tools'}`
      : 'Connected'
    : integration.unblocks > 0
      ? `Unblocks ${integration.unblocks} ${integration.unblocks === 1 ? 'tool' : 'tools'}`
      : integration.wantedBy > 0
        ? `Needed by ${integration.wantedBy} ${integration.wantedBy === 1 ? 'tool' : 'tools'}`
        : 'Not needed yet';

  return (
    <Card style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
        <Dot tone={integration.connected ? 'live' : integration.unblocks > 0 ? 'alert' : 'off'} />

        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[Type.cardTitle, { color: palette.ink }]}>{integration.label}</Text>
          <Mono>{reason}</Mono>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${integration.connected ? 'Disconnect' : 'Connect'} ${integration.label}`}
          disabled={busy}
          onPress={onPress}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            height: 34,
            paddingHorizontal: 13,
            borderRadius: Radius.well,
            backgroundColor: integration.connected ? 'transparent' : palette.mark,
            borderWidth: 1,
            borderColor: integration.connected ? palette.line : palette.mark,
            opacity: busy ? 0.4 : pressed ? 0.75 : 1,
          })}
        >
          {busy ? (
            <ActivityIndicator size="small" color={palette.muted} />
          ) : (
            <>
              {integration.connected ? null : (
                <Icon name="plug" size={14} color={palette.paper} />
              )}
              <Text
                style={{
                  fontFamily: Type.cardTitle.fontFamily,
                  fontSize: 13,
                  color: integration.connected ? palette.inkSoft : palette.paper,
                }}
              >
                {integration.connected ? 'Disconnect' : 'Connect'}
              </Text>
            </>
          )}
        </Pressable>
      </View>
    </Card>
  );
}

/** "google_calendar" → "Google calendar". Noctus's keys are snake_case. */
function prettify(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
