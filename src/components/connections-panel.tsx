/**
 * What Grove may reach, as a block inside Settings.
 *
 * It had a tab of its own. Four tabs for a four-screen app is right only if
 * all four are places you go; this was a place you went once, when something
 * stopped working, and then never again. It sits above "Does it all work?"
 * now, which is the other thing on that screen you only open when something
 * is wrong — and the two answer the same question from opposite ends: what is
 * connected, and does any of it actually work.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, Text, View } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { Mono, Notice, Panel, Section } from '@/components/ui';
import { Radius, Type } from '@/constants/theme';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { abilityById } from '@/lib/abilities';
import { CONNECTIONS, providerFor, type Connection } from '@/lib/connections';
import { grantMessage, type GrantOutcome } from '@/lib/devicePermissions';
import { missingScopes } from '@/lib/googleAuth';

export function ConnectionsPanel() {
  const palette = usePalette();
  const { connections, connect, disconnect, notice, dismissNotice } = useSession();

  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when the fix is in iOS Settings, so the notice can go straight there. */
  const [needsSettings, setNeedsSettings] = useState(false);
  /**
   * Jobs the Google sign-in was never given permission for.
   *
   * A token keeps working for everything it already covered, so a connection
   * made before sending existed reads mail perfectly and refuses to send — and
   * the only way anyone found out was by dictating a message and watching it
   * fail. Said here instead, where the fix is one button away.
   */
  const [ungranted, setUngranted] = useState<string[]>([]);


  const live = new Set(connections);
  const connected = CONNECTIONS.filter((c) => live.has(c.key));

  const googleLive = live.has('email');
  useEffect(() => {
    let current = true;
    void (async () => {
      if (!googleLive) {
        if (current) setUngranted([]);
        return;
      }
      const jobs = ['sending mail', 'writing documents', 'your calendar'];
      const short: string[] = [];
      for (const job of jobs) {
        const missing = await missingScopes(job);
        if (missing && missing.length > 0) short.push(job);
      }
      if (current) setUngranted(short);
    })();
    return () => {
      current = false;
    };
  }, [googleLive, working]);

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
    <View style={{ gap: 0 }}>
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

      {ungranted.length > 0 ? (
        <Notice
          text={`Your Google sign-in does not cover ${ungranted.join(' or ')}. Tap Google Workspace below to disconnect, then connect again and allow everything on the consent screen.`}
        />
      ) : null}

      {connected.length > 0 ? (
        <Section label="Connected">
          <Panel>
            {connected.map((item) => (
              <Row
              key={item.key}
              item={item}
              connected
                busy={working === item.key}
                onPress={() => void act(item)}
              />
            ))}
          </Panel>
        </Section>
      ) : null}

      <Section label={connected.length > 0 ? 'Available' : undefined}>
        <Panel>
          {rest.map((item) => (
            <Row
              key={item.key}
              item={item}
              connected={false}
              busy={working === item.key}
              onPress={() => void act(item)}
            />
          ))}
        </Panel>
      </Section>

    </View>
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
    <View style={{ paddingHorizontal: 13, paddingVertical: 12, opacity: disabled ? 0.55 : 1 }}>
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
    </View>
  );
}
