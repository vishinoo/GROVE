/**
 * Talk.
 *
 * The screen you are not looking at. Almost everything that happens here
 * happens while the phone is in a pocket, so the layout is ordered by what
 * matters when you *do* look: is my hardware live, what state is Grove in, what
 * did it just say, and what has it been doing.
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

import { AppIcon, iconForKey } from '@/components/app-icon';
import { Icon } from '@/components/icon';
import { Orb } from '@/components/orb';
import { Card, Dot, Mono, Notice } from '@/components/ui';
import { Radius, Space, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { capabilities, reducedModeReason } from '@/lib/capabilities';
import { modeById } from '@/lib/modes';
import { when } from '@/lib/transcript';

export default function Talk() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { notice, dismissNotice } = useSession();
  const { state, caption, heard, level, armed, route, problem, activity, press, say, persona } = useAgent();

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
        <Hardware
          armed={armed}
          routeName={route.name}
          external={route.isExternal}
          mic={route.hasExternalMic}
        />

        {notice ? <Notice text={notice} onDismiss={dismissNotice} /> : null}
        {problem ? <Notice text={problem} /> : null}
        {reduced && !notice && !problem ? <Notice text={reduced} tone="info" /> : null}

        <View style={{ alignItems: 'center', marginTop: 26 }}>
          <Orb
            state={state}
            level={level}
            size={210}
            onPress={press}
            // The whole palette, not just the tint. Passing the tint alone
            // recoloured exactly one lobe of four, which read as a glitch
            // rather than a mode.
            palette={modeById(persona.mode ?? 'normal').palette}
          />
        </View>


        {shown ? (
          <Text
            style={[
              Type.caption,
              {
                color: state === 'listening' ? palette.inkSoft : palette.ink,
                textAlign: 'center',
                marginTop: 18,
              },
            ]}
          >
            {shown}
          </Text>
        ) : (
          <Text style={[Type.bodySm, { color: palette.muted, textAlign: 'center', marginTop: 18 }]}>
            {armed ? 'Press your ring, or the orb above.' : 'Press the orb above to talk.'}
          </Text>
        )}

        {activity.length > 0 ? (
          <View style={{ marginTop: 32 }}>
            <Mono style={{ marginBottom: 10 }}>Recent</Mono>
            {activity.map((entry) => (
              <LogRow key={entry.id} entry={entry} />
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
            minHeight: 46,
            paddingHorizontal: 15,
            paddingTop: 13,
            paddingBottom: 13,
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
            width: 46,
            height: 46,
            borderRadius: Radius.control,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: palette.mark,
            opacity: !draft.trim() ? 0.3 : pressed ? 0.8 : 1,
          })}
        >
          <Icon name="send" size={18} color={palette.raised} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * One exchange, and what came of it.
 *
 * Collapsed to the two lines that matter — what you said, what happened — and
 * expanding to the rest. This is the only record that anything happened at all:
 * it all took place while you were looking somewhere else, so "did that
 * reminder actually get set" is a question with no other way to answer it.
 */
function LogRow({ entry }: { entry: ReturnType<typeof useAgent>['activity'][number] }) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);

  const tool = entry.tool;
  const icon = tool ? iconForKey(tool.name) : null;
  const failed = tool?.state === 'failed' || tool?.state === 'blocked';

  return (
    <Card style={{ marginBottom: 8, paddingHorizontal: 0, paddingVertical: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${entry.said}. Tap for detail.`}
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => ({ padding: 13, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          {icon ? <AppIcon name={icon} size={30} /> : null}
          <View style={{ flex: 1, gap: 3 }}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Text style={[Type.bodySm, { color: palette.muted, flex: 1 }]} numberOfLines={1}>
                {entry.said}
              </Text>
              <Mono>{when(entry.at)}</Mono>
            </View>
            <Text style={[Type.body, { color: palette.ink }]} numberOfLines={open ? undefined : 2}>
              {tool?.detail ?? entry.replied}
            </Text>
          </View>
        </View>

        {/* A run that failed is the thing you most need to see, so it is on the
            collapsed card rather than hidden one tap away. */}
        {tool ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              marginTop: 10,
              paddingTop: 10,
              borderTopWidth: 1,
              borderTopColor: palette.line,
            }}
          >
            <Dot tone={failed ? 'alert' : tool.state === 'done' ? 'live' : 'off'} />
            <Text style={[Type.bodySm, { color: palette.inkSoft, flex: 1 }]}>
              {tool.name}
              {tool.state === 'done' ? ' ran' : tool.state === 'running' ? ' running' : ` ${tool.state}`}
            </Text>
            <Icon name={open ? 'down' : 'chevron'} size={13} color={palette.muted} />
          </View>
        ) : null}
      </Pressable>

      {open ? (
        <View
          style={{
            paddingHorizontal: 13,
            paddingBottom: 13,
            borderTopWidth: 1,
            borderTopColor: palette.line,
          }}
        >
          <LogLine label="You said">{entry.said}</LogLine>
          <LogLine label="Grove said">{entry.replied}</LogLine>
          {tool ? <LogLine label="Ability">{`${tool.name} — ${tool.state}`}</LogLine> : null}
          {tool?.detail ? <LogLine label="Result">{tool.detail}</LogLine> : null}
          {tool?.needs?.length ? (
            <LogLine label="Needed">
              {tool.needs.join(', ').replace(/-permission/g, ' access')}
            </LogLine>
          ) : null}
          <LogLine label="When">{new Date(entry.at).toLocaleString()}</LogLine>
        </View>
      ) : null}
    </Card>
  );
}

function LogLine({ label, children }: { label: string; children: string }) {
  const palette = usePalette();
  return (
    <View style={{ marginTop: 12 }}>
      <Mono style={{ marginBottom: 3 }}>{label}</Mono>
      <Text style={[Type.bodySm, { color: palette.ink, lineHeight: 19 }]}>{children}</Text>
    </View>
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
      <Chip icon="ring" label={armed ? 'Ring armed' : 'Ring off'} tone={armed ? 'live' : 'off'} />
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
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: Radius.control,
        backgroundColor: palette.raised,
        borderWidth: 1,
        borderColor: palette.line,
      }}
    >
      <Icon name={icon} size={17} color={tone === 'off' ? palette.muted : palette.inkSoft} />
      <View style={{ flex: 1 }}>
        <Text
          style={{
            fontFamily: Type.cardTitle.fontFamily,
            fontSize: 12.5,
            color: tone === 'off' ? palette.muted : palette.ink,
          }}
          numberOfLines={1}
        >
          {label}
        </Text>
        {hint ? (
          <Text style={{ fontFamily: Type.body.fontFamily, fontSize: 10, color: palette.alert }}>
            {hint}
          </Text>
        ) : null}
      </View>
      <Dot tone={tone} />
    </View>
  );
}
