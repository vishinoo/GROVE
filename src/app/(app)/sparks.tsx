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
import { Pressable, Text, TextInput, View } from 'react-native';

import { Icon } from '@/components/icon';
import { Card, Mono, Peek, Screen, Section } from '@/components/ui';
import { SwipeAway } from '@/components/swipe-away';
import { Radius, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { usePalette } from '@/hooks/use-palette';
import { VALUE_MAX } from '@/lib/memory';
import {
  openCommitments,
  type Entity as LifeEntity,
  type Episode as LifeEpisode,
} from '@/lib/life';
import { shortDate } from '@/lib/when';
import { when as transcriptWhen } from '@/lib/transcript';

export default function Sparks() {
  const palette = usePalette();
  const { facts, editFact, forgetFact, life, forgetEntity, forgetEpisode, struggles, gotStruggle, forgetStruggle } =
    useAgent();
  // Goals and facts are shown apart because they are read differently: a goal
  // is something you check on, a fact is something you correct.
  const goals = facts.filter((f) => f.kind === 'goal');
  const plain = facts.filter((f) => f.kind !== 'goal');
  const stuck = struggles.filter((x) => !x.gotItAt);
  const owed = openCommitments(life);

  return (
    <Screen
      title="Sparks"
      subtitle="What Grove has done, and everything it keeps about you. Swipe any of it away."
    >

      <Done />

      {/*
        Goals and promises in one place, because the distinction was a
        filing decision rather than a real one. "Promised, not done" is a name
        only a database would choose; what both of these are is a thing you
        said you were going to do and have not. A goal is the long version and
        a commitment is the one with someone else waiting on it.

        A commitment cannot be swiped. It is closed by saying it is done — "I
        sent Jason the build" — which also marks it kept in the long memory,
        and swiping it would record nothing and quietly lose the thread.
      */}
      {goals.length > 0 || owed.length > 0 ? (
        <Peek label="Still to do" show={5}>
          {goals.map((fact) => (
            <SwipeAway key={fact.id} label={fact.value} onDelete={() => void forgetFact(fact.id)}>
              <FactCard
                fact={fact}
                onSave={(value) => void editFact(fact.id, value)}
                onForget={() => void forgetFact(fact.id)}
              />
            </SwipeAway>
          ))}
          {owed.map((e) => (
            <Card key={e.id} style={{ marginBottom: 8 }}>
              <Text style={[Type.body, { color: palette.ink }]}>{e.title}</Text>
              <Text style={[Type.bodySm, { color: palette.muted, marginTop: 2 }]}>
                Promised {shortDate(e.at)}
                {e.summary ? ` · ${e.summary}` : ''}
              </Text>
            </Card>
          ))}
        </Peek>
      ) : null}

      {/*
        The one list here that is about something you cannot do yet, which is
        why it is shown at all: a gap you can see is a gap you can close, and
        the count beside each one is the part no other app can tell you.
        Hidden when empty, like the inbox — a tutor with nothing to teach does
        not need a panel.
      */}
      {stuck.length > 0 ? (
        <Section label="Keeps tripping you up">
          {stuck.slice(0, 20).map((item) => (
            <SwipeAway key={item.id} label={item.what} onDelete={() => void forgetStruggle(item.id)}>
            <Card style={{ marginBottom: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${item.what} is no longer a problem`}
                  onPress={() => void gotStruggle(item.id)}
                  hitSlop={8}
                  style={({ pressed }) => ({ paddingTop: 1, opacity: pressed ? 0.5 : 1 })}
                >
                  <Icon name="check" size={15} color={palette.muted} />
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={[Type.body, { color: palette.ink }]}>{item.what}</Text>
                  <Text style={[Type.bodySm, { color: palette.muted, marginTop: 2 }]}>
                    {item.about ? `${item.about} · ` : ''}
                    {item.raised === 1 ? 'once' : `${item.raised} times`}
                  </Text>
                </View>
              </View>
            </Card>
            </SwipeAway>
          ))}
          <Text style={[Type.bodySm, { color: palette.muted, marginTop: 6 }]}>
            Tick one off once it stops happening, or swipe it away.
          </Text>
        </Section>
      ) : null}

      {/*
        Notes above memory, because they are what you made on purpose. Memory is
        what Grove picked up along the way.
      */}
      {/*
        What Grove has worked out on its own, rather than been told. It is the
        part of memory most worth being able to read: an assistant that quietly
        believes something wrong about a person you see every week is worse
        than one that remembers nothing.
      */}
      {life.entities.length > 0 ? (
        <Peek label="People and projects">
          {[...life.entities]
            .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
            .slice(0, 40)
            .map((entity) => (
              <SwipeAway
                key={entity.id}
                label={entity.name}
                onDelete={() => void forgetEntity(entity.id)}
              >
                <EntityCard
                  entity={entity}
                  episodes={life.episodes.filter((e) => e.about.includes(entity.id))}
                  onForget={() => void forgetEntity(entity.id)}
                  onForgetEpisode={(id) => void forgetEpisode(id)}
                />
              </SwipeAway>
            ))}
        </Peek>
      ) : null}

      {life.episodes.length > 0 ? (
        <Peek label="What happened">
          {life.episodes.slice(0, 15).map((episode) => (
            <SwipeAway
              key={episode.id}
              label={episode.title}
              onDelete={() => void forgetEpisode(episode.id)}
            >
            <EpisodeRow
              episode={episode}
              names={episode.about
                .map((id) => life.entities.find((e) => e.id === id)?.name)
                .filter((n): n is string => !!n)}
              onForget={() => void forgetEpisode(episode.id)}
            />
            </SwipeAway>
          ))}
        </Peek>
      ) : null}

      {/*
        The count on a Peek is its children, so an empty state cannot live
        inside one — "Facts about you · 1" over the words "nothing yet" is a
        lie told by a layout. Empty is its own section, and the trailing note
        about correcting a line only exists once there is a line to correct.
      */}
      {plain.length === 0 ? (
        <Section label="Facts about you">
          <Text style={[Type.bodySm, { color: palette.muted }]}>
            Nothing yet. Tell Grove something about yourself and it turns up here.
          </Text>
        </Section>
      ) : (
        <>
          <Peek label="Facts about you" show={3}>
            {plain.map((fact) => (
              <SwipeAway key={fact.id} label={fact.value} onDelete={() => void forgetFact(fact.id)}>
                <FactCard
                  fact={fact}
                  onSave={(value) => void editFact(fact.id, value)}
                  onForget={() => void forgetFact(fact.id)}
                />
              </SwipeAway>
            ))}
          </Peek>
          <Text style={[Type.bodySm, { color: palette.muted, marginTop: -14, marginBottom: 22 }]}>
            Open a line to correct it. Speech gets names wrong; this is where you fix that.
          </Text>
        </>
      )}

    </Screen>
  );
}

/**
 * What Grove has actually done for you.
 *
 * Everything else on this screen is what it knows. This is what it did — the
 * mail it sent, the events it moved, the documents it wrote, the reminders it
 * set — and until now the only place you could see any of that was the Talk
 * screen, where it scrolls away behind the next thing you say.
 *
 * It shows what is **still running** too, which is the half that matters while
 * it is happening: a document takes most of a minute to write, and during that
 * minute the only sign anything was going on was a screen that said "working".
 *
 * Only exchanges that actually did something. A conversation is not a log, and
 * filling this with "hey" and "thanks" would bury the five lines worth reading.
 */
function Done() {
  const palette = usePalette();
  const { activity } = useAgent();
  const ran = activity.filter((entry) => entry.tool);
  if (ran.length === 0) return null;

  return (
    <Peek label="What it did" show={5}>
      {ran.map((entry) => {
        const tool = entry.tool!;
        const failed = tool.state === 'failed' || tool.state === 'blocked';
        const running = tool.state === 'running';
        return (
          <Card key={entry.id} style={{ marginBottom: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 9 }}>
              <View
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: 4,
                  marginTop: 6,
                  backgroundColor: failed ? palette.alert : running ? palette.muted : palette.signal,
                }}
              />
              <View style={{ flex: 1 }}>
                <Text style={[Type.body, { color: palette.ink }]} numberOfLines={3}>
                  {tool.detail || entry.replied || tool.name}
                </Text>
                <Text style={[Type.bodySm, { color: palette.muted, marginTop: 3 }]}>
                  {tool.name}
                  {running ? ' · still going' : failed ? ` · ${tool.state}` : ''} ·{' '}
                  {transcriptWhen(entry.at)}
                </Text>
              </View>
            </View>
          </Card>
        );
      })}
    </Peek>
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
  onSave,
  onForget,
}: {
  fact: ReturnType<typeof useAgent>['facts'][number];
  onSave: (value: string) => void;
  onForget: () => void;
}) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(fact.value);

  // Follows the stored value: a later turn can rewrite a fact while this screen
  // is open, and the box should not sit there showing the old one.
  useEffect(() => setText(fact.value), [fact.value]);

  const commit = () => {
    const next = text.trim();
    if (!next) {
      // Clearing the box is not a delete. "Forget this" is, and it is right
      // below — a blank line is far more often a mistyped edit than an
      // intention to erase something.
      setText(fact.value);
      return;
    }
    if (next !== fact.value) onSave(next);
  };

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
          <Text style={[Type.bodySm, { color: palette.muted, marginTop: 11, marginBottom: 2 }]}>
            {fact.kind === 'goal' ? 'The goal' : 'What Grove wrote down'}
          </Text>
          <TextInput
            value={text}
            onChangeText={(next) => setText(next.slice(0, VALUE_MAX))}
            onBlur={commit}
            onSubmitEditing={commit}
            returnKeyType="done"
            multiline
            accessibilityLabel={`${fact.value}. Edit to correct it.`}
            style={{
              fontFamily: Type.body.fontFamily,
              fontSize: 14.5,
              lineHeight: 21,
              color: palette.ink,
              paddingVertical: 8,
              paddingHorizontal: 10,
              borderWidth: 1,
              borderColor: palette.line,
              borderRadius: Radius.well,
              marginBottom: 4,
            }}
          />
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

function EntityCard({
  entity,
  episodes,
  onForget,
  onForgetEpisode,
}: {
  entity: LifeEntity;
  episodes: LifeEpisode[];
  onForget: () => void;
  onForgetEpisode: (id: string) => void;
}) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  const known = entity.facts.filter((f) => !f.stale);
  const stale = entity.facts.filter((f) => f.stale);

  return (
    <Card style={{ marginBottom: 8, paddingHorizontal: 0, paddingVertical: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${entity.name}. Tap to ${open ? 'close' : 'open'}.`}
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => ({ padding: 13, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={[Type.cardTitle, { color: palette.ink }]} numberOfLines={open ? undefined : 1}>
              {entity.name}
              {entity.relation ? ` · ${entity.relation}` : ''}
            </Text>
            <Text style={[Type.bodySm, { color: palette.muted, marginTop: 2 }]} numberOfLines={open ? undefined : 1}>
              {entity.summary || `${entity.kind} · seen ${transcriptWhen(entity.lastSeen)}`}
            </Text>
          </View>
          <Icon name={open ? 'down' : 'chevron'} size={13} color={palette.muted} />
        </View>
      </Pressable>

      {open ? (
        <View style={{ paddingHorizontal: 13, paddingBottom: 13, gap: 10, borderTopWidth: 1, borderTopColor: palette.line }}>
          {known.length > 0 ? (
            <View style={{ gap: 4, marginTop: 10 }}>
              <Text style={[Type.bodySm, { color: palette.muted }]}>What Grove knows</Text>
              {known.map((fact, i) => (
                <Text key={i} style={[Type.body, { color: palette.ink }]}>{`\u2022 ${fact.text}`}</Text>
              ))}
            </View>
          ) : null}

          {episodes.length > 0 ? (
            <View style={{ gap: 4 }}>
              <Text style={[Type.bodySm, { color: palette.muted }]}>History</Text>
              {episodes.slice(0, 10).map((episode) => (
                <Pressable
                  key={episode.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${episode.title}`}
                  onLongPress={() => onForgetEpisode(episode.id)}
                  style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
                >
                  <Text style={[Type.bodySm, { color: palette.inkSoft }]}>
                    {`${shortDate(episode.at)} · ${episode.title}${episode.open ? ' (outstanding)' : ''}`}
                  </Text>
                </Pressable>
              ))}
              <Text style={[Type.bodySm, { color: palette.muted }]}>Hold a line to delete it.</Text>
            </View>
          ) : null}

          {stale.length > 0 ? (
            <View style={{ gap: 4 }}>
              <Text style={[Type.bodySm, { color: palette.muted }]}>No longer true</Text>
              {stale.map((fact, i) => (
                <Text key={i} style={[Type.bodySm, { color: palette.muted }]}>{`\u2022 ${fact.text}`}</Text>
              ))}
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Forget ${entity.name}`}
            onPress={onForget}
            hitSlop={6}
            style={({ pressed }) => ({ paddingVertical: 6, opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={[Type.bodySm, { color: palette.alert }]}>Forget {entity.name}</Text>
          </Pressable>
        </View>
      ) : null}
    </Card>
  );
}

function EpisodeRow({
  episode,
  names,
  onForget,
}: {
  episode: LifeEpisode;
  names: string[];
  onForget: () => void;
}) {
  const palette = usePalette();
  return (
    <Card style={{ marginBottom: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={[Type.body, { color: palette.ink }]}>
            {episode.title}
            {episode.open ? ' · outstanding' : ''}
          </Text>
          <Text style={[Type.bodySm, { color: palette.muted, marginTop: 2 }]}>
            {shortDate(episode.at)}
            {names.length > 0 ? ` · ${names.join(', ')}` : ''}
          </Text>
          {episode.summary ? (
            <Text style={[Type.bodySm, { color: palette.inkSoft, marginTop: 4 }]}>{episode.summary}</Text>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Delete ${episode.title}`}
          onPress={onForget}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, paddingTop: 2 })}
        >
          <Text style={[Type.bodySm, { color: palette.alert }]}>Delete</Text>
        </Pressable>
      </View>
    </Card>
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
