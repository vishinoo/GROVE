/**
 * Sparks.
 *
 * This screen replaces the Noctus catalogue, and it is deliberately not a
 * catalogue. There is nothing to browse and nothing to install: a spark exists
 * because you said something with a recurrence in it, and the list is a record
 * of what you asked for rather than a shop.
 *
 * THE CARD
 *
 * Name, what it does, then a footer carrying when it runs and which apps it
 * reaches into. The name matters more than it looks: a spark used to show the
 * sentence someone spoke, which opens with "also" and carries the schedule
 * inside it, so every card read as a wall of truncated speech. What you said is
 * still kept — it moves into the detail, where it belongs, along with the
 * ability and the arguments pulled out of it.
 *
 * Tapping opens that detail rather than a separate screen, because it is three
 * facts and a sentence, and pushing a route for that is ceremony.
 *
 * Underneath sits the honest list of what Grove can do at all, including the
 * abilities that are declared but not built, greyed rather than hidden. An
 * assistant that quietly lacks a capability is worse than one that says so,
 * because you find out mid-walk.
 */

import { useState } from 'react';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';

import { AppIcon, iconForKey, type AppIconName } from '@/components/app-icon';
import { Icon } from '@/components/icon';
import { Card, Dot, Empty, Mono, Screen, Section } from '@/components/ui';
import { Radius, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { usePalette } from '@/hooks/use-palette';
import { ABILITIES, abilityById, type Ability } from '@/lib/abilities';
import { describeSchedule, parseSchedule, type Spark } from '@/lib/sparks';

export default function Sparks() {
  const { sparks, setSparkEnabled, editSpark, deleteSpark } = useAgent();

  return (
    <Screen
      title="Sparks"
      subtitle="Standing jobs. Ask for something with a time in it and it turns up here."
    >
      {sparks.length === 0 ? (
        <Empty
          text={'Nothing standing yet. Try “brief me on my watchlist every weekday morning”.'}
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

      <Section label="What Grove can do">
        {ABILITIES.map((ability) => (
          <AbilityRow key={ability.id} ability={ability} />
        ))}
      </Section>
    </Screen>
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
  onEdit: (patch: Partial<Pick<Spark, 'title' | 'abilityId' | 'schedule'>>) => void;
  onDelete: () => void;
}) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);

  const ability = abilityById(spark.abilityId);
  const tiles = icons(ability);

  return (
    <Card style={{ marginBottom: 8, paddingVertical: 0, paddingHorizontal: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${spark.title}. ${describeSchedule(spark.schedule)}. Tap for detail.`}
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => ({ padding: 13, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={[Type.cardTitle, { color: palette.ink }]} numberOfLines={1}>
              {spark.title}
            </Text>
            <Text style={[Type.bodySm, { color: palette.muted }]} numberOfLines={2}>
              {ability?.what ?? 'Waiting on an ability that is not built yet.'}
            </Text>
          </View>
          <Switch
            value={spark.enabled}
            onValueChange={onToggle}
            trackColor={{ true: palette.mark, false: palette.sunken }}
            thumbColor={palette.raised}
          />
        </View>

        {/* When it runs, and what it reaches into. */}
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
          <Text style={[Type.bodySm, { color: palette.inkSoft, flex: 1 }]}>
            {describeSchedule(spark.schedule)}
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
          {/*
            Editable, because a spark is built from one spoken sentence and
            speech is misheard. Without this the only repair for a wrong time is
            to delete the job and say the whole thing again.
          */}
          <Field
            label="Name"
            value={spark.title}
            placeholder="Morning brief"
            onCommit={(title) => onEdit({ title })}
          />

          <Field
            label="When"
            value={describeSchedule(spark.schedule)}
            placeholder="every weekday at 7"
            help="Say it how you would out loud — “every weekday at half four”."
            onCommit={(said) => {
              const schedule = parseSchedule(said);
              // Silently keeping the old schedule would be worse than refusing:
              // the card would show a time nobody set.
              if (schedule) onEdit({ schedule });
            }}
          />

          <Mono style={{ marginTop: 14, marginBottom: 5 }}>What it does</Mono>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {ABILITIES.filter((a) => a.wired).map((a) => {
              const on = a.id === spark.abilityId;
              return (
                <Pressable
                  key={a.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={a.name}
                  onPress={() => onEdit({ abilityId: a.id })}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingVertical: 7,
                    paddingHorizontal: 10,
                    borderRadius: Radius.pill,
                    backgroundColor: on ? palette.mark : palette.sunken,
                    borderWidth: 1,
                    borderColor: on ? palette.mark : palette.line,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Text
                    style={{
                      fontFamily: Type.cardTitle.fontFamily,
                      fontSize: 12.5,
                      color: on ? palette.raised : palette.ink,
                    }}
                  >
                    {a.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Detail label="Needs">
            {tiles.length > 0 || (ability?.needs.length ?? 0) > 0
              ? (ability?.needs ?? []).join(', ').replace(/-permission/g, ' access') || 'Nothing'
              : 'Nothing'}
          </Detail>
          <Detail label="You said">{spark.said}</Detail>
          <Detail label="Runs">
            {spark.schedulable
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
 * parsed and saved as a schedule nobody meant.
 */
function Field({
  label,
  value,
  placeholder,
  help,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder: string;
  help?: string;
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
        style={{
          backgroundColor: palette.sunken,
          borderWidth: 1,
          borderColor: palette.line,
          borderRadius: Radius.well,
          paddingHorizontal: 11,
          paddingVertical: 9,
          fontFamily: Type.body.fontFamily,
          fontSize: 14,
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
    <View style={{ marginTop: 12 }}>
      <Mono style={{ marginBottom: 3 }}>{label}</Mono>
      <Text style={[Type.bodySm, { color: palette.ink, lineHeight: 19 }]}>{children}</Text>
    </View>
  );
}

function AbilityRow({ ability }: { ability: Ability }) {
  const palette = usePalette();
  const tile = iconForKey(ability.id) ?? iconForKey(ability.name);

  return (
    <Card style={{ marginBottom: 8, opacity: ability.wired ? 1 : 0.55 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
        {tile ? <AppIcon name={tile} size={30} /> : <Dot tone={ability.wired ? 'live' : 'off'} />}
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[Type.cardTitle, { color: palette.ink }]}>{ability.name}</Text>
          <Text style={[Type.bodySm, { color: palette.muted }]}>{ability.what}</Text>
        </View>
        <Mono>
          {ability.wired ? (ability.where === 'device' ? 'on phone' : 'anywhere') : 'not built'}
        </Mono>
      </View>

      {/* Why it is not built, rather than leaving it greyed with no reason. */}
      {!ability.wired && ability.needs.length > 0 ? (
        <Text
          style={[
            Type.bodySm,
            {
              color: palette.muted,
              marginTop: 9,
              paddingTop: 9,
              borderTopWidth: 1,
              borderTopColor: palette.line,
            },
          ]}
        >
          Needs {ability.needs.join(', ').replace(/-permission/g, ' access')}.
        </Text>
      ) : null}
    </Card>
  );
}
