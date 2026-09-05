/**
 * Sparks.
 *
 * This screen replaces the Noctus catalogue, and it is deliberately not a
 * catalogue. There is nothing to browse and nothing to install: a spark exists
 * because you said something with a recurrence in it, and the list is a record
 * of what you asked for rather than a shop.
 *
 * Underneath sits the honest list of what Grove can do at all — including the
 * abilities that are declared but not built yet, greyed rather than hidden.
 * Same reasoning as the reduced-mode notice: an assistant that quietly lacks a
 * capability is worse than one that says so, because you find out mid-walk.
 */

import { Switch, Text, View } from 'react-native';

import { AppIcon, iconForKey } from '@/components/app-icon';
import { Icon } from '@/components/icon';
import { Card, Dot, Empty, Mono, Screen, Section } from '@/components/ui';
import { Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { usePalette } from '@/hooks/use-palette';
import { ABILITIES } from '@/lib/abilities';
import { describeSchedule } from '@/lib/sparks';

export default function Sparks() {
  const { sparks, setSparkEnabled, deleteSpark } = useAgent();

  return (
    <Screen
      title="Sparks"
      subtitle="Standing jobs. Ask for something with a time in it and it turns up here."
    >
      {sparks.length === 0 ? (
        <Empty text={'Nothing standing yet. Try “brief me on my watchlist every weekday morning”.'} />
      ) : (
        <Section>
          {sparks.map((spark) => (
            <SparkRow
              key={spark.id}
              said={spark.said}
              when={describeSchedule(spark.schedule)}
              schedulable={spark.schedulable}
              enabled={spark.enabled}
              onToggle={(next) => void setSparkEnabled(spark.id, next)}
              onDelete={() => void deleteSpark(spark.id)}
            />
          ))}
        </Section>
      )}

      <Section label="What Grove can do">
        {ABILITIES.map((ability) => (
          <AbilityRow
            key={ability.id}
            name={ability.name}
            what={ability.what}
            wired={ability.wired}
            onDevice={ability.where === 'device'}
          />
        ))}
      </Section>
    </Screen>
  );
}

function SparkRow({
  said,
  when,
  schedulable,
  enabled,
  onToggle,
  onDelete,
}: {
  said: string;
  when: string;
  schedulable: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  onDelete: () => void;
}) {
  const palette = usePalette();

  return (
    <Card style={{ marginBottom: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ paddingTop: 5 }}>
          <Dot tone={enabled ? 'live' : 'off'} />
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[Type.cardTitle, { color: palette.ink }]} numberOfLines={2}>
            {said}
          </Text>
          <Mono>{when}</Mono>
        </View>
        <Switch
          value={enabled}
          onValueChange={onToggle}
          trackColor={{ true: palette.mark, false: palette.sunken }}
          thumbColor={palette.paper}
        />
      </View>

      {/*
        The one thing this screen must not imply. A spark touching anything on
        the phone cannot run at a chosen moment — iOS will not wake Grove for
        it — so it catches up next time you pick the phone up, and saying that
        is the difference between a late briefing and a broken one.
      */}
      {!schedulable ? (
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
          <Icon name="alert" size={13} color={palette.muted} />
          <Text style={[Type.bodySm, { color: palette.muted, flex: 1 }]}>
            Needs Grove running, so it catches up when you next pick me up.
          </Text>
        </View>
      ) : null}

      <Text
        onPress={onDelete}
        accessibilityRole="button"
        style={[Type.bodySm, { color: palette.alert, marginTop: 10 }]}
      >
        Stop this
      </Text>
    </Card>
  );
}

function AbilityRow({
  name,
  what,
  wired,
  onDevice,
}: {
  name: string;
  what: string;
  wired: boolean;
  onDevice: boolean;
}) {
  const palette = usePalette();
  const tile = iconForKey(name);

  return (
    <Card style={{ marginBottom: 8, opacity: wired ? 1 : 0.55 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
        {tile ? <AppIcon name={tile} size={30} /> : <Dot tone={wired ? 'live' : 'off'} />}
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[Type.cardTitle, { color: palette.ink }]}>{name}</Text>
          <Text style={[Type.bodySm, { color: palette.muted }]}>{what}</Text>
        </View>
        <Mono>{wired ? (onDevice ? 'on phone' : 'anywhere') : 'not built'}</Mono>
      </View>
    </Card>
  );
}
