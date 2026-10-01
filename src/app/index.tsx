import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { ALWAYS_SHOW_ONBOARDING, hasSeenOnboarding } from '@/lib/firstRun';
import { catchUpToLatest } from '@/lib/updates';

/** The gate: nothing renders until we know whether there's a Noctus session. */
export default function Index() {
  const { status } = useSession();
  const palette = usePalette();

  // null while unknown. Resolving this inside the same spinner the session
  // already blocks on is what stops the login screen flashing up for a moment
  // before the intro replaces it.
  const [seenIntro, setSeenIntro] = useState<boolean | null>(null);

  /**
   * Whether the newest bundle has had its chance to arrive.
   *
   * This gate is the only moment a reload costs nothing — nothing is listening,
   * nothing is speaking, nothing is waiting on a press. See updates.ts for why
   * it is never offered later, and why it is bounded.
   */
  const [caughtUp, setCaughtUp] = useState(false);

  useEffect(() => {
    void hasSeenOnboarding().then(setSeenIntro);
    // On 'reloading' this component is about to be thrown away, so letting the
    // gate through would flash a screen from the old bundle on the way out.
    void catchUpToLatest().then((outcome) => {
      if (outcome !== 'reloading') setCaughtUp(true);
    });
  }, []);

  if (status === 'loading' || seenIntro === null || !caughtUp) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.paper }}>
        <ActivityIndicator color={palette.muted} />
      </View>
    );
  }

  // Whether the intro has been seen decides this, and nothing else does.
  //
  // It used to be the session: a live one meant the app had been used before,
  // so the intro was assumed to be in the way. That held while Noctus was
  // mandatory and stopped holding the moment Grove went standalone — with no
  // backend configured the session context reports 'signed-in' on the very
  // first launch, by design, because there is no account to sign in to. So this
  // branch sent every new install straight past the intro, and onboarding had
  // been unreachable in a release build ever since: no name, no hardware
  // checklist, nobody told that a force-quit turns the ring off.
  //
  // The dev flag still comes second, so a stray EXPO_PUBLIC_ALWAYS_ONBOARD
  // cannot strand a shipped build on the intro.
  if (!seenIntro) return <Redirect href="/onboarding" />;
  if (ALWAYS_SHOW_ONBOARDING) return <Redirect href="/onboarding" />;
  return <Redirect href={status === 'signed-in' ? '/(app)' : '/login'} />;
}
