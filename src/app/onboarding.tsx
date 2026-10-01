/**
 * First run.
 *
 * Three slides, then the setup. Two of the setup steps happen in iOS Settings,
 * where Grove cannot reach, and someone who skips them has an app that looks
 * fine and a pair of glasses that does nothing.
 *
 * THE SLIDES ARE THE ONLY MARKETING IN THE APP
 *
 * Grove is indistinguishable from every other voice assistant for the first
 * thirty seconds and completely different after a week, and someone who does
 * not know which one they have bought gives up during the thirty seconds.
 *
 * They are written in the second person about nobody in particular. An earlier
 * version used the author's own life as the example — a sister at med school,
 * a cofounder by name — which read, to anyone else holding the phone, as an app
 * that already knew things about them. The one thing a memory product cannot
 * afford on its first screen is to seem like it has been reading your mail.
 *
 * THE HARDWARE STEPS LEAD WITH THE HARDWARE
 *
 * You have just unboxed a pair of glasses and a ring, and the screen should be
 * showing you the thing in your hand rather than an icon of it. So each of those
 * steps is a photograph of the real product with the live status underneath —
 * and the status is the part that moves, because it is the part that changes.
 *
 * The plate behind the product stays light in both themes. These are black
 * objects photographed on white; on a near-black background they are an empty
 * rectangle. That is a fact about the product rather than a style choice, which
 * is why it is not a palette token.
 *
 * Both steps verify themselves rather than asking you to take them on trust:
 * the glasses panel reads the live audio route, and the ring panel shows the raw
 * media keys as you press. That second one used to be buried in Settings, which
 * was the wrong place — "did my twelve-pound ring work" is the question you have
 * at exactly this moment.
 */

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { Orb } from '@/components/orb';
import { Button, Card, Mono } from '@/components/ui';
import { Radius, Space, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { rememberIntro } from '@/lib/consolidate';
import { markOnboardingSeen } from '@/lib/firstRun';
import { loadLife } from '@/lib/life';
import { NAME_LIMIT } from '@/lib/persona';
import * as trigger from '@/lib/trigger';

const STEPS = ['what', 'how', 'private', 'name', 'you', 'glasses', 'ring', 'limit'] as const;

const GLASSES = require('../../assets/images/glasses.png');
const RING = require('../../assets/images/ring.png');

/**
 * The ground a black product is photographed against.
 *
 * Fixed in both themes on purpose. See the note at the top: in dark mode the
 * palette's own surfaces are near-black, and a black pair of glasses on one of
 * them is a rectangle with nothing in it.
 */
const PLATE = '#F2F3F5';

/**
 * What the intro turned into, if anything.
 *
 * The read takes a few seconds, and the two steps after it are hardware —
 * pairing glasses and pressing a ring — which take considerably longer. So it
 * is started when they move on and the result is shown at the end, by which
 * time it has long finished. Nobody waits for a spinner, and the last screen
 * gets to prove the whole thing works by naming their own people back to them.
 */
type Read = { state: 'none' } | { state: 'reading' } | { state: 'done'; names: string[] };

/* ------------------------------------------------------------------ motion */

/**
 * Whether the person has asked the system to stop things moving.
 *
 * Read once rather than subscribed to: nobody changes this setting halfway
 * through an eight-screen intro, and a subscription here would be three lines
 * of listener for a case that does not happen.
 */
function useStillness(): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => alive && setStill(on));
    return () => {
      alive = false;
    };
  }, []);
  return still;
}

/**
 * One entrance per screen, and only one.
 *
 * The generic version of this animates every element on the page in sequence,
 * which reads as a website rather than as a setup flow and makes the fifth
 * screen as slow as the first. Here the whole step arrives as a single object —
 * a short rise and fade, keyed on the step so it replays on each change — and
 * nothing inside it moves on its own.
 */
function Reveal({ step, children }: { step: string; children: React.ReactNode }) {
  const still = useStillness();
  const enter = useSharedValue(still ? 1 : 0);

  useEffect(() => {
    if (still) {
      enter.value = 1;
      return;
    }
    enter.value = 0;
    enter.value = withTiming(1, { duration: 320, easing: Easing.out(Easing.cubic) });
  }, [step, still, enter]);

  const style = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 14 }],
  }));

  return <Animated.View style={style}>{children}</Animated.View>;
}

