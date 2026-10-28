/**
 * Settings › Your Mac: pairing, and whether it is there.
 *
 * Pairing is typed once — the Mac's name and the six digits its menu bar icon
 * shows under "Pair an iPhone…" — and never again: the Mac answers with a
 * token kept in the Keychain (mac.ts). After that this only says whether the
 * laptop is reachable, because "is it connected" is the whole question.
 */

import { useState, useSyncExternalStore } from 'react';
import { Text, TextInput, View } from 'react-native';

import { Button, Card, Dot, Row } from '@/components/ui';
import { Type } from '@/constants/theme';
import { usePalette } from '@/hooks/use-palette';
import { forgetMac, macStatus, pairMac, subscribeMac } from '@/lib/mac';

export function MacPanel() {
  const palette = usePalette();
  const mac = useSyncExternalStore(subscribeMac, macStatus, macStatus);
  const [host, setHost] = useState(mac.host ?? '');
  const [code, setCode] = useState('');

  const paired = mac.state === 'connected' || mac.state === 'away' || (mac.state === 'connecting' && !!mac.mac);

  if (paired) {
    return (
      <Card style={{ paddingVertical: 2 }}>
        <Row
          label={mac.mac ?? 'Your Mac'}
          hint={
            mac.state === 'connected'
              ? 'Connected. It takes jobs from here, and asks this phone what to do with ⌘K.'
              : mac.state === 'connecting'
                ? 'Connecting…'
                : 'Not reachable. It needs to be awake and on the same Wi-Fi.'
          }
          tone={mac.state === 'connected' ? 'live' : 'off'}
        />
        <Row label="Forget this Mac" onPress={() => void forgetMac()} />
      </Card>
    );
  }

  const field = {
    fontFamily: Type.body.fontFamily,
    fontSize: 15,
    color: palette.ink,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  } as const;

  return (
    <Card style={{ gap: 4 }}>
      <Text style={[Type.bodySm, { color: palette.muted }]}>
        On the Mac, open the Grove menu in the menu bar and choose Pair an iPhone. Enter what it shows.
      </Text>
      <TextInput
        value={host}
        onChangeText={setHost}
        placeholder="Your Mac’s name, like vishnus-macbook-air.local"
        placeholderTextColor={palette.muted}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Your Mac's name"
        style={field}
      />
      <TextInput
        value={code}
        onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))}
        placeholder="Six-digit code"
        placeholderTextColor={palette.muted}
        keyboardType="number-pad"
        accessibilityLabel="Pairing code"
        style={field}
      />
      {mac.note ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <Dot tone="alert" />
          <Text style={[Type.bodySm, { color: palette.inkSoft, flex: 1 }]}>{mac.note}</Text>
        </View>
      ) : null}
      <Button
        label={mac.state === 'connecting' ? 'Connecting…' : 'Pair'}
        busy={mac.state === 'connecting'}
        disabled={!host.trim() || code.length !== 6}
        onPress={() => pairMac(host, code)}
        style={{ marginTop: 12 }}
      />
    </Card>
  );
}
