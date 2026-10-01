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
import * as life from '@/lib/life';
import { whatMatters, nextUp, type Attention, type NextUp } from '@/lib/attention';
import { dayIn, nextDiscovery } from '@/lib/reveal';
import { learnWeek, noteTurn } from '@/lib/rhythms';
import * as struggles from '@/lib/struggles';
import { afterTurn, consolidateNow, rememberNote } from '@/lib/consolidate';
import * as notesStore from '@/lib/notes';
import * as inbox from '@/lib/inbox';
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

  /** Thoughts caught on the way past, newest first. */
  captures: inbox.Capture[];
  tickOff: (id: string) => Promise<void>;
  dropCapture: (id: string) => Promise<void>;
  /** What they are focused on, if anything. */
  focus: inbox.Focus | null;
  endFocus: () => Promise<void>;

  /** The long memory: who and what is in their life, and what happened. */
  life: life.Life;
  forgetEntity: (id: string) => Promise<void>;
  forgetEpisode: (id: string) => Promise<void>;

  /** The next thing in the day, and when to leave for it. Shown, never spoken. */
  next: NextUp;

  /**
   * How many days since Grove was first opened. Used for the one question it
   * asks on the seventh — see `proactive` in persona.ts.
   */
  dayOne: number;

  /** Things they said they did not understand, hardest first. */
  struggles: struggles.Struggle[];
  /** Tick one off by hand, when a quiz is not how they found out. */
  gotStruggle: (id: string) => Promise<void>;
  forgetStruggle: (id: string) => Promise<void>;

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

  /** Delays the working pulse, so a fast answer never makes a sound at all. */
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When the recogniser last opened, to spot one that dies on the spot. */
  const openedAt = useRef(0);
  /** When Grove last made a sound, which is when a phantom press can arrive. */
  const lastSound = useRef(0);
  /** What has already been volunteered, so nothing is said twice. */
  const attention = useRef<Attention>({ said: new Set<string>() });
  const [next, setNext] = useState<NextUp>(null);
  const [stuck, setStuck] = useState<struggles.Struggle[]>([]);
  const [dayOne, setDayOne] = useState(0);
  /** So a listen can retry itself without `press` being rebuilt. */
  const beginListeningRef = useRef<((continuous: boolean, retrying?: boolean) => void) | null>(null);

  const setState = useCallback(
    (next: AgentState | ((current: AgentState) => AgentState)) => {
      const was = stateNow.current;
      const resolved = typeof next === 'function' ? next(was) : next;
      stateNow.current = resolved;
      setRenderedState(resolved);
      if (resolved !== was) soundFor(was, resolved);
    },
    // soundFor only touches refs and the native module.
    []
  );

  /**
   * What each change of state sounds like.
   *
   * The screen said all of this already, and nobody wearing glasses is looking
   * at the screen. The microphone opened on its own often enough that people
   * stopped trusting when it was safe to talk — so opening and closing it now
   * make a sound, and so does working, in case the silence was the confusing
   * part.
   *
   * Hearing you is not announced: going from listening to thinking means it
   * heard you, and the pulse that follows says so without a third sound.
   */
  const soundFor = (was: AgentState, now: AgentState) => {
    // Haptics first: they work on every build, and the chimes only exist on one
    // that has the native half.
    if ((now === 'listening' || now === 'noting') && was !== 'listening' && was !== 'noting') {
      buzz('open');
    } else if ((was === 'listening' || was === 'noting') && (now === 'idle' || now === 'asleep')) {
      buzz('closed');
    }
    const remote = remoteModule();
    if (!remote) return;
    // Any sound Grove starts can move the volume on Bluetooth glasses, and the
    // volume fallback would read that as a press. See the ring handler below.
    lastSound.current = Date.now();
    trigger.suppressVolumeTriggers();
    const busy = (x: AgentState) => x === 'thinking' || x === 'working';

    if ((now === 'listening' || now === 'noting') && was !== 'listening' && was !== 'noting') {
      remote.chime('listen');
    } else if ((was === 'listening' || was === 'noting') && (now === 'idle' || now === 'asleep')) {
      // Stopped hearing you without anything to act on — the case that used
      // to be invisible.
      remote.chime('stop');
    }

    if (busy(now) && !busy(was)) {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      // Most turns answer in under a second, and a pulse that starts and stops
      // in the same breath is noise. Only work that is actually taking a while
      // gets one.
      pulseTimer.current = setTimeout(() => {
        pulseTimer.current = null;
        if (!busy(stateNow.current)) return;
        trigger.suppressVolumeTriggers();
        remote.workingPulse(true);
        // A cap, whatever else happens. Every path out of working stops the
        // pulse, but a loop that ticks for ever if one of them is ever missed
        // is not a risk worth taking with something playing in someone's ear.
        pulseTimer.current = setTimeout(() => {
          pulseTimer.current = null;
          remote.workingPulse(false);
        }, 90_000);
      }, 900);
    } else if (!busy(now) && busy(was)) {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      pulseTimer.current = null;
      remote.workingPulse(false);
    }
  };
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
  const [lifeMemory, setLifeMemory] = useState<life.Life>({ entities: [], episodes: [], pending: [] });
  const [captures, setCaptures] = useState<inbox.Capture[]>([]);
  const [focus, setFocus] = useState<inbox.Focus | null>(null);
  /**
   * Words to help the recogniser hear this person's world: Grove's name, the
   * people and projects in their life, what it calls them. Rebuilt whenever
   * the long memory changes, so someone mentioned today is heard right tomorrow.
   */
  const hints = useRef<string[]>([]);
  useEffect(() => {
    const byRecency = [...lifeMemory.entities].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    hints.current = [
      ...new Set(
        [
          persona.name,
          persona.friend?.callMe ?? '',
          ...byRecency.flatMap((e) => [e.name, ...e.aliases]),
          'Grove',
        ]
          .map((w) => w.trim())
          .filter((w) => w.length > 1)
      ),
    ].slice(0, 100);
  }, [lifeMemory, persona.name, persona.friend?.callMe]);

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
    /** Set when this was started as a meeting rather than a note to self. */
    meeting?: boolean;
    /** Who is in the room, when they were named. */
    people: string[];
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
    void inbox.loadInbox(uid).then((items) => {
      if (mounted.current) setCaptures(items);
    });
    void inbox.loadFocus(uid).then((f) => {
      if (mounted.current) setFocus(f);
    });
    void life.loadLife(uid).then((l) => {
      if (mounted.current) setLifeMemory(l);
      // A day that ended mid-buffer is still worth remembering. Opening the app
      // is the only moment iOS reliably gives us to do it.
      void consolidateNow(uid).then(async () => {
        const fresh = await life.loadLife(uid);
        if (mounted.current) setLifeMemory(fresh);
      });
    });
    void sparks.loadSparks(uid).then((s) => {
      if (mounted.current) setSparkList(s);
      // Opening the app is the only reliable moment a device-side spark gets.
      void catchUp();
    });
    // What their week normally looks like. Held for a day inside rhythms.ts, so
    // this is a network call on the first open of the day and free after that.
    void learnWeek(uid);
    void struggles.loadStruggles(uid).then((list) => {
      if (mounted.current) setStuck(list);
    });
    void dayIn(uid).then((day) => {
      if (mounted.current) setDayOne(day);
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
      startNote(notesStore.meetingStart(text));
      return;
    }

    const turn = ++turnSeq.current;
    /** Whether this turn is still the one the user is waiting on. */
    const mine = () => mounted.current && turn === turnSeq.current;

    const { persona: voice, facts: known, uid: account } = live.current;

    // When the day started. Marked here, on something the person said, rather
    // than on anything Grove said first — a leave-by reminder landing at seven
    // before they have spoken would file every day as an early one.
    void noteTurn(account);

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
      utter(holdingFor(voice), false, true);
      // Four seconds, not two. A phone on mobile data takes two to three for
      // an ordinary answer, so at 2.2 nearly every reply was preceded by
      // "give me a sec" — and the working pulse already says it is busy.
    }, 4000);

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
      history.current = [
        ...history.current,
        newTurn('user', text),
        newTurn('assistant', answered.spoken),
      ].slice(-24);
      setCaption(answered.spoken);
      rememberQuestion(waiting.ability, filled, answered);
      await whenQuiet();
      if (mine()) {
        utter(
          answered.ok ? answered.spoken : shortFailure(answered.spoken),
          pending.current !== null || answered.listenAfter === true
        );
      }
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
    // Never silence. A reply with no words and nothing to run would drop
    // straight to Ready having said nothing — indistinguishable from the app
    // ignoring you — so it says so instead.
    if (!reply.ability && !reply.text.trim()) {
      utter('I lost my train of thought there. Say that again?', true);
      return;
    }
    if (!reply.holdForTool) utter(reply.text, Boolean(reply.expectsReply));

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

    // Buffered for the long memory, and read in the background once there is
    // enough to be worth a call. Not awaited: this turn is over.
    void afterTurn(account, text, reply.text).then(async () => {
      const fresh = await life.loadLife(account);
      if (mounted.current) setLifeMemory(fresh);
    });

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

    // Writing takes a minute, and a minute of silence reads as a crash. This is
    // not the empty promise the prompt forbids — the work is already running
    // and the answer is guaranteed to follow it.
    if (ability.slow) {
      setCaption('Writing…');
      // stillWorking, or the screen drops to Ready two seconds into a write
      // that runs for a minute — and the mid-turn press guard, which only
      // covers thinking and working, stops protecting the turn.
      if (mine()) utter('Writing it now.', false, true);
    }

    // Bounded, so a hung ability can never leave a promise unanswered.
    const outcome = await runAbility(ability, reply.args);
    running.current = false;
    if (!mine()) return;

    // What happened goes into the conversation, not only onto the screen. The
    // reply that handed this over is usually empty, so the model was left
    // seeing a request with no answer after it — and took the next sentence as
    // another go at the last one, saving "remember this" twice instead of
    // setting the reminder it was asked for.
    history.current = history.current.map((turn, i, all) =>
      i === all.length - 1 && turn.role === 'assistant'
        ? { ...turn, text: [turn.text, outcome.spoken].filter(Boolean).join(' ') }
        : turn
    );

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
      awaitingYes.current = { ability, args: outcome.confirmArgs ?? reply.args, at: Date.now() };
      if (!mounted.current) return;
      setCaption(outcome.spoken);
      await whenQuiet();
      // "Send" was right for mail and wrong for everything added since —
      // deleting an event, moving one, ordering food. The instruction has to
      // match the thing being decided, or the press means something else.
      // The twenty-five seconds start when the reading stops, not when it
      // starts: a long draft read aloud takes most of that window, and the
      // press that followed was being thrown away as stale.
      if (mine()) {
        utter(
          `${outcome.spoken.replace(/[.!?\s]+$/, '')}. Press once to go ahead, twice to cancel.`,
          false,
          false,
          () => {
            if (awaitingYes.current) awaitingYes.current.at = Date.now();
          }
        );
      }
      return;
    }

    rememberQuestion(ability, reply.args, outcome);
    if (outcome.ok && !ability.reads) doneChime();
    // The inbox and the session are shown on screen, so they refresh as soon
    // as something changes them rather than on the next launch.
    if (outcome.ok && ability.id.startsWith('inbox.')) {
      void inbox.loadInbox(account).then((items) => mounted.current && setCaptures(items));
    }
    if (outcome.ok && (ability.id.startsWith('focus.') || ability.id === 'inbox.add')) {
      void inbox.loadFocus(account).then((f) => mounted.current && setFocus(f));
    }
    if (outcome.ok && ability.id.startsWith('study.')) {
      void struggles.loadStruggles(account).then((list) => mounted.current && setStuck(list));
    }

    const heard = outcome.ok ? outcome.spoken : shortFailure(outcome.spoken);

    // The result of work you interrupted is not something you still want read
    // out — you have already moved on and asked something else.
    // An ability that asked for a missing detail — "what's your home address?"
    // — is waiting on the answer, so the microphone opens for it.
    if (mine()) utter(heard, pending.current !== null || outcome.listenAfter === true);

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
   * Speaking first, which is the part that can ruin the product.
   *
   * Every ninety seconds while Grove is resting: work out whether there is one
   * thing worth an interruption (attention.ts decides what qualifies), and say
   * it only if the mode allows interruptions at all, nothing else is happening,
   * and it has not already been said. Everything else waits to be asked.
   */
  const considerSpeaking = useCallback(async () => {
    if (!mounted.current) return;
    const resting = stateNow.current === 'idle' || stateNow.current === 'asleep';
    if (!resting || running.current || isSpeaking() || memo.current || awaitingYes.current) return;

    const mode = modeById(live.current.persona.mode ?? 'normal');
    if (!maySpeak(mode, lastVolunteered.current)) return;
    // Checking in is theirs to switch off; nothing here overrides that.
    if (live.current.persona.friend?.checksIn === false) return;

    // Urgency first, always. A discovery is only ever offered when there is
    // nothing to be late for — being told what you talk about most while you
    // should be leaving the house is the wrong order.
    const account = live.current.uid;
    const moment = await whatMatters(
      attention.current,
      account,
      live.current.persona.friend?.proactive === true
    );
    // Both of these record what they offered before it is spoken, so the state
    // is re-checked here rather than after — a press that landed during the
    // calendar read means this turn is over, and a discovery marked as said
    // and then dropped is gone for good.
    if (!mounted.current || (stateNow.current !== 'idle' && stateNow.current !== 'asleep')) return;

    const say = moment
      ? moment.say
      : ((await nextDiscovery(account).catch(() => null))?.say ?? null);
    if (!say || !mounted.current) return;
    if (stateNow.current !== 'idle' && stateNow.current !== 'asleep') return;

    if (moment) attention.current.said.add(moment.id);
    lastVolunteered.current = new Date().toISOString();
    setCaption(say);
    // Spoken, never listened after — even the lines that end in a question.
    // Grove started this, the phone is in a pocket, and an opened microphone
    // that hears nothing closes with a second sound. One unasked-for noise is
    // the most this is worth. The press is there if they want to answer.
    utter(say);

    if (account && account !== 'anon') {
      const entries = await transcript.record(account, { said: '', replied: say });
      if (mounted.current) setActivity(entries);
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
  const utter = useCallback(
    (text: string, listenAfter = false, stillWorking = false, afterSpeaking?: () => void) => {
    // Claimed at the moment of speaking, because stopSpeaking() also fires
    // onDone — an interruption and a natural ending are the same callback.
    // Unguarded, barging in went: press, stop the speech, start listening, and
    // then the *stopped* speech's onDone landed and set the state back to
    // resting, throwing away the listening turn it had just opened. That is why
    // interrupting took three presses and why the screen said "Ready" with the
    // old reply still under it.
    const turn = turnSeq.current;
    // Speech starting and stopping moves the audio route on glasses too.
    lastSound.current = Date.now();
    trigger.suppressVolumeTriggers();
    setState('speaking');
    // The voice picked in Settings is saved on the persona, not in `delivery`,
    // and only `delivery` was passed — so choosing a voice changed the preview
    // and nothing else. Merged here, once, for every sentence Grove says.
    const { persona: who } = live.current;
    speak(text, { ...who.delivery, voiceId: who.voiceId ?? who.delivery.voiceId }, {
      onDone: () => {
        trigger.suppressVolumeTriggers();
        afterSpeaking?.();
        if (!mounted.current) return;
        // A newer press owns the app now; this speech is over and irrelevant.
        if (turn !== turnSeq.current) return;
        // Listen only when something is genuinely waiting on an answer — the
        // model asked back on purpose, or an ability needs a missing detail.
        //
        // This used to open the microphone after anything ending in a question
        // mark. With a personality that ends half its replies on a joke — "or
        // were you hoping I could conjure it out of thin air?" — that meant the
        // mic opened at random, and people stopped trusting when it was safe to
        // talk. Punctuation was never the signal; intent is.
        if (listenAfter && !running.current) {
          void beginListening(false);
          return;
        }
        // A holding line is said in the middle of a turn, not at the end of
        // one. Dropping to resting after it showed Ready while the answer was
        // still on its way, so people pressed — which abandons the turn — and
        // the next question got another holding line, and the next. Every
        // reply became "give me a sec" and nothing else.
        if (stillWorking) {
          setState((current) => (current === 'speaking' ? 'thinking' : current));
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
      // Never `confirmed` or `draft`: they are filled by the turn, not by the
      // person, and picking one as the gap makes the question unanswerable.
      const empty = Object.entries(ability.args).filter(
        ([name]) => !(args[name] ?? '').trim() && name !== 'confirmed' && name !== 'draft'
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
      { continuous: true, preferOnDevice: live.current.persona.preferOnDevice, hints: hints.current }
    );

    if (!started) void finishNote();
  };

  const startNote = (meetingWith: string[] | null = null) => {
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
      ...(meetingWith ? { meeting: true, people: meetingWith } : { people: [] }),
    };
    setHeard('');
    setCaption(
      meetingWith
        ? `Logging the meeting${meetingWith.length > 0 ? ` with ${meetingWith.join(' and ')}` : ''}. Press when you are done.`
        : 'Taking notes. Press when you are done.'
    );
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
    const { notes: next, saved } = await notesStore.saveNote(live.current.uid, {
      ...note,
      transcript: said,
      createdAt: new Date().toISOString(),
      seconds,
      ...(m.meeting ? { kind: 'meeting' as const, people: m.people } : {}),
    });
    if (!mounted.current) return;
    setNoteList(next);

    // Read into the long memory behind the reply: who was there, what was
    // decided, what anyone promised. One model call, and nobody waits on it.
    const account = live.current.uid;
    void rememberNote(account, saved, saved.id).then(async () => {
      const fresh = await life.loadLife(account);
      if (mounted.current) setLifeMemory(fresh);
    });

    if (!shape) {
      utter("Saved the recording, but I couldn't write it up just now. It's all in your notes.");
      return;
    }

    const todo = note.actions.length;
    const batch = abilityById('reminders.batch');
    if (todo === 0 || !batch) {
      utter(`Saved: ${note.title}.`);
      return;
    }

    // The things to do are offered, not created. Four reminders appearing in
    // your list because a meeting mentioned four things is the kind of
    // helpfulness you spend a morning undoing.
    awaitingYes.current = { ability: batch, args: { items: note.actions.join('\n') }, at: Date.now() };
    utter(
      `Saved: ${note.title}. ${todo === 1 ? 'One thing' : `${todo} things`} to do in there. Press once to put ${todo === 1 ? 'it' : 'them'} in your reminders, twice to leave ${todo === 1 ? 'it' : 'them'}.`
    );
  };

  const tickOff = useCallback(async (id: string) => {
    setCaptures(await inbox.complete(live.current.uid, id));
  }, []);

  const dropCapture = useCallback(async (id: string) => {
    setCaptures(await inbox.remove(live.current.uid, id));
  }, []);

  const endFocus = useCallback(async () => {
    await inbox.setFocus(live.current.uid, null);
    if (mounted.current) setFocus(null);
  }, []);

  const forgetEntity = useCallback(async (id: string) => {
    setLifeMemory(await life.updateLife(live.current.uid, (now) => life.forgetEntity(now, id)));
  }, []);

  const forgetEpisode = useCallback(async (id: string) => {
    setLifeMemory(await life.updateLife(live.current.uid, (now) => life.forgetEpisode(now, id)));
  }, []);

  const gotStruggle = useCallback(async (id: string) => {
    setStuck(await struggles.gotIt(live.current.uid, id));
  }, []);

  const forgetStruggle = useCallback(async (id: string) => {
    setStuck(await struggles.forget(live.current.uid, id));
  }, []);

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
    async (continuous: boolean, retrying = false) => {
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
            const instant = Date.now() - openedAt.current < 700;
            if (instant && !retrying && mounted.current && turn === listenSeq.current) {
              console.log('[grove:listen] ended instantly — one more go');
              void trigger.setKeepAlive(true).catch(() => undefined);
              void beginListeningRef.current?.(continuous, true);
              return;
            }
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
          hints: hints.current,
        }
      );

      console.log('[grove:listen] startListening returned', started);
      if (!started) {
        void trigger.setKeepAlive(true).catch(() => undefined);
        // One retry, after handing the audio graph back and taking it again.
        // The recogniser refusing to start is usually the session still being
        // held by the silence after a spell in the background — and a press
        // that silently does nothing is why people press twice.
        if (!retrying) {
          console.log('[grove:listen] retrying once');
          try {
            await trigger.reactivate();
            await trigger.setKeepAlive(false);
          } catch {
            // The retry below is the thing that matters, not this.
          }
          if (!mounted.current || turn !== listenSeq.current) return;
          void beginListeningRef.current?.(continuous, true);
          return;
        }
        buzz('failed');
        setState(restingState());
        utter("I couldn't open the microphone. Try me again.");
        return;
      }

      // A recogniser that starts and ends within a blink did not really start.
      // That happens coming back from the background, and the person hears
      // nothing at all — so it is worth exactly one more go.
      openedAt.current = Date.now();

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
    // utter is a useCallback with no deps, so it is stable; listing it would
    // rebuild this and, through `press`, resubscribe the ring on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [exchange, clearSilence, setState]
  );

  beginListeningRef.current = beginListening;

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
    if (outcome.ok) doneChime();
    // Otherwise the conversation ends at "press once to go ahead", and "did
    // that send?" is asked of a model that never heard the answer.
    history.current = [...history.current, newTurn('assistant', outcome.spoken)].slice(-24);
    setCaption(outcome.spoken);
    await whenQuiet();
    utter(outcome.ok ? outcome.spoken : shortFailure(outcome.spoken));
    // setState and utter are both stable (useCallback with no deps).
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
          // A press from the volume fallback, while an answer is on its way,
          // is almost never a finger. Grove's own sounds — the chimes, the
          // working pulse, speech starting — can shift the volume on Bluetooth
          // glasses, and the fallback cannot tell that from a press. Taken as
          // one, it abandoned the answer, opened the microphone to nothing and
          // fell back to Ready: "listening, ready, and it doesn't do anything".
          // So the answer is protected. A deliberate interruption still works
          // from the screen, from a ring that sends real media keys, or by
          // pressing once Grove starts talking.
          // Only in the seconds right after a sound Grove made. A press is a
          // phantom because a chime or speech just moved the volume, not
          // because Grove happens to be busy — and ignoring every volume press
          // while thinking or working meant a turn that stalled swallowed real
          // presses too, leaving the ring dead in a pocket.
          if (
            event.raw === 'volume-down' &&
            !awaitingYes.current &&
            Date.now() - lastSound.current < 4000 &&
            (stateNow.current === 'thinking' || stateNow.current === 'working')
          ) {
            console.log('[grove:trigger] volume press ignored — Grove just made a sound');
            break;
          }
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

    // A quiet heartbeat, because the ring going dead in a pocket is the worst
    // failure this app has: you press, nothing happens, and there is no screen
    // to tell you why. Losing the audio session to another app is silent, and
    // until now only opening Grove took it back. This re-arms only when it has
    // genuinely been lost, so an armed Grove — or another app's music — is
    // never disturbed.
    const heartbeat = setInterval(() => {
      if (!mounted.current || trigger.isArmed()) return;
      console.log('[grove:trigger] lost the session — re-arming');
      void arm();
    }, 4 * 60_000);

    // Speaking first. Ninety seconds is often enough to catch a "leave now"
    // while it is still useful, and rare enough that the checks cost nothing:
    // a calendar read, and a route lookup only when something with an address
    // is close.
    const watch = setInterval(() => void considerSpeaking(), 90_000);
    void considerSpeaking();

    // What the Talk screen shows without being asked. A minute is finer than
    // anyone needs and still cheap.
    const refreshNext = async () => {
      const found = await nextUp().catch(() => null);
      if (mounted.current) setNext(found);
    };
    void refreshNext();
    const upcoming = setInterval(() => void refreshNext(), 60_000);

    return () => {
      cancelled = true;
      clearInterval(heartbeat);
      clearInterval(watch);
      clearInterval(upcoming);
      offTrigger();
      offRoute();
      appSub.remove();
    };
    // finishNote reads only refs and stable setters; see the note on `press`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, press, beginListening, catchUp, considerSpeaking, setState]);

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
      captures,
      tickOff,
      dropCapture,
      focus,
      endFocus,
      next,
      dayOne,
      struggles: stuck,
      gotStruggle,
      forgetStruggle,
      life: lifeMemory,
      forgetEntity,
      forgetEpisode,
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
      captures,
      tickOff,
      dropCapture,
      focus,
      endFocus,
      next,
      dayOne,
      stuck,
      gotStruggle,
      forgetStruggle,
      lifeMemory,
      forgetEntity,
      forgetEpisode,
      press,
      say,
    ]
  );

  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

/** The native module, or null on a build without it. Never throws. */
function remoteModule(): typeof import('grove-remote') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('grove-remote') as typeof import('grove-remote');
  } catch {
    return null;
  }
}

/**
 * A job finished: something was added, moved, sent or written.
 *
 * Only for things that changed something. A lookup answers with its answer; a
 * chime on top of that is decoration.
 */
function doneChime(): void {
  buzz('done');
  trigger.suppressVolumeTriggers();
  remoteModule()?.chime('done');
}

/**
 * A short tap, when the build has haptics.
 *
 * Loaded lazily and swallowed on failure for the same reason as everything
 * else native here: this must never be the thing that stops Grove listening.
 */
/**
 * A tap you can feel through a pocket, and a different one per event.
 *
 * With the phone pocketed and the glasses on, the screen says nothing and the
 * chimes only exist on a build that has them. One Light tap for everything was
 * indistinguishable from the phone's own notifications, so pressing and having
 * nothing happen felt the same as pressing and being heard — which is why the
 * habit became pressing twice.
 *
 *   press    a press registered
 *   open     the microphone is actually open — talk now
 *   closed   it closed without hearing anything
 *   done     something was changed
 *   failed   it could not do the thing
 */
function buzz(kind: 'press' | 'open' | 'closed' | 'done' | 'failed' = 'press'): void {
  if (!capabilities().haptics) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const haptics = require('expo-haptics');
    const tap = (style: 'Light' | 'Medium' | 'Heavy') =>
      haptics.impactAsync(haptics.ImpactFeedbackStyle[style]);
    if (kind === 'open') {
      // Two rising taps: the one signal that has to be unmistakable.
      void tap('Medium');
      setTimeout(() => void tap('Heavy').catch(() => undefined), 90);
      return;
    }
    if (kind === 'closed') {
      void tap('Light');
      setTimeout(() => void tap('Light').catch(() => undefined), 110);
      return;
    }
    if (kind === 'done') {
      void haptics.notificationAsync(haptics.NotificationFeedbackType.Success);
      return;
    }
    if (kind === 'failed') {
      void haptics.notificationAsync(haptics.NotificationFeedbackType.Warning);
      return;
    }
    void tap('Light');
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