/* ------------------------------------------------------------------ screen */

export default function Onboarding() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const { status, uid } = useSession();
  const [about, setAbout] = useState('');
  const [read, setRead] = useState<Read>({ state: 'none' });
  const started = useRef(false);

  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  /**
   * Reads the intro into the long memory, once, in the background.
   *
   * Failing is quiet on purpose: the words are worth something and the setup is
   * worth more. If the model could not be reached, the last screen simply says
   * nothing about it and the first conversation picks the names up instead.
   */
  const keep = () => {
    if (started.current) return;
    const text = about.trim();
    if (text.length < 12 || !uid || uid === 'anon') return;
    started.current = true;
    setRead({ state: 'reading' });
    void (async () => {
      const outcome = await rememberIntro(uid, text).catch(() => 'failed' as const);
      if (outcome !== 'kept') {
        setRead({ state: 'none' });
        return;
      }
      const life = await loadLife(uid).catch(() => null);
      const names = (life?.entities ?? [])
        .sort((a, b) => b.mentions - a.mentions || b.lastSeen.localeCompare(a.lastSeen))
        .slice(0, 6)
        .map((e) => e.name);
      setRead(names.length > 0 ? { state: 'done', names } : { state: 'none' });
    })();
  };

  const finish = async () => {
    await markOnboardingSeen();
    // Where the intro lets you out depends on whether you are already signed
    // in. It used to always land on /login, which meant replaying it — or
    // being sent through it by a stray dev flag — threw away a perfectly good
    // session and asked for Google again.
    router.replace(status === 'signed-in' ? '/(app)' : '/login');
  };

  const advance = () => {
    if (step === 'you') keep();
    if (last) void finish();
    else setIndex((n) => n + 1);
  };

  const label = last
    ? status === 'signed-in'
      ? 'Done'
      : 'Sign in'
    : step === 'you' && about.trim().length < 12
      ? 'Do this later'
      : step === 'private'
        ? 'Set it up'
        : 'Continue';

  return (
    <View style={{ flex: 1, backgroundColor: palette.paper }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + 16,
          paddingHorizontal: Space.screenX + 4,
          paddingBottom: 16,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Skip the intro"
            onPress={() => void finish()}
            hitSlop={8}
            style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={[Type.bodySm, { color: palette.muted }]}>Skip</Text>
          </Pressable>
        </View>

        <View style={{ flex: 1, justifyContent: 'center', paddingVertical: 24 }}>
          <Reveal step={step}>
            {step === 'what' ? <WhatStep /> : null}
            {step === 'how' ? <HowStep /> : null}
            {step === 'private' ? <PrivateStep /> : null}
            {step === 'name' ? <NameStep /> : null}
            {step === 'you' ? <YouStep value={about} onChange={setAbout} /> : null}
            {step === 'glasses' ? <GlassesStep /> : null}
            {step === 'ring' ? <RingStep /> : null}
            {step === 'limit' ? <LimitStep read={read} /> : null}
          </Reveal>
        </View>
      </ScrollView>

      <View
        style={{
          paddingHorizontal: Space.screenX + 4,
          paddingBottom: Math.max(insets.bottom, 16),
          gap: 16,
        }}
      >
        <Progress count={STEPS.length} at={index} />
        <Button label={label} onPress={advance} />
      </View>
    </View>
  );
}

/**
 * Where you are, as a row of marks.
 *
 * The current one grows rather than merely changing colour, so moving between
 * screens is legible out of the corner of your eye. This is a sequence, and the
 * progress through it is the one piece of chrome worth animating.
 */
function Progress({ count, at }: { count: number; at: number }) {
  const palette = usePalette();
  return (
    <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center' }}>
      {Array.from({ length: count }, (_, i) => (
        <Mark key={i} active={i === at} done={i < at} palette={palette} />
      ))}
    </View>
  );
}

function Mark({
  active,
  done,
  palette,
}: {
  active: boolean;
  done: boolean;
  palette: ReturnType<typeof usePalette>;
}) {
  const still = useStillness();
  const width = useSharedValue(active ? 20 : 6);

  useEffect(() => {
    const to = active ? 20 : 6;
    width.value = still ? to : withTiming(to, { duration: 260, easing: Easing.out(Easing.cubic) });
  }, [active, still, width]);

  const style = useAnimatedStyle(() => ({ width: width.value }));

  return (
    <Animated.View
      style={[
        style,
        {
          height: 6,
          borderRadius: 3,
          backgroundColor: active || done ? palette.mark : palette.lineStrong,
        },
      ]}
    />
  );
}

