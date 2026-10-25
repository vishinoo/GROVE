/**
 * A line of the log, used by Settings → Logs.
 */

import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { AppIcon, iconForKey } from '@/components/app-icon';
import { Icon } from '@/components/icon';
import { Card, Dot, Mono } from '@/components/ui';
import { Type } from '@/constants/theme';
import { usePalette } from '@/hooks/use-palette';
import { when, type Entry } from '@/lib/transcript';

/**
 * Which connection an ability went through, named the way the person knows
 * it — "Calendar", not "calendar.add". Ability ids are "area.verb", and the
 * area is the connection; anything unrecognised is shown as its area,
 * capitalised, rather than hidden.
 */
const CONNECTION: Record<string, string> = {
  calendar: 'Calendar',
  gcal: 'Calendar',
  mail: 'Gmail',
  email: 'Gmail',
  doc: 'Google Docs',
  contacts: 'Contacts',
  contact: 'Contacts',
  call: 'Phone',
  mac: 'Your Mac',
  remind: 'Reminders',
  reminders: 'Reminders',
  music: 'Music',
  brief: 'Web search',
  web: 'Web search',
  weather: 'Weather',
  maps: 'Maps',
  route: 'Maps',
  message: 'Messages',
  memory: 'Memory',
  person: 'Memory',
  ride: 'Uber',
  food: 'Food delivery',
  shop: 'Shopping',
  now: 'Your day',
  day: 'Your day',
  focus: 'Focus',
};

export function connectionFor(ability: string): string {
  const area = ability.split(/[._]/)[0].toLowerCase();
  return CONNECTION[area] ?? area.charAt(0).toUpperCase() + area.slice(1);
}

/**
 * One exchange, and what came of it.
 *
 * Collapsed to the two lines that matter — what you said, what happened — and
 * expanding to the rest. This is the only record that anything happened at all:
 * it all took place while you were looking somewhere else, so "did that
 * reminder actually get set" is a question with no other way to answer it.
 */
export function LogRow({ entry }: { entry: Entry }) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);

  const tool = entry.tool;
  const icon = tool ? iconForKey(tool.name) : null;
  const failed = tool?.state === 'failed' || tool?.state === 'blocked';

  return (
    <Card style={{ marginBottom: 8, paddingHorizontal: 0, paddingVertical: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${entry.said}. Tap for detail.`}
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => ({ padding: 13, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
          {icon ? <AppIcon name={icon} size={30} /> : null}
          <View style={{ flex: 1, gap: 3 }}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Text style={[Type.bodySm, { color: palette.muted, flex: 1 }]} numberOfLines={1}>
                {entry.said}
              </Text>
              <Mono>{when(entry.at)}</Mono>
            </View>
            <Text style={[Type.body, { color: palette.ink }]} numberOfLines={open ? undefined : 2}>
              {tool?.detail ?? entry.replied}
            </Text>
          </View>
        </View>

        {/* A run that failed is the thing you most need to see, so it is on the
            collapsed card rather than hidden one tap away. */}
        {tool ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              marginTop: 10,
              paddingTop: 10,
              borderTopWidth: 1,
              borderTopColor: palette.line,
            }}
          >
            <Dot tone={failed ? 'alert' : tool.state === 'done' ? 'live' : 'off'} />
            <Text style={[Type.bodySm, { color: palette.inkSoft, flex: 1 }]}>
              {connectionFor(tool.name)}
              <Text style={{ color: palette.muted }}>
                {tool.state === 'done'
                  ? ''
                  : tool.state === 'running'
                    ? ' · running'
                    : tool.state === 'blocked'
                      ? ' · needed permission'
                      : ' · failed'}
              </Text>
            </Text>
            <Icon name={open ? 'down' : 'chevron'} size={13} color={palette.muted} />
          </View>
        ) : null}
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
          <LogLine label="You said">{entry.said}</LogLine>
          <LogLine label="Grove said">{entry.replied}</LogLine>
          {tool ? <LogLine label="Ability">{`${tool.name} — ${tool.state}`}</LogLine> : null}
          {tool?.detail ? <LogLine label="Result">{tool.detail}</LogLine> : null}
          {tool?.needs?.length ? (
            <LogLine label="Needed">
              {tool.needs.join(', ').replace(/-permission/g, ' access')}
            </LogLine>
          ) : null}
          <LogLine label="When">{new Date(entry.at).toLocaleString()}</LogLine>
        </View>
      ) : null}
    </Card>
  );
}

function LogLine({ label, children }: { label: string; children: string }) {
  const palette = usePalette();
  return (
    <View style={{ marginTop: 12 }}>
      <Mono style={{ marginBottom: 3 }}>{label}</Mono>
      <Text style={[Type.bodySm, { color: palette.ink, lineHeight: 19 }]}>{children}</Text>
    </View>
  );
}

