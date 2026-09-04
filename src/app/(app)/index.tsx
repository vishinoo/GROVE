/**
 * Talk.
 *
 * The screen you are not looking at. Almost everything that happens here
 * happens while the phone is in a pocket, so the layout is ordered by what
 * matters when you *do* look: is my hardware live, what state is Grove in,
 * what did it just say, and what has it been doing.
 *
 * The typed composer at the bottom is not a chat feature. It is the fallback
 * for a build with no speech recognition — Expo Go, or a denied microphone —
 * and it is the reason this app is developable without a device build at all.
 */

import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { Trigger } from '@/components/trigger';
import { Card, Dot, Mono, Notice } from '@/components/ui';
import { Radius, Space, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { capabilities, reducedModeReason } from '@/lib/capabilities';
import { when } from '@/lib/transcript';

export default function Talk() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { notice, dismissNotice } = useSession();
  const { state, caption, heard, level, armed, route, problem, activity, press, say } = useAgent();

  const [draft, setDraft] = useState('');
  const canListen = capabilities().speech;
  const reduced = reducedModeReason();

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    await say(text);
  };

  // While listening, the caption shows what's being heard rather than the last
  // thing said — otherwise the screen looks frozen exactly when it isn't.
  const shown = state === 'listening' ? heard || 'Go ahead.' : caption;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.paper }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: insets.top + 10,
          paddingHorizontal: Space.screenX,
          paddingBottom: 24,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Hardware armed={armed} routeName={route.name} external={route.isExternal} mic={route.hasExternalMic} />

        {notice ? <Notice text={notice} onDismiss={dismissNotice} /> : null}
        {problem ? <Notice text={problem} /> : null}
        {reduced && !notice && !problem ? <Notice text={reduced} tone="info" /> : null}

        <View style={{ alignItems: 'center', marginTop: 22 }}>
          <Trigger state={state} level={level} armed={armed} onPress={press} />
        </View>

        {shown ? (
          <Text
            style={[
              Type.caption,
              {
                color: state === 'listening' ? palette.inkSoft : palette.ink,
                textAlign: 'center',
                marginTop: 22,
              },
            ]}
          >
            {shown}
          </Text>
        ) : (
          <Text
            style={[
              Type.bodySm,
              { color: palette.muted, textAlign: 'center', marginTop: 22 },
            ]}
          >
            {armed
              ? 'Press your ring, or the button above.'
              : 'Press the button above to talk.'}
          </Text>
        )}

        {activity.length > 0 ? (
          <View style={{ marginTop: 36 }}>
            <Mono style={{ marginBottom: 10 }}>Recent</Mono>
            {activity.slice(0, 6).map((entry) => (
              <Card key={entry.id} style={{ marginBottom: 8 }}>
                <View
                  style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}
                >
                  <Text style={[Type.bodySm, { color: palette.inkSoft, flex: 1 }]} numberOfLines={2}>
                    {entry.said}
                  </Text>
                  <Mono>{when(entry.at)}</Mono>
                </View>

                <Text style={[Type.body, { color: palette.ink, marginTop: 6 }]}>
                  {entry.replied}
                </Text>

                {entry.tool ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      marginTop: 10,
                      paddingTop: 10,
                      borderTopWidth: 1,
                      borderTopColor: palette.line,
                    }}
                  >
                    <Dot
                      tone={
                        entry.tool.state === 'done'
                          ? 'live'
                          : entry.tool.state === 'running'
                            ? 'off'
                            : 'alert'
                      }
                    />
                    <Mono color={palette.inkSoft}>{entry.tool.name}</Mono>
                    {entry.tool.detail ? (
                      <Text
                        style={[Type.bodySm, { color: palette.muted, flex: 1 }]}
                        numberOfLines={2}
                      >
                        {entry.tool.detail}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </Card>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/*
        Shown whenever speech is unavailable, and also when it is — typing is
        occasionally the right input even on a working build, in a meeting or
        on a train.
      */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 8,
          paddingHorizontal: Space.screenX,
          paddingBottom: Math.max(insets.bottom, 12) + 76,
        }}
      >
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={canListen ? 'Or type it' : 'Type to Grove'}
          placeholderTextColor={palette.muted}
          multiline
          onSubmitEditing={send}
          style={{
            flex: 1,
            maxHeight: 110,
            minHeight: 44,
            paddingHorizontal: 15,
            paddingTop: 12,
            paddingBottom: 12,
            borderRadius: Radius.control,
            backgroundColor: palette.raised,
            borderWidth: 1,
            borderColor: palette.line,
            fontFamily: Type.body.fontFamily,
            fontSize: 14.5,
            color: palette.ink,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          onPress={send}
          disabled={!draft.trim()}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: Radius.control,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.mark,
            opacity: !draft.trim() ? 0.35 : pressed ? 0.8 : 1,
          })}
        >
          <Icon name="send" size={18} color={palette.paper} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * The hardware strip.
 *
 * Two facts, stated plainly, because between them they explain every way this
 * product fails: the glasses aren't connected, or the ring can't reach Grove.
 * The mic caveat is separate from the route on purpose — a pair of glasses can
 * be connected for playback and still not be listening, which is otherwise an
 * invisible and maddening failure.
 */
function Hardware({
  armed,
  routeName,
  external,
  mic,
}: {
  armed: boolean;
  routeName: string;
  external: boolean;
  mic: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Chip
        icon="glasses"
        label={external ? routeName : 'Phone'}
        hint={external && !mic ? 'playback only' : undefined}
        tone={external ? (mic ? 'live' : 'alert') : 'off'}
      />
      <Chip
        icon="ring"
        label={armed ? 'Ring armed' : 'Ring off'}
        tone={armed ? 'live' : 'off'}
      />
    </View>
  );
}

function Chip({
  icon,
  label,
  hint,
  tone,
}: {
  icon: 'glasses' | 'ring';
  label: string;
  hint?: string;
  tone: 'live' | 'alert' | 'off';
}) {
  const palette = usePalette();
  return (
    <View
      style={{
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 9,
        paddingHorizontal: 11,
        borderRadius: Radius.control,
        backgroundColor: palette.raised,
        borderWidth: 1,
        borderColor: palette.line,
      }}
    >
      <Icon name={icon} size={17} color={tone === 'off' ? palette.muted : palette.ink} />
      <View style={{ flex: 1 }}>
        <Text
          style={{
            fontFamily: Type.bodySm.fontFamily,
            fontSize: 12,
            color: tone === 'off' ? palette.muted : palette.ink,
          }}
          numberOfLines={1}
        >
          {label}
        </Text>
        {hint ? <Mono style={{ fontSize: 8.5, marginTop: 1 }}>{hint}</Mono> : null}
      </View>
      <Dot tone={tone} />
    </View>
  );
}