/* ------------------------------------------------------------------- parts */

function Heading({ icon, title }: { icon?: IconName; title: string }) {
  const palette = usePalette();
  return (
    <>
      {icon ? <Icon name={icon} size={30} color={palette.ink} /> : null}
      <Text style={[Type.screenTitle, { color: palette.ink, marginTop: 14, marginBottom: 8 }]}>
        {title}
      </Text>
    </>
  );
}

function Body({ children }: { children: string }) {
  const palette = usePalette();
  return <Text style={[Type.body, { color: palette.inkSoft }]}>{children}</Text>;
}

/**
 * A slide, which is deliberately not a step.
 *
 * Nothing to fill in, nothing to check, and the type is bigger — so the three
 * of these read as being told something and the five after them read as being
 * asked for something. One statement, a few lines under it, and no card: a
 * card is a container for data, and there is no data here.
 */
function Slide({ title, lines }: { title: string; lines: string[] }) {
  const palette = usePalette();
  return (
    <>
      <Text style={[Type.screenTitle, { color: palette.ink, fontSize: 30, lineHeight: 36 }]}>
        {title}
      </Text>
      {lines.map((line, i) => (
        <Text
          key={line.slice(0, 16)}
          style={[
            Type.body,
            {
              color: i === 0 ? palette.ink : palette.inkSoft,
              marginTop: i === 0 ? 18 : 14,
              lineHeight: 24,
            },
          ]}
        >
          {line}
        </Text>
      ))}
    </>
  );
}

/**
 * The real thing, on a ground it can be seen against.
 *
 * Photographed rather than drawn, because at this moment the object is in the
 * person's other hand and an icon of it is a worse match than the thing itself.
 */
