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
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon, iconForKey } from '@/components/app-icon';
import { Icon } from '@/components/icon';
import { Horizon } from '@/components/horizon';
import { Card, Dot, Mono, Notice } from '@/components/ui';
import { Radius, Space, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { capabilities, reducedModeReason } from '@/lib/capabilities';
import { when } from '@/lib/transcript';

import type { NextUp } from '@/lib/attention';

export default function Talk() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { notice, dismissNotice } = useSession();
  const { state, caption, heard, armed, ringSeen, route, problem, activity, next, press, say } =
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

        {/*
          The sky, full width.

          It escapes the scroll view's own padding rather than sitting inside
          it, because a horizon with a margin either side is a picture of a
          horizon. Everything else on this screen keeps its gutter.
        */}
        <View style={{ marginHorizontal: -Space.screenX, marginTop: 18 }}>
          <Horizon state={state} width={width} height={236} onPress={press} />
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
          <>
            {/*
              A greeting, on screen rather than read out.
              
              Grove used to open by reading its own memory back — "I've got
              Grove, the energy stock document and probabilistic machine
              learning written down" — which is a roster, not a hello, and a
              miserable way to be greeted by your own assistant. It says
              nothing at launch now unless you are about to be late. This is
              the warmth, where it costs nobody anything.
            */}
            <Text style={[Type.caption, { color: palette.ink, textAlign: 'center', marginTop: 18 }]}>
              {greeting()}
            </Text>
            <Text style={[Type.bodySm, { color: palette.muted, textAlign: 'center', marginTop: 8 }]}>
              {armed ? 'Press your ring, or the orb above.' : 'Press the orb above to talk.'}
            </Text>
          </>
        )}

        <Now next={next} />

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
/**
 * What the screen says when nothing is happening.
 *
 * The hour, and nothing else. No name, no count of anything, no reference to
 * what it remembers — the point is that it reads as someone looking up when
 * you walk in, rather than as a dashboard reporting its state.
 */
function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return 'Still up?';
  if (h < 12) return 'Morning.';
  if (h < 18) return 'Afternoon.';
  if (h < 22) return 'Evening.';
  return 'Late one.';
}

function Now({ next }: { next: NextUp }) {
  const palette = usePalette();
  if (!next) return null;

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
 * be connected for playback while the phone does the listening — which still
 * works, and is said under the name rather than coloured as a fault.
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
      {/*
        Paired is paired. This used to go amber for a pair connected without a
        microphone, which was technically true and read as a fault — the
        glasses were on, Grove was working, and the strip said something was
        wrong. The microphone is the phone's in that case and everything still
        works, so it is a note under the name rather than a warning colour.
      */}
      <Chip
        icon="glasses"
        label={external ? routeName : 'Phone'}
        hint={external && !mic ? 'phone mic' : undefined}
        tone={external ? 'live' : 'off'}
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
