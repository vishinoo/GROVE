/**
 * Settings.
 *
 * Cut down hard. It used to open with a paragraph explaining what the manner
 * box does, followed by five preset buttons that wrote sentences into that same
 * box. Both went: the box says what it is by being a box you type a sentence
 * into, and a preset that overwrites what you wrote is a second source of truth
 * for one setting.
 *
 * What is left is five things in the order they matter: what Grove is called,
 * how it talks, whether the hardware is working, what it remembers, and who you
 * are signed in as.
 *
 * The diagnostics panel is not developer furniture — it is a product feature for
 * hardware nobody has documentation for. Cheap rings do not come with a spec
 * sheet, and the only reliable way to find out what one emits is to press it and
 * look.
 */

import { useCallback, useEffect, useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';

import { Icon } from '@/components/icon';
import { Button, Card, Dot, Mono, Notice, Row, Screen, Section } from '@/components/ui';
import { Radius, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { capabilities, reducedModeReason } from '@/lib/capabilities';
import { MANNER_LIMIT, NAME_LIMIT, type Persona } from '@/lib/persona';
import { availableVoices, bestVoiceId, hasEnhancedVoice, speak } from '@/lib/speak';
import * as trigger from '@/lib/trigger';
import type * as SpeechTypes from 'expo-speech';

export default function Settings() {
  const palette = usePalette();
  const { user, signOut } = useSession();
  const { persona, updatePersona, armed, route, facts, forgetFact, forgetEverything } = useAgent();

  const reduced = reducedModeReason();
  const report = capabilities();

  const set = useCallback(
    (patch: Partial<Persona>) => void updatePersona({ ...persona, ...patch }),
    [persona, updatePersona]
  );

  return (
    <Screen title="Settings">
      {reduced ? <Notice text={reduced} tone="info" /> : null}

      {/* ------------------------------------------------------------- name */}

      <Section label="Name">
        <Card>
          <TextInput
            value={persona.name}
            onChangeText={(name) => set({ name: name.slice(0, NAME_LIMIT) })}
            placeholder="Buddy"
            placeholderTextColor={palette.muted}
            style={{
              fontFamily: Type.cardTitle.fontFamily,
              fontSize: 17,
              color: palette.ink,
              paddingVertical: 2,
            }}
          />
          <Text style={[Type.bodySm, { color: palette.muted, marginTop: 6 }]}>
            You’ll be saying it out loud in public. Pick something you don’t mind saying.
          </Text>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ voice */}

      <Section label="How it talks">
        <Card>
          <TextInput
            value={persona.manner}
            onChangeText={(manner) => set({ manner: manner.slice(0, MANNER_LIMIT) })}
            placeholder="Short and dry. Don’t be chirpy."
            placeholderTextColor={palette.muted}
            multiline
            style={{
              minHeight: 76,
              fontFamily: Type.body.fontFamily,
              fontSize: 14.5,
              lineHeight: 21,
              color: palette.ink,
            }}
          />
          <Mono style={{ marginTop: 8 }}>
            {persona.manner.length}/{MANNER_LIMIT}
          </Mono>
        </Card>
      </Section>

      <Section label="Voice">
        <VoicePicker
          selected={persona.voiceId}
          onSelect={(voiceId) => set({ voiceId })}
          delivery={persona.delivery}
        />
        <Card style={{ paddingVertical: 2, marginTop: 10 }}>
          <Stepper
            label="Speed"
            value={persona.delivery.rate}
            min={0.6}
            max={1.5}
            step={0.05}
            onChange={(rate) => set({ delivery: { ...persona.delivery, rate } })}
          />
          <Row
            label="Keep speech on this device"
            hint={
              persona.preferOnDevice
                ? 'Nothing you say is sent to Apple.'
                : 'Uses Apple’s servers. Better with names.'
            }
            right={
              <Switch
                value={persona.preferOnDevice}
                onValueChange={(preferOnDevice) => set({ preferOnDevice })}
                trackColor={{ true: palette.mark, false: palette.sunken }}
                thumbColor={palette.raised}
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
                  : 'Playing through them, listening on the phone. Reconnect as a headset.'
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
                  ? 'Grove holds the audio session, so your ring reaches it locked.'
                  : 'Not armed. Open Grove once to re-take the session.'
            }
            value={armed ? 'Armed' : 'Off'}
            tone={armed ? 'live' : 'off'}
          />
          <Row
            label="Use the volume button"
            hint={
              !report.remote
                ? 'Needs a development build.'
                : persona.volumeTrigger
                  ? 'Volume-down is Grove’s trigger now. The phone’s own volume-down button fires it too — iOS reports the new level, never who pressed it.'
                  : 'For a ring that only sends volume, Home or Sleep. iOS hands none of those to an app, but the volume changing is something Grove can see.'
            }
            right={
              <Switch
                value={persona.volumeTrigger}
                onValueChange={(volumeTrigger) => set({ volumeTrigger })}
                disabled={!report.remote}
                trackColor={{ true: palette.mark, false: palette.sunken }}
                thumbColor={palette.paper}
              />
            }
          />
        </Card>
        <Diagnostics />
      </Section>

      {/* ----------------------------------------------------------- memory */}

      <Section label="What Grove remembers">
        {facts.length === 0 ? (
          <Card>
            <Text style={[Type.bodySm, { color: palette.muted }]}>
              Nothing yet. Tell it something about you and it keeps it here, where you can delete
              it.
            </Text>
          </Card>
        ) : (
          <Card style={{ paddingVertical: 2 }}>
            {facts.map((fact) => (
              <Row
                key={fact.id}
                label={fact.value}
                right={
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Forget: ${fact.value}`}
                    onPress={() => void forgetFact(fact.id)}
                    hitSlop={8}
                    style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.5 : 1 })}
                  >
                    <Icon name="trash" size={16} color={palette.muted} />
                  </Pressable>
                }
              />
            ))}
          </Card>
        )}
        {facts.length > 0 ? (
          <Button
            label="Forget everything"
            tone="quiet"
            onPress={() => void forgetEverything()}
            style={{ marginTop: 10 }}
          />
        ) : null}
      </Section>

      {/* ---------------------------------------------------------- account */}

      <Section label="Account">
        <Card style={{ paddingVertical: 2 }}>
          <Row label="Signed in" value={user?.email ?? user?.name ?? '—'} />
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
 * Which voice Grove speaks in.
 *
 * The list is scored in speak.ts rather than shown in device order, because the
 * order iOS returns is arbitrary and its first entry is usually a compact voice.
 *
 * The notice at the top is the only advice on this screen worth giving. iOS
 * ships every language with a small "compact" voice and offers a much better
 * one as a download — until someone fetches it, no amount of rate and pitch
 * tuning stops it sounding like a satnav. That download is free and is a bigger
 * improvement than anything this app can do in code.
 */
function VoicePicker({
  selected,
  onSelect,
  delivery,
}: {
  selected?: string;
  onSelect: (id: string) => void;
  delivery: Persona['delivery'];
}) {
  const palette = usePalette();
  const [voices, setVoices] = useState<SpeechTypes.Voice[]>([]);
  const [enhanced, setEnhanced] = useState(true);
  const [auto, setAuto] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [list, hasGood, fallback] = await Promise.all([
        availableVoices(),
        hasEnhancedVoice(),
        bestVoiceId(),
      ]);
      if (!alive) return;
      setVoices(list.slice(0, 8));
      setEnhanced(hasGood);
      setAuto(fallback);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const current = selected ?? auto ?? undefined;
  const chosen = voices.find((v) => v.identifier === current);

  const preview = (id: string) =>
    speak('This is how I sound. Press your ring whenever you want me.', {
      ...delivery,
      voiceId: id,
    });

  return (
    <>
      {!enhanced ? (
        <Notice
          tone="info"
          text={
            'These are the small built-in voices, which is why it sounds synthetic. ' +
            'iOS Settings > Accessibility > Spoken Content > Voices > English — download ' +
            'an Enhanced or Premium one. It is free and it is the biggest difference available.'
          }
        />
      ) : null}

      {/*
        Collapsed to a single row. Eight voices is a wall of near-identical
        names, and the only one that matters day to day is the one in use.
      */}
      <Card style={{ paddingVertical: 2 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`Voice: ${chosen?.name ?? 'automatic'}. Tap to change.`}
          onPress={() => setOpen((was) => !was)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingVertical: 13,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <View style={{ flex: 1 }}>
            <Text style={[Type.body, { color: palette.ink }]}>
              {chosen?.name ?? 'Best available'}
            </Text>
            <Text style={[Type.bodySm, { color: palette.muted }]}>
              {chosen
                ? `${chosen.language}${chosen.quality === 'Enhanced' ? ' · enhanced' : ''}`
                : 'Chosen for you'}
            </Text>
          </View>
          {voices.length > 0 ? <Mono>{voices.length}</Mono> : null}
          <Icon name={open ? 'down' : 'chevron'} size={14} color={palette.muted} />
        </Pressable>

        {open
          ? voices.map((voice) => {
              const on = voice.identifier === current;
              return (
                <Pressable
                  key={voice.identifier}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${voice.name}, ${voice.quality}`}
                  onPress={() => {
                    onSelect(voice.identifier);
                    // Hearing it is the only way to choose one.
                    preview(voice.identifier);
                  }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    paddingVertical: 11,
                    borderTopWidth: 1,
                    borderTopColor: palette.line,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  <Dot tone={on ? 'live' : 'off'} />
                  <View style={{ flex: 1 }}>
                    <Text style={[Type.body, { color: palette.ink }]}>{voice.name}</Text>
                    <Text style={[Type.bodySm, { color: palette.muted }]}>
                      {voice.language}
                      {voice.quality === 'Enhanced' ? ' · enhanced' : ''}
                    </Text>
                  </View>
                  <Icon name="talk" size={15} color={palette.muted} />
                </Pressable>
              );
            })
          : null}
      </Card>
    </>
  );
}

/**
 * What the ring actually sends.
 *
 * Every press is recorded raw — the media key iOS delivered, and whether Grove
 * treated it as a duplicate of the one before. Someone with an undocumented ring
 * can press each button, read this, and know for certain whether their hardware
 * works and which gesture does what.
 */
function Diagnostics() {
  const palette = usePalette();
  const [signals, setSignals] = useState(() => trigger.recentSignals());
  // Read from the native module rather than from the preference. When the
  // switch is on and this is off, the observer failed to install — which is
  // invisible otherwise and looks exactly like a ring that sends nothing.
  const [volumeWatch, setVolumeWatch] = useState(() => trigger.isVolumeFallbackOn());
  const [open, setOpen] = useState(false);

  // Polled rather than subscribed: the point is to watch it while pressing a
  // button, and a one-second refresh is invisible to a person doing that.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      setSignals(trigger.recentSignals());
      setVolumeWatch(trigger.isVolumeFallbackOn());
    }, 700);
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
          paddingVertical: 12,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={[Type.body, { color: palette.inkSoft, flex: 1 }]}>
          What is my ring sending?
        </Text>
        {signals.length > 0 ? <Mono>{signals.length}</Mono> : null}
        <Icon name={open ? 'down' : 'chevron'} size={14} color={palette.muted} />
      </Pressable>

      {open ? (
        <Card>
          <Text style={[Type.bodySm, { color: palette.muted, marginBottom: 12 }]}>
            Press each button and watch. If nothing appears, your ring isn’t sending media keys
            and can’t reach Grove — check it starts and stops music from the lock screen.
          </Text>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 9,
              paddingBottom: 10,
              marginBottom: 6,
              borderBottomWidth: 1,
              borderBottomColor: palette.line,
            }}
          >
            <Dot tone={volumeWatch ? 'live' : 'off'} size={6} />
            <Mono color={palette.ink} style={{ flex: 1 }}>
              volume watch
            </Mono>
            <Mono>{volumeWatch ? 'listening' : 'not installed'}</Mono>
          </View>

          {signals.length === 0 ? (
            <Mono>No signals yet</Mono>
          ) : (
            signals.map((signal, index) => (
              <View
                key={`${signal.at}-${index}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 9,
                  paddingVertical: 8,
                  borderTopWidth: index === 0 ? 0 : 1,
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
 * Speech rate is a value people tune by ear in small increments, and a stepper
 * with a readout is easier to land on 1.15 with than a 200-pixel track.
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
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: palette.line,
      }}
    >
      <Text style={[Type.body, { color: palette.ink, flex: 1 }]}>{label}</Text>
      <Mono color={palette.inkSoft}>{value.toFixed(2)}×</Mono>

      <View style={{ flexDirection: 'row', gap: 6 }}>
        {([-1, 1] as const).map((direction) => {
          const spent = direction < 0 ? value <= min : value >= max;
          return (
            <Pressable
              key={direction}
              accessibilityRole="button"
              accessibilityLabel={`${direction < 0 ? 'Decrease' : 'Increase'} ${label.toLowerCase()}`}
              disabled={spent}
              onPress={() => nudge(direction)}
              // Hit area padded past the 32pt visual to clear the 44pt minimum.
              hitSlop={6}
              style={({ pressed }) => ({
                width: 32,
                height: 32,
                borderRadius: Radius.well,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: palette.sunken,
                borderWidth: 1,
                borderColor: palette.line,
                opacity: spent ? 0.35 : pressed ? 0.6 : 1,
              })}
            >
              <Icon name={direction < 0 ? 'minus' : 'plus'} size={15} color={palette.ink} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
