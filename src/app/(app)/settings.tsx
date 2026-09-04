/**
 * Settings.
 *
 * Three jobs, in the order they matter: how Grove talks, whether the hardware
 * is working, and who you're signed in as.
 *
 * The diagnostics panel is not developer furniture — it is a product feature
 * for hardware nobody has documentation for. Cheap glasses and cheap rings do
 * not come with a spec sheet, and the only reliable way to find out what a
 * given ring emits is to press it and look. That panel is that.
 */

import { useCallback, useEffect, useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';

import { Icon } from '@/components/icon';
import { Button, Card, Dot, Mono, Notice, Row, Screen, Section } from '@/components/ui';
import { Radius, Type, monoLabel } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { capabilities, reducedModeReason } from '@/lib/capabilities';
import { MANNER_LIMIT, PRESETS, type Persona } from '@/lib/persona';
import { speak } from '@/lib/speak';
import * as trigger from '@/lib/trigger';

export default function Settings() {
  const palette = usePalette();
  const { user, signOut } = useSession();
  const { persona, updatePersona, armed, route, activity, clearActivity } = useAgent();

  const reduced = reducedModeReason();
  const report = capabilities();

  const set = useCallback(
    (patch: Partial<Persona>) => void updatePersona({ ...persona, ...patch }),
    [persona, updatePersona]
  );

  return (
    <Screen title="Settings">
      {reduced ? <Notice text={reduced} tone="info" /> : null}

      {/* ------------------------------------------------------------ voice */}

      <Section label="How Grove talks">
        <Card>
          <Text style={[Type.bodySm, { color: palette.muted, marginBottom: 10 }]}>
            Tell Grove how to speak, in your own words. This shapes tone and length only — it
            never changes what Grove reports as true.
          </Text>

          <TextInput
            value={persona.manner}
            onChangeText={(manner) => set({ manner: manner.slice(0, MANNER_LIMIT) })}
            placeholder="Be energetic. Keep it under two sentences."
            placeholderTextColor={palette.muted}
            multiline
            style={{
              minHeight: 88,
              padding: 12,
              borderRadius: Radius.well,
              backgroundColor: palette.sunken,
              borderWidth: 1,
              borderColor: palette.line,
              fontFamily: Type.body.fontFamily,
              fontSize: 14,
              lineHeight: 20,
              color: palette.ink,
            }}
          />

          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 8,
            }}
          >
            <Mono>
              {persona.manner.length}/{MANNER_LIMIT}
            </Mono>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hear how that sounds"
              onPress={() =>
                speak(
                  'This is how I sound. Press your ring whenever you want me.',
                  persona.delivery
                )
              }
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                opacity: pressed ? 0.5 : 1,
              })}
            >
              <Icon name="talk" size={15} color={palette.ink} />
              <Text style={[Type.bodySm, { color: palette.ink }]}>Hear it</Text>
            </Pressable>
          </View>
        </Card>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10 }}>
          {PRESETS.map((preset) => {
            const active = persona.manner.trim() === preset.manner;
            return (
              <Pressable
                key={preset.key}
                accessibilityRole="button"
                accessibilityLabel={`${preset.label}: ${preset.blurb}`}
                accessibilityState={{ selected: active }}
                onPress={() => set({ manner: preset.manner, delivery: preset.delivery })}
                style={({ pressed }) => ({
                  paddingVertical: 8,
                  paddingHorizontal: 13,
                  borderRadius: Radius.pill,
                  backgroundColor: active ? palette.mark : palette.raised,
                  borderWidth: 1,
                  borderColor: active ? palette.mark : palette.line,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text
                  style={{
                    fontFamily: Type.cardTitle.fontFamily,
                    fontSize: 13,
                    color: active ? palette.paper : palette.ink,
                  }}
                >
                  {preset.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Section>

      {/* --------------------------------------------------------- delivery */}

      <Section label="Delivery">
        <Card>
          <Stepper
            label="Speed"
            value={persona.delivery.rate}
            min={0.6}
            max={1.5}
            step={0.05}
            onChange={(rate) => set({ delivery: { ...persona.delivery, rate } })}
          />
          <View style={{ height: 1, backgroundColor: palette.line, marginVertical: 12 }} />
          <Stepper
            label="Pitch"
            value={persona.delivery.pitch}
            min={0.7}
            max={1.4}
            step={0.05}
            onChange={(pitch) => set({ delivery: { ...persona.delivery, pitch } })}
          />
        </Card>
        <Text style={[Type.bodySm, { color: palette.muted, marginTop: 9 }]}>
          Choosing a different voice is coming — this build uses the system voice.
        </Text>
      </Section>

      {/* -------------------------------------------------------- listening */}

      <Section label="Listening">
        <Card style={{ paddingVertical: 2 }}>
          <Row
            label="Keep speech on this device"
            hint={
              persona.preferOnDevice
                ? 'Nothing you say is sent to Apple. Slightly worse with names.'
                : 'Uses Apple’s servers. Better with names, and your speech leaves the phone.'
            }
            right={
              <Switch
                value={persona.preferOnDevice}
                onValueChange={(preferOnDevice) => set({ preferOnDevice })}
                trackColor={{ true: palette.mark, false: palette.sunken }}
                thumbColor={palette.paper}
              />
            }
          />
        </Card>
      </Section>

      {/* --------------------------------------------------------- hardware */}

      <Section label="Hardware">
        <Card style={{ paddingVertical: 2 }}>
          <Row
            label="Glasses"
            hint={
              route.isExternal
                ? route.hasExternalMic
                  ? 'Playing and listening through them.'
                  : 'Playing through them, but listening on the phone. Reconnect them as a headset.'
                : 'Pair them in iOS Settings — Grove follows the system route.'
            }
            value={route.isExternal ? route.name : 'Phone'}
            tone={route.isExternal ? (route.hasExternalMic ? 'live' : 'alert') : 'off'}
          />
          <Row
            label="Ring"
            hint={
              !report.remote
                ? 'Needs a development build.'
                : armed
                  ? 'Grove holds the audio session, so your ring reaches it with the screen locked.'
                  : 'Not armed. Open Grove once to re-take the session.'
            }
            value={armed ? 'Armed' : 'Off'}
            tone={armed ? 'live' : 'off'}
          />
        </Card>

        <Diagnostics />
      </Section>

      {/* ---------------------------------------------------------- account */}

      <Section label="Account">
        <Card style={{ paddingVertical: 2 }}>
          <Row label="Signed in" value={user?.email ?? user?.name ?? '—'} />
          <Row label="Plan" value={user?.plan ?? 'free'} />
          <Row
            label="History"
            hint={`${activity.length} exchanges kept on this phone`}
            right={
              activity.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear history"
                  onPress={() => void clearActivity()}
                  style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, padding: 6 })}
                >
                  <Icon name="trash" size={17} color={palette.alert} />
                </Pressable>
              ) : undefined
            }
          />
        </Card>

        <Button
          label="Sign out"
          tone="danger"
          onPress={() => void signOut()}
          style={{ marginTop: 14 }}
        />
      </Section>
    </Screen>
  );
}

/**
 * What the ring actually sends.
 *
 * Every press is recorded raw — the media key iOS delivered, how long after
 * the signal before it, and whether Grove treated it as a duplicate. A user with an undocumented
 * ring can press each button, read this, and know for certain whether their
 * hardware works with Grove and which gesture does what.
 */
function Diagnostics() {
  const palette = usePalette();
  const [signals, setSignals] = useState(() => trigger.recentSignals());
  const [open, setOpen] = useState(false);

  // Polled rather than subscribed: the point is to watch it while pressing a
  // button, and a one-second refresh is invisible to a person doing that.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setSignals(trigger.recentSignals()), 700);
    return () => clearInterval(timer);
  }, [open]);

  return (
    <View style={{ marginTop: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Ring diagnostics"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingVertical: 11,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Icon name={open ? 'down' : 'chevron'} size={14} color={palette.inkSoft} />
        <Text style={[Type.bodySm, { color: palette.inkSoft, flex: 1 }]}>
          What is my ring sending?
        </Text>
        {signals.length > 0 ? <Mono>{signals.length}</Mono> : null}
      </Pressable>

      {open ? (
        <Card>
          <Text style={[Type.bodySm, { color: palette.muted, marginBottom: 12 }]}>
            Press each button on your ring and watch this list. If nothing appears, your ring
            isn’t sending media keys and can’t reach Grove — pair it and check it starts and
            stops music from the lock screen.
          </Text>

          {signals.length === 0 ? (
            <Text style={[monoLabel, { color: palette.muted }]}>No signals yet</Text>
          ) : (
            signals.map((signal, index) => (
              <View
                key={`${signal.at}-${index}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 9,
                  paddingVertical: 7,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: palette.line,
                }}
              >
                <Dot tone={signal.coalesced ? 'off' : 'live'} size={6} />
                <Mono color={palette.ink} style={{ flex: 1 }}>
                  {signal.command}
                  {signal.phase ? ` · ${signal.phase}` : ''}
                </Mono>
                {/* Only sub-two-second gaps are worth showing. Anything longer
                    is a person pausing between presses, which they already
                    know they did; the informative range is the one that
                    decides whether two signals were one press or two. */}
                {signal.gap !== undefined && signal.gap < 2000 ? (
                  <Mono>+{signal.gap}ms</Mono>
                ) : null}
                <Mono>{signal.coalesced ? 'merged' : 'used'}</Mono>
              </View>
            ))
          )}

          {signals.length > 0 ? (
            <Button
              label="Clear"
              tone="quiet"
              onPress={() => {
                trigger.clearSignals();
                setSignals([]);
              }}
              style={{ marginTop: 12 }}
            />
          ) : null}
        </Card>
      ) : null}
    </View>
  );
}

/**
 * A stepper rather than a slider.
 *
 * There is no slider in the dependency tree and adding one for two controls
 * isn't worth it — but the better reason is that speech rate is a value people
 * tune by ear in small increments, and a stepper with a readout is easier to
 * land on 1.15 with than a 200-pixel track.
 */
function Stepper({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
}) {
  const palette = usePalette();

  const nudge = (direction: 1 | -1) => {
    // Rounded to the step so floating-point drift doesn't produce 1.0500000001.
    const next = Math.round((value + direction * step) / step) * step;
    onChange(Math.min(max, Math.max(min, Number(next.toFixed(2)))));
  };

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <Text style={[Type.body, { color: palette.ink, flex: 1 }]}>{label}</Text>
      <Mono color={palette.inkSoft}>{value.toFixed(2)}×</Mono>

      <View style={{ flexDirection: 'row', gap: 6 }}>
        {([-1, 1] as const).map((direction) => (
          <Pressable
            key={direction}
            accessibilityRole="button"
            accessibilityLabel={`${direction < 0 ? 'Decrease' : 'Increase'} ${label.toLowerCase()}`}
            disabled={direction < 0 ? value <= min : value >= max}
            onPress={() => nudge(direction)}
            style={({ pressed }) => ({
              width: 34,
              height: 34,
              borderRadius: Radius.well,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: palette.sunken,
              borderWidth: 1,
              borderColor: palette.line,
              opacity:
                (direction < 0 ? value <= min : value >= max) ? 0.35 : pressed ? 0.6 : 1,
            })}
          >
            <Icon name={direction < 0 ? 'minus' : 'plus'} size={15} color={palette.ink} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
