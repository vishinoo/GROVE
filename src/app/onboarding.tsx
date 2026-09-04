/**
 * The intro.
 *
 * Grove is a companion to hardware, and the hardware needs two things done in
 * iOS Settings that this app cannot do for you: pair the glasses as an audio
 * device, and pair the ring as a media remote. Someone who skips those has an
 * app that appears to work and a pair of glasses that does nothing, so the
 * intro is a setup checklist rather than a feature tour.
 *
 * It is honest about the one hard limit too. Telling someone up front that
 * Grove has to stay running for the ring to reach it is far better than
 * letting them discover it the first time they force-quit the app and their
 * ring goes dead.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GroveMark } from '@/components/grove-mark';
import { Icon, type IconName } from '@/components/icon';
import { Button } from '@/components/ui';
import { Radius, Space, Type } from '@/constants/theme';
import { usePalette } from '@/hooks/use-palette';
import { markOnboardingSeen } from '@/lib/firstRun';

type Step = {
  icon: IconName;
  title: string;
  body: string;
  /** Shown as a numbered instruction the user has to actually carry out. */
  todo?: string;
};

const STEPS: Step[] = [
  {
    icon: 'glasses',
    title: 'Pair your glasses',
    body:
      'Grove speaks and listens through whatever audio device iOS is using. Your glasses are an ordinary Bluetooth headset as far as the phone is concerned, so there is nothing to set up in here.',
    todo: 'Open iOS Settings → Bluetooth and pair them. Make sure they connect as a headset, not just for playback — otherwise Grove will talk into your ear and listen through the phone.',
  },
  {
    icon: 'ring',
    title: 'Pair your ring',
    body:
      'The ring reaches Grove as a media remote — the same signal a headset’s play button sends. Grove holds the audio session so those presses arrive even with the screen locked and the phone in your pocket.',
    todo: 'Pair the ring in iOS Settings, then check it starts and stops music from the lock screen. If it does, it will reach Grove. Settings → Hardware shows exactly what it sends.',
  },
  {
    icon: 'tools',
    title: 'Give it something to do',
    body:
      'Grove answers on its own, and reaches for a tool when a job needs one — your calendar, your mail, whatever you have on Noctus. Add the tools you want in the Tools tab and connect what they need.',
  },
  {
    icon: 'alert',
    title: 'One thing to know',
    body:
      'iOS won’t let any app be woken from fully closed by a button press. Grove has to be running — in the background is fine, locked is fine, pocket is fine — for your ring to reach it. Force-quitting Grove turns the ring off until you open it again.',
  },
];

export default function Onboarding() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [step, setStep] = useState(0);

  const last = step === STEPS.length - 1;
  const current = STEPS[step];

  const advance = async () => {
    if (!last) {
      setStep((n) => n + 1);
      return;
    }
    await markOnboardingSeen();
    router.replace('/login');
  };

  const skip = async () => {
    await markOnboardingSeen();
    router.replace('/login');
  };

  return (
    <View style={{ flex: 1, backgroundColor: palette.paper }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + 24,
          paddingHorizontal: Space.screenX + 4,
          paddingBottom: 20,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <GroveMark size={34} color={palette.mark} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Skip the intro"
            onPress={() => void skip()}
            style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={[Type.bodySm, { color: palette.muted }]}>Skip</Text>
          </Pressable>
        </View>

        <View style={{ flex: 1, justifyContent: 'center', paddingVertical: 40 }}>
          <View
            style={{
              width: 54,
              height: 54,
              borderRadius: Radius.control,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: palette.mark,
              marginBottom: 22,
            }}
          >
            <Icon name={current.icon} size={26} color={palette.paper} />
          </View>

          <Text style={[Type.screenTitle, { color: palette.ink, marginBottom: 12 }]}>
            {current.title}
          </Text>

          <Text style={[Type.caption, { color: palette.inkSoft }]}>{current.body}</Text>

          {current.todo ? (
            <View
              style={{
                marginTop: 18,
                padding: 14,
                borderRadius: Radius.card,
                backgroundColor: palette.raised,
                borderWidth: 1,
                borderColor: palette.line,
              }}
            >
              <Text style={[Type.bodySm, { color: palette.ink }]}>{current.todo}</Text>
            </View>
          ) : null}
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
          {STEPS.map((_, index) => (
            <View
              key={index}
              style={{
                width: index === step ? 22 : 6,
                height: 6,
                borderRadius: 3,
                backgroundColor: index === step ? palette.mark : palette.lineStrong,
              }}
            />
          ))}
        </View>

        <Button label={last ? 'Sign in with Noctus' : 'Next'} onPress={() => void advance()} />
      </View>
    </View>
  );
}
