/**
 * Sparks.
 *
 * A spark is a standing instruction: something to do, and what sets it off.
 *
 * It used to be a picked ability plus a bag of arguments, chosen from a list of
 * six. That was the wrong shape twice over — it could only express things
 * someone had already written a function for, and it put a dropdown in front of
 * a person who had just said what they wanted out loud. "Read my email for
 * anything from Priya and tell me what she said" had nowhere to go.
 *
 * So the card carries a sentence you can edit and a trigger you can change, and
 * the ability is worked out when it runs rather than chosen up front. What it
 * touches is shown, not selected.
 *
 * The list of everything Grove can do used to sit underneath. It has gone:
 * Connections already answers "what can this reach", and the same information
 * in two places means one of them is wrong the moment either changes.
 */

import { useEffect, useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';

import { AppIcon, iconForKey, type AppIconName } from '@/components/app-icon';
import { Icon } from '@/components/icon';
import { Card, Empty, Mono, Screen, Section } from '@/components/ui';
import { Radius, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { usePalette } from '@/hooks/use-palette';
import { abilityById, type Ability } from '@/lib/abilities';
import { describeTrigger, parseSchedule, phraseTrigger, type Spark } from '@/lib/sparks';
import { MODES, loadOverrides, setOnEnter, type Mode } from '@/lib/modes';

export default function Sparks() {
  const palette = usePalette();
  const { sparks, setSparkEnabled, editSpark, deleteSpark, facts, forgetFact, persona, updatePersona } =
    useAgent();

  return (
    <Screen
      title="Sparks"
      subtitle="Standing instructions. Say what you want and when, and it turns up here."
    >
      {sparks.length === 0 ? (
        <Empty
          text={
            'Nothing standing yet. Try “every weekday at eight, check my email for anything ' +
            'from Priya and tell me what she said”.'
          }
        />
      ) : (
        <Section>
          {sparks.map((spark) => (
            <SparkCard
              key={spark.id}
              spark={spark}
              onToggle={(next) => void setSparkEnabled(spark.id, next)}
              onEdit={(patch) => void editSpark(spark.id, patch)}
              onDelete={() => void deleteSpark(spark.id)}
            />
          ))}
        </Section>
      )}

      {/*
        Modes live here rather than in Settings, because a mode is a spark with
        a different trigger: not a clock and not a phrase, but a situation.
        "Every time I'm studying, put this on" is the same kind of standing
        instruction as "every weekday at eight" — so it belongs beside them.
      */}
      <Section label="Modes">
        {MODES.filter((m) => m.id !== 'normal').map((mode) => (
          <ModeCard
            key={mode.id}
            mode={mode}
            active={(persona.mode ?? 'normal') === mode.id}
            onActivate={() =>
              void updatePersona({
                ...persona,
                // Tapping the active one returns to normal, so a mode is never
                // a trap you have to hunt for the exit from.
                mode: (persona.mode ?? 'normal') === mode.id ? 'normal' : mode.id,
              })
            }
          />
        ))}
      </Section>

      {/*
        Memory sits under the sparks rather than only in Settings, because the
        two are the same idea seen from different ends: a spark is a standing
        instruction, a fact is a standing piece of context, and both are things
        Grove keeps and acts on without being asked again. Finding out what it
        remembers should not require going looking for it.
      */}
      <Section label="Memory">
        {facts.length === 0 ? (
          <Card>
            <Text style={[Type.bodySm, { color: palette.muted }]}>
              Nothing yet. Tell Grove something about yourself — where you live, when you leave
              for work — and it turns up here, where you can delete it.
            </Text>
          </Card>
        ) : (
          facts.map((fact) => (
            <FactCard key={fact.id} fact={fact} onForget={() => void forgetFact(fact.id)} />
          ))
        )}
      </Section>
    </Screen>
  );
}

/**
 * A mode, as a card you can teach.
 *
 * The same shape as a spark on purpose: a name, what it does, a trigger, and an
 * instruction you can edit. The only difference is what sets it off — a
 * situation rather than a clock — which is why moving these out of Settings was
 * the right call once they became conditional.
 */
function ModeCard({
  mode,
  active,
  onActivate,
}: {
  mode: Mode;
  active: boolean;
  onActivate: () => void;
}) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  const [rule, setRule] = useState('');
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let alive = true;
    void loadOverrides().then((all) => {
      if (!alive) return;
      const own = all[mode.id]?.onEnter ?? '';
      setRule(own);
      setDraft(own);
    });
    return () => {
      alive = false;
    };
  }, [mode.id]);

  return (
    <Card
      style={{
        marginBottom: 8,
        paddingHorizontal: 0,
        paddingVertical: 0,
        borderColor: active ? mode.tint : palette.line,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${mode.label}: ${mode.what}. Tap to edit.`}
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => ({ padding: 13, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: mode.tint }} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[Type.cardTitle, { color: palette.ink }]}>{mode.label}</Text>
            <Text style={[Type.bodySm, { color: palette.muted }]} numberOfLines={2}>
              {rule || mode.what}
            </Text>
          </View>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: active }}
            accessibilityLabel={active ? `Leave ${mode.label}` : `Switch to ${mode.label}`}
            onPress={onActivate}
            hitSlop={8}
            style={({ pressed }) => ({
              height: 30,
              paddingHorizontal: 12,
              borderRadius: Radius.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: active ? mode.tint : palette.sunken,
              borderWidth: 1,
              borderColor: active ? mode.tint : palette.line,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text
              style={{
                fontFamily: Type.cardTitle.fontFamily,
                fontSize: 12,
                color: active ? palette.ink : palette.inkSoft,
              }}
            >
              {active ? 'On' : 'Use'}
            </Text>
          </Pressable>
          <Icon name={open ? 'down' : 'chevron'} size={13} color={palette.muted} />
        </View>
      </Pressable>

      {open ? (
        <View
          style={{
            paddingHorizontal: 13,
            paddingBottom: 13,
            borderTopWidth: 1,
            borderTopColor: palette.line,
          }}
        >
          <Mono style={{ marginTop: 14, marginBottom: 5 }}>Every time this mode starts</Mono>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            onBlur={() => {
              const next = draft.trim();
              if (next !== rule) {
                setRule(next);
                void setOnEnter(mode.id, next);
              }
            }}
            placeholder={
              mode.id === 'study' ? 'put on the focus playlist and silence my reminders' : 'nothing, unless you say so'
            }
            placeholderTextColor={palette.muted}
            multiline
            style={{
              backgroundColor: palette.sunken,
              borderWidth: 1,
              borderColor: palette.line,
              borderRadius: Radius.well,
              paddingHorizontal: 11,
              paddingVertical: 10,
              minHeight: 62,
              fontFamily: Type.body.fontFamily,
              fontSize: 14,
              lineHeight: 20,
              color: palette.ink,
            }}
          />
          <Text style={[Type.bodySm, { color: palette.muted, marginTop: 6 }]}>
            Said to Grove as though you had spoken it, the moment you switch.
          </Text>

          <Detail label="How it talks">{mode.what}</Detail>
          <Detail label="Interrupts">
            {mode.interrupt === 'never'
              ? 'Never speaks first.'
              : mode.interrupt === 'sparingly'
                ? 'At most once an hour.'
                : 'Freely.'}
          </Detail>
        </View>
      ) : null}
    </Card>
  );
}

/**
 * One thing Grove knows about you.
 *
 * Same card as a spark, deliberately. A fact is stored, acted on, and yours to
 * delete, exactly as a standing instruction is — and showing them in two
 * different shapes would suggest a difference that is not there.
 */
function FactCard({
  fact,
  onForget,
}: {
  fact: ReturnType<typeof useAgent>['facts'][number];
  onForget: () => void;
}) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);

  return (
    <Card style={{ marginBottom: 8, paddingHorizontal: 0, paddingVertical: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${fact.value}. Tap for detail.`}
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => ({ padding: 13, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text style={[Type.body, { color: palette.ink, flex: 1 }]} numberOfLines={open ? undefined : 2}>
            {fact.value}
          </Text>
          <Icon name={open ? 'down' : 'chevron'} size={13} color={palette.muted} />
        </View>
      </Pressable>

      {open ? (
        <View
          style={{
            paddingHorizontal: 13,
            paddingBottom: 13,
            borderTopWidth: 1,
            borderTopColor: palette.line,
          }}
        >
          <Detail label="Kind">{fact.key}</Detail>
          <Detail label="How Grove knows">
            {fact.source === 'told' ? 'You told it.' : 'It worked it out from something you said.'}
          </Detail>
          <Detail label="Since">{new Date(fact.at).toLocaleDateString()}</Detail>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Forget: ${fact.value}`}
            onPress={onForget}
            hitSlop={6}
            style={({ pressed }) => ({ paddingVertical: 12, opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={[Type.bodySm, { color: palette.alert }]}>Forget this</Text>
          </Pressable>
        </View>
      ) : null}
    </Card>
  );
}

/** The apps a spark touches, as the tiles you already recognise. */
function icons(ability: Ability | undefined): AppIconName[] {
  if (!ability) return [];
  const found = [iconForKey(ability.id), iconForKey(ability.name), ...ability.needs.map(iconForKey)];
  return [...new Set(found.filter((n): n is AppIconName => n !== null))].slice(0, 3);
}

function SparkCard({
  spark,
  onToggle,
  onEdit,
  onDelete,
}: {
  spark: Spark;
  onToggle: (next: boolean) => void;
  onEdit: (patch: Partial<Pick<Spark, 'title' | 'instruction' | 'trigger'>>) => void;
  onDelete: () => void;
}) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);

  const ability = spark.abilityId ? abilityById(spark.abilityId) : undefined;
  const tiles = icons(ability);

  return (
    <Card style={{ marginBottom: 8, paddingHorizontal: 0, paddingVertical: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${spark.title}. ${describeTrigger(spark.trigger)}. Tap to edit.`}
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => ({ padding: 13, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={[Type.cardTitle, { color: palette.ink }]} numberOfLines={1}>
              {spark.title}
            </Text>
            <Text style={[Type.bodySm, { color: palette.muted }]} numberOfLines={2}>
              {spark.instruction}
            </Text>
          </View>
          <Switch
            value={spark.enabled}
            onValueChange={onToggle}
            trackColor={{ true: palette.mark, false: palette.sunken }}
            thumbColor={palette.raised}
          />
        </View>

        {/* What sets it off, and what it reaches into. */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            marginTop: 11,
            paddingTop: 11,
            borderTopWidth: 1,
            borderTopColor: palette.line,
          }}
        >
          <Text style={[Type.bodySm, { color: palette.inkSoft, flex: 1 }]} numberOfLines={1}>
            {describeTrigger(spark.trigger)}
          </Text>
          {tiles.map((name) => (
            <AppIcon key={name} name={name} size={22} />
          ))}
          <Icon name={open ? 'down' : 'chevron'} size={13} color={palette.muted} />
        </View>
      </Pressable>

      {open ? (
        <View
          style={{
            paddingHorizontal: 13,
            paddingBottom: 13,
            borderTopWidth: 1,
            borderTopColor: palette.line,
          }}
        >
          <Field
            label="Name"
            value={spark.title}
            placeholder="Morning brief"
            onCommit={(title) => onEdit({ title })}
          />

          {/*
            Free text, not a picker. This is the whole instruction, and it can
            describe things the ability list does not cover yet — which is the
            point, because the list grows and the sentence should not have to be
            rewritten when it does.
          */}
          <Field
            label="What it does"
            value={spark.instruction}
            placeholder="check my email for anything from Priya and tell me what she said"
            multiline
            onCommit={(instruction) => onEdit({ instruction })}
          />

          <Field
            label="What sets it off"
            value={describeTrigger(spark.trigger)}
            placeholder="every weekday at 8, or: when I say play my favourite song"
            help={'A time — “every weekday at half four” — or a phrase: “when I say wind down”.'}
            onCommit={(said) => {
              const schedule = parseSchedule(said);
              if (schedule) {
                onEdit({ trigger: { kind: 'schedule', schedule } });
                return;
              }
              const phrase = phraseTrigger(said) ?? said.replace(/^when(?:ever)? i say\s+/i, '');
              // Refusing beats silently keeping the old trigger, which would
              // leave the card showing a time nobody set.
              if (phrase.trim()) onEdit({ trigger: { kind: 'phrase', phrase: phrase.trim() } });
            }}
          />

          <Detail label="Reaches">
            {ability
              ? [ability.name, ...ability.needs].join(', ').replace(/-permission/g, ' access')
              : 'Worked out when it runs.'}
          </Detail>
          <Detail label="Runs">
            {spark.trigger.kind === 'phrase'
              ? 'When you say it, so Grove has to be listening.'
              : spark.schedulable
                ? 'On Noctus, at the stated time, whether or not your phone is awake.'
                : 'Only while Grove is running — it catches up next time you pick the phone up.'}
          </Detail>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Stop ${spark.title}`}
            onPress={onDelete}
            hitSlop={6}
            style={({ pressed }) => ({ paddingVertical: 12, opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={[Type.bodySm, { color: palette.alert }]}>Stop this</Text>
          </Pressable>
        </View>
      ) : null}
    </Card>
  );
}

/**
 * One editable line.
 *
 * Commits on blur rather than on every keystroke, so a half-typed time is never
 * parsed and saved as a trigger nobody meant.
 */
function Field({
  label,
  value,
  placeholder,
  help,
  multiline,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder: string;
  help?: string;
  multiline?: boolean;
  onCommit: (next: string) => void;
}) {
  const palette = usePalette();
  const [draft, setDraft] = useState(value);

  return (
    <View style={{ marginTop: 14 }}>
      <Mono style={{ marginBottom: 5 }}>{label}</Mono>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={() => {
          const next = draft.trim();
          if (next && next !== value) onCommit(next);
          else setDraft(value);
        }}
        placeholder={placeholder}
        placeholderTextColor={palette.muted}
        multiline={multiline}
        style={{
          backgroundColor: palette.sunken,
          borderWidth: 1,
          borderColor: palette.line,
          borderRadius: Radius.well,
          paddingHorizontal: 11,
          paddingVertical: 10,
          minHeight: multiline ? 68 : undefined,
          fontFamily: Type.body.fontFamily,
          fontSize: 14,
          lineHeight: 20,
          color: palette.ink,
        }}
      />
      {help ? (
        <Text style={[Type.bodySm, { color: palette.muted, marginTop: 5 }]}>{help}</Text>
      ) : null}
    </View>
  );
}

function Detail({ label, children }: { label: string; children: string }) {
  const palette = usePalette();
  return (
    <View style={{ marginTop: 14 }}>
      <Mono style={{ marginBottom: 3 }}>{label}</Mono>
      <Text style={[Type.bodySm, { color: palette.ink, lineHeight: 19 }]}>{children}</Text>
    </View>
  );
}
