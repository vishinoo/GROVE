/**
 * First run.
 *
 * A checklist, not a feature tour. Two of these four steps happen in iOS
 * Settings, where Grove cannot reach, and someone who skips them has an app that
 * looks fine and a pair of glasses that does nothing.
 *
 * Two of the steps verify themselves rather than asking you to take them on
 * trust: the glasses card only goes green once they are actually connected with
 * a microphone, and the ring step shows the raw media keys as you press. That
 * second one used to be buried in Settings, which was the wrong place — "did my
 * twelve-pound ring work" is the question you have at exactly this moment.
 */

import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { Orb } from '@/components/orb';
import { Button, Card, Dot, Mono } from '@/components/ui';
import { Radius, Space, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { usePalette } from '@/hooks/use-palette';
import { markOnboardingSeen } from '@/lib/firstRun';
import { NAME_LIMIT } from '@/lib/persona';
import * as trigger from '@/lib/trigger';

const STEPS = ['name', 'glasses', 'ring', 'limit'] as const;


export default function Onboarding() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [index, setIndex] = useState(0);

  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  const finish = async () => {
    await markOnboardingSeen();
    router.replace('/login');
  };

  const advance = () => (last ? void finish() : setIndex((n) => n + 1));

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
          {step === 'name' ? <NameStep /> : null}
          {step === 'glasses' ? <GlassesStep /> : null}
          {step === 'ring' ? <RingStep /> : null}
          {step === 'limit' ? <LimitStep /> : null}
        </View>
      </ScrollView>

      <View
        style={{
          paddingHorizontal: Space.screenX + 4,
          paddingBottom: Math.max(insets.bottom, 16),
          gap: 16,
        }}
      >
        <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center' }}>
          {STEPS.map((_, i) => (
            <View
              key={i}
              style={{
                width: i === index ? 20 : 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: i === index ? palette.mark : palette.lineStrong,
              }}
            />
          ))}
        </View>
        <Button label={last ? 'Sign in with Noctus' : 'Continue'} onPress={advance} />
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ steps */

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

function Todo({ children }: { children: React.ReactNode }) {
  const palette = usePalette();
  return (
    <View
      style={{
        marginTop: 16,
        padding: 13,
        borderRadius: Radius.card,
        backgroundColor: palette.sunken,
        borderWidth: 1,
        borderColor: palette.line,
      }}
    >
      <Text style={[Type.bodySm, { color: palette.ink, lineHeight: 19 }]}>{children}</Text>
    </View>
  );
}

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
 * The card underneath is live. It goes green only once the glasses are actually
 * connected *with a microphone*, so the step proves itself.
 */
function GlassesStep() {
  const palette = usePalette();
  const { route } = useAgent();

  const good = route.isExternal && route.hasExternalMic;
  const playbackOnly = route.isExternal && !route.hasExternalMic;

  return (
    <>
      <Heading icon="glasses" title="Pair your glasses" />
      <Body>
        They’re an ordinary Bluetooth headset. iOS does the routing, so there’s nothing to set up
        in here.
      </Body>
      <Todo>
        Settings › Bluetooth, and pair them. They have to connect as a headset, not playback only
        — otherwise Grove talks into your ear while the phone listens.
      </Todo>
      <Card style={{ marginTop: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name="glasses" size={19} color={palette.inkSoft} />
          <View style={{ flex: 1 }}>
            <Text style={[Type.cardTitle, { color: palette.ink }]}>
              {route.isExternal ? route.name : 'Nothing paired yet'}
            </Text>
            <Text style={[Type.bodySm, { color: palette.muted }]}>
              {good
                ? 'Headset — microphone works'
                : playbackOnly
                  ? 'Playback only — reconnect as a headset'
                  : 'Waiting for a headset'}
            </Text>
          </View>
          <Dot tone={good ? 'live' : playbackOnly ? 'alert' : 'off'} />
        </View>
      </Card>
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

  return (
    <>
      <Heading icon="ring" title="Press your ring" />
      <Body>
        It reaches Grove as a media remote — the same signal a headset’s play button sends.
      </Body>
      <Todo>Pair it in Settings, then press it a few times. Whatever it sends shows up below.</Todo>

      <Card style={{ marginTop: 12 }}>
        {signals.length === 0 ? (
          <Text style={[Type.bodySm, { color: palette.muted }]}>
            Nothing yet. If it stays empty, your ring isn’t sending media keys — check it starts
            and stops music from the lock screen.
          </Text>
        ) : (
          signals.slice(0, 5).map((signal, i) => (
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
              <Dot tone={signal.coalesced ? 'off' : 'live'} size={6} />
              <Text style={[Type.bodySm, { color: palette.ink, flex: 1 }]}>
                {signal.command}
                {signal.phase ? ` · ${signal.phase}` : ''}
              </Text>
              <Mono>{signal.coalesced ? 'merged' : 'used'}</Mono>
            </View>
          ))
        )}
      </Card>
    </>
  );
}

/** Said up front rather than discovered on a walk. */
function LimitStep() {
  return (
    <>
      <Heading icon="alert" title="One thing to know" />
      <Body>
        iOS won’t let any app be woken from fully closed by a button press. Grove has to be running
        for your ring to reach it.
      </Body>
      <Todo>
        Backgrounded is fine. Locked is fine. Pocketed is fine. Swiping Grove away turns the ring
        off until you open it again.
      </Todo>
    </>
  );
}
