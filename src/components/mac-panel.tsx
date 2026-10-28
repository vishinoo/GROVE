/**
 * Settings › Your Mac.
 *
 * The phone and the Mac meet through the person's Noctus account, so this is
 * one button — sign in with Google through Noctus — and then a line saying
 * whether the laptop is there. The Mac signs in from its own menu bar icon
 * with the same account, and they find each other (mac.ts).
 */

import { useState, useSyncExternalStore } from 'react';
import { Text, TextInput, View } from 'react-native';

import { Button, Card, Dot, Row } from '@/components/ui';
import { Type } from '@/constants/theme';
import { usePalette } from '@/hooks/use-palette';
import { macStatus, pairWithCode, signInForMac, stopMac, subscribeMac } from '@/lib/mac';

export function MacPanel() {
  const palette = usePalette();
  const mac = useSyncExternalStore(subscribeMac, macStatus, macStatus);
  const [code, setCode] = useState('');

  if (mac.state === 'signed-out') {
    return (
      <Card style={{ gap: 10 }}>
        <Text style={[Type.bodySm, { color: palette.inkSoft }]}>
          On your Mac, open the Grove menu and choose Connect iPhone. Type the code it shows.
        </Text>
        <TextInput
          value={code}
          onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))}
          placeholder="Six-digit code"
          placeholderTextColor={palette.muted}
          keyboardType="number-pad"
          accessibilityLabel="Code from your Mac"
          style={{
            fontFamily: Type.body.fontFamily,
            fontSize: 22,
            letterSpacing: 6,
            color: palette.ink,
            paddingVertical: 10,
            borderBottomWidth: 1,
            borderBottomColor: palette.line,
          }}
        />
        {mac.note ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <Dot tone="alert" />
            <Text style={[Type.bodySm, { color: palette.inkSoft, flex: 1 }]} selectable>
              {mac.note}
            </Text>
          </View>
        ) : null}
        <Button label="Connect" disabled={code.length !== 6} onPress={() => void pairWithCode(code)} />
        <Button label="Or sign in with Google (Noctus)" tone="quiet" onPress={() => void signInForMac()} />
      </Card>
    );
  }

  return (
    <Card style={{ paddingVertical: 2 }}>
      <Row
        label={mac.mac ?? 'Your Mac'}
        hint={
          mac.state === 'connected'
            ? 'Connected. It takes jobs from here, and asks this phone what to do with ⌘K.'
            : mac.state === 'refused'
              ? mac.note
              : `Signed in${mac.email ? ` as ${mac.email}` : ''}. Waiting for the Mac — open Grove on it and sign in there too.`
        }
        tone={mac.state === 'connected' ? 'live' : mac.state === 'refused' ? 'alert' : 'off'}
      />
      <Row label="Disconnect" onPress={() => void stopMac()} />
    </Card>
  );
}
