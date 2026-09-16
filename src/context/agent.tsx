/**
 * Grove, running.
 *
 * One machine that owns the whole conversation: the ring wakes it, the
 * microphone fills it, the brain answers, the glasses speak. Screens read its
 * state and call `press()`; nothing else in the app touches speech, the
 * trigger or the audio session directly.
 *
 * The state is a genuine lifecycle rather than a flag, because it is the only
 * feedback a user gets when they are not looking at the phone:
 *
 *   asleep     not resident — the ring cannot reach us
 *   idle       resident, waiting for a press
 *   listening  microphone open
 *   thinking   the brain has the sentence
 *   speaking   audio is actually playing
 *   working    a tool is running on Noctus after Grove already replied
 *
 * Two behaviours are deliberate and worth not undoing:
 *
 *   BARGE-IN. A press while Grove is speaking stops it dead and opens the
 *   microphone. Waiting politely for an assistant to finish a sentence you have
 *   already understood is the single most irritating thing about talking to
 *   one, and the fix costs one branch.
 *
 *   REPLY BEFORE RUN. Grove speaks first and runs the tool second. A Noctus
 *   run can take ten seconds; ten seconds of silence in your ear reads as a
 *   crash, so the acknowledgement goes out immediately and the outcome is
 *   spoken when it arrives.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { capabilities } from '@/lib/capabilities';
import {
  abilityById,
  runAbility,
  setCurrentAccount,
  setModeHandler,
  type Ability,
} from '@/lib/abilities';
import { loadOverrides, maySpeak, modeById, withOverrides } from '@/lib/modes';
import { askGrove, detectActIntent, newTurn, type Turn, type TurnTool } from '@/lib/grove';
import { abortListening, isListening, startListening, stopListening } from '@/lib/listen';
import {
  DEFAULT_PERSONA,
  fallback,
  holdingFor,
  loadPersona,
  savePersona,
  type Persona,
} from '@/lib/persona';
import { isSpeaking, speak, stopSpeaking } from '@/lib/speak';
import { lightNotes } from '@/lib/lightModel';
import * as memory from '@/lib/memory';
import * as notesStore from '@/lib/notes';
import * as sparks from '@/lib/sparks';
import * as transcript from '@/lib/transcript';
import * as trigger from '@/lib/trigger';
import { useSession } from './session';

/**
 * How long a listen may hear nothing before it gives up.
 *
 * A recogniser left open on silence is worse than one that closes: it holds
 * the microphone, keeps the UI claiming to listen, and on this hardware the
 * only way out was another press. Five seconds is long enough to gather
 * yourself after pressing and short enough that an accidental trigger in a
 * pocket does not sit there listening.
 */
const SILENCE_TIMEOUT_MS = 5000;

export type AgentState =
  | 'asleep'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'working'
  /** Taking a voice note: listening at length, and not replying to any of it. */
  | 'noting';

type AgentValue = {
  state: AgentState;
  /** What Grove last said, or what it is hearing. Shown large on Talk. */
  caption: string;
  /** The live partial transcript while listening. */
  heard: string;
  /** Microphone level, 0–1, for the trigger's animation. */
  level: number;
  /** Whether the ring can currently reach Grove. */
  armed: boolean;
  /** A ring has actually pressed something, so hardware is really there. */
  ringSeen: boolean;
  /** The live audio route — the glasses, when they're on. */
  route: trigger.AudioRoute;
  /** Something the user should know about, e.g. a denied microphone. */
  problem: string | null;

  persona: Persona;
  updatePersona: (next: Persona) => Promise<void>;

  activity: transcript.Entry[];
  clearActivity: () => Promise<void>;
  /** Everything Grove holds about you, gone. */
  startAgain: () => Promise<void>;

  /** The small set of durable facts Grove keeps. Readable and deletable. */
  facts: memory.Fact[];
  /** Correct a fact Grove wrote down wrong. */
  editFact: (id: string, value: string) => Promise<void>;
  forgetFact: (id: string) => Promise<void>;
  forgetEverything: () => Promise<void>;

  /** Standing jobs, newest first. */
  sparks: sparks.Spark[];
  setSparkEnabled: (id: string, enabled: boolean) => Promise<void>;
  editSpark: (id: string, patch: Parameters<typeof sparks.editSpark>[2]) => Promise<void>;
  deleteSpark: (id: string) => Promise<void>;

  /** Voice notes, newest first. */
  notes: notesStore.Note[];
  forgetNote: (id: string) => Promise<void>;

  /** The trigger, however it was pressed — ring, screen or keyboard. */
  press: () => void;
  /** Skip the microphone entirely. Used by the typed fallback. */
  say: (text: string) => Promise<void>;
};

const AgentContext = createContext<AgentValue | null>(null);

