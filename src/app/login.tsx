/**
 * There is no Grove account. You log in with Noctus, and your tools and
 * integrations come with you.
 *
 * The rescue field halfway down is not clutter. Noctus's OAuth callback lands
 * on Noctus's own web pages rather than back in the app, so on a misconfigured
 * Supabase redirect the browser closes on a page that is holding a perfectly
 * good session in its URL. Pasting that address recovers it, which turns the
 * single most common setup failure from a dead end into an inconvenience.
 */

import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GroveMark } from '@/components/grove-mark';
import { Icon } from '@/components/icon';
import { Button, Mono, Notice } from '@/components/ui';
import { Fonts, Radius, Space, Type, monoLabel } from '@/constants/theme';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { getNoctusUrl, setNoctusUrl } from '@/lib/noctusApi';
import { DEV_LOGIN_ENABLED, isSupabaseConfigured, redirectTo } from '@/lib/noctusAuth';

type Busy = null | 'noctus' | 'email' | 'dev' | 'rescue';

export default function Login() {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { status, signIn, signInWithEmail, finishSignIn, signInAsDev, notice } = useSession();

  const [busy, setBusy] = useState<Busy>(null);
  const [email, setEmail] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backend, setBackend] = useState('');
  const [rescue, setRescue] = useState('');
  const [showRescue, setShowRescue] = useState(false);

  useEffect(() => {
    void getNoctusUrl().then(setBackend);
  }, []);

  if (status === 'signed-in') return <Redirect href="/(app)" />;

  const configured = isSupabaseConfigured();

  async function run(kind: NonNullable<Busy>, fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      if (kind === 'email') {
        setEmailSent(true);
        // The emailed link lands on Noctus's site too, so offer the same rescue.
        setShowRescue(true);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed.');
      // A bounced redirect is recoverable — the tokens are on the page the
      // browser ended up on, so surface the field that accepts them.
      if (e instanceof Error && e.name === 'SignInIncomplete') setShowRescue(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: palette.paper }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 56,
          paddingHorizontal: Space.screenX + 4,
          paddingBottom: insets.bottom + 40,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: 'center', marginBottom: 34 }}>
          <GroveMark size={84} color={palette.mark} />
          <Text style={[Type.screenTitle, { color: palette.ink, marginTop: 18 }]}>Grove</Text>
          <Text
            style={[
              Type.body,
              { color: palette.inkSoft, textAlign: 'center', marginTop: 8, maxWidth: 300 },
            ]}
          >
            The voice in your glasses. Sign in with Noctus and your tools come with you.
          </Text>
        </View>

        {!configured ? (
          <Notice
            text="Supabase isn't configured in this build, so sign-in can't complete. Set EXPO_PUBLIC_NOCTUS_SUPABASE_URL and the anon key in .env."
            tone="info"
          />
        ) : null}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log in with Noctus"
          disabled={!configured || busy !== null}
          onPress={() => run('noctus', signIn)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            minHeight: 52,
            borderRadius: Radius.control,
            backgroundColor: palette.mark,
            opacity: !configured || busy ? 0.5 : pressed ? 0.85 : 1,
          })}
        >
          {busy === 'noctus' ? (
            <ActivityIndicator size="small" color={palette.paper} />
          ) : (
            <Icon name="noctus" size={16} color={palette.paper} />
          )}
          <Text style={{ fontFamily: Fonts.bodySemi, fontSize: 15.5, color: palette.paper }}>
            Log in with Noctus
          </Text>
        </Pressable>

        <Mono style={{ textAlign: 'center', marginTop: 24, marginBottom: 12 }}>
          Or use your email
        </Mono>

        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput
            style={{
              flex: 1,
              backgroundColor: palette.raised,
              borderRadius: Radius.control,
              borderWidth: 1,
              borderColor: palette.line,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontFamily: Fonts.body,
              fontSize: 14.5,
              color: palette.ink,
            }}
            placeholder="you@example.com"
            placeholderTextColor={palette.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            value={email}
            onChangeText={(t) => {
              setEmail(t);
              setEmailSent(false);
            }}
            editable={configured && busy === null}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send sign-in link"
            disabled={!configured || busy !== null || !email.includes('@')}
            onPress={() => run('email', () => signInWithEmail(email))}
            style={({ pressed }) => ({
              width: 52,
              borderRadius: Radius.control,
              backgroundColor: palette.mark,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: !configured || !email.includes('@') || busy ? 0.4 : pressed ? 0.8 : 1,
            })}
          >
            {busy === 'email' ? (
              <ActivityIndicator size="small" color={palette.paper} />
            ) : (
              <Icon name="send" size={16} color={palette.paper} />
            )}
          </Pressable>
        </View>

        {emailSent ? (
          <Text style={[Type.bodySm, { color: palette.inkSoft, marginTop: 12 }]}>
            Link sent. Open it on this device and it&apos;ll bring you straight back here.
          </Text>
        ) : null}

        {showRescue ? (
          <View style={{ marginTop: 22, gap: 8 }}>
            <Mono>Finish sign-in</Mono>
            <Text style={[Type.bodySm, { color: palette.inkSoft }]}>
              Paste the whole address from the page Noctus sent you to — it carries your session
              even though it opened the website.
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TextInput
                style={{
                  flex: 1,
                  backgroundColor: palette.raised,
                  borderRadius: Radius.control,
                  borderWidth: 1,
                  borderColor: palette.line,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  fontFamily: Fonts.mono,
                  fontSize: 11,
                  color: palette.ink,
                }}
                placeholder="https://noctusai.org/#access_token=…"
                placeholderTextColor={palette.muted}
                autoCapitalize="none"
                autoCorrect={false}
                value={rescue}
                onChangeText={setRescue}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Finish sign-in"
                disabled={busy !== null || rescue.trim().length === 0}
                onPress={() => run('rescue', () => finishSignIn(rescue, email))}
                style={({ pressed }) => ({
                  width: 52,
                  borderRadius: Radius.control,
                  backgroundColor: palette.mark,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: busy || rescue.trim().length === 0 ? 0.4 : pressed ? 0.8 : 1,
                })}
              >
                {busy === 'rescue' ? (
                  <ActivityIndicator size="small" color={palette.paper} />
                ) : (
                  <Icon name="send" size={16} color={palette.paper} />
                )}
              </Pressable>
            </View>
          </View>
        ) : null}

        {error || notice ? (
          <Text style={[Type.bodySm, { color: palette.alert, marginTop: 16 }]}>
            {error ?? notice}
          </Text>
        ) : null}

        {DEV_LOGIN_ENABLED ? (
          <View style={{ marginTop: 30, gap: 14 }}>
            <Button
              label="Continue as dev"
              icon="person"
              tone="quiet"
              busy={busy === 'dev'}
              disabled={busy !== null}
              onPress={() => run('dev', signInAsDev)}
            />

            {/*
              OAuth only completes if Noctus's Supabase project allows this
              exact redirect, and it changes with the LAN IP under Expo Go —
              so show it rather than make someone derive it.
            */}
            <Text
              selectable
              style={[
                monoLabel,
                {
                  fontSize: 10,
                  color: palette.muted,
                  textAlign: 'center',
                  lineHeight: 16,
                  textTransform: 'none',
                },
              ]}
            >
              Allow this redirect in Supabase:{'\n'}
              {redirectTo}
            </Text>

            {/*
              Which Noctus this build talks to, editable on the device. Without
              it, pointing a phone at a laptop running Noctus locally means
              editing .env and restarting Metro for every switch.
            */}
            <View style={{ gap: 6 }}>
              <Mono style={{ textAlign: 'center' }}>Noctus backend</Mono>
              <TextInput
                style={{
                  backgroundColor: palette.raised,
                  borderRadius: Radius.control,
                  borderWidth: 1,
                  borderColor: palette.line,
                  paddingHorizontal: 16,
                  paddingVertical: 11,
                  fontFamily: Fonts.mono,
                  fontSize: 11,
                  color: palette.ink,
                  textAlign: 'center',
                }}
                value={backend}
                onChangeText={setBackend}
                onEndEditing={() => {
                  const next = backend.trim();
                  if (!next) return;
                  // setNoctusUrl rejects a non-URL or cleartext host rather
                  // than storing somewhere the auth token would then be sent.
                  setNoctusUrl(next).catch((e: unknown) => {
                    setError(e instanceof Error ? e.message : 'That Noctus URL was not accepted.');
                    void getNoctusUrl().then(setBackend);
                  });
                }}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="http://192.168.0.10:4000"
                placeholderTextColor={palette.muted}
              />
            </View>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
