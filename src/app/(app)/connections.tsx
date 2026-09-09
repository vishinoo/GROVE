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
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { Card, Mono, Notice, Screen, Section } from '@/components/ui';
import { Radius, Type } from '@/constants/theme';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { ABILITIES, abilityById } from '@/lib/abilities';
import { CONNECTIONS, providerFor, type Connection } from '@/lib/connections';
import { grantMessage, type GrantOutcome } from '@/lib/devicePermissions';

export default function Connections() {
  const palette = usePalette();
  const { connections, connect, disconnect, notice, dismissNotice } = useSession();

  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when the fix is in iOS Settings, so the notice can go straight there. */
  const [needsSettings, setNeedsSettings] = useState(false);
  const [showAll, setShowAll] = useState(false);

  /** Only what is actually built — a list of things that do not work is noise. */
  const wired = ABILITIES.filter((a) => a.wired);

  const live = new Set(connections);
  const connected = CONNECTIONS.filter((c) => live.has(c.key));
  const rest = CONNECTIONS.filter((c) => !live.has(c.key));

  const act = async (item: Connection) => {
    if (item.impossible) return;
    setWorking(item.key);
    setError(null);
    setNeedsSettings(false);
    try {
      if (live.has(item.key)) await disconnect(item.key);
      // A device permission is asked for by key; an account is started by
      // provider, which is not always the same string. Branching on `kind`
      // rather than letting one path serve both is the whole fix here.
      else await connect(item.kind === 'device' ? item.key : providerFor(item));
    } catch (problem) {
      // A device row throws the bare outcome word; anything else is already a
      // sentence. Turning the word into copy here is what lets the message name
      // the connection and know whether Settings is even the right advice.
      const raw = problem instanceof Error ? problem.message : 'That didn’t work.';
      if (raw === 'blocked' || raw === 'unavailable') {
        const said = grantMessage(item.label, raw as Exclude<GrantOutcome, 'granted'>);
        setError(said.text);
        setNeedsSettings(said.settings);
      } else {
        setError(raw);
      }
    } finally {
      setWorking(null);
    }
  };

  return (
    <Screen title="Connections" subtitle="What Grove may reach on your behalf.">
      {notice ? <Notice text={notice} onDismiss={dismissNotice} /> : null}
      {error ? (
        <View style={{ gap: 8 }}>
          <Notice text={error} onDismiss={() => setError(null)} />
          {needsSettings ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open iOS Settings for Grove"
              onPress={() => void Linking.openSettings()}
              style={({ pressed }) => ({
                alignSelf: 'flex-start',
                height: 40,
                justifyContent: 'center',
                paddingHorizontal: 16,
                borderRadius: Radius.well,
                backgroundColor: palette.mark,
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <Text style={{ fontFamily: Type.cardTitle.fontFamily, fontSize: 14, color: palette.raised }}>
                Open iOS Settings
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

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

      {/*
        What all of that adds up to.

        A connection is not a capability, and this screen only showed the
        former: Contacts and Calling both arrive through the Google row, so
        adding them changed nothing visible and there was no way to find out
        what Grove could suddenly do. The useful question is never "is Google
        connected" but "what can I say", and this answers it.

        Folded away, because two dozen cards is a wall rather than a list. Open
        it when you want to know what to ask for; the rest of the time this
        screen is about what is connected, which is five rows.
      */}
      <Section label="Everything it can do">
        <Card style={{ paddingVertical: 0 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showAll }}
            onPress={() => setShowAll((was) => !was)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingVertical: 14,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text style={[Type.body, { color: palette.ink, flex: 1 }]}>
              {wired.length} things you can ask for
            </Text>
            <Mono color={palette.muted}>{showAll ? 'hide' : 'show'}</Mono>
          </Pressable>

          {showAll ? (
            <View style={{ paddingBottom: 12, gap: 12 }}>
              {wired.map((ability) => (
                <View key={ability.id} style={{ borderTopWidth: 1, borderTopColor: palette.line, paddingTop: 10 }}>
                  <Text style={[Type.cardTitle, { color: palette.ink }]}>{ability.name}</Text>
                  {ability.examples[0] ? (
                    <Text style={[Type.bodySm, { color: palette.muted, marginTop: 3 }]}>
                      &ldquo;{ability.examples[0]}&rdquo;
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </Card>
      </Section>

      <Text
        style={[
          Type.bodySm,
          { color: palette.muted, paddingHorizontal: 2, marginTop: 4 },
        ]}
      >
        Reminders, Music, Maps and Messages are permissions on this phone —
        allowing one asks iOS, not a website. Google Workspace signs in through
        Google and keeps its tokens in this phone&rsquo;s Keychain. Anything you
        turn down here is changed again in iOS Settings › Grove.
      </Text>
    </Screen>
  );
}

/**
 * What the button actually does, said on the button.
 *
 * "Connect" is right for an account and wrong for a permission: nothing is
 * being connected to, iOS is being asked a question you answer in a dialogue.
 */
function verb(item: Connection): string {
  return item.kind === 'device' ? 'Allow' : 'Connect';
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
            accessibilityLabel={`${connected ? 'Disconnect' : verb(item)} ${item.label}`}
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
                {connected ? 'Disconnect' : verb(item)}
              </Text>
            )}
          </Pressable>
        )}
      </View>
    </Card>
  );
}
