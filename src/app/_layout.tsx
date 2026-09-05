import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Colors } from '@/constants/theme';
import { AgentProvider } from '@/context/agent';
import { SessionProvider } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded, fontError]);

  // A missing font shouldn't be a blank app — fall through to system faces.
  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, backgroundColor: Colors.light.paper }} />;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/*
          The agent lives inside the session because it reads the signed-in
          account's tools, and arms the ring only once there is one — a Grove
          holding the audio session on the sign-in screen would be claiming the
          lock-screen transport controls before it could do anything with them.
        */}
        <SessionProvider>
          <AgentProvider>
            <Chrome />
          </AgentProvider>
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Chrome() {
  const palette = usePalette();
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: palette.paper },
          animation: 'fade',
        }}
      >
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="login" />
        <Stack.Screen name="(app)" />
      </Stack>
    </>
  );
}
