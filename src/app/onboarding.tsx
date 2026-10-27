/**
 * First run.
 *
 * Nine short screens over the same moving field as the rest of the app, and
 * almost nothing to read. The first version was three slides of argument
 * before any setup — what it remembers, how you press, why it is private —
 * and nobody reads an argument on a phone they have just unboxed. So the
 * promise is one line, and everything after it is something you do: pair the
 * glasses, press the ring, name it, colour it, tell it about yourself.
 *
 * THE HARDWARE STEPS END IN A MOMENT
 *
 * Pairing happens in iOS Settings, where Grove cannot reach — there is no API
 * for an app to pair a Bluetooth headset, and Grove has no Bluetooth code at
 * all (see AGENTS.md). What it can do is notice. The glasses step watches the
 * audio route, and the moment a headset becomes it, the Bluetooth mark turns
 * green, a ring of light goes out, and the "done" chime plays through the very
 * glasses that just connected. The ring step does the same on the first press
 * it hears. That is the whole proof that setup worked, so it is made to feel
 * like it.
 *
 * The product photographs sit on a light disc in both themes. They are black
 * objects shot on white; on the field they would be a hole.
 *
 * WHAT YOU WRITE GOES INTO MEMORY
 *
 * Two boxes, one each: what is true about you, and what you are working on.
 * They go to rememberIntro as one passage with each half labelled, which
 * files the first as facts and the second as goals. Signing out leads back
 * here before signing in, when there is no account for them to belong to, so
 * the words are held (holdIntro) and read in once there is one.
 */

import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Image,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { Field, useField } from '@/components/field';
import { FIELD_COLOURS, fieldColour } from '@/components/field-shader';
import { Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { useSession } from '@/context/session';
import { capabilities } from '@/lib/capabilities';
import { rememberIntro } from '@/lib/consolidate';
import { holdIntro, markOnboardingSeen } from '@/lib/firstRun';
import { NAME_LIMIT } from '@/lib/persona';
import * as trigger from '@/lib/trigger';

const STEPS = ['welcome', 'what', 'glasses', 'ring', 'name', 'colour', 'you', 'work', 'ready'] as const;
type Step = (typeof STEPS)[number];

const GLYPH = require('../../assets/images/grove-glyph.png');
const GLASSES = require('../../assets/images/glasses.png');
const RING = require('../../assets/images/ring.png');

const WHITE = '#FFFFFF';
const SOFT = 'rgba(255,255,255,0.78)';
const FAINT = 'rgba(255,255,255,0.62)';
const LIVE = '#5EE08A';

/** Long enough for a paragraph about a life, short enough to stay one call. */
const INTRO_LIMIT = 1200;

/**
 * What goes in the boxes, shown by example and turning over every few
 * seconds.
 *
 * Several strangers' lives, not one, and never the author's: a single
 * example reads as the shape the answer must take, and an example naming the
 * person holding the phone reads as an app that already knows them. Ordinary,
 * happy, specific lives, so the point lands — names, places, plans — without
 * anyone feeling they have to have a marathon to mention.
 */
const ABOUT_EXAMPLES = [
  'I’m a nurse on night shifts in Halifax. I love cooking for friends, and I’m learning to surf.',
  'Second-year engineering student. I play bass in a band on weekends and I’m always halfway through a book.',
  'I run a small coffee shop with my partner. Two kids, one dog, and a garden that’s getting away from us.',
  'Designer in Toronto. I swim most mornings and I’m trying to cook more and order in less.',
  'Just moved to Vancouver for work. I hike on weekends and call my mum every Sunday.',
];
const WORK_EXAMPLES = [
  'Training for my first marathon in April, and saving for a trip to Japan.',
  'Launching my own design studio. Getting back to the gym three times a week.',
  'Finishing my thesis by June, and learning Spanish before a summer in Mexico.',
  'Opening a second shop. Reading one book a month this year.',
  'Going for team lead this year, and finally learning the piano.',
];

/**
 * Whether the person has asked the system to stop things moving. Read once:
 * nobody changes it halfway through a two-minute intro.
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
 * The "it worked" moment: the done chime and a success tap. Both are optional
 * on a build that lacks them, and both are required to be quiet about it.
 */
function celebrate(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const remote = require('grove-remote') as typeof import('grove-remote');
    remote.chime('done');
  } catch {
    // No native half: the light still goes out, which is most of it.
  }
  if (!capabilities().haptics) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const haptics = require('expo-haptics');
    void haptics.notificationAsync(haptics.NotificationFeedbackType.Success);
  } catch {
    // Silence is fine here.
  }
}

