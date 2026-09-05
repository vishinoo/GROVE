/**
 * Connections.
 *
 * Six things, each drawn as the app icon you already recognise. This screen
 * exists because the failure it prevents is invisible: an ability that cannot
 * run because the calendar was never granted fails silently in your ear, while
 * you are walking, with no screen being looked at.
 *
 * So every row says what Grove does with it rather than just naming it, and the
 * two rows that can never work say so outright instead of offering a button
 * that leads nowhere.
 */

import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { Card, Mono, Notice, Screen, Section } from '@/components/ui';
import { Radius, Type } from '@/constants/theme';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { abilityById } from '@/lib/abilities';
import { CONNECTIONS, providerFor, type Connection } from '@/lib/connections';

export default function Connections() {
  const palette = usePalette();
  const { connections, connect, disconnect, notice, dismissNotice } = useSession();

  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const live = new Set(connections);
  const connected = CONNECTIONS.filter((c) => live.has(c.key));
  const rest = CONNECTIONS.filter((c) => !live.has(c.key));

  const act = async (item: Connection) => {
    if (item.impossible) return;
    setWorking(item.key);
    setError(null);
    try {
      if (live.has(item.key)) await disconnect(item.key);
      else await connect(providerFor(item));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'That didn’t work.');
    } finally {
      setWorking(null);
    }
  };

  return (
    <Screen title="Connections" subtitle="What Grove may reach on your behalf.">
      {notice ? <Notice text={notice} onDismiss={dismissNotice} /> : null}
      {error ? <Notice text={error} onDismiss={() => setError(null)} /> : null}

      {connected.length > 0 ? (
        <Section label="Connected">
          {connected.map((item) => (
            <Row
              key={item.key}
              item={item}
              connected
              busy={working === item.key}
              onPress={() => void act(item)}
            />
          ))}
        </Section>
      ) : null}

      <Section label={connected.length > 0 ? 'Available' : undefined}>
        {rest.map((item) => (
          <Row
            key={item.key}
            item={item}
            connected={false}
            busy={working === item.key}
            onPress={() => void act(item)}
          />
        ))}
      </Section>

      <Text
        style={[
          Type.bodySm,
          { color: palette.muted, paddingHorizontal: 2, marginTop: 4 },
        ]}
      >
        Calendar, Reminders, Music and Maps are permissions on this phone. Mail
        is an account, so it opens a browser.
      </Text>
    </Screen>
  );
}

function Row({
  item,
  connected,
  busy,
  onPress,
}: {
  item: Connection;
  connected: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const palette = usePalette();

  // An ability that exists but has no code behind it yet is a different thing
  // from a platform that will never allow it, and the row says which.
  const built = item.unlocks.some((id) => abilityById(id)?.wired);
  const disabled = Boolean(item.impossible);

  const note = item.impossible
    ? item.impossible
    : connected
      ? item.note ?? item.what
      : built
        ? item.what
        : 'Not built yet';

  return (
    <Card style={{ marginBottom: 8, opacity: disabled ? 0.55 : 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
        <AppIcon name={item.icon} size={32} />

        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[Type.cardTitle, { color: palette.ink }]}>{item.label}</Text>
          <Text style={[Type.bodySm, { color: palette.muted }]} numberOfLines={2}>
            {note}
          </Text>
        </View>

        {disabled ? (
          <Mono color={palette.muted}>Can’t</Mono>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${connected ? 'Disconnect' : 'Connect'} ${item.label}`}
            disabled={busy}
            onPress={onPress}
            style={({ pressed }) => ({
              height: 34,
              minWidth: 76,
              paddingHorizontal: 13,
              borderRadius: Radius.well,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: connected ? 'transparent' : palette.mark,
              borderWidth: 1,
              borderColor: connected ? palette.line : palette.mark,
              opacity: busy ? 0.4 : pressed ? 0.75 : 1,
            })}
          >
            {busy ? (
              <ActivityIndicator size="small" color={palette.muted} />
            ) : (
              <Text
                style={{
                  fontFamily: Type.cardTitle.fontFamily,
                  fontSize: 13,
                  color: connected ? palette.inkSoft : palette.raised,
                }}
              >
                {connected ? 'Disconnect' : 'Connect'}
              </Text>
            )}
          </Pressable>
        )}
      </View>
    </Card>
  );
}
