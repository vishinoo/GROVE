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

import { useRef, useState } from 'react';
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

import { Icon } from '@/components/icon';
import { STATE_WORD } from '@/components/field';
import { Glass } from '@/components/glass';
import { Card, Mono, Notice } from '@/components/ui';
import { Radius, Space, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { capabilities, reducedModeReason } from '@/lib/capabilities';

import type { NextUp } from '@/lib/attention';

/** Words written straight onto the field, which is dark enough everywhere for white. */
const ON_FIELD = '#FFFFFF';
const ON_FIELD_SOFT = 'rgba(255,255,255,0.74)';

/** Faded in and out with focus, like the other tabs on the field; see Glass. */
export default function Talk() {
  return (
    <Glass plain>
      <TalkBody />
    </Glass>
  );
}

function TalkBody() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  /*
    The field is the whole screen, and the words sit in it.

    The open space above the greeting is the button — "press the sky" — and
    it is a little over a third of the screen, which puts the greeting where
    the lab had it and leaves the reply most of the room below.
  */
  const sky = Math.round(height * 0.36);

  const { notice, dismissNotice } = useSession();
  const { state, caption, heard, armed, ringSeen, route, problem, next, due, press, say } =
    useAgent();

  // Recomputed on every render, and `next` is refreshed each minute, so the
  // count of minutes stays true without a timer of its own.
  const resting = state === 'idle' || state === 'asleep';
  const hello = greeting(next, due);

  /*
    One screen: the field and everything you talk through — the greeting,
    the reply and the composer. The record of what happened is not here at
    all; it is Settings → Logs, somewhere you go to check, because nothing in
    it is something you need while talking.

    The screen is measured, not taken from the window, so that when the
    keyboard shortens the view the composer stays on it.
  */
  const [viewport, setViewport] = useState(0);
  const page = viewport || height;
  const replyRef = useRef<ScrollView>(null);

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
      // Transparent: the field is drawn once behind every tab, by the layout.
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        onLayout={(event) => setViewport(event.nativeEvent.layout.height)}
        // One page. It only scrolls so the keyboard can push the composer up.
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ height: page, overflow: 'hidden' }}>

          <Pressable
            onPress={press}
            accessibilityRole="button"
            accessibilityLabel="Talk to Grove"
            // The whole open field is the button. On a screen you reach for
            // while walking, a small target in the middle of it would be wrong.
            style={{ height: sky }}
          />

          {/*
            The reply never runs under the composer: this column takes what is
            left of the page and the reply card shrinks into it, scrolling
            inside itself past that.
          */}
          <View style={{ flex: 1, minHeight: 0, paddingHorizontal: Space.screenX }}>
            {notice ? <Notice text={notice} onDismiss={dismissNotice} /> : null}
            {problem ? <Notice text={problem} /> : null}
            {reduced && !notice && !problem ? <Notice text={reduced} tone="info" /> : null}

            {/*
              A greeting, not a status word.

              "Ready" is a machine telling you it is available, which is both
              obvious — it is on your screen — and the least interesting thing
              it could say. The field already carries the state in how fast it
              moves. So the word under it is a hello while Grove is idle, and
              only becomes the state when the state is worth naming.
            */}
            <Text
              style={[
                Type.state,
                { color: ON_FIELD, textAlign: 'center', marginTop: 2, maxWidth: 320, alignSelf: 'center' },
                // A sentence about your day is read, not glanced at: a size
                // down from the one-word hello, so two lines still fit.
                resting && !hello.plain ? { fontSize: 19, lineHeight: 25, letterSpacing: -0.4 } : null,
              ]}
            >
              {resting ? hello.line : STATE_WORD[state]}
            </Text>

            {resting && hello.plain ? (
              <Text style={[Type.bodySm, { color: ON_FIELD_SOFT, textAlign: 'center', marginTop: 6 }]}>
                {armed ? 'Press your ring, or the sky.' : 'Press the sky to talk.'}
              </Text>
            ) : null}

            {shown ? (
              <Card style={{ marginTop: 18, flexShrink: 1, minHeight: 0 }}>
                <ScrollView
                  ref={replyRef}
                  style={{ flexGrow: 0, flexShrink: 1 }}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator={false}
                  // While you are talking the newest words are the point, so it
                  // follows them; a reply is read from its first line.
                  onContentSizeChange={() => {
                    if (state === 'listening' || state === 'noting') {
                      replyRef.current?.scrollToEnd({ animated: false });
                    }
                  }}
                >
                  <Text
                    style={[
                      Type.body,
                      { color: state === 'listening' || state === 'noting' ? palette.inkSoft : palette.ink },
                    ]}
                  >
                    {shown}
                  </Text>
                </ScrollView>
              </Card>
            ) : null}

            {resting && hello.covers ? null : <Now next={next} />}
          </View>

          {/*
            Shown whenever speech is unavailable, and also when it is — typing
            is occasionally the right input even on a working build, in a
            meeting or on a train. It belongs to this page and leaves with it.
          */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              gap: 8,
              paddingTop: 12,
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
              <Icon name="send" size={18} color={palette.onMark} />
            </Pressable>
          </View>

          {/*
            The hardware strip rides on the field rather than pushing it down.
            "Are my glasses on" is a glance, and the answer belongs in the
            corner you are already looking at.
          */}
          <View
            pointerEvents="box-none"
            style={{ position: 'absolute', top: insets.top + 6, left: Space.screenX, right: Space.screenX }}
          >
            <Hardware
              armed={armed}
              ringSeen={ringSeen}
              routeName={route.name}
              external={route.isExternal}
              mic={route.hasExternalMic}
            />
          </View>
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

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
 * The hour, unless something in the day is worth a glance — and then that,
 * instead. Never both: a greeting with a meeting tacked on is a dashboard
 * that learnt to say hello.
 *
 * What counts is the same short list attention.ts speaks up for, read with a
 * wider window, because a line on a screen you chose to look at costs far
 * less than a voice in your ear. Nothing here is ever said aloud.
 *
 * `covers` says whether the line already names the next event, so the card
 * underneath does not say it a second time. `plain` is the hour alone, the
 * only time the "press the sky" hint is worth its line: next to a sentence
 * that is actually about your day it is clutter, and it fell under the
 * composer whenever that sentence ran to two lines.
 */
function greeting(
  next: NextUp,
  due: string | null,
  now = new Date()
): { line: string; covers: boolean; plain?: boolean } {
  if (next?.leaveBy) {
    const leaveIn = minutesUntil(next.leaveBy, now);
    if (leaveIn <= 0) return { line: `Time to leave for ${next.title}.`, covers: true };
    if (leaveIn <= 30) return { line: `Leave by ${clock(next.leaveBy)} for ${next.title}.`, covers: true };
  }
  if (next) {
    const m = minutesUntil(next.at, now);
    if (m > 0 && m <= 60) {
      return {
        line: `You have ${m === 1 ? 'a minute' : `${m} minutes`} before ${next.title}.`,
        covers: true,
      };
    }
  }
  if (due) return { line: `You asked me to remind you about ${due} today.`, covers: false };

  const h = now.getHours();
  const line =
    h < 5 ? 'Still up?' : h < 12 ? 'Morning.' : h < 18 ? 'Afternoon.' : h < 22 ? 'Evening.' : 'Late one.';
  return { line, covers: false, plain: true };
}

function minutesUntil(at: Date, now: Date): number {
  return Math.round((at.getTime() - now.getTime()) / 60_000);
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
