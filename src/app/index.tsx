import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { ALWAYS_SHOW_ONBOARDING, hasSeenOnboarding } from '@/lib/firstRun';

/** The gate: nothing renders until we know whether there's a Noctus session. */
export default function Index() {
  const { status } = useSession();
  const palette = usePalette();

  // null while unknown. Resolving this inside the same spinner the session
  // already blocks on is what stops the login screen flashing up for a moment
  // before the intro replaces it.
  const [seenIntro, setSeenIntro] = useState<boolean | null>(null);

  useEffect(() => {
    void hasSeenOnboarding().then(setSeenIntro);
  }, []);

  if (status === 'loading' || seenIntro === null) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.paper }}>
        <ActivityIndicator color={palette.muted} />
      </View>
    );
  }

  // A live session means this app has been used before, so the intro is only
  // ever in the way — it belongs in front of people who haven't signed in.
  //
  // This deliberately outranks ALWAYS_SHOW_ONBOARDING. That flag used to come
  // first, so a machine with it set walked a signed-in user through the intro
  // on every launch and then dropped them at /login — which reads as being
  // signed out, and means doing Google again, several times a day. A dev
  // convenience must not be able to look like a broken session.
  if (status === 'signed-in') return <Redirect href="/(app)" />;
  if (ALWAYS_SHOW_ONBOARDING) return <Redirect href="/onboarding" />;
  return <Redirect href={seenIntro ? '/login' : '/onboarding'} />;
}