function Product({ source, height }: { source: number; height: number }) {
  const still = useStillness();
  const settle = useSharedValue(still ? 1 : 0);

  useEffect(() => {
    settle.value = still
      ? 1
      : withDelay(90, withTiming(1, { duration: 420, easing: Easing.out(Easing.cubic) }));
  }, [still, settle]);

  const style = useAnimatedStyle(() => ({
    opacity: settle.value,
    transform: [{ scale: 0.96 + settle.value * 0.04 }],
  }));

  return (
    <View
      style={{
        height,
        borderRadius: Radius.card,
        backgroundColor: PLATE,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      <Animated.View style={style}>
        <Image
          source={source}
          resizeMode="contain"
          style={{ width: '100%', height: height - 28 }}
          accessible={false}
        />
      </Animated.View>
    </View>
  );
}

/**
 * The live half of a hardware step.
 *
 * One line that says what is true now, and a mark that is green when the thing
 * works. It moves when the state changes, which is the only motion in these two
 * screens that answers an event rather than a screen appearing.
 */
function Status({ live, title, note }: { live: boolean; title: string; note?: string }) {
  const palette = usePalette();
  const still = useStillness();
  const on = useSharedValue(live ? 1 : 0);

  useEffect(() => {
    on.value = still ? (live ? 1 : 0) : withTiming(live ? 1 : 0, { duration: 420 });
  }, [live, still, on]);

  const dot = useAnimatedStyle(() => ({
    transform: [{ scale: 0.7 + on.value * 0.3 }],
    opacity: 0.45 + on.value * 0.55,
  }));

  return (
    <View
      style={{
        marginTop: 14,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 11,
        paddingVertical: 13,
        paddingHorizontal: 15,
        borderRadius: Radius.card,
        backgroundColor: palette.raised,
        borderWidth: 1,
        borderColor: live ? palette.lineStrong : palette.line,
      }}
    >
      <Animated.View
        style={[
          dot,
          {
            width: 9,
            height: 9,
            borderRadius: 5,
            backgroundColor: live ? palette.signal : palette.muted,
          },
        ]}
      />
      <View style={{ flex: 1 }}>
        <Text style={[Type.cardTitle, { color: palette.ink }]}>{title}</Text>
        {note ? (
          <Text style={[Type.bodySm, { color: palette.muted, marginTop: 2 }]}>{note}</Text>
        ) : null}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ slides */

/** The promise, stated once, in the words it will actually be judged on. */
function WhatStep() {
  return (
    <>
      <View style={{ alignItems: 'flex-start', marginBottom: 22 }}>
        <Orb state="idle" level={0} size={96} showCaption={false} />
      </View>
      <Slide
        title="It remembers, so you don’t have to."
        lines={[
          'Tell it something once and it keeps it. Weeks later you can ask about the same person, the same project, the same decision, and it still knows.',
          'It keeps what things meant, not a recording of your day. That is the difference between this and something that answers questions.',
        ]}
      />
    </>
  );
}

/** How you actually use it, which is the part nobody expects. */
function HowStep() {
  return (
    <Slide
      title="Press the ring. Talk. That’s it."
      lines={[
        'No wake word, no phone out, no screen. One press, say what you want, and it answers through your glasses.',
        'It reaches your mail, your calendar, your documents and the web directly. Anything it cannot undo, it reads back and waits for a press first.',
      ]}
    />
  );
}

/** What it does not do, which on a wearable is a feature and not a disclaimer. */
function PrivateStep() {
  return (
    <Slide
      title="No camera. No server. Your memory."
      lines={[
        'Nothing is pointed at anyone around you, and there is nothing to be pointed. Wear it in a lecture, a meeting or a restaurant.',
        'What it remembers lives on this phone, encrypted with a key that never leaves it.',
        'All of it sits on one screen, where you can correct it, delete it, or delete the lot.',
      ]}
    />
  );
}

/* ------------------------------------------------------------------- steps */

/** Name first, because every step after this refers to it by name. */
function NameStep() {
  const palette = usePalette();
  const { persona, updatePersona } = useAgent();

  return (
    <>
      <View style={{ alignItems: 'flex-start' }}>
        <Orb state="idle" level={0} size={108} showCaption={false} />
      </View>
      <Heading title="What should I answer to?" />
      <Body>
        Pick anything. You’ll be saying it out loud in public, so pick something you don’t mind
        saying.
      </Body>
      <Card style={{ marginTop: 16 }}>
        <TextInput
          value={persona.name}
          onChangeText={(name) =>
            void updatePersona({ ...persona, name: name.slice(0, NAME_LIMIT) })
          }
          placeholder="Buddy"
          placeholderTextColor={palette.muted}
          autoCapitalize="words"
          style={{
            fontFamily: Type.cardTitle.fontFamily,
            fontSize: 18,
            color: palette.ink,
            paddingVertical: 2,
          }}
        />
      </Card>
    </>
  );
}

/**
 * The one step that is not setup.
 *
 * Everything else here makes the hardware work. This makes Grove worth having
 * on the first afternoon rather than the third week: a handful of sentences
 * about who is in your life and what you are doing goes straight into the long
 * memory, so the first thing you ask is answered with your own names in it
 * instead of "I don't know anything about you yet".
 *
 * Typed, not spoken, and this is the one place in the app where that is the
 * right way round. It is a paragraph, not a sentence; it is full of proper
 * nouns a recogniser has never heard — which is the exact problem the long
 * memory later solves by feeding those names back to it — and people edit
 * themselves when they write. Skipping is a real option, said plainly on the
 * button, because an empty box with a Continue greyed out is a wall.
 *
 * The example is a stranger's life, not the author's. A placeholder naming real
 * people reads as an app that already knows them.
 */
function YouStep({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const palette = usePalette();

  return (
    <>
      <Heading icon="person" title="Tell me about your life" />
      <Body>
        Who’s in it, what you’re working on, what you’re trying to get done. A few sentences is
        plenty — I’ll keep the names and fill in the rest as we talk.
      </Body>
      <Card style={{ marginTop: 16 }}>
        <TextInput
          value={value}
          onChangeText={(text) => onChange(text.slice(0, INTRO_LIMIT))}
          placeholder={
            'Second year of a law degree. Sharing a flat with two friends, saving for a trip in the summer, and trying to get back into running three times a week.'
          }
          placeholderTextColor={palette.muted}
          multiline
          textAlignVertical="top"
          style={{
            fontFamily: Type.body.fontFamily,
            fontSize: 16,
            lineHeight: 23,
            color: palette.ink,
            minHeight: 148,
            paddingVertical: 2,
          }}
        />
      </Card>
      <Text style={[Type.bodySm, { color: palette.muted, marginTop: 10 }]}>
        Stays on your phone. You can read and delete any of it later, on Sparks.
      </Text>
    </>
  );
}

/** Long enough for a paragraph about a life, short enough to stay one call. */
const INTRO_LIMIT = 1200;

/**
 * Pairing, with the glasses on screen and the live route underneath.
 *
 * Connected is connected. This used to insist on a headset profile and go amber
 * for a pair connected without a microphone — which looked like a failure in
 * the middle of setup, when nothing had failed: Grove speaks through them, the
 * phone does the listening, and everything works. It is a note under the name
 * now rather than a warning.
 */
function GlassesStep() {
  const { route } = useAgent();
  const paired = route.isExternal;

  return (
    <>
      <Heading title="Pair your glasses" />
      <Body>
        They’re an ordinary Bluetooth headset. Open Settings › Bluetooth and pair them — iOS does
        the routing, so there’s nothing to set up in here.
      </Body>
      <View style={{ marginTop: 18 }}>
        <Product source={GLASSES} height={150} />
      </View>
      <Status
        live={paired}
        title={paired ? route.name : 'Waiting for your glasses'}
        note={
          paired
            ? route.hasExternalMic
              ? 'Speaking and listening through them.'
              : 'Speaking through them, listening on the phone.'
            : 'They’ll show up here the moment they connect.'
        }
      />
    </>
  );
}

/**
 * The most useful screen in the app.
 *
 * Nobody ships a spec sheet with a cheap ring, so rather than explain what it
 * ought to send, Grove shows what yours actually sends. "Merged" is it telling
 * you it saw the double signal and treated it as one press.
 */
function RingStep() {
  const palette = usePalette();
  const [signals, setSignals] = useState(() => trigger.recentSignals());

  useEffect(() => {
    const timer = setInterval(() => setSignals(trigger.recentSignals()), 600);
    return () => clearInterval(timer);
  }, []);

  const heard = signals.length > 0;

  return (
    <>
      <Heading title="Press your ring" />
      <Body>
        Pair it in Settings, then press it a few times. It reaches Grove as a media remote — the
        same signal a headset’s play button sends.
      </Body>
      <View style={{ marginTop: 18 }}>
        <Product source={RING} height={190} />
      </View>
      <Status
        live={heard}
        title={heard ? `${signals.length} press${signals.length === 1 ? '' : 'es'} heard` : 'Nothing yet'}
        note={
          heard
            ? 'That’s it working. Grove sees every one of these.'
            : 'If it stays empty, check the ring starts and stops music from the lock screen.'
        }
      />

      {heard ? (
        <View style={{ marginTop: 10, paddingHorizontal: 4 }}>
          {signals.slice(0, 4).map((signal, i) => (
            <View
              key={`${signal.at}-${i}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 9,
                paddingVertical: 7,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: palette.line,
              }}
            >
              <Text style={[Type.bodySm, { color: palette.inkSoft, flex: 1 }]}>
                {signal.command}
                {signal.phase ? ` · ${signal.phase}` : ''}
              </Text>
              <Mono>{signal.coalesced ? 'merged' : 'used'}</Mono>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );
}

/** Said up front rather than discovered on a walk. */
function LimitStep({ read }: { read: Read }) {
  const palette = usePalette();

  return (
    <>
      <Heading icon="alert" title="One thing to know" />
      <Body>
        iOS won’t let any app be woken from fully closed by a button press. Backgrounded, locked
        and pocketed are all fine — swiping Grove away turns the ring off until you open it again.
      </Body>

      {/*
        The intro, read while they were pairing. Their own names, back in their
        own words — which is a better argument for the whole app than anything
        this screen could claim about it.
      */}
      {read.state === 'done' ? (
        <Card style={{ marginTop: 18 }}>
          <Mono style={{ marginBottom: 8 }}>Already yours</Mono>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {read.names.map((name) => (
              <View
                key={name}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  borderRadius: Radius.pill,
                  backgroundColor: palette.sunken,
                  borderWidth: 1,
                  borderColor: palette.line,
                }}
              >
                <Text style={[Type.bodySm, { color: palette.ink }]}>{name}</Text>
              </View>
            ))}
          </View>
          <Text style={[Type.bodySm, { color: palette.muted, marginTop: 10 }]}>
            Ask me about any of them.
          </Text>
        </Card>
      ) : null}
    </>
  );
}
