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
import { Linking, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import Svg, { Defs, LinearGradient as SvgGradient, Rect, Stop } from 'react-native-svg';

import { router } from 'expo-router';
import * as Updates from 'expo-updates';

import { ConnectionsPanel } from '@/components/connections-panel';
import { Icon } from '@/components/icon';
import { Button, Card, Dot, Mono, Notice, Row, Screen, Section } from '@/components/ui';
import { FIELD_COLOURS, fieldColour } from '@/components/field-shader';
import { Glass } from '@/components/glass';
import { Radius, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { capabilities, reducedModeReason } from '@/lib/capabilities';
import { runSelfCheck, type CheckResult } from '@/lib/selfCheck';
import { checkNow, runningLabel, type Caught } from '@/lib/updates';
import { MANNER_LIMIT, NAME_LIMIT, PRESETS, type Persona } from '@/lib/persona';
import { hasOwnKey, setOwnKey } from '@/lib/lightModel';
import { availableVoices, bestVoiceId, characterVoice, hasEnhancedVoice, speak } from '@/lib/speak';
import * as trigger from '@/lib/trigger';
import { LIMIT } from '@/lib/transcript';
import type * as SpeechTypes from 'expo-speech';


/** On glass, like Memory; see Glass. */
export default function Settings() {
  return (
    <Glass>
      <SettingsBody />
    </Glass>
  );
}

function SettingsBody() {
  const palette = usePalette();
  const { user, signOut } = useSession();
  // Memory moved to Sparks, where the standing instructions already live: a
  // spark and a fact are the same idea from different ends, and keeping the
  // list somewhere you pass anyway beats burying it in Settings.
  const { persona, updatePersona, armed, route, activity } = useAgent();
  const colour = fieldColour(persona.sky);
  const gradientId = `grove-name-${colour.key}`;
  /** Not one of the presets, so the box is theirs and worth showing. */
  const custom = !PRESETS.some((preset) => preset.manner.trim() === persona.manner.trim());
  const updateLabel = runningLabel();

  const reduced = reducedModeReason();
  const report = capabilities();

  const set = useCallback(
    (patch: Partial<Persona>) => void updatePersona({ ...persona, ...patch }),
    [persona, updatePersona]
  );

  return (
    <Screen title="Settings">
      {reduced ? <Notice text={reduced} tone="info" /> : null}

      {/* ------------------------------------------------------- who it is */}

      {/*
        Name and colours together, at the top, because they are one decision.
        Both answer "whose assistant is this" and neither reads as a setting —
        splitting them across the screen made the orb feel like a theme option
        rather than the thing you are naming.

        The name sits where the state word goes, so you are editing it in the
        place you will actually read it.
      */}
      <Section>
        <Card style={{ alignItems: 'center', paddingVertical: 20, gap: 12 }}>
          {/*
            The name sits on a piece of the sky rather than under a preview of
            the orb. It is the one free-text field on this screen, so it gets
            the one coloured surface, and tapping the name itself to rename it
            is the whole interaction — which a label above a box does not say.
          */}
          <View
            style={{
              width: '100%',
              height: 112,
              borderRadius: Radius.card,
              overflow: 'hidden',
              justifyContent: 'flex-end',
            }}
          >
            <Svg width="100%" height="100%" style={StyleSheet.absoluteFill}>
              <Defs>
                {/* Keyed on the choice, or the gradient is cached under one
                    id and the card never repaints when you pick another. */}
                <SvgGradient id={gradientId} x1="0" y1="0" x2="0.35" y2="1">
                  {[colour.c[0], colour.c[1], colour.c[3], colour.c[2]].map((stop, i) => (
                    <Stop key={stop} offset={i / 3} stopColor={stop} />
                  ))}
                </SvgGradient>
              </Defs>
              <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${gradientId})`} />
            </Svg>

            <TextInput
              value={persona.name}
              onChangeText={(name) => set({ name: name.slice(0, NAME_LIMIT) })}
              placeholder="Buddy"
              placeholderTextColor="rgba(255,255,255,0.65)"
              accessibilityLabel="What it answers to. Tap to rename."
              style={[Type.state, { color: '#FFFFFF', paddingHorizontal: 14, paddingBottom: 12 }]}
            />
          </View>

        </Card>
      </Section>

      {/*
        Pills, and the prompt only when you are writing one.

        This was a row that opened a list, above a box holding whatever the
        chosen preset's manner happened to be — four hundred words of
        second-person instructions, on a settings screen, reading "400/400" as
        though the user had written it and run out of room. Nobody needs to
        read Jarvis at himself. Pick a name, or pick Custom and get an empty
        box that is actually yours.
      */}
      <Section label="How it talks">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
          {PRESETS.map((preset) => {
            const picked = preset.manner.trim() === persona.manner.trim();
            return (
              <Pressable
                key={preset.key}
                accessibilityRole="radio"
                accessibilityState={{ selected: picked }}
                accessibilityLabel={`${preset.label}. ${preset.blurb}`}
                onPress={() => set({ manner: preset.manner, delivery: preset.delivery })}
                style={({ pressed }) => ({
                  height: 34,
                  paddingHorizontal: 15,
                  borderRadius: Radius.pill,
                  justifyContent: 'center',
                  backgroundColor: picked ? palette.mark : palette.raised,
                  borderWidth: 1,
                  borderColor: picked ? palette.mark : palette.line,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text
                  style={{
                    fontFamily: Type.cardTitle.fontFamily,
                    fontSize: 13.5,
                    color: picked ? palette.onMark : palette.ink,
                  }}
                >
                  {preset.label}
                </Text>
              </Pressable>
            );
          })}

          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected: custom }}
            accessibilityLabel="Custom. Write your own."
            onPress={() => set({ manner: custom ? persona.manner : '' })}
            style={({ pressed }) => ({
              height: 34,
              paddingHorizontal: 15,
              borderRadius: Radius.pill,
              justifyContent: 'center',
              backgroundColor: custom ? palette.mark : palette.raised,
              borderWidth: 1,
              borderColor: custom ? palette.mark : palette.line,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{
                fontFamily: Type.cardTitle.fontFamily,
                fontSize: 13.5,
                color: custom ? palette.onMark : palette.ink,
              }}
            >
              Custom
            </Text>
          </Pressable>
        </View>

        {custom ? (
          <Card style={{ marginTop: 10 }}>
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
        ) : null}
      </Section>

      {/*
        One switch, where six used to be.

        What it calls you, how blunt it is, whether it may swear, how deep it
        goes — all of that was asked on this screen, in the abstract, about
        something the person demonstrates every time they open their mouth. It
        is read from how they actually talk now; see rapport.ts. That reading
        used to be printed here too, and it is not any more: it is an
        observation about someone, not a control, and a screen of switches is
        the wrong place to be told what you sound like. This switch stays
        because it cannot be observed — someone who has never been interrupted
        has given no sign either way.
      */}

      {/*
        Back to swatches, and further down.

        A list of names was the wrong trade: the card at the top is a preview
        of one sky, and choosing between five of them is a comparison, which
        is a thing you do by looking rather than by reading. It sits below the
        voice now because it is the least consequential control on the screen
        and it was the second thing on it.
      */}
      {/*
        Three, because "follow the phone" is the right default and is also the
        one that does not work yet: app.json pinned the whole app to light at
        the OS level, so the system never reports dark. That is changed for the
        next build; until it exists, Dark is the one that does something, and
        it does it over the air because only JavaScript decides which palette
        object comes back.
      */}
      <Section label="Appearance">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 7 }}>
          {(['system', 'light', 'dark'] as const).map((mode) => {
            const picked = (persona.theme ?? 'system') === mode;
            return (
              <Pressable
                key={mode}
                accessibilityRole="radio"
                accessibilityState={{ selected: picked }}
                accessibilityLabel={mode === 'system' ? 'Follow the phone' : mode}
                onPress={() => set({ theme: mode })}
                style={({ pressed }) => ({
                  height: 34,
                  paddingHorizontal: 15,
                  borderRadius: Radius.pill,
                  justifyContent: 'center',
                  backgroundColor: picked ? palette.mark : palette.raised,
                  borderWidth: 1,
                  borderColor: picked ? palette.mark : palette.line,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text
                  style={{
                    fontFamily: Type.cardTitle.fontFamily,
                    fontSize: 13.5,
                    color: picked ? palette.onMark : palette.ink,
                  }}
                >
                  {mode === 'system' ? 'Follow phone' : mode === 'light' ? 'Light' : 'Dark'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Section>

      {/*
        The colour of the field, and nothing to do with the voice.

        It belonged to the personality once, and a manner someone wrote
        themselves has no colour, so it is its own choice now. Four, all from
        outdoors, each with its own pace; picking one repaints the field
        behind this very screen, which is the preview.
      */}
      <Section label="Colour">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {FIELD_COLOURS.map((option) => {
            const picked = option.key === colour.key;
            return (
              <Pressable
                key={option.key}
                accessibilityRole="radio"
                accessibilityState={{ selected: picked }}
                accessibilityLabel={`${option.label}. ${option.blurb}`}
                onPress={() => set({ sky: option.key })}
                style={({ pressed }) => ({
                  width: '48.5%',
                  padding: 10,
                  gap: 9,
                  borderRadius: Radius.card,
                  backgroundColor: picked ? 'rgba(255,255,255,0.16)' : palette.raised,
                  borderWidth: 1,
                  borderColor: picked ? 'rgba(255,255,255,0.72)' : palette.line,
                  opacity: pressed ? 0.75 : 1,
                })}
              >
                <View style={{ height: 56, borderRadius: 12, overflow: 'hidden' }}>
                  <Svg width="100%" height="100%">
                    <Defs>
                      <SvgGradient id={`grove-colour-${option.key}`} x1="0" y1="0.2" x2="1" y2="0.8">
                        {[option.c[0], option.c[1], option.c[3], option.c[2]].map((stop, i) => (
                          <Stop key={stop} offset={i / 3} stopColor={stop} />
                        ))}
                      </SvgGradient>
                    </Defs>
                    <Rect x="0" y="0" width="100%" height="100%" fill={`url(#grove-colour-${option.key})`} />
                  </Svg>
                </View>
                <View style={{ gap: 2, paddingHorizontal: 2 }}>
                  <Text style={[Type.cardTitle, { color: palette.ink }]}>{option.label}</Text>
                  <Text style={[Type.bodySm, { color: palette.muted }]}>{option.blurb}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      </Section>

      <Section label="Speaking up">
        <Card style={{ paddingVertical: 2 }}>
          <Row
            label="Speaks up unprompted"
            right={
              <Switch
                value={persona.speaksUp !== false}
                onValueChange={(speaksUp) => set({ speaksUp })}
                trackColor={{ true: palette.mark, false: palette.sunken }}
                thumbColor="#FFFFFF"
              />
            }
          />
        </Card>
      </Section>

      <Section label="Voice">
        <VoicePicker
          selected={persona.voiceId}
          onSelect={(voiceId) => set({ voiceId })}
          delivery={persona.delivery}
        />
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          {(
            [
              ['measured-british', 'Measured British', 'Low, precise, unhurried'],
              ['low-american', 'Low and slow', 'Gravelly, laconic, American'],
            ] as const
          ).map(([character, title, blurb]) => (
            <Pressable
              key={character}
              accessibilityRole="button"
              accessibilityLabel={`${title}. ${blurb}`}
              onPress={() => {
                void characterVoice(character).then(({ voiceId, rate, pitch }) => {
                  set({ voiceId, delivery: { ...persona.delivery, rate, pitch } });
                  speak("Right then. Tell me what you need.", { ...persona.delivery, rate, pitch, voiceId });
                });
              }}
              style={({ pressed }) => ({
                flex: 1,
                padding: 12,
                borderRadius: Radius.well,
                borderWidth: 1,
                borderColor: palette.line,
                backgroundColor: palette.raised,
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <Text style={[Type.cardTitle, { color: palette.ink, fontSize: 14 }]}>{title}</Text>
              <Text style={[Type.bodySm, { color: palette.muted, marginTop: 2 }]}>{blurb}</Text>
            </Pressable>
          ))}
        </View>
        <Card style={{ paddingVertical: 2, marginTop: 10 }}>
          <Stepper
            label="Speed"
            value={persona.delivery.rate}
            min={0.6}
            max={1.5}
            step={0.05}
            onChange={(rate) => set({ delivery: { ...persona.delivery, rate } })}
          />
          <Stepper
            label="Pitch"
            value={persona.delivery.pitch}
            min={0.7}
            max={1.4}
            step={0.05}
            onChange={(pitch) => set({ delivery: { ...persona.delivery, pitch } })}
          />
          <Row
            label="Keep speech on this device"
            right={
              <Switch
                value={persona.preferOnDevice}
                onValueChange={(preferOnDevice) => set({ preferOnDevice })}
                trackColor={{ true: palette.mark, false: palette.sunken }}
                thumbColor="#FFFFFF"
              />
            }
          />
        </Card>
      </Section>

      <Section label="Thinking on its own">
        <OwnKey />
      </Section>

      {/* --------------------------------------------------------- hardware */}

      <Section label="Connections">
        <ConnectionsPanel />
      </Section>

      {/* What it did, and through which connection: the place you check
          whether a reminder actually got set. */}
      <Section label="Logs">
        <Card style={{ paddingVertical: 2 }}>
          <Row
            label="Logs"
            hint={`The last ${LIMIT} things you asked, and the connection each used.`}
            value={activity.length ? String(activity.length) : undefined}
            onPress={() => router.push('/logs')}
          />
        </Card>
      </Section>

      <Section label="Does it all work?">
        <Card>
          <SelfCheck />
        </Card>
      </Section>

      <Section label="Hardware">
        <Card style={{ paddingVertical: 2 }}>
          <Row
            label="Glasses"
            hint={route.isExternal && !route.hasExternalMic ? 'Listening on the phone.' : undefined}
            value={route.isExternal ? route.name : 'Not paired'}
            tone={route.isExternal ? 'live' : 'off'}
          />
          <Row
            label="Ring"
            hint={!report.remote ? 'Needs a development build.' : armed ? undefined : 'Open Grove once to re-take it.'}
            value={armed ? 'Armed' : 'Off'}
            tone={armed ? 'live' : 'off'}
          />
          <Row
            label="Use the volume button"
            hint={
              !report.remote
                ? 'Needs a development build.'
                : persona.volumeTrigger
                  ? 'The phone’s own volume button fires it too.'
                  : 'For a ring that sends volume instead of play.'
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

      {/* ---------------------------------------------------------- account */}

      {/* ------------------------------------------------------- what's running */}

      {/*
        Which bundle is actually on the phone.

        Over-the-air updates apply on the launch AFTER they download, so "I
        shipped a fix" and "the fix is on your phone" are different statements,
        and there was no way to tell them apart from the outside. Two people
        spent an evening debugging a model that had already been fixed, because
        the phone was still running the bundle that had the broken one.
      */}
      <Section label="Version">
        <Card>
          <Row label="Update" value={updateLabel} />
          <Row label="Channel" value={Updates.channel || 'embedded'} />
          <Row label="Model" value={process.env.EXPO_PUBLIC_GEMINI_MODEL || 'default'} />
        </Card>
        <UpdateNow />
      </Section>

      <Section label="Account">
        <Card style={{ paddingVertical: 2 }}>
          <Row label="Signed in" value={user?.email ?? user?.name ?? '—'} />
        </Card>
        <Forgetting />
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
 * Fetching the newest bundle on purpose.
 *
 * Grove catches up on its own at launch, which covers the ordinary case. This
 * is for the case where someone has been told an update exists and wants to see
 * it now rather than find out whether it worked — and for the one where the
 * launch check gave up because the connection was slow.
 *
 * It says which of the four things happened, including "you already have it",
 * because that is the answer someone is actually looking for half the time and
 * a button that reports nothing is a button you press twice.
 */
function UpdateNow() {
  const palette = usePalette();
  const [state, setState] = useState<'idle' | 'looking' | Caught>('idle');

  const look = async () => {
    setState('looking');
    setState(await checkNow());
  };

  const said =
    state === 'looking'
      ? 'Looking…'
      : state === 'current'
        ? 'You already have the newest one.'
        : state === 'reloading'
          ? 'Found one. Restarting…'
          : state === 'unavailable'
            ? 'Updates are off in this build.'
            : state === 'failed'
              ? 'Could not reach the update server. Try again in a moment.'
              : '';

  return (
    <>
      <Button
        label={state === 'looking' ? 'Checking…' : 'Check for an update'}
        onPress={() => void look()}
        style={{ marginTop: 10 }}
      />
      {said ? (
        <Text style={[Type.bodySm, { color: palette.muted, marginTop: 8 }]}>{said}</Text>
      ) : null}
    </>
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
 * A model key kept on this phone.
 *
 * Grove's key normally lives on Noctus, which keeps it out of the app bundle
 * where anyone could extract it. The cost is that Grove cannot think when
 * Noctus is down — and for something you talk to, that is the whole product
 * failing rather than one feature.
 *
 * A key entered here sits in the Keychain on one phone rather than in every
 * build, and is used only when the server cannot be reached.
 */
function OwnKey() {
  const palette = usePalette();
  const [has, setHas] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let alive = true;
    void hasOwnKey().then((h) => alive && setHas(h));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Card>
      <Text style={[Type.bodySm, { color: palette.muted, marginBottom: 9 }]}>
        {has
          ? 'Grove can still think when the server is unreachable.'
          : 'Grove needs the server to think. Add your own key and it keeps working without one.'}
      </Text>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onEndEditing={() => {
          void setOwnKey(draft).then(() => {
            setHas(Boolean(draft.trim()));
            setDraft('');
          });
        }}
        placeholder={has ? 'Stored. Type to replace, or clear to remove.' : 'AIza…'}
        placeholderTextColor={palette.muted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={{
          backgroundColor: palette.sunken,
          borderWidth: 1,
          borderColor: palette.line,
          borderRadius: Radius.well,
          paddingHorizontal: 11,
          paddingVertical: 10,
          fontFamily: Type.body.fontFamily,
          fontSize: 14,
          color: palette.ink,
        }}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 8 }}>
        <Dot tone={has ? 'live' : 'off'} />
        <Text style={[Type.bodySm, { color: palette.muted }]}>
          {has ? 'Stored on this phone only' : 'Not set'}
        </Text>
      </View>
    </Card>
  );
}

/**
 * Wipe everything and start over.
 *
 * Two taps rather than a dialog. This deletes conversations, memory and every
 * standing job at once and none of it can be recovered, so a single tap is too
 * cheap — but a modal for something you will use twice is heavier than the
 * action deserves. The second tap goes back to sleep after a few seconds, so a
 * stray press cannot sit there waiting to be completed by accident.
 */
/**
 * A button that asks once, by becoming the question.
 *
 * No dialog: the second tap is the confirmation, and it disarms itself after
 * four seconds so a button left armed cannot be hit by the next thing you
 * meant to press. The same reasoning as the confirmation on a spoken action —
 * doing nothing has to be the safe outcome.
 */
function Armed({
  label,
  question,
  onConfirm,
}: {
  label: string;
  question: string;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <Button
      label={armed ? question : label}
      tone={armed ? 'danger' : 'quiet'}
      onPress={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      style={{ marginTop: 14 }}
    />
  );
}

/**
 * The two ways of forgetting, which are not the same thing.
 *
 * Forgetting the facts drops the short list that rides in every prompt and
 * leaves the people, the notes and what happened alone — which is what someone
 * wants when Grove has written down something wrong about them. Starting again
 * takes the lot. Both live here rather than at the end of the memory list on
 * Sparks, where a wipe sat directly under the rows it would destroy.
 */
function Forgetting() {
  const { startAgain, forgetEverything } = useAgent();

  return (
    <>
      <Armed
        label="Forget the facts about me"
        question="Tap again to forget them"
        onConfirm={() => void forgetEverything()}
      />
      <Armed
        label="Start again"
        question="Tap again to wipe everything"
        onConfirm={() => void startAgain()}
      />
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
/**
 * "Does any of this actually work?"
 *
 * The answer used to be "try it and see", one feature at a time, out loud, in
 * public. This runs every integration against the real account and says which
 * one is broken and what to do about it — including the link when a Google API
 * is simply switched off.
 */
function SelfCheck() {
  const palette = usePalette();
  const [results, setResults] = useState<CheckResult[]>([]);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setResults([]);
    setRunning(true);
    await runSelfCheck((result) => setResults((all) => [...all, result]));
    setRunning(false);
  };

  const failed = results.filter((r) => !r.ok).length;

  return (
    <View style={{ marginTop: 10 }}>
      <Button
        label={running ? 'Checking…' : results.length > 0 ? 'Check again' : 'Check everything'}
        tone="quiet"
        onPress={() => void run()}
      />

      {results.map((result) => (
        <View key={result.name} style={{ flexDirection: 'row', gap: 10, paddingVertical: 8 }}>
          <Icon
            name={result.ok ? 'check' : 'alert'}
            size={14}
            color={result.ok ? palette.ink : palette.alert}
          />
          <View style={{ flex: 1 }}>
            <Text style={[Type.body, { color: palette.ink }]}>{result.name}</Text>
            <Text style={[Type.bodySm, { color: result.ok ? palette.muted : palette.inkSoft, marginTop: 2 }]}>
              {result.detail}
            </Text>
            {result.link ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Switch on the API for ${result.name}`}
                onPress={() => void Linking.openURL(result.link as string)}
                style={({ pressed }) => ({ paddingVertical: 6, opacity: pressed ? 0.6 : 1 })}
              >
                <Text style={[Type.bodySm, { color: palette.ink, textDecorationLine: 'underline' }]}>
                  Switch it on in Google Cloud
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ))}

      {!running && results.length > 0 ? (
        <Text style={[Type.bodySm, { color: palette.muted, marginTop: 8 }]}>
          {failed === 0
            ? 'Everything answered.'
            : `${failed} of ${results.length} need attention.`}
        </Text>
      ) : null}
    </View>
  );
}

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

