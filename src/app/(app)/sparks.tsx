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
import { Button, Card, Empty, Mono, Screen, Section } from '@/components/ui';
import { Radius, Type } from '@/constants/theme';
import { useAgent } from '@/context/agent';
import { useSession } from '@/context/session';
import { usePalette } from '@/hooks/use-palette';
import { abilityById, type Ability } from '@/lib/abilities';
import { describeTrigger, parseSchedule, phraseTrigger, type Spark } from '@/lib/sparks';
import { MODES, loadOverrides, setOnEnter, type Mode } from '@/lib/modes';
import { VALUE_MAX } from '@/lib/memory';
import type { Note as NoteItem } from '@/lib/notes';
import type { Entity as LifeEntity, Episode as LifeEpisode } from '@/lib/life';
import { open as openCaptures, remaining } from '@/lib/inbox';
import { asMoney, forgetPurchase, loadMoney, standing, type Money } from '@/lib/money';
import { shortDate } from '@/lib/when';
import { when as transcriptWhen } from '@/lib/transcript';

export default function Sparks() {
  const palette = usePalette();
  const { captures, tickOff, dropCapture, focus, endFocus, sparks, setSparkEnabled, editSpark, deleteSpark, facts, editFact, forgetFact, forgetEverything, notes, forgetNote, life, forgetEntity, forgetEpisode, struggles, gotStruggle, forgetStruggle, persona, updatePersona } =
    useAgent();
  const waiting = openCaptures(captures);
  // Goals and facts are shown apart because they are read differently: a goal
  // is something you check on, a fact is something you correct.
  const goals = facts.filter((f) => f.kind === 'goal');
  const plain = facts.filter((f) => f.kind !== 'goal');
  const stuck = struggles.filter((x) => !x.gotItAt);


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
      {/*
        The inbox first, because it is the one list that is meant to be emptied.
        Everything else on this screen is a record; this is a queue.
      */}
      {focus ? (
        <Card style={{ marginBottom: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={[Type.cardTitle, { color: palette.ink }]}>Focused on {focus.what}</Text>
              <Text style={[Type.bodySm, { color: palette.muted, marginTop: 2 }]}>
                {remaining(focus) || `since ${new Date(focus.startedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`}
                . Anything else gets caught for later.
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="End the focus session"
              onPress={() => void endFocus()}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
            >
              <Text style={[Type.bodySm, { color: palette.alert }]}>End</Text>
            </Pressable>
          </View>
        </Card>
      ) : null}

      {/*
        Shown only when there is something in it. An empty queue with a
        paragraph explaining itself is the ugliest thing on this screen, and the
        feature explains itself the first time you say "I have to do the dishes".
      */}
      {waiting.length > 0 ? (
        <Section label="Inbox">
          {waiting.slice(0, 30).map((item) => (
            <Card key={item.id} style={{ marginBottom: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Tick off ${item.text}`}
                  onPress={() => void tickOff(item.id)}
                  hitSlop={8}
                  style={({ pressed }) => ({ paddingTop: 1, opacity: pressed ? 0.5 : 1 })}
                >
                  <Icon name="check" size={15} color={palette.muted} />
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={[Type.body, { color: palette.ink }]}>{item.text}</Text>
                  <Text style={[Type.bodySm, { color: palette.muted, marginTop: 2 }]}>
                    {transcriptWhen(item.at)}
                    {item.during ? ` · caught during ${item.during}` : ''}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${item.text}`}
                  onPress={() => void dropCapture(item.id)}
                  hitSlop={8}
                  style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
                >
                  <Text style={[Type.bodySm, { color: palette.alert }]}>Delete</Text>
                </Pressable>
              </View>
            </Card>
          ))}
        </Section>
      ) : null}

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
      <Section label="Goals">
        {goals.length === 0 ? (
          <Card>
            <Text style={[Type.bodySm, { color: palette.muted }]}>
              Nothing yet. Say &ldquo;I want to learn Spanish&rdquo; or &ldquo;I&rsquo;m saving for a
              deposit&rdquo; and it is kept here. Goals are held apart from everything else and are
              never dropped to make room.
            </Text>
          </Card>
        ) : (
          goals.map((fact) => (
            <FactCard
              key={fact.id}
              fact={fact}
              onSave={(value) => void editFact(fact.id, value)}
              onForget={() => void forgetFact(fact.id)}
            />
          ))
        )}
      </Section>

      <Spending />

      {/*
        The one list here that is about something you cannot do yet, which is
        why it is shown at all: a gap you can see is a gap you can close, and
        the count beside each one is the part no other app can tell you.
        Hidden when empty, like the inbox — a tutor with nothing to teach does
        not need a panel.
      */}
      {stuck.length > 0 ? (
        <Section label="Not clicking yet">
          {stuck.slice(0, 20).map((item) => (
            <Card key={item.id} style={{ marginBottom: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`I understand ${item.what} now`}
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
                    {item.right > 0 ? ' · one right answer so far' : ''}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${item.what}`}
                  onPress={() => void forgetStruggle(item.id)}
                  hitSlop={8}
                  style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
                >
                  <Text style={[Type.bodySm, { color: palette.alert }]}>Delete</Text>
                </Pressable>
              </View>
            </Card>
          ))}
          <Text style={[Type.bodySm, { color: palette.muted, marginTop: 6 }]}>
            Say &ldquo;quiz me&rdquo; and these are the questions. Two right answers in a row and
            one comes off the list.
          </Text>
        </Section>
      ) : null}

      {/*
        Notes above memory, because they are what you made on purpose. Memory is
        what Grove picked up along the way.
      */}
      <Section label="Notes">
        {notes.length === 0 ? (
          <Card>
            <Text style={[Type.bodySm, { color: palette.muted }]}>
              Say &ldquo;listen to this&rdquo; and talk. Press when you are done, and it turns into
              a note here — summary, points and anything you need to do.
            </Text>
          </Card>
        ) : (
          notes.slice(0, 20).map((note) => (
            <NoteCard key={note.id} note={note} onForget={() => void forgetNote(note.id)} />
          ))
        )}
      </Section>

      {/*
        What Grove has worked out on its own, rather than been told. It is the
        part of memory most worth being able to read: an assistant that quietly
        believes something wrong about a person you see every week is worse
        than one that remembers nothing.
      */}
      <Section label="People and projects">
        {life.entities.length === 0 ? (
          <Card>
            <Text style={[Type.bodySm, { color: palette.muted }]}>
              Nothing yet. As you talk, log meetings and take notes, Grove builds up who and what
              is in your life here — and what happened, with dates. Everything in here can be
              deleted.
            </Text>
          </Card>
        ) : (
          [...life.entities]
            .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
            .slice(0, 40)
            .map((entity) => (
              <EntityCard
                key={entity.id}
                entity={entity}
                episodes={life.episodes.filter((e) => e.about.includes(entity.id))}
                onForget={() => void forgetEntity(entity.id)}
                onForgetEpisode={(id) => void forgetEpisode(id)}
              />
            ))
        )}
      </Section>

      {life.episodes.length > 0 ? (
        <Section label="What happened">
          {life.episodes.slice(0, 15).map((episode) => (
            <EpisodeRow
              key={episode.id}
              episode={episode}
              names={episode.about
                .map((id) => life.entities.find((e) => e.id === id)?.name)
                .filter((n): n is string => !!n)}
              onForget={() => void forgetEpisode(episode.id)}
            />
          ))}
        </Section>
      ) : null}

      <Section label="Memory">
        {plain.length === 0 ? (
          <Card>
            <Text style={[Type.bodySm, { color: palette.muted }]}>
              Nothing yet. Tell Grove something about yourself — where you live, when you leave
              for work — and it turns up here, where you can read it, correct it and delete it.
            </Text>
          </Card>
        ) : (
          plain.map((fact) => (
            <FactCard
              key={fact.id}
              fact={fact}
              onSave={(value) => void editFact(fact.id, value)}
              onForget={() => void forgetFact(fact.id)}
            />
          ))
        )}
        {facts.length > 0 ? (
          <>
            <Text style={[Type.bodySm, { color: palette.muted, marginTop: 9 }]}>
              Open a line to correct it. Speech gets names wrong; this is where you fix that.
            </Text>
            <Button
              label="Forget everything"
              tone="quiet"
              onPress={() => void forgetEverything()}
              style={{ marginTop: 10 }}
            />
          </>
        ) : null}
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
              mode.id === 'focus' ? 'put on something instrumental and tell me what is left today' : 'nothing, unless you say so'
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

/**
 * The ledger, where you can see it.
 *
 * Same rule as everything else on this screen: a memory you cannot see is one
 * you cannot correct, and money is the memory where a wrong entry does the most
 * damage — one mistyped amount and every piece of advice after it is arithmetic
 * about a number that never happened. So every line here can be deleted.
 *
 * Read on mount rather than held in the agent context, because nothing else on
 * screen depends on it and spending changes a few times a day at most.
 */
function Spending() {
  const palette = usePalette();
  const { uid } = useSession();
  const [money, setMoney] = useState<Money | null>(null);

  useEffect(() => {
    let alive = true;
    void loadMoney(uid).then((m) => {
      if (alive) setMoney(m);
    });
    return () => {
      alive = false;
    };
  }, [uid]);

  if (!money || (money.purchases.length === 0 && money.monthly === undefined)) return null;
  const s = standing(money);
  const c = money.currency;

  return (
    <Section label="Spending">
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text style={[Type.screenTitle, { color: palette.ink }]}>{asMoney(s.thisMonth, c)}</Text>
          <Text style={[Type.bodySm, { color: palette.muted, flex: 1 }]}>
            this month
            {s.left === null ? '' : ` · ${asMoney(s.left, c)} left of ${asMoney(money.monthly ?? 0, c)}`}
          </Text>
        </View>
        {s.byCategory.length > 0 ? (
          <Text style={[Type.bodySm, { color: palette.inkSoft, marginTop: 6 }]}>
            {s.byCategory
              .slice(0, 4)
              .map((g) => `${g.category} ${asMoney(g.amount, c)}`)
              .join(' · ')}
          </Text>
        ) : null}
        {s.usualMonth !== null ? (
          <Text style={[Type.bodySm, { color: palette.muted, marginTop: 4 }]}>
            A normal month for you is about {asMoney(s.usualMonth, c)}.
          </Text>
        ) : null}
      </Card>

      {money.purchases.slice(0, 10).map((p) => (
        <Card key={p.id} style={{ marginTop: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={[Type.body, { color: palette.ink }]}>{p.what}</Text>
              <Text style={[Type.bodySm, { color: palette.muted, marginTop: 2 }]}>
                {shortDate(p.at)}
                {p.category ? ` · ${p.category}` : ''}
              </Text>
            </View>
            <Text style={[Type.cardTitle, { color: palette.ink }]}>{asMoney(p.amount, c)}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Delete ${p.what}`}
              onPress={() => void forgetPurchase(uid, p.id).then(setMoney)}
              hitSlop={8}
              style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
            >
              <Icon name="trash" size={15} color={palette.alert} />
            </Pressable>
          </View>
        </Card>
      ))}
      <Text style={[Type.bodySm, { color: palette.muted, marginTop: 6 }]}>
        Say what you spent and it lands here. &ldquo;Should I buy this?&rdquo; is answered against
        these numbers, and nothing in Grove can spend any of it.
      </Text>
    </Section>
  );
}

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

/**
 * A voice note, closed to its title and opened to everything.
 *
 * Closed, a list of titles and dates is the archive. Open, the summary and the
 * actions come first because they are what the note is for, and the transcript
 * last because it is only needed when the summary is wrong.
 */
function NoteCard({ note, onForget }: { note: NoteItem; onForget: () => void }) {
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  const when = new Date(note.createdAt).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const length = note.seconds >= 60 ? `${Math.round(note.seconds / 60)} min` : `${note.seconds}s`;

  return (
    <Card style={{ marginBottom: 8, paddingHorizontal: 0, paddingVertical: 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${note.title}, ${when}. Tap to ${open ? 'close' : 'open'}.`}
        onPress={() => setOpen((was) => !was)}
        style={({ pressed }) => ({ padding: 13, opacity: pressed ? 0.7 : 1 })}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={[Type.cardTitle, { color: palette.ink }]} numberOfLines={open ? undefined : 1}>
              {note.title}
            </Text>
            <Text style={[Type.bodySm, { color: palette.muted, marginTop: 2 }]}>
              {when} · {length}
              {note.actions.length > 0
                ? ` · ${note.actions.length} to do`
                : ''}
            </Text>
          </View>
          <Icon name={open ? 'down' : 'chevron'} size={13} color={palette.muted} />
        </View>
      </Pressable>

      {open ? (
        <View style={{ paddingHorizontal: 13, paddingBottom: 13, gap: 10, borderTopWidth: 1, borderTopColor: palette.line }}>
          {note.summary ? (
            <Text style={[Type.body, { color: palette.ink, marginTop: 10 }]}>{note.summary}</Text>
          ) : null}

          {note.actions.length > 0 ? (
            <View style={{ gap: 4 }}>
              <Text style={[Type.bodySm, { color: palette.muted }]}>To do</Text>
              {note.actions.map((action, i) => (
                <Text key={i} style={[Type.body, { color: palette.ink }]}>
                  {`\u2022 ${action}`}
                </Text>
              ))}
            </View>
          ) : null}

          {note.points.length > 0 ? (
            <View style={{ gap: 4 }}>
              <Text style={[Type.bodySm, { color: palette.muted }]}>Points</Text>
              {note.points.map((point, i) => (
                <Text key={i} style={[Type.bodySm, { color: palette.inkSoft }]}>
                  {`\u2022 ${point}`}
                </Text>
              ))}
            </View>
          ) : null}

          <View style={{ gap: 4 }}>
            <Text style={[Type.bodySm, { color: palette.muted }]}>What you said</Text>
            <Text selectable style={[Type.bodySm, { color: palette.inkSoft }]}>
              {note.transcript}
            </Text>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Delete the note ${note.title}`}
            onPress={onForget}
            hitSlop={6}
            style={({ pressed }) => ({ paddingVertical: 6, opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={[Type.bodySm, { color: palette.alert }]}>Delete note</Text>
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