export default function Onboarding() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  const { status, uid } = useSession();
  const { state, persona, level, updatePersona, route } = useAgent();
  const field = useField(state, persona, level);

  const [index, setIndex] = useState(0);
  const [about, setAbout] = useState('');
  const [work, setWork] = useState('');
  const [ringHeard, setRingHeard] = useState(() => trigger.recentSignals().length > 0);
  const step: Step = STEPS[index];

  // Polled rather than subscribed: the trigger module keeps the last few
  // presses for exactly this, and the ring step is the only thing that asks.
  useEffect(() => {
    if (step !== 'ring' || ringHeard) return;
    const timer = setInterval(() => {
      if (trigger.recentSignals().length > 0) setRingHeard(true);
    }, 300);
    return () => clearInterval(timer);
  }, [step, ringHeard]);

  const glasses = route.isExternal;

  const finish = async () => {
    const intro = [
      about.trim() ? `About me: ${about.trim()}` : '',
      work.trim() ? `What I am working on, my goals: ${work.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    if (intro.length >= 12) {
      if (status === 'signed-in' && uid && uid !== 'anon') void rememberIntro(uid, intro).catch(() => undefined);
      else holdIntro(intro);
    }
    await markOnboardingSeen();
    router.replace(status === 'signed-in' ? '/(app)' : '/login');
  };

  const next = () => (index === STEPS.length - 1 ? void finish() : setIndex((n) => n + 1));

  return (
    <View style={{ flex: 1, backgroundColor: '#0B0C12' }}>
      <View style={{ position: 'absolute', top: 0, left: 0 }} pointerEvents="none">
        <Field uniforms={field.uniforms} palette={field.palette} width={width} fullHeight={height} />
      </View>
      {/* A little darker towards the bottom, where the words and buttons are. */}
      <Svg width={width} height={height} style={{ position: 'absolute' }} pointerEvents="none">
        <Defs>
          <LinearGradient id="grove-intro-scrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#08090D" stopOpacity={0.05} />
            <Stop offset="0.55" stopColor="#08090D" stopOpacity={0.28} />
            <Stop offset="1" stopColor="#08090D" stopOpacity={0.55} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={width} height={height} fill="url(#grove-intro-scrim)" />
      </Svg>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1, paddingTop: insets.top + 18, paddingHorizontal: 28 }}>
          <Dots count={STEPS.length} at={index} hidden={step === 'welcome'} />

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingVertical: 24 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Enter step={step}>
              {step === 'welcome' ? <Welcome /> : null}
              {step === 'what' ? <What /> : null}
              {step === 'glasses' ? <Glasses connected={glasses} /> : null}
              {step === 'ring' ? <Ring heard={ringHeard} /> : null}
              {step === 'name' ? (
                <NameStep
                  value={persona.name}
                  onChange={(name) => void updatePersona({ ...persona, name: name.slice(0, NAME_LIMIT) })}
                />
              ) : null}
              {step === 'colour' ? (
                <ColourStep value={persona.sky} onChange={(sky) => void updatePersona({ ...persona, sky })} />
              ) : null}
              {step === 'you' ? (
                <Writing title="Tell it about you." value={about} onChange={setAbout} examples={ABOUT_EXAMPLES} />
              ) : null}
              {step === 'work' ? (
                <Writing title="What are you working on?" value={work} onChange={setWork} examples={WORK_EXAMPLES} />
              ) : null}
              {step === 'ready' ? (
                <Ready name={persona.name.trim() || 'Grove'} glasses={glasses} ring={ringHeard} />
              ) : null}
            </Enter>
          </ScrollView>

          <View style={{ paddingBottom: Math.max(insets.bottom, 16), gap: 4 }}>
            {step === 'glasses' && !glasses ? (
              <GlassButton
                label="Open Bluetooth"
                onPress={() =>
                  // The Bluetooth page itself, where iOS still allows it; the
                  // Settings app otherwise. A private URL is fine on a personal
                  // build and is one of the things to revisit before the store.
                  void Linking.openURL('App-Prefs:Bluetooth').catch(() => Linking.openSettings())
                }
              />
            ) : (
              <GlassButton
                label={label(step, status === 'signed-in')}
                onPress={next}
                disabled={step === 'ring' && !ringHeard}
              />
            )}
            {step === 'glasses' || step === 'ring' ? <Quiet label="Later" onPress={next} /> : null}
            {step === 'you' || step === 'work' ? <Quiet label="Skip" onPress={next} /> : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function label(step: Step, signedIn: boolean): string {
  if (step === 'welcome') return 'Begin';
  if (step === 'what') return 'Set it up';
  if (step === 'ready') return signedIn ? 'Start talking' : 'Sign in';
  return 'Continue';
}

/* -------------------------------------------------------------- the frame */

/** One entrance per screen: a short rise and fade, replayed on each step. */
function Enter({ step, children }: { step: string; children: React.ReactNode }) {
  const still = useStillness();
  const enter = useSharedValue(still ? 1 : 0);
  useEffect(() => {
    enter.value = still ? 1 : 0;
    if (!still) enter.value = withTiming(1, { duration: 420, easing: Easing.out(Easing.cubic) });
  }, [step, still, enter]);
  const style = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 14 }],
  }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

function Dots({ count, at, hidden }: { count: number; at: number; hidden: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6, opacity: hidden ? 0 : 1, height: 6 }}>
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={{
            width: i === at ? 18 : 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: i === at ? WHITE : 'rgba(255,255,255,0.35)',
          }}
        />
      ))}
    </View>
  );
}

/** Glass, like every surface on the field. */
function GlassButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        minHeight: 54,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.16)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.28)',
        opacity: disabled ? 0.35 : 1,
      })}
    >
      <Text style={{ fontFamily: Type.cardTitle.fontFamily, fontSize: 16, color: WHITE }}>{label}</Text>
    </Pressable>
  );
}

function Quiet({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8} style={{ padding: 12, alignItems: 'center' }}>
      <Text style={[Type.bodySm, { fontSize: 14, color: SOFT }]}>{label}</Text>
    </Pressable>
  );
}

const big = { fontFamily: Type.state.fontFamily, fontSize: 34, lineHeight: 39, letterSpacing: -1.1, color: WHITE };
const mid = { fontFamily: Type.state.fontFamily, fontSize: 26, lineHeight: 31, letterSpacing: -0.8, color: WHITE };

/* ---------------------------------------------------------------- screens */

function Welcome() {
  return (
    <View style={{ alignItems: 'center', gap: 14 }}>
      <Image source={GLYPH} style={{ width: 92, height: 118 }} resizeMode="contain" accessibilityLabel="Grove" />
      <Text style={{ fontFamily: Type.state.fontFamily, fontSize: 44, letterSpacing: -1.6, color: WHITE, marginTop: 4 }}>
        Grove
      </Text>
      <Text style={[Type.body, { fontSize: 15.5, lineHeight: 23, color: SOFT, textAlign: 'center', maxWidth: 280 }]}>
        A voice in your glasses that remembers your life.
      </Text>
    </View>
  );
}

function What() {
  return <Text style={big}>{'Press your ring.\nSay it.\nGrove remembers.'}</Text>;
}

function Glasses({ connected }: { connected: boolean }) {
  return (
    <Pairing
      source={GLASSES}
      imageWidth={158}
      imageHeight={50}
      done={connected}
      title={connected ? 'Connected.' : 'Connect your glasses.'}
      hint="Pair Grove Glass in Bluetooth."
    />
  );
}

function Ring({ heard }: { heard: boolean }) {
  return (
    <Pairing
      source={RING}
      imageWidth={104}
      imageHeight={108}
      done={heard}
      title={heard ? 'Got it.' : 'Press your ring.'}
      hint="Pair J09, then press once."
    />
  );
}

/**
 * A product on a light disc, rings going out from it while Grove waits, and
 * the moment it connects: the rings stop, one bright ring flashes out, the
 * Bluetooth mark turns green, and it chimes.
 *
 * The chime only plays on the change, not on arriving at a step that is
 * already done — walking back to a connected pair of glasses is not news.
 */
function Pairing({
  source,
  imageWidth,
  imageHeight,
  done,
  title,
  hint,
}: {
  source: number;
  imageWidth: number;
  imageHeight: number;
  done: boolean;
  title: string;
  hint: string;
}) {
  const still = useStillness();
  const was = useRef(done);
  const flash = useSharedValue(0);
  const pop = useSharedValue(done ? 1 : 0);

  useEffect(() => {
    if (done && !was.current) {
      celebrate();
      flash.value = 0;
      flash.value = withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) });
    }
    pop.value = still ? (done ? 1 : 0) : withSpring(done ? 1 : 0, { damping: 11, stiffness: 160 });
    was.current = done;
  }, [done, still, flash, pop]);

  const flashStyle = useAnimatedStyle(() => ({
    opacity: flash.value === 0 ? 0 : 1 - flash.value,
    transform: [{ scale: 0.9 + flash.value * 0.8 }],
  }));
  const discStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 + pop.value * 0.04 }] }));

  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: 236, height: 236, alignItems: 'center', justifyContent: 'center' }}>
        {!done && !still ? [0, 800, 1600].map((delay) => <Pulse key={delay} delay={delay} />) : null}
        <Animated.View
          pointerEvents="none"
          style={[
            flashStyle,
            { position: 'absolute', width: 196, height: 196, borderRadius: 98, borderWidth: 2, borderColor: WHITE },
          ]}
        />
        <Animated.View
          style={[
            discStyle,
            {
              width: 196,
              height: 196,
              borderRadius: 98,
              backgroundColor: '#EEF0F3',
              alignItems: 'center',
              justifyContent: 'center',
              shadowColor: '#000',
              shadowOpacity: 0.35,
              shadowRadius: 30,
              shadowOffset: { width: 0, height: 20 },
            },
          ]}
        >
          <Image source={source} style={{ width: imageWidth, height: imageHeight }} resizeMode="contain" accessible={false} />
        </Animated.View>
      </View>

      <Bluetooth on={done} />
      <Text style={[mid, { textAlign: 'center', marginTop: 14 }]}>{title}</Text>
      {done ? null : <Text style={[Type.bodySm, { fontSize: 13, color: FAINT, marginTop: 6 }]}>{hint}</Text>}
    </View>
  );
}

function Pulse({ delay }: { delay: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: 2400, easing: Easing.out(Easing.quad) }), -1));
    return () => cancelAnimation(t);
  }, [delay, t]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.7 * (1 - t.value),
    transform: [{ scale: 0.85 + t.value * 0.5 }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[style, { position: 'absolute', width: 196, height: 196, borderRadius: 98, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)' }]}
    />
  );
}

/** White while waiting, green once it is real. */
function Bluetooth({ on }: { on: boolean }) {
  const glow = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    glow.value = withSequence(withTiming(on ? 1 : 0, { duration: 400 }));
  }, [on, glow]);
  const halo = useAnimatedStyle(() => ({ opacity: glow.value, transform: [{ scale: 1 + glow.value * 0.45 }] }));
  return (
    <View style={{ width: 34, height: 34, marginTop: 6, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={[halo, { position: 'absolute', width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(94,224,138,0.18)' }]}
      />
      <View
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: 1.5,
          borderColor: on ? LIVE : 'rgba(255,255,255,0.85)',
          backgroundColor: on ? LIVE : 'transparent',
        }}
      >
        <Svg width={16} height={16} viewBox="0 0 24 24">
          <Path
            d="M7 7l10 10-5 4V3l5 4L7 17"
            stroke={on ? '#0B2A16' : WHITE}
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </Svg>
      </View>
    </View>
  );
}

function NameStep({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return (
    <View style={{ alignItems: 'center' }}>
      <Text style={mid}>Name it.</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder="Grove"
        placeholderTextColor={FAINT}
        autoCapitalize="words"
        accessibilityLabel="Its name"
        style={{
          marginTop: 22,
          width: '100%',
          textAlign: 'center',
          fontFamily: Type.state.fontFamily,
          fontSize: 40,
          letterSpacing: -1.2,
          color: WHITE,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: 'rgba(255,255,255,0.4)',
        }}
      />
    </View>
  );
}

function ColourStep({ value, onChange }: { value: string | undefined; onChange: (key: string) => void }) {
  const chosen = fieldColour(value).key;
  return (
    <View style={{ gap: 18 }}>
      <Text style={mid}>Pick its colours.</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {FIELD_COLOURS.map((option) => {
          const picked = option.key === chosen;
          return (
            <Pressable
              key={option.key}
              accessibilityRole="radio"
              accessibilityState={{ selected: picked }}
              accessibilityLabel={`${option.label}. ${option.blurb}`}
              onPress={() => onChange(option.key)}
              style={({ pressed }) => ({
                width: '47.8%',
                padding: 10,
                gap: 9,
                borderRadius: 18,
                backgroundColor: picked ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.07)',
                borderWidth: 1,
                borderColor: picked ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.18)',
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <View style={{ height: 54, borderRadius: 12, overflow: 'hidden' }}>
                <Svg width="100%" height="100%">
                  <Defs>
                    <LinearGradient id={`grove-intro-${option.key}`} x1="0" y1="0.2" x2="1" y2="0.8">
                      {[option.c[0], option.c[1], option.c[3], option.c[2]].map((stop, i) => (
                        <Stop key={stop} offset={i / 3} stopColor={stop} />
                      ))}
                    </LinearGradient>
                  </Defs>
                  <Rect x="0" y="0" width="100%" height="100%" fill={`url(#grove-intro-${option.key})`} />
                </Svg>
              </View>
              <Text style={{ fontFamily: Type.cardTitle.fontFamily, fontSize: 15, color: WHITE }}>{option.label}</Text>
              <Text style={[Type.bodySm, { color: SOFT }]}>{option.blurb}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Writing({
  title,
  value,
  onChange,
  examples,
}: {
  title: string;
  value: string;
  onChange: (text: string) => void;
  examples: string[];
}) {
  // Turns over only while the box is empty; once someone is typing, the
  // example has done its job.
  const [shown, setShown] = useState(() => Math.floor(Math.random() * examples.length));
  useEffect(() => {
    if (value) return;
    const timer = setInterval(() => setShown((n) => (n + 1) % examples.length), 3800);
    return () => clearInterval(timer);
  }, [value, examples.length]);
  const placeholder = examples[shown];

  return (
    <View style={{ gap: 16 }}>
      <Text style={mid}>{title}</Text>
      <TextInput
        value={value}
        onChangeText={(text) => onChange(text.slice(0, INTRO_LIMIT))}
        placeholder={placeholder}
        placeholderTextColor="rgba(255,255,255,0.55)"
        multiline
        textAlignVertical="top"
        accessibilityLabel={title}
        style={{
          minHeight: 170,
          borderRadius: 18,
          paddingHorizontal: 16,
          paddingTop: 14,
          paddingBottom: 14,
          backgroundColor: 'rgba(8,10,16,0.42)',
          borderWidth: 1,
          borderColor: 'rgba(255,255,255,0.16)',
          fontFamily: Type.body.fontFamily,
          fontSize: 15.5,
          lineHeight: 23,
          color: WHITE,
        }}
      />
    </View>
  );
}

function Ready({ name, glasses, ring }: { name: string; glasses: boolean; ring: boolean }) {
  return (
    <View style={{ alignItems: 'center', gap: 16 }}>
      <Text style={[big, { textAlign: 'center' }]}>{`${name} is ready.`}</Text>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Chip on={glasses} label={glasses ? 'Grove Glass' : 'No glasses yet'} />
        <Chip on={ring} label={ring ? 'J09' : 'No ring yet'} />
      </View>
      <Text style={[Type.bodySm, { fontSize: 13, color: FAINT, textAlign: 'center', maxWidth: 260 }]}>
        Keep it open in the background. Swiping it away turns the ring off.
      </Text>
    </View>
  );
}

function Chip({ on, label }: { on: boolean; label: string }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 999,
        backgroundColor: 'rgba(255,255,255,0.10)',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.18)',
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: on ? LIVE : 'rgba(255,255,255,0.4)' }} />
      <Text style={[Type.bodySm, { color: WHITE }]}>{label}</Text>
    </View>
  );
}
