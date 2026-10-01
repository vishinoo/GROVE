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
import { remaining } from '@/lib/inbox';
import { modeById } from '@/lib/modes';
import { when } from '@/lib/transcript';

import type { NextUp } from '@/lib/attention';
import type { Focus } from '@/lib/inbox';

export default function Talk() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { notice, dismissNotice } = useSession();
  const { state, caption, heard, level, armed, ringSeen, route, problem, activity, next, focus, dayOne, press, say, persona, updatePersona } =
    useAgent();

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
  // While a note is being taken the live words are the point — they show what
  // is being caught, so a mishearing can be said again before it is written up.
  const shown =
    state === 'listening'
      ? heard || 'Go ahead.'
      : state === 'noting'
        ? heard || caption
        : caption;

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
          ringSeen={ringSeen}
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
            // Your own colours win over the mode's. Choosing them is choosing
            // to see your assistant rather than your current situation.
            palette={persona.palette ?? modeById(persona.mode ?? 'normal').palette}
          />
        </View>


        {shown ? (
          <Text
            style={[
              Type.caption,
              {
                color: state === 'listening' || state === 'noting' ? palette.inkSoft : palette.ink,
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

        <Now focus={focus} next={next} />

        {/*
          The one question Grove asks about itself, on the seventh day, once.
          Asked on screen with two buttons rather than out loud, because a
          spoken question needs an open microphone and "yeah" has to be
          unmistakably an answer — on a decision about whether something may
          talk to you unprompted, a misheard yes is the worst possible outcome.
        */}
        {dayOne >= 7 && persona.friend?.proactive === undefined ? (
          <View
            style={{
              marginTop: 18,
              alignSelf: 'center',
              maxWidth: 420,
              width: '100%',
              paddingVertical: 14,
              paddingHorizontal: 16,
              borderRadius: Radius.well,
              backgroundColor: palette.sunken,
              borderWidth: 1,
              borderColor: palette.lineStrong,
            }}
          >
            <Text style={[Type.body, { color: palette.ink }]}>
              A week in. I know your week well enough now to speak up before you ask — when a
              fixture is missing from your diary, or something you meant to do has gone past.
            </Text>
            <Text style={[Type.bodySm, { color: palette.muted, marginTop: 8 }]}>
              Either way I&rsquo;ll still tell you when you need to leave for something.
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  void updatePersona({
                    ...persona,
                    friend: { ...(persona.friend ?? {}), proactive: true },
                  })
                }
                style={({ pressed }) => ({
                  flex: 1,
                  paddingVertical: 11,
                  borderRadius: Radius.card,
                  backgroundColor: palette.ink,
                  alignItems: 'center',
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text style={[Type.cardTitle, { color: palette.paper }]}>Go ahead</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  void updatePersona({
                    ...persona,
                    friend: { ...(persona.friend ?? {}), proactive: false },
                  })
                }
                style={({ pressed }) => ({
                  flex: 1,
                  paddingVertical: 11,
                  borderRadius: Radius.card,
                  borderWidth: 1,
                  borderColor: palette.lineStrong,
                  alignItems: 'center',
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text style={[Type.cardTitle, { color: palette.ink }]}>Only if it&rsquo;s urgent</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

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
/**
 * The only thing on this screen that is there before you speak.
 *
 * Two lines at most, and both of them answer "what am I supposed to be doing" —
 * which is the question someone has when they take the phone out, and the one
 * thing a lock screen cannot answer. A focus session goes above the diary
 * because it is what they chose over everything in it, and a leave-by time
 * earns its place by being a fact nothing else on the phone will tell them.
 *
 * Nothing here is a dashboard. If there is no session and nothing coming, it is
 * not there at all — an empty "Nothing standing yet" panel was on the Sparks
 * screen once and was the ugliest thing in the app.
 */
function Now({ focus, next }: { focus: Focus | null; next: NextUp }) {
  const palette = usePalette();
  if (!focus && !next) return null;
  const left = focus ? remaining(focus) : '';

  return (
    <View
      style={{
        marginTop: 26,
        alignSelf: 'center',
        maxWidth: 420,
        width: '100%',
        paddingVertical: 13,
        paddingHorizontal: 16,
        borderRadius: Radius.well,
        backgroundColor: palette.raised,
        borderWidth: 1,
        borderColor: palette.line,
      }}
    >
      {focus ? (
        <>
          <Mono>On</Mono>
          <Text style={[Type.body, { color: palette.ink, marginTop: 3 }]}>
            {focus.what}
            {left ? <Text style={{ color: palette.muted }}>{`  ${left}`}</Text> : null}
          </Text>
        </>
      ) : null}

      {next ? (
        <View
          style={
            focus
              ? { marginTop: 11, paddingTop: 11, borderTopWidth: 1, borderTopColor: palette.line }
              : undefined
          }
        >
          <Mono>Next</Mono>
          <Text style={[Type.body, { color: palette.ink, marginTop: 3 }]}>
            {next.title}
            <Text style={{ color: palette.muted }}>{`  ${clock(next.at)}`}</Text>
          </Text>
          {next.leaveBy ? (
            <Text style={[Type.bodySm, { color: palette.ink, marginTop: 4 }]}>
              Leave by {clock(next.leaveBy)}
              {next.where ? ` — ${next.where}` : ''}
            </Text>
          ) : next.where ? (
            <Text style={[Type.bodySm, { color: palette.muted, marginTop: 4 }]}>{next.where}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function clock(date: Date): string {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

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
  ringSeen,
  routeName,
  external,
  mic,
}: {
  armed: boolean;
  ringSeen: boolean;
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
      {/*
        Three states, because there are three. Grove cannot see a paired ring —
        iOS exposes no Bluetooth remote to a third-party app — so "armed" was
        claiming knowledge it did not have, and said the same thing on a phone
        with no ring at all. Ready means the session is held and a press would
        arrive; armed means one actually has.
      */}
      <Chip
        icon="ring"
        label={!armed ? 'Ring off' : ringSeen ? 'Ring armed' : 'Ring ready'}
        tone={!armed ? 'off' : ringSeen ? 'live' : 'alert'}
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
