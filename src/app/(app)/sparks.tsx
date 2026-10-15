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

import { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';

import { Icon } from '@/components/icon';
import { MAP_SECTIONS, MemoryMap, type MapSection } from '@/components/memory-map';
import { Card, Peek, Screen, Section } from '@/components/ui';
import { SwipeAway } from '@/components/swipe-away';
import { Space, Type } from '@/constants/theme';
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
  const { activity, facts, editFact, forgetFact, life, forgetEntity, forgetEpisode, struggles, gotStruggle, forgetStruggle } =
    useAgent();
  // Goals and facts are shown apart because they are read differently: a goal
  // is something you check on, a fact is something you correct.
  const goals = facts.filter((f) => f.kind === 'goal');
  const plain = facts.filter((f) => f.kind !== 'goal');
  const stuck = struggles.filter((x) => !x.gotItAt);
  const owed = openCommitments(life);

  /*
    The map is the scrollbar.

    Each block reports where it starts; the scroll offset says which one you
    have reached, and that lights its wedge and cools the rest. Driving it off
    layout rather than a tab strip means the map can never disagree with the
    list — there is only one source of truth for where you are.
  */
  const { width } = useWindowDimensions();
  const [lit, setLit] = useState<MapSection>('did');
  const tops = useRef<Partial<Record<MapSection, number>>>({});

  const mark = (id: MapSection) => (event: LayoutChangeEvent) => {
    tops.current[id] = event.nativeEvent.layout.y;
  };

  const onScroll = (y: number) => {
    let current: MapSection = 'did';
    // Measured against a line below the pinned map, which is where a section
    // actually becomes the one you are looking at.
    for (const section of MAP_SECTIONS) {
      const top = tops.current[section.id];
      if (top !== undefined && top <= y + 230) current = section.id;
    }
    if (current !== lit) setLit(current);
  };

  const counts: Record<MapSection, number> = {
    did: activity.filter((entry) => entry.tool).length,
    open: goals.length + owed.length,
    repeats: stuck.length,
    people: life.entities.length,
    happened: life.episodes.length,
    about: plain.length,
  };

  return (
    <Screen
      title="Sparks"
      onScroll={onScroll}
      sticky={
        <MemoryMap counts={counts} active={lit} width={width - Space.screenX * 2} />
      }
    >

      <View onLayout={mark('did')}>
        <Done />
      </View>

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
      <View onLayout={mark('open')} />
      {goals.length > 0 || owed.length > 0 ? (
        <Peek label="Still to do" show={5}>
          {goals.map((fact) => (
            <SwipeAway key={fact.id} label={fact.value} onDelete={() => void forgetFact(fact.id)}>
              <FactCard fact={fact} onSave={(value) => void editFact(fact.id, value)} />
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
      <View onLayout={mark('repeats')} />
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
      <View onLayout={mark('people')} />
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
                <EntityCard entity={entity} />
              </SwipeAway>
            ))}
        </Peek>
      ) : null}

      <View onLayout={mark('happened')} />
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
      <View onLayout={mark('about')} />
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
                <FactCard fact={fact} onSave={(value) => void editFact(fact.id, value)} />
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
 * One remembered line, correctable in place.
 *
 * It used to be a disclosure: tap, and get the editor plus where the fact came
 * from, when it was first known, and a Forget link. All of that was one tap
 * away from a row whose whole content was already on screen — a panel of
 * metadata about a sentence you can already read.
 *
 * What is left is the one thing the panel was actually for. Speech gets names
 * wrong, so a fact has to be correctable; tapping the line turns it into a
 * field and blurring it saves. Deleting is a swipe, like everything else here.
 */
function FactCard({
  fact,
  onSave,
}: {
  fact: ReturnType<typeof useAgent>['facts'][number];
  onSave: (value: string) => void;
}) {
  const palette = usePalette();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(fact.value);

  // Follows the stored value: a later turn can rewrite a fact while this
  // screen is open, and the box should not sit there showing the old one.
  useEffect(() => setText(fact.value), [fact.value]);

  const commit = () => {
    setEditing(false);
    const next = text.trim();
    if (!next) {
      // Clearing the box is not a delete — that is the swipe. A blank line is
      // far more often a mistyped edit than an intention to erase something.
      setText(fact.value);
      return;
    }
    if (next !== fact.value) onSave(next);
  };

  return (
    <Card style={{ marginBottom: 8 }}>
      {editing ? (
        <TextInput
          value={text}
          onChangeText={(next) => setText(next.slice(0, VALUE_MAX))}
          onBlur={commit}
          onSubmitEditing={commit}
          autoFocus
          returnKeyType="done"
          multiline
          accessibilityLabel={`Correct: ${fact.value}`}
          style={{
            fontFamily: Type.body.fontFamily,
            fontSize: 15,
            lineHeight: 22,
            color: palette.ink,
            paddingVertical: 0,
          }}
        />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${fact.value}. Tap to correct.`}
          onPress={() => setEditing(true)}
          hitSlop={4}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={[Type.body, { color: palette.ink }]}>{fact.value}</Text>
        </Pressable>
      )}
    </Card>
  );
}

/**
 * A person, a project, a place — and what Grove has worked out about them.
 *
 * Everything it knows is on the card. It used to be a disclosure, with the
 * facts a tap away behind a summary line, which meant the most interesting
 * part of the long memory was the part you could not see: an assistant that
 * quietly believes something wrong about someone you see every week is worse
 * than one that remembers nothing, and it can only be corrected if it is
 * legible first.
 *
 * Stale facts are shown struck through rather than hidden. "Lives in Toronto"
 * superseded by "moved to Berlin" is the history of a person, and dropping it
 * is how you lose the reason the current answer is the current answer.
 */
function EntityCard({ entity }: { entity: LifeEntity }) {
  const palette = usePalette();
  const known = entity.facts.filter((f) => !f.stale);
  const stale = entity.facts.filter((f) => f.stale);

  return (
    <Card style={{ marginBottom: 8 }}>
      <Text style={[Type.cardTitle, { color: palette.ink }]}>
        {entity.name}
        {entity.relation ? ` · ${entity.relation}` : ''}
      </Text>
      <Text style={[Type.bodySm, { color: palette.muted, marginTop: 2 }]}>
        {entity.summary || `${entity.kind} · seen ${transcriptWhen(entity.lastSeen)}`}
      </Text>

      {known.slice(0, 6).map((f, i) => (
        <Text
          key={`${f.text}-${i}`}
          style={[Type.bodySm, { color: palette.inkSoft, marginTop: i === 0 ? 8 : 3 }]}
        >
          {f.text}
        </Text>
      ))}
      {stale.slice(0, 2).map((f, i) => (
        <Text
          key={`stale-${f.text}-${i}`}
          style={[
            Type.bodySm,
            { color: palette.muted, marginTop: 3, textDecorationLine: 'line-through' },
          ]}
        >
          {f.text}
        </Text>
      ))}
    </Card>
  );
}

function EpisodeRow({ episode, names }: { episode: LifeEpisode; names: string[] }) {
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
      </View>
    </Card>
  );
}