export function useAgent(): AgentValue {
  const value = useContext(AgentContext);
  if (!value) throw new Error('useAgent must be used inside <AgentProvider>');
  return value;
}

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const { status, uid } = useSession();

  const [state, setRenderedState] = useState<AgentState>('asleep');

  /**
   * The state as of the last thing that changed it, not the last render.
   *
   * React batches, so a ref filled during render is one press behind: tap to
   * start listening and tap again quickly, and the second press reads the state
   * from before the first took effect and takes the wrong branch. That is the
   * whole of "the clicks are not coordinated" — the handler was working from a
   * picture of the app that was a few milliseconds stale, which is exactly the
   * window in which someone double-taps.
   */
  const stateNow = useRef<AgentState>('asleep');

  const setState = useCallback(
    (next: AgentState | ((current: AgentState) => AgentState)) => {
      const resolved = typeof next === 'function' ? next(stateNow.current) : next;
      stateNow.current = resolved;
      setRenderedState(resolved);
    },
    []
  );
  const [caption, setCaption] = useState('');
  const [heard, setHeard] = useState('');
  const [level, setLevel] = useState(0);
  const [armed, setArmed] = useState(false);
  /** Set once a real press arrives, which is the only proof a ring exists. */
  const [ringSeen, setRingSeen] = useState(() => trigger.hasHeardRing());
  const [route, setRoute] = useState<trigger.AudioRoute>(() => trigger.currentRoute());
  const [problem, setProblem] = useState<string | null>(null);
  const [persona, setPersona] = useState<Persona>(DEFAULT_PERSONA);
  const [activity, setActivity] = useState<transcript.Entry[]>([]);
  const [facts, setFacts] = useState<memory.Fact[]>([]);
  const [noteList, setNoteList] = useState<notesStore.Note[]>([]);

  /**
   * The voice note being taken, if one is.
   *
   * Speech arrives in sessions, because iOS ends a recognition task on its own
   * schedule however long someone is still talking. `committed` is every
   * session that has ended; `buffer` is the one still running. A note is both,
   * joined — which is what lets a five-minute ramble survive the recogniser
   * restarting under it three times.
   */
  const memo = useRef<{
    committed: string[];
    buffer: string;
    startedAt: number;
    finishing: boolean;
    endTimer: ReturnType<typeof setTimeout> | null;
    quietTimer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const [sparkList, setSparkList] = useState<sparks.Spark[]>([]);

  /**
   * Refs, not state, for everything the trigger callback reads.
   *
   * The ring fires from a native event into a closure captured once. Reading
   * React state there gives whatever the values were when the listener was
   * registered, which in practice means an empty toolbelt and a stale persona
   * forever. These are the live values.
   */
  const history = useRef<Turn[]>([]);
  const live = useRef({ state, persona, facts, uid, sparks: sparkList });
  live.current = { state, persona, facts, uid, sparks: sparkList };
  const mounted = useRef(true);
  /** Claims a listening turn, so an interrupted start cannot finish. */
  const listenSeq = useRef(0);
  /** Cancels a listen that never heard anything. */
  const silence = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Whether a tool is still running on Noctus.
   *
   * Speaking and working overlap by design — Grove acknowledges immediately and
   * the run happens behind the acknowledgement — so the end of speech is not
   * the end of the turn. Without this, speech finishing would drop the machine
   * back to idle while a run was still in flight, and the screen would claim
   * Grove was doing nothing while it waited on Noctus.
   */
  const running = useRef(false);
  /**
   * An ability that asked something and is waiting for the answer.
   *
   * "What should I call it?" was a dead end: the question was asked, the turn
   * ended, and the reply arrived as a brand new sentence with no verb in it —
   * which opens no gate, reaches no ability, and errored. The asking half
   * existed and the listening half did not.
   */
  const pending = useRef<{ ability: Ability; args: Record<string, string>; gap: string } | null>(
    null
  );

  /**
   * Something irreversible, waiting on a yes.
   *
   * One press confirms, two cancels, silence cancels. The asymmetry is the
   * point: doing nothing has to be safe, because the failure that matters is
   * money spent by a hand brushing a ring in a pocket, not a purchase that
   * needed asking for twice.
   *
   * It expires, and it expires into "no". A confirmation left armed is a
   * booby trap: press the ring twenty minutes later to ask about the weather
   * and buy something instead.
   */
  const awaitingYes = useRef<{
    ability: Ability;
    args: Record<string, string>;
    at: number;
  } | null>(null);

  /** Set while a first press is waiting to see whether a second follows. */
  const yesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** How long a confirmation stays live. Long enough to think, short enough to forget. */
  const CONFIRM_WINDOW_MS = 25_000;
  /** How long to wait for a second press before treating the first as a yes. */
  const SECOND_PRESS_MS = 700;
  /**
   * When Grove last spoke without being asked. Feeds the mode's rate control —
   * an assistant that volunteers something every time you unlock your phone
   * stops being used, which is the failure this guards against.
   */
  const lastVolunteered = useRef<string | null>(null);
  /**
   * Which turn is current. Bumped by every press.
   *
   * A turn has several points where it waits — for the model, and for the
   * synthesiser to go quiet before speaking a result. Interrupting resolves
   * those waits rather than cancelling them: stopSpeaking() makes whenQuiet()
   * return *immediately*, so the code after it carried on and started talking
   * over the listening session that had just opened. That is the "I interrupt
   * it and it keeps going" bug, and no amount of stopping speech fixes it,
   * because the problem is a turn that no longer has permission to speak.
   *
   * Every await inside a turn is followed by a check that this still matches.
   */
  const turnSeq = useRef(0);

  /** Where the machine settles when nothing is in flight. */
  const restingState = (): AgentState =>
    running.current ? 'working' : trigger.isArmed() ? 'idle' : 'asleep';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopSpeaking();
      abortListening();
    };
  }, []);

  /* ------------------------------------------------------------ settings */

  useEffect(() => {
    void loadPersona().then((stored) => {
      if (mounted.current) setPersona(stored);
    });
  }, []);

  const updatePersona = useCallback(async (next: Persona) => {
    const was = live.current.persona.mode ?? 'normal';
    setPersona(next);
    await savePersona(next);

    // Entering a mode can carry an instruction — "every time I'm in commute
    // mode put on my driving playlist". Run it as though it had been said out
    // loud, which is what makes a mode conditional rather than a label.
    const now = next.mode ?? 'normal';
    if (now === was) return;
    const rule = withOverrides(modeById(now), await loadOverrides()).onEnter;
    if (rule?.trim()) void say(rule);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ------------------------------------------------------------ activity */

  useEffect(() => {
    if (status !== 'signed-in') {
      setActivity([]);
      setFacts([]);
      setSparkList([]);
      return;
    }
    void transcript.loadActivity(uid).then((entries) => {
      if (mounted.current) setActivity(entries);
    });
    // Abilities read per-account state through this rather than through a
    // parameter, so it has to be set before any of them can run.
    setCurrentAccount(uid);
    // Lets mode.set reach back into persona state without abilities.ts growing
    // a dependency on React.
    setModeHandler(async (mode) => {
      await updatePersona({ ...live.current.persona, mode });
    });
    void memory.loadFacts(uid).then((f) => {
      if (mounted.current) setFacts(f);
    });
    void notesStore.loadNotes(uid).then((n) => {
      if (mounted.current) setNoteList(n);
    });
    void sparks.loadSparks(uid).then((s) => {
      if (mounted.current) setSparkList(s);
      // Opening the app is the only reliable moment a device-side spark gets.
      void catchUp();
    });
    // catchUp is declared below and is stable (useCallback with no deps), so
    // naming it here would be a forward reference for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, uid]);

  const clearActivity = useCallback(async () => {
    setActivity(await transcript.clearActivity(live.current.uid));
  }, []);

  const editFact = useCallback(async (id: string, value: string) => {
    setFacts(await memory.reword(live.current.uid, id, value));
  }, []);

  /**
   * Wipes everything and starts over.
   *
   * The conversation in memory as well as the stored one: without clearing
   * history.current, Grove carries on referring to things you have just deleted,
   * which is worse than not offering a reset at all.
   */
  const startAgain = useCallback(async () => {
    const account = live.current.uid;
    history.current = [];
    lastVolunteered.current = null;
    turnSeq.current += 1;
    setCaption('');
    setHeard('');
    const [entries, facts, list] = await Promise.all([
      transcript.clearActivity(account),
      memory.forgetAll(account),
      sparks.clearSparks(account),
    ]);
    if (!mounted.current) return;
    setActivity(entries);
    setFacts(facts);
    setSparkList(list);
  }, []);

  const forgetFact = useCallback(async (id: string) => {
    setFacts(await memory.forget(live.current.uid, id));
  }, []);

  const forgetEverything = useCallback(async () => {
    setFacts(await memory.forgetAll(live.current.uid));
  }, []);

  const setSparkEnabled = useCallback(async (id: string, enabled: boolean) => {
    setSparkList(await sparks.setSparkEnabled(live.current.uid, id, enabled));
  }, []);

  const editSpark = useCallback(
    async (id: string, patch: Parameters<typeof sparks.editSpark>[2]) => {
      setSparkList(await sparks.editSpark(live.current.uid, id, patch));
    },
    []
  );

  const deleteSpark = useCallback(async (id: string) => {
    setSparkList(await sparks.deleteSpark(live.current.uid, id));
  }, []);

  /* ------------------------------------------------------------- talking */

  /**
   * One exchange, end to end.
   *
   * Written as a single function rather than split across the state machine
   * because the ordering *is* the design — reply, record, then run — and
   * scattering it across handlers is how that ordering quietly gets lost.
   */
  const exchange = useCallback(async (said: string) => {
    const text = said.trim();
    if (!text) {
      setState(restingState());
      return;
    }

    // "Listen to this" is decided here, before the model, because people start
    // talking the instant they have said it. A round trip first would reopen
    // the microphone after the opening sentence of the note — usually the one
    // saying what it is about.
    if (notesStore.isStartingNote(text)) {
      startNote();
      return;
    }

    const turn = ++turnSeq.current;
    /** Whether this turn is still the one the user is waiting on. */
    const mine = () => mounted.current && turn === turnSeq.current;

    const { persona: voice, facts: known, uid: account } = live.current;

    // A phrase trigger turns your own words into a button, so it is checked
    // before anything is routed: "play my favourite song" should run the spark
    // you taught, not be re-interpreted from scratch every time.
    const taught = sparks.matchPhrase(text, live.current.sparks);
    const asked = taught ? taught.instruction : text;

    setHeard('');
    setCaption(text);
    setState('thinking');

    /**
     * Say something if the turn is taking a while.
     *
     * Only fires when the work is genuinely still running, and the answer is
     * guaranteed to follow — which is what separates this from the empty
     * promise the prompt forbids. Below this threshold it stays quiet, because
     * a holding line in front of an instant answer is just noise.
     */
    let held = false;
    const holdTimer = setTimeout(() => {
      if (!mine()) return;
      held = true;
      // The voice, not the mode: a holding line is the phrase repeated most
      // often, so it is the one most likely to break the character.
      utter(holdingFor(voice));
    }, 2200);

    // A spoken yes or no settles a confirmation, before anything else looks at
    // the sentence. Someone wearing glasses will often answer out loud rather
    // than reach for the ring, and "no" routed as an ordinary turn would be
    // answered conversationally while the thing sat there still waiting.
    const holding = awaitingYes.current;
    if (holding) {
      const fresh = Date.now() - holding.at <= CONFIRM_WINDOW_MS;
      if (/^\s*(yes|yeah|yep|yup|go ahead|do it|send it|confirm|ok(ay)?)\s*[.!]?\s*$/i.test(asked)) {
        clearTimeout(holdTimer);
        awaitingYes.current = null;
        if (fresh) await confirmNow();
        else utter('That one timed out. Ask me again.');
        return;
      }
      if (/^\s*(no|nope|cancel|stop|don'?t|forget it|never mind)\s*[.!]?\s*$/i.test(asked)) {
        clearTimeout(holdTimer);
        awaitingYes.current = null;
        utter('Cancelled.');
        return;
      }
      // Anything else means they moved on, and a confirmation nobody answered
      // must not survive into a later turn.
      awaitingYes.current = null;
    }

    // An answer to Grove's own question runs the ability that asked it.
    //
    // Deliberately before the model: "Dinner with Sam" is a complete answer to
    // "what should I call it?" and a meaningless sentence on its own, so
    // routing it fresh could only ever fail. Cleared either way, so a question
    // never captures more than the one reply.
    const waiting = pending.current;
    pending.current = null;
    if (waiting && !detectActIntent(asked)) {
      clearTimeout(holdTimer);
      const filled = { ...waiting.args, [waiting.gap]: asked };
      running.current = true;
      setState('working');
      const answered = await runAbility(waiting.ability, filled);
      running.current = false;
      if (!mine()) return;
      setCaption(answered.spoken);
      rememberQuestion(waiting.ability, filled, answered);
      await whenQuiet();
      if (mine()) utter(answered.ok ? answered.spoken : shortFailure(answered.spoken));
      return;
    }

    let reply;
    try {
      reply = await askGrove(history.current, asked, { persona: voice, facts: known });
    } catch (error) {
      clearTimeout(holdTimer);
      const message = error instanceof Error ? error.message : fallback.stuck();
      if (!mounted.current) return;
      setCaption(message);
      utter(message);
      return;
    }
    clearTimeout(holdTimer);
    if (!mine()) return;

    history.current = [
      ...history.current,
      newTurn('user', text),
      newTurn('assistant', reply.text),
      // Only the last dozen turns are ever sent anywhere, so there is no
      // reason to hold a whole day of conversation in memory.
    ].slice(-24);

    setCaption(reply.text);
    // Queued behind the holding line rather than cutting it off — being
    // interrupted by the thing you were waiting for is worse than the wait.
    if (held) await whenQuiet();
    if (!mine()) return;
    // A read says nothing until it has something to say. The holding timer
    // above covers a slow one; speaking here as well produced two "let me
    // check"s and, when the lookup failed, no answer at all.
    if (!reply.holdForTool) utter(reply.text);

    // Anything worth remembering was pulled locally, by keyword, from what was
    // said — never inferred by a model and stored where you cannot see it.
    if (reply.fact) {
      const next = await memory.remember(account, {
        key: reply.fact.key,
        value: reply.fact.value,
        source: 'told',
        subject: reply.fact.subject,
        open: reply.fact.open,
        kind: reply.fact.kind,
      });
      if (mounted.current) setFacts(next);
    }

    const entries = await transcript.record(account, {
      said: text,
      replied: reply.text,
      // A pending ability is still to run; reads that already ran inside the
      // model's turn are finished, and the card says which way they went.
      tool: reply.ability
        ? { name: reply.ability.name, state: 'running' }
        : reply.ran && reply.ran.length > 0
          ? {
              name: reply.ran.map((r) => r.ability.name).join(' + '),
              state: reply.ran.every((r) => r.ok) ? 'done' : 'failed',
              detail: reply.ran.map((r) => r.spoken).join('\n'),
            }
          : undefined,
    });
    if (!mine()) return;
    setActivity(entries);
    const entryId = entries[0]?.id;

    // A standing job is worth saving even when nothing can carry it out yet —
    // the instruction is re-read on every run, so it starts working the day the
    // ability behind it exists. Returning here first meant "whenever I say X,
    // email Y" was thrown away because mail happened to be unwired.
    if (!reply.ability && !reply.schedule && !reply.phrase) return;

    // A recurrence makes this a standing job rather than a one-off. Saved and
    // not run now: the point of "every morning" is that it happens then.
    // Either kind of standing job. Testing `schedule` alone silently dropped
    // every "whenever I say..." — the spark was never created, and nothing said
    // so, which is the worst shape a bug can take in something you talk to.
    if ((reply.schedule || reply.phrase) && !taught) {
      const spark = await sparks.createSpark(account, {
        said: text,
        title: reply.title,
        instruction: reply.instruction,
        abilityId: reply.ability?.id ?? null,
      });
      if (spark && mounted.current) setSparkList(await sparks.loadSparks(account));
      return;
    }

    // Past the spark branch, so this is a one-off. Nothing to run means nothing
    // to do — the reply has already been spoken.
    const ability = reply.ability;
    if (!ability) return;

    // The reply is already being spoken; the run happens behind it. The flag
    // is what stops the end of that speech from reporting the turn as over.
    running.current = true;
    setState((current) => (current === 'speaking' ? current : 'working'));

    // Bounded, so a hung ability can never leave a promise unanswered.
    const outcome = await runAbility(ability, reply.args);
    running.current = false;
    if (!mine()) return;

    const record: TurnTool = {
      name: ability.name,
      state: outcome.ok ? 'done' : 'failed',
      detail: outcome.spoken,
      needs: ability.needs,
    };

    if (entryId) {
      const updated = await transcript.attachTool(account, entryId, record);
      if (mounted.current) setActivity(updated);
    }

    // Read the outcome out — this is the half the user actually waited for.
    // Queued behind whatever is still playing rather than cutting it off.
    if (!mounted.current) return;
    setCaption(outcome.spoken);
    await whenQuiet();

    // A failure is said once, briefly, and the detail stays on screen.
    //
    // Grove would make a remark and then read out the machinery behind it —
    // "reconnect Google in Connections, allow everything on the consent
    // screen" — which is the right thing to be able to read and the wrong
    // thing to have recited into your ear while walking. The card keeps the
    // full sentence; out loud it gets a short one.
    // Held, not done. The ability stopped short of the irreversible part and
    // said what it is about to do; the press decides whether it happens.
    if (outcome.needsConfirming) {
      awaitingYes.current = { ability, args: reply.args, at: Date.now() };
      if (!mounted.current) return;
      setCaption(outcome.spoken);
      await whenQuiet();
      // "Send" was right for mail and wrong for everything added since —
      // deleting an event, moving one, ordering food. The instruction has to
      // match the thing being decided, or the press means something else.
      if (mine()) utter(`${outcome.spoken}. Press once to go ahead, twice to cancel.`);
      return;
    }

    rememberQuestion(ability, reply.args, outcome);

    const heard = outcome.ok ? outcome.spoken : shortFailure(outcome.spoken);

    // The result of work you interrupted is not something you still want read
    // out — you have already moved on and asked something else.
    if (mine()) utter(heard);

    // The song starts when the sentence ends. Anything else means a few seconds
    // of music, an interruption, and a track that has lost its opening.
    if (outcome.resumeMusicWhenQuiet) {
      await whenQuiet();
      if (mine()) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const remote = require('grove-remote') as typeof import('grove-remote');
          await remote.controlMusic('play');
        } catch {
          // A build without the native half never queued anything to resume.
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Runs anything that was due while Grove was closed.
   *
   * iOS will not wake the app at a chosen moment, so a device-side spark can
   * only ever catch up — which is what the Sparks screen promises and what
   * nothing was actually doing: dueSparks() existed and was never called, so a
   * scheduled job had no path to running at all.
   *
   * One at a time, and only the oldest: coming back after a week away should
   * produce one briefing, not seven talking over each other.
   */
  const catchUp = useCallback(async () => {
    const account = live.current.uid;
    if (!account || account === 'anon') return;

    // The mode decides whether Grove may speak first at all. Without this the
    // rate control is decorative: focus mode would still be interrupted by a
    // spark catching up, which is the exact behaviour it exists to prevent.
    const mode = modeById(live.current.persona.mode ?? 'normal');
    if (!maySpeak(mode, lastVolunteered.current)) return;

    const all = await sparks.loadSparks(account);
    const due = sparks.dueSparks(all);
    if (due.length === 0) return;

    const spark = due[due.length - 1];
    const ability = spark.abilityId ? abilityById(spark.abilityId) : undefined;
    // Marked before running, so a failing spark cannot retry on a loop every
    // time the app comes forward.
    setSparkList(await sparks.markRun(account, spark.id));
    if (!ability?.wired) return;

    const outcome = await runAbility(ability, {});
    if (!mounted.current || !outcome.ok) return;

    const entries = await transcript.record(account, {
      said: spark.title,
      replied: outcome.spoken,
      tool: { name: ability.name, state: 'done', detail: outcome.spoken },
    });
    if (!mounted.current) return;
    setActivity(entries);
    lastVolunteered.current = new Date().toISOString();
    setCaption(outcome.spoken);
    utter(outcome.spoken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
 * What a failure sounds like, as opposed to what it says on screen.
 *
 * The first sentence is nearly always the human half — "I have no address for
 * Priya", "Google is not connected" — and the rest is the instructions. Reading
 * the instructions aloud is what made every error feel robotic; they are still
 * there to be read on the card, where they can actually be followed.
 */
function shortFailure(text: string): string {
  const first = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return first.length > 4 && first.length <= 120 ? first : text.slice(0, 120);
}

/**
   * Speak, and let the state follow the audio rather than a timer.
   *
   * A question opens the microphone when it finishes. Grove asking "what
   * should I call it?" and then dropping to Ready puts the burden back on the
   * person to press again — which, wearing glasses with the phone in a pocket,
   * is the moment a conversation stops being hands-free.
   */
  const utter = useCallback((text: string) => {
    // Claimed at the moment of speaking, because stopSpeaking() also fires
    // onDone — an interruption and a natural ending are the same callback.
    // Unguarded, barging in went: press, stop the speech, start listening, and
    // then the *stopped* speech's onDone landed and set the state back to
    // resting, throwing away the listening turn it had just opened. That is why
    // interrupting took three presses and why the screen said "Ready" with the
    // old reply still under it.
    const turn = turnSeq.current;
    setState('speaking');
    speak(text, live.current.persona.delivery, {
      onDone: () => {
        if (!mounted.current) return;
        // A newer press owns the app now; this speech is over and irrelevant.
        if (turn !== turnSeq.current) return;
        // A question expects an answer, so listen for one rather than resting.
        // Only when no ability is still running: something asked while work is
        // in flight is rhetorical, not a prompt.
        if (text.trim().endsWith('?') && !running.current) {
          void beginListening(false);
          return;
        }
        // And even within the same turn, only speaking becomes resting. If
        // anything downstream has already moved on, it keeps its state.
        setState((current) => (current === 'speaking' ? restingState() : current));
      },
    });
    // beginListening is declared below and is stable: its own deps are exchange
    // and clearSilence, both useCallback with no deps. Listing it here would be
    // a forward reference that changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Note that an ability asked for something, and which argument is missing.
   *
   * A question is a failed run whose reply ends in a question mark — that is
   * what "I need one more thing" looks like from out here. The gap is the first
   * required argument that came back empty, which is the one being asked about.
   */
  const rememberQuestion = useCallback(
    (ability: Ability, args: Record<string, string>, outcome: { ok: boolean; spoken: string }) => {
      // A question mark anywhere, not only at the end. "Which town? Tell me
      // once and I'll remember it." is a question with a promise after it, and
      // requiring the mark last meant that one registered as no question at all
      // — so the answer was routed as a fresh sentence and the weather asked
      // where you were, again, having just offered to remember.
      if (outcome.ok || !outcome.spoken.includes('?')) return;
      // A required argument first, then any empty one. Weather's `place` is not
      // marked required — it usually comes from memory — so when it did have to
      // ask, nothing was recorded as missing, the answer was routed as a fresh
      // sentence, and Grove asked where you were again. And again.
      const empty = Object.entries(ability.args).filter(
        ([name]) => !(args[name] ?? '').trim()
      );
      const gap =
        empty.find(([, spec]) => spec.required === true)?.[0] ?? empty[0]?.[0];
      pending.current = gap ? { ability, args, gap } : null;
    },
    []
  );

  /* --------------------------------------------------------- voice notes */

  /** Everything heard so far in the note, in order. */
  const noteText = (): string => {
    const m = memo.current;
    if (!m) return '';
    return [...m.committed, m.buffer]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(' ');
  };

  /**
   * Take in a new transcript for the running session.
   *
   * On iOS each result is the whole session so far, not the latest words, so a
   * result replaces the buffer rather than adding to it. The exception is a
   * result that is suddenly much shorter than the buffer: a transcript does not
   * shrink by half as it grows, so that is a new session starting, and the old
   * one is kept before it is overwritten. Comparing lengths rather than opening
   * words matters, because the recogniser revises its first few words as it
   * hears more, and treating a revision as a new session duplicated them.
   */
  const absorb = (text: string) => {
    const m = memo.current;
    const said = text.trim();
    if (!m || !said) return;
    if (m.buffer && said.length < m.buffer.length * 0.5) m.committed.push(m.buffer);
    m.buffer = said;
    if (mounted.current) setHeard(noteText().slice(-220));
  };

  /**
   * A note ends after two minutes of nobody saying anything.
   *
   * Long enough for thinking, pausing, reading something off a page. Short
   * enough that a note left running by accident does not record the rest of
   * the afternoon.
   */
  const armNoteQuiet = () => {
    const m = memo.current;
    if (!m) return;
    if (m.quietTimer) clearTimeout(m.quietTimer);
    m.quietTimer = setTimeout(() => void finishNote(), 120_000);
  };

  /**
   * "That's it" ends a note — once it has stayed the last thing said.
   *
   * Checked on partial results, because on iOS a continuous session only
   * delivers a final one when it stops. The short wait is what keeps "that's
   * it, the whole plan hinges on Friday" from ending the note at the comma.
   */
  const watchForEnd = () => {
    const m = memo.current;
    if (!m) return;
    if (m.endTimer) clearTimeout(m.endTimer);
    if (!notesStore.endsNote(noteText()).ended) return;
    m.endTimer = setTimeout(() => {
      if (memo.current && notesStore.endsNote(noteText()).ended) void finishNote();
    }, 2500);
  };

  const listenForNote = async () => {
    const m = memo.current;
    if (!m || m.finishing) return;

    // The same preparation beginListening does out of the foreground: pocketed,
    // the audio session has lapsed and must be taken back before recording.
    if (AppState.currentState !== 'active') {
      try {
        await trigger.reactivate();
        await trigger.setKeepAlive(false);
      } catch {
        // Recording may still start; if it does not, the note ends below.
      }
    }
    trigger.suppressVolumeTriggers();

    const started = startListening(
      {
        onPartial: (text) => {
          absorb(text);
          armNoteQuiet();
          watchForEnd();
        },
        onFinal: (text) => {
          absorb(text);
          watchForEnd();
        },
        onLevel: (value) => {
          if (mounted.current) setLevel(value);
        },
        onError: (message) => {
          console.log('[grove:note] recogniser error', message);
        },
        onEnd: () => {
          const current = memo.current;
          if (!current || current.finishing) return;
          // iOS ended the session, not the person. Keep what it heard and start
          // another, so a long note is several sessions rather than a lost one.
          if (current.buffer) current.committed.push(current.buffer);
          current.buffer = '';
          setTimeout(() => void listenForNote(), 250);
        },
      },
      { continuous: true, preferOnDevice: live.current.persona.preferOnDevice }
    );

    if (!started) void finishNote();
  };

  const startNote = () => {
    stopSpeaking();
    // A buzz, not a sentence. Anything spoken now plays into the glasses while
    // the microphone opens, and gets written into the note as its first line.
    buzz();
    memo.current = {
      committed: [],
      buffer: '',
      startedAt: Date.now(),
      finishing: false,
      endTimer: null,
      quietTimer: null,
    };
    setHeard('');
    setCaption('Taking notes. Press when you are done.');
    setState('noting');
    armNoteQuiet();
    void listenForNote();
  };

  const finishNote = async () => {
    const m = memo.current;
    if (!m || m.finishing) return;
    m.finishing = true;
    if (m.endTimer) clearTimeout(m.endTimer);
    if (m.quietTimer) clearTimeout(m.quietTimer);

    // Ask for the final transcript and give it a moment to arrive: the last
    // few words are exactly the ones still being recognised when the press
    // lands, and they are often the conclusion.
    stopListening();
    await new Promise((done) => setTimeout(done, 700));

    const said = notesStore.endsNote(noteText()).kept;
    const seconds = Math.max(1, Math.round((Date.now() - m.startedAt) / 1000));
    memo.current = null;
    void trigger.setKeepAlive(true).catch(() => undefined);
    buzz();
    if (!mounted.current) return;
    setLevel(0);
    setHeard('');

    if (said.split(/\s+/).filter(Boolean).length < 3) {
      utter("I didn't catch anything, so there's no note.");
      return;
    }

    setState('thinking');
    setCaption('Writing up your note…');

    const shape = await lightNotes(said);
    // Saved whether or not the write-up worked. The recording is the thing that
    // cannot be got back; a summary can be made again.
    const note = shape ?? {
      title: said.split(/\s+/).slice(0, 6).join(' '),
      summary: '',
      points: [],
      actions: [],
    };
    const next = await notesStore.saveNote(live.current.uid, {
      ...note,
      transcript: said,
      createdAt: new Date().toISOString(),
      seconds,
    });
    if (!mounted.current) return;
    setNoteList(next);

    const todo = note.actions.length;
    utter(
      shape
        ? `Saved: ${note.title}.${todo > 0 ? ` ${todo === 1 ? 'One thing' : `${todo} things`} to do in there.` : ''}`
        : "Saved the recording, but I couldn't write it up just now. It's all in your notes."
    );
  };

  const forgetNote = useCallback(async (id: string) => {
    setNoteList(await notesStore.deleteNote(live.current.uid, id));
  }, []);

  const clearSilence = useCallback(() => {
    if (silence.current) {
      clearTimeout(silence.current);
      silence.current = null;
    }
  }, []);

  const beginListening = useCallback(
    async (continuous: boolean) => {
      // Re-taking the session is asynchronous, and the state says 'listening'
      // for that whole window — so a second press arrives, stops a recogniser
      // that has not started, and the original start then runs anyway against
      // a session being reconfigured underneath it. This claim makes the last
      // press win instead.
      const turn = ++listenSeq.current;

      setProblem(null);
      setHeard('');
      setLevel(0);

      setState('listening');

      // Only out of the foreground.
      //
      // Someone wearing glasses starts talking the moment they press — they
      // are not watching the screen for a cue — so the microphone has to be
      // live immediately, and two round trips into native before recording is
      // exactly the delay they would talk straight through. In the foreground
      // the session is already held and neither call buys anything.
      //
      // Backgrounded is the opposite: the session has lapsed and the silence
      // owns the audio graph, so recording cannot start until both are dealt
      // with. There the delay is the price of it working at all.
      if (AppState.currentState !== 'active') {
        try {
          await trigger.reactivate();
          await trigger.setKeepAlive(false);
        } catch (error) {
          console.log('[grove:listen] session prepare failed', error);
        }

        if (turn !== listenSeq.current || !mounted.current) {
          // Leave the state alone: whoever superseded this turn owns it now.
          return;
        }
      }

      // Before the recogniser starts, because its engine coming up is what
      // moves the volume and would otherwise read as a second press.
      trigger.suppressVolumeTriggers();

      const started = startListening(
        {
          onPartial: (text) => {
            // Anything heard at all means this is a real conversation, so the
            // give-up timer stops applying.
            if (text.trim()) clearSilence();
            if (mounted.current) setHeard(text);
          },
          onFinal: (text) => {
            clearSilence();
            console.log('[grove:listen] final', JSON.stringify(text));
            void exchange(text);
          },
          onLevel: (value) => {
            if (mounted.current) setLevel(value);
          },
          onError: (message) => {
            console.log('[grove:listen] ERROR', message);
            if (!mounted.current) return;
            setProblem(message);
            setCaption(message);
          },
          onEnd: () => {
            clearSilence();
            // Unconditional, and not guarded by `mounted`: leaving the silence
            // paused is what would let iOS suspend Grove and kill the ring.
            void trigger.setKeepAlive(true).catch(() => undefined);
            console.log('[grove:listen] end');
            if (!mounted.current) return;
            setLevel(0);
            // Only fall back to idle if nothing downstream took over — a final
            // transcript moves us to 'thinking' before this fires.
            setState((current) => (current === 'listening' ? restingState() : current));
          },
        },
        {
          continuous,
          preferOnDevice: live.current.persona.preferOnDevice,
        }
      );

      console.log('[grove:listen] startListening returned', started);
      if (!started) {
        void trigger.setKeepAlive(true).catch(() => undefined);
        setState(restingState());
        return;
      }

      // Nothing said at all: close the recogniser rather than leave it holding
      // the microphone with the UI insisting it is listening.
      clearSilence();
      silence.current = setTimeout(() => {
        if (!mounted.current || turn !== listenSeq.current) return;
        console.log('[grove:listen] nothing heard in', SILENCE_TIMEOUT_MS, 'ms — cancelling');
        abortListening();
        setState(restingState());
      }, SILENCE_TIMEOUT_MS);
    },
    [exchange, clearSilence, setState]
  );

  /**
   * The trigger.
   *
   * Every route into Grove funnels through here — the ring, the on-screen
   * button, the keyboard — so all three behave identically by construction
   * rather than by three implementations agreeing with each other.
   */
  /** Do the thing that was waiting on a yes. */
  const confirmNow = useCallback(async () => {
    const waiting = awaitingYes.current;
    awaitingYes.current = null;
    if (!waiting) return;
    setState('working');
    const outcome = await runAbility(waiting.ability, { ...waiting.args, confirmed: 'yes' });
    if (!mounted.current) return;
    setCaption(outcome.spoken);
    await whenQuiet();
    utter(outcome.ok ? outcome.spoken : shortFailure(outcome.spoken));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const press = useCallback(() => {
    // While a note is being taken, the press is how it ends. Nothing else a
    // press could mean is more likely than "I'm done".
    if (memo.current) {
      void finishNote();
      return;
    }

    // A confirmation owns the next press, and only the next one.
    const waiting = awaitingYes.current;
    if (waiting) {
      if (Date.now() - waiting.at > CONFIRM_WINDOW_MS) {
        // Expired into no, which is the only safe direction for it to expire.
        awaitingYes.current = null;
      } else if (yesTimer.current) {
        // A second press inside the window. That is a no, said with the hand
        // rather than the voice, and it cancels outright.
        clearTimeout(yesTimer.current);
        yesTimer.current = null;
        awaitingYes.current = null;
        buzz();
        utter('Cancelled.');
        return;
      } else {
        // First press. Wait to see whether a second follows before acting,
        // because acting immediately makes a double press impossible to express.
        buzz();
        yesTimer.current = setTimeout(() => {
          yesTimer.current = null;
          void confirmNow();
        }, SECOND_PRESS_MS);
        return;
      }
    }

    const current = stateNow.current;

    // The only confirmation available to someone whose phone is in a pocket
    // and whose ring has no feedback of its own. Without it there is a silent
    // gap between pressing and Grove being ready, and people press again.
    buzz();

    // Any press ends the turn that was running, whatever it was doing. Without
    // this, work already in flight comes back and speaks over the new one.
    turnSeq.current += 1;
    // And it is no longer "working", whatever the abandoned ability is still
    // doing in the background — restingState() reads this flag, so leaving it
    // set makes the next resting state report work nobody is waiting for.
    running.current = false;

    // Barge-in. Stop talking and start listening, in that order.
    if (current === 'speaking' || isSpeaking()) {
      stopSpeaking();
      void beginListening(false);
      return;
    }
    if (current === 'listening') {
      // A state of 'listening' with nothing actually recording is a desync —
      // stopping it would do nothing and leave the app stuck there forever, so
      // treat it as a fresh press instead of a stop.
      if (!isListening()) {
        void beginListening(false);
        return;
      }
      // Also invalidates a start that is still waiting on the session.
      listenSeq.current += 1;
      // Settle what's been said rather than discarding it.
      stopListening();
      return;
    }
    // Thinking and working used to swallow the press entirely. On a phone in a
    // pocket that is indistinguishable from a broken button: you press, nothing
    // happens, the abandoned turn finishes and drops the app to Ready, and only
    // the press after that reaches the microphone. The turn was already
    // cancelled at the top of this function, so there is nothing left to
    // protect — barge in like any other state.
    if (current === 'thinking' || current === 'working') {
      stopSpeaking();
      void beginListening(false);
      return;
    }

    void beginListening(false);
    // confirmNow and utter are both useCallback with no deps, so they are
    // stable and listing them changes nothing but the lint. finishNote is left
    // out on purpose: it is rebuilt each render but reads only refs and stable
    // setters, so any render's copy behaves identically, and listing it would
    // rebuild `press` — and resubscribe the ring — on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beginListening, confirmNow, utter]);

  const say = useCallback(
    async (text: string) => {
      stopSpeaking();
      await exchange(text);
    },
    [exchange]
  );

  /* -------------------------------------------------------------- the ring */

  useEffect(() => {
    if (status !== 'signed-in') return;
    if (!capabilities().remote) {
      setState('asleep');
      setArmed(false);
      return;
    }

    let cancelled = false;

    const arm = async () => {
      const ok = await trigger.arm();
      if (cancelled || !mounted.current) return;
      setArmed(ok);
      setRoute(trigger.currentRoute());
      setState((current) => (current === 'asleep' && ok ? 'idle' : current));
    };

    void arm();

    const offTrigger = trigger.onTrigger((event) => {
      // Proof that hardware exists. Until something presses, "armed" only ever
      // meant Grove was ready to hear one — which is equally true of a phone
      // with no ring paired at all.
      setRingSeen(true);
      switch (event.kind) {
        case 'tap':
          press();
          break;
        case 'hold-start':
          if (memo.current) {
            void finishNote();
            break;
          }
          // A held button means "I am still talking" — keep the recogniser
          // open rather than letting it endpoint at the first pause.
          if (stateNow.current !== 'listening') void beginListening(true);
          break;
        case 'hold-end':
          if (memo.current) break;
          if (stateNow.current === 'listening') stopListening();
          break;
      }
    });

    const offRoute = trigger.onRoute((next) => {
      if (mounted.current) setRoute(next);
    });

    // An audio session lost to a phone call is never handed back on its own,
    // so every return to the foreground re-takes it. Without this the ring
    // works until the first interruption and then silently stops.
    const onAppState = (next: AppStateStatus) => {
      if (next === 'active') {
        void arm();
        void catchUp();
      }
    };
    const appSub = AppState.addEventListener('change', onAppState);

    return () => {
      cancelled = true;
      offTrigger();
      offRoute();
      appSub.remove();
    };
    // finishNote reads only refs and stable setters; see the note on `press`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, press, beginListening, catchUp, setState]);

  /**
   * The volume-down fallback follows the preference, but only once the session
   * is actually held — enabling it against a module that is not holding the
   * audio session would install a volume observer with nothing to observe.
   */
  useEffect(() => {
    console.log('[grove:volume] effect', { armed, want: persona.volumeTrigger });
    if (!armed) return;
    // Not `void`: a rejection here is the difference between "the hardware
    // sends nothing" and "the native call failed", and those look identical
    // from the outside.
    trigger
      .setVolumeFallback(persona.volumeTrigger)
      .then(() => {
        console.log('[grove:volume] native now', trigger.isVolumeFallbackOn());
      })
      .catch((error: unknown) => {
        console.log('[grove:volume] FAILED', error);
      });
  }, [armed, persona.volumeTrigger]);

  // Signing out must not leave Grove holding the audio session and the remote.
  useEffect(() => {
    if (status === 'signed-out') {
      void trigger.disarm();
      setArmed(false);
      setState('asleep');
      history.current = [];
      setCaption('');
    }
  }, [status, setState]);

  const value = useMemo<AgentValue>(
    () => ({
      state,
      caption,
      heard,
      level,
      armed,
      ringSeen,
      route,
      problem,
      persona,
      updatePersona,
      activity,
      clearActivity,
      startAgain,
      facts,
      editFact,
      forgetFact,
      forgetEverything,
      sparks: sparkList,
      setSparkEnabled,
      editSpark,
      deleteSpark,
      notes: noteList,
      forgetNote,
      press,
      say,
    }),
    [
      state,
      caption,
      heard,
      level,
      armed,
      ringSeen,
      route,
      problem,
      persona,
      updatePersona,
      activity,
      clearActivity,
      startAgain,
      facts,
      editFact,
      forgetFact,
      forgetEverything,
      sparkList,
      setSparkEnabled,
      editSpark,
      deleteSpark,
      noteList,
      forgetNote,
      press,
      say,
    ]
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

/**
 * A short tap, when the build has haptics.
 *
 * Loaded lazily and swallowed on failure for the same reason as everything
 * else native here: this must never be the thing that stops Grove listening.
 */
function buzz(): void {
  if (!capabilities().haptics) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const haptics = require('expo-haptics');
    void haptics.impactAsync(haptics.ImpactFeedbackStyle.Light);
  } catch {
    // No haptics is not a failure worth surfacing.
  }
}

/**
 * Waits for the synthesiser to go quiet, so a tool's result doesn't cut off
 * the acknowledgement that preceded it. Bounded, because a speech engine that
 * never reports done must not wedge the conversation.
 */
async function whenQuiet(timeoutMs = 12_000): Promise<void> {
  const started = Date.now();
  while (isSpeaking() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}
