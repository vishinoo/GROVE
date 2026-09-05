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
import { Pressable, Switch, Text, View } from 'react-native';

import { AppIcon, iconForKey, type AppIconName } from '@/components/app-icon';
import { Icon } from '@/components/icon';
import { Card, Dot, Empty, Mono, Screen, Section } from '@/components/ui';
import { Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { usePalette } from '@/hooks/use-palette';
import { ABILITIES, abilityById, type Ability } from '@/lib/abilities';
import { describeSchedule, type Spark } from '@/lib/sparks';

export default function Sparks() {
  const { sparks, setSparkEnabled, deleteSpark } = useAgent();

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
  onDelete,
}: {
  spark: Spark;
  onToggle: (next: boolean) => void;
  onDelete: () => void;
}) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);

  const ability = abilityById(spark.abilityId);
  const tiles = icons(ability);
  const args = Object.entries(spark.args).filter(([, v]) => v);

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
          <Detail label="You said">{spark.said}</Detail>
          <Detail label="Ability">{ability ? `${ability.name} — ${ability.id}` : spark.abilityId}</Detail>
          {args.length > 0 ? (
            <Detail label="Arguments">{args.map(([k, v]) => `${k}: ${v}`).join('\n')}</Detail>
          ) : null}
          <Detail label="Runs">
            {spark.schedulable
              ? 'On Noctus, at the stated time, whether or not your phone is awake.'
              : 'Only while Grove is running — it catches up next time you pick the phone up.'}
          </Detail>
          {spark.lastRun ? <Detail label="Last run">{spark.lastRun}</Detail> : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Stop ${spark.title}`}
            onPress={onDelete}
            hitSlop={6}
            style={({ pressed }) => ({ paddingVertical: 10, opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={[Type.bodySm, { color: palette.alert }]}>Stop this</Text>
          </Pressable>
        </View>
      ) : null}
    </Card>
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
