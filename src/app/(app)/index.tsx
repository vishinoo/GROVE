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
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppIcon, iconForKey } from '@/components/app-icon';
import { Icon } from '@/components/icon';
import { Horizon, STATE_WORD } from '@/components/horizon';
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
  const { width, height } = useWindowDimensions();
  /*
    Half the screen.

    The horizon is the thing this app is, and at 280 on a tall phone it was a
    band across the top of a page of cards. Half gives it the weight of a
    view you are looking at rather than a header you are looking past, and
    everything below it is still reachable with a thumb.
  */
  const sky = Math.round(height * 0.5);

  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });
  // Fully there by the time you have scrolled a third of the sky away.
  const recent = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, scrollY.value / (sky * 0.33))),
  }));
  const { notice, dismissNotice } = useSession();
  const { state, caption, heard, level, armed, ringSeen, route, problem, activity, next, press, say, persona } =
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
      <Animated.ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: Space.screenX,
          paddingBottom: 24,
        }}
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {/*
          The sky, full width and starting at the very top of the screen —
          behind the status bar, not below it. A horizon with a margin either
          side, or a strip of page above it, is a picture of a horizon.
          Everything else on this screen keeps its gutter.
        */}
        <View style={{ marginHorizontal: -Space.screenX }}>
          <Horizon
            state={state}
            width={width}
            height={sky}
            onPress={press}
            sky={persona.sky}
            level={level}
          />
        </View>

        {notice ? <Notice text={notice} onDismiss={dismissNotice} /> : null}
        {problem ? <Notice text={problem} /> : null}
        {reduced && !notice && !problem ? <Notice text={reduced} tone="info" /> : null}


        {/*
          A greeting, not a status word.

          "Ready" is a machine telling you it is available, which is both
          obvious — it is on your screen — and the least interesting thing it
          could say. The sky already carries the state: it is flat when
          nothing is happening and rough when something is. So the word under
          it is a hello while Grove is idle, and only becomes the state when
          the state is worth naming.
        */}
        <Text style={[Type.state, { color: palette.ink, textAlign: 'center', marginTop: 2 }]}>
          {state === 'idle' || state === 'asleep' ? greeting() : STATE_WORD[state]}
        </Text>

        {state === 'idle' || state === 'asleep' ? (
          <Text style={[Type.bodySm, { color: palette.muted, textAlign: 'center', marginTop: 6 }]}>
            {armed ? 'Press your ring, or the sky.' : 'Press the sky to talk.'}
          </Text>
        ) : null}

        {/*
          What was heard, and what came back, in the body of the page rather
          than tucked under the horizon.

          Under the wave it was a caption on a picture: small, centred, and
          competing with the one thing on the screen that is supposed to hold
          your eye. Down here it is the content, and it can be as long as it
          needs to be without pushing the sky around.
        */}
        {shown ? (
          <Card style={{ marginTop: 18 }}>
            <Text
              style={[
                Type.body,
                { color: state === 'listening' || state === 'noting' ? palette.inkSoft : palette.ink },
              ]}
            >
              {shown}
            </Text>
          </Card>
        ) : null}

        <Now next={next} />

        {/*
          The log arrives as you go looking for it.

          Nothing on this screen is urgent and the log is the least urgent
          thing on it — a record you read when you want to check something,
          not when you open the app. Hidden at rest it keeps the first screen
          to a sky and a sentence; tied to the scroll it is already there by
          the time you have travelled far enough to want it, rather than
          appearing suddenly once you cross a line.
        */}
        {activity.length > 0 ? (
          <Animated.View style={[recent, { marginTop: 32 }]}>
            <Mono style={{ marginBottom: 10 }}>Recent</Mono>
            {activity.map((entry) => (
              <LogRow key={entry.id} entry={entry} />
            ))}
          </Animated.View>
        ) : null}
      </Animated.ScrollView>

      {/*
        The hardware strip rides on the sky rather than pushing it down the
        page. "Are my glasses on" is a glance, and the answer belongs in the
        corner you are already looking at, not in a row that costs the horizon
        forty pixels of height.
      */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          top: insets.top + 6,
          left: Space.screenX,
          right: Space.screenX,
        }}
      >
        <Hardware
          armed={armed}
          ringSeen={ringSeen}
          routeName={route.name}
          external={route.isExternal}
          mic={route.hasExternalMic}
        />
      </View>

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
  const palette = usePalette();
  const [open, setOpen] = useState(false);

  // Everything being fine is the usual case, and the usual case deserves the
  // least ink on the screen. Two chips announcing that nothing is wrong sat
  // across the top of the sky all day; one dot says the same thing, and the
  // detail is one tap away for the times it actually matters.
  //
  // White, then green. Amber was reading as a warning for the ordinary state
  // of having no glasses on — nothing is wrong when you are holding the
  // phone, so nothing should be coloured.
  const live = external && armed && ringSeen;

  return (
    <View style={{ alignItems: 'center', gap: 8 }}>
      <Pressable
        onPress={() => setOpen((was) => !was)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`What is connected. ${external ? routeName : 'Phone'}, ${
          !armed ? 'ring off' : ringSeen ? 'ring armed' : 'ring ready'
        }.`}
        hitSlop={14}
        style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}
      >
        <View
          style={{
            width: open ? 5 : 8,
            height: open ? 5 : 8,
            borderRadius: 4,
            // White in both themes, because it sits on the sky rather than
            // on the page — and the sky is pale at the top in daylight and
            // deep at night, so a palette colour would vanish into one of
            // them. The ring is what keeps it visible against the pale one.
            backgroundColor: live ? palette.signal : '#FFFFFF',
            borderWidth: live ? 0 : 1,
            borderColor: 'rgba(16,20,24,0.22)',
          }}
        />
      </Pressable>

      {open ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 9,
            height: 34,
            paddingHorizontal: 13,
            borderRadius: Radius.pill,
            backgroundColor: palette.glass,
            borderWidth: 1,
            borderColor: palette.glassLine,
          }}
        >
          <Icon name="glasses" size={16} color={palette.inkSoft} />
          <Text style={[Type.bodySm, { color: palette.ink }]}>
            {external ? routeName : 'Phone'}
            <Text style={{ color: palette.muted }}>
              {external && !mic ? ' · phone mic' : ''}
              {!armed ? ' · ring off' : ringSeen ? ' · ring armed' : ' · ring ready'}
            </Text>
          </Text>
        </View>
      ) : null}
    </View>
  );
}
