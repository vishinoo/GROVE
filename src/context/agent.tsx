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

import { fillDemoMemory } from '@/lib/demoMemory';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { setThemeChoice, type ThemeChoice } from '@/hooks/use-palette';
import { capabilities } from '@/lib/capabilities';
import {
  ABILITIES,
  runAbility,
  setCurrentAccount,
  rememberTone,
  abilityById,
  type Ability,
} from '@/lib/abilities';
import { askGrove, detectActIntent, newTurn, type Turn, type TurnTool } from '@/lib/grove';
import { agreesOnTime, phraseAction } from '@/lib/brain';
import { abortListening, isListening, startListening, stopListening } from '@/lib/listen';
import {
  DEFAULT_PERSONA,
  fallback,
  fineFor,
  holdingFor,
  loadPersona,
  savePersona,
  type Persona,
} from '@/lib/persona';
import { isSpeaking, speak, stopSpeaking } from '@/lib/speak';
import * as memory from '@/lib/memory';
import * as life from '@/lib/life';
import { dueToday, whatMatters, nextUp, type Attention, type NextUp } from '@/lib/attention';
import { noteAnswered } from '@/lib/interrupt';
import { learnWeek, noteTurn } from '@/lib/rhythms';
import { forgetRapport, notice as noticeRapport } from '@/lib/rapport';
import { noteTrouble } from '@/lib/troubles';
import {
  answered as answeredOffer,
  forgetOffers,
  made as offerMade,
  offerFrom,
  worthOffering,
  TURNS_BETWEEN,
  type Offer,
  type Proposal,
} from '@/lib/offers';
import { closing } from '@/lib/closing';
import { plainFailure } from '@/lib/failure';
import * as struggles from '@/lib/struggles';
import { afterTurn, consolidateNow } from '@/lib/consolidate';
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

/**
 * How long the microphone stays open when Grove opened it itself.
 *
 * Every reply now ends with a moment where you can simply carry on talking,
 * instead of reaching for the ring again to say one more thing. The window is
 * short on purpose: the failure this design was built to avoid is a mic that
 * opens at random and sits there, and the fix for that is not refusing to open
 * it — it is closing it again almost immediately when nobody speaks.
 *
 * A question gets much longer, because Grove has just asked for something and
 * the person has to think before they answer.
 *
 * WHY THE TWO NUMBERS ARE SO FAR APART
 *
 * They are answers to different questions, and treating them as one dial is
 * why both have been wrong at some point.
 *
 * `ANSWER_MS` is "Grove asked you something, how long to decide" — twelve
 * seconds, because deciding takes thought and the question was Grove's idea.
 *
 * `GRACE_MS` is only "how long to wait for you to *begin* a word you already
 * meant to say". Nothing is pending; the reply is finished. It went from two
 * to four and a half to make room for the tail of Grove's own voice, and that
 * overshot badly: `SPEECH_TAIL_MS` now holds the microphone back until the
 * sound has actually stopped, so the window no longer has to absorb it, and
 * four and a half seconds of a screen saying Listening after an ordinary
 * answer reads as the app having hung.
 *
 * Cutting it to a second and a half overshot the other way, and the reason is
 * worth writing down because the number alone does not explain it. The clock
 * used to start when `startListening` *returned*, which is the recogniser
 * agreeing to start — not the microphone being open. Bringing up the audio
 * engine takes a few hundred milliseconds more, and all of it was being spent
 * out of a window that short. So the clock now starts at the first level
 * reading from the recogniser, which is the first evidence that a microphone
 * is genuinely listening, and three seconds here means three seconds of
 * microphone rather than three seconds minus however long the hardware took.
 *
 * This is only ever about *starting*: `onPartial` re-arms to `TRAILING_MS`
 * the moment a word is heard, so anyone who does begin gets three and a half
 * seconds of pausing room per breath and is never cut off mid-sentence.
 *
 * And if you already know you are finished, you do not have to wait it out —
 * see `closing.ts`.
 *
 * The asymmetry is the whole point. A short window costs one press from
 * someone who hesitated; a long one makes every single reply end in a pause
 * that looks like a fault.
 */
/**
 * The gap between a sentence being finished and the microphone opening.
 *
 * `Speech.speak`'s onDone fires when the synthesiser has queued its last
 * buffer, which on iOS is before the sound has actually left the speaker.
 * Starting the recogniser takes the audio route, so without this pause the
 * end of every reply was clipped by the thing listening for the next one.
 *
 * Tunable, and worth tuning on a device: too short and words are lost, too
 * long and the reply feels like it ends twice. It is spent inside a window
 * measured in seconds, so erring long is cheap.
 */
const SPEECH_TAIL_MS = 500;

const GRACE_MS = 3000;
const ANSWER_MS = 12_000;

/**
 * Silence after speech has already been heard.
 *
 * Separate from the two above, which are "nothing at all yet". Once words have
 * arrived this is a pause mid-sentence, and cutting someone off because they
 * drew breath is worse than waiting a moment longer — so this is the most
 * generous of the three relative to what it is waiting for.
 */
const TRAILING_MS = 3600;

/**
 * How long a claim to be listening is allowed to go unbacked by a recogniser
 * before the watchdog treats it as a desync. Long enough to cover the session
 * handover coming back from the background, which is the slowest honest start.
 */
const LISTEN_GRACE_MS = 3000;

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

  /** The long memory: who and what is in their life, and what happened. */
  life: life.Life;
  forgetEntity: (id: string) => Promise<void>;
  forgetEpisode: (id: string) => Promise<void>;

  /** The next thing in the day, and when to leave for it. Shown, never spoken. */
  next: NextUp;
  /** A reminder due today, read only when access was already granted. */
  due: string | null;
  /** Demo only: fills memory with what is known about the author. See demoMemory.ts. */
  fillDemo: () => Promise<void>;

  /** Things they said they did not understand, hardest first. */
  struggles: struggles.Struggle[];
  /** Tick one off by hand, once it has stopped happening. */
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
  /** Set while a window Grove opened itself is running, so it makes no sound. */
  const quietListen = useRef(false);
  /**
   * The turn after which no grace window opens, because it was not wanted.
   *
   * Held as a turn number rather than a flag so it cannot leak: it applies to
   * exactly the turn that set it, and the next sentence carries its own
   * number and is listened after as usual. Two things set it — someone
   * saying "enough" (`closing.ts`), and anything Grove says unprompted.
   */
  const hushAfter = useRef(-1);
  /** When the current claim to be listening began, for the desync watchdog. */
  const listenStartedAt = useRef(0);
  /** When Grove last made a sound, which is when a phantom press can arrive. */
  const lastSound = useRef(0);
  /** What has already been volunteered, so nothing is said twice. */
  const attention = useRef<Attention>({ said: new Set<string>() });
  const [next, setNext] = useState<NextUp>(null);
  const [due, setDue] = useState<string | null>(null);
  const [stuck, setStuck] = useState<struggles.Struggle[]>([]);
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
    const opening =
      (now === 'listening' || now === 'noting') && was !== 'listening' && was !== 'noting';
    const shutting =
      (was === 'listening' || was === 'noting') && (now === 'idle' || now === 'asleep');

    /*
      A grace window makes no sound at either end.

      Opening the microphone after every single reply is right; announcing it
      twice with chimes and haptics every single time is not — a conversation
      would come with a two-tone jingle between every sentence. A press still
      gets both sounds, because a press is a question about whether the thing
      heard you and the sound is the answer.
    */
    const quietly = quietListen.current;
    if (shutting) quietListen.current = false;

    // Haptics first: they work on every build, and the chimes only exist on one
    // that has the native half.
    if (opening && !quietly) {
      buzz('open');
    } else if (shutting && !quietly) {
      buzz('closed');
    }
    const remote = remoteModule();
    if (!remote) return;
    // Any sound Grove starts can move the volume on Bluetooth glasses, and the
    // volume fallback would read that as a press. See the ring handler below.
    lastSound.current = Date.now();
    trigger.suppressVolumeTriggers();
    const busy = (x: AgentState) => x === 'thinking' || x === 'working';

    if (opening && !quietly) {
      remote.chime('listen');
    } else if (shutting && !quietly) {
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
  const [lifeMemory, setLifeMemory] = useState<life.Life>({ entities: [], episodes: [], pending: [] });
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
          ...byRecency.flatMap((e) => [e.name, ...e.aliases]),
          'Grove',
        ]
          .map((w) => w.trim())
          .filter((w) => w.length > 1)
      ),
    ].slice(0, 100);
  }, [lifeMemory, persona.name]);

  /**
   * Refs, not state, for everything the trigger callback reads.
   *
   * The ring fires from a native event into a closure captured once. Reading
   * React state there gives whatever the values were when the listener was
   * registered, which in practice means an empty toolbelt and a stale persona
   * forever. These are the live values.
   */
  const history = useRef<Turn[]>([]);
  const live = useRef({ state, persona, facts, uid });
  live.current = { state, persona, facts, uid };
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

  /**
   * An offer Grove made at the end of the last reply, waiting on a yes.
   *
   * Kept apart from `awaitingYes` on purpose, and the difference is the whole
   * safety argument for the feature. A confirmation is the last gate in front
   * of something irreversible, and a press answers it. An offer is a question
   * Grove thought of by itself, and saying yes to one only ever *starts* the
   * ability — which then asks for its own confirmation if it has one. So an
   * offer cannot be answered with a press, and nothing here ever sets
   * `confirmed`. See offers.ts.
   */
  const offered = useRef<(Offer & { at: number }) | null>(null);

  /**
   * Turns of plain conversation since the last offer.
   *
   * Starts full, so the first one Grove notices is allowed. Held here rather
   * than written down because spacing only has to hold inside a conversation,
   * and reading it off disk would have put a storage read on every turn.
   */
  const turnsSinceOffer = useRef(TURNS_BETWEEN);

  /** Set while a first press is waiting to see whether a second follows. */
  const yesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** How long a confirmation stays live. Long enough to think, short enough to forget. */
  const CONFIRM_WINDOW_MS = 25_000;

  /**
   * How long an offer stays answerable.
   *
   * Longer than a confirmation, because there is nothing armed: a confirmation
   * left live is a booby trap, since the next press is meant for something
   * else, and an offer cannot be answered by a press at all. Short enough
   * that "yeah" two minutes later is a reply to whatever was said since.
   */
  const OFFER_WINDOW_MS = 90_000;
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
      if (!mounted.current) return;
      setPersona(stored);
      // The palette store lives outside React so that the login and onboarding
      // screens, which render before this provider, are drawn in the right
      // colours too. Pushed on load and on every change.
      setThemeChoice(stored.theme as ThemeChoice | undefined);
    });
  }, []);

  const updatePersona = useCallback(async (next: Persona) => {
    setPersona(next);
    setThemeChoice(next.theme as ThemeChoice | undefined);
    await savePersona(next);
  }, []);

  /* ------------------------------------------------------------ activity */

  useEffect(() => {
    if (status !== 'signed-in') {
      setActivity([]);
      setFacts([]);
      return;
    }
    void transcript.loadActivity(uid).then((entries) => {
      if (mounted.current) setActivity(entries);
    });
    // Abilities read per-account state through this rather than through a
    // parameter, so it has to be set before any of them can run.
    setCurrentAccount(uid);
    void memory.loadFacts(uid).then((f) => {
      if (mounted.current) setFacts(f);
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
    // What their week normally looks like. Held for a day inside rhythms.ts, so
    // this is a network call on the first open of the day and free after that.
    void learnWeek(uid);
    void struggles.loadStruggles(uid).then((list) => {
      if (mounted.current) setStuck(list);
    });
     
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
  /**
   * Start again, meaning it.
   *
   * This used to clear the transcript, the facts and the sparks, and leave the
   * long memory, the notes, the ledger and the study list exactly where they
   * were — so a button labelled "start again" left behind every person, every
   * dated episode and every amount anyone had ever mentioned. Which is the one
   * thing a wipe must not do, and became more important rather than less once
   * all of it was being encrypted: a promise about where someone's data lives
   * is worth nothing if the button that deletes it does not.
   */
  const startAgain = useCallback(async () => {
    const account = live.current.uid;
    history.current = [];
    lastVolunteered.current = null;
    attention.current = { said: new Set<string>() };
    offered.current = null;
    turnsSinceOffer.current = TURNS_BETWEEN;
    turnSeq.current += 1;
    setCaption('');
    setHeard('');
    const [entries, facts] = await Promise.all([
      transcript.clearActivity(account),
      memory.forgetAll(account),
      life.forgetAllLife(account),
      struggles.forgetAllStruggles(account),
      forgetRapport(account),
      // Including what it has learned about which offers are welcome. That is
      // a record of someone's refusals, and starting again means it goes too.
      forgetOffers(account),
    ]);
    if (!mounted.current) return;
    setActivity(entries);
    setFacts(facts);
    setLifeMemory({ entities: [], episodes: [], pending: [] });
    setStuck([]);
    setNext(null);
    setDue(null);
  }, []);

  const fillDemo = useCallback(async () => {
    const account = live.current.uid;
    if (!account || account === 'anon') return;
    await fillDemoMemory(account);
    const [f, l] = await Promise.all([memory.loadFacts(account), life.loadLife(account)]);
    if (!mounted.current) return;
    setFacts(f);
    setLifeMemory(l);
  }, []);

  const forgetFact = useCallback(async (id: string) => {
    setFacts(await memory.forget(live.current.uid, id));
  }, []);

  const forgetEverything = useCallback(async () => {
    setFacts(await memory.forgetAll(live.current.uid));
  }, []);

  /* ------------------------------------------------------------- talking */

  /**
   * One exchange, end to end.
   *
   * Written as a single function rather than split across the state machine
   * because the ordering *is* the design — reply, record, then run — and
   * scattering it across handlers is how that ordering quietly gets lost.
   */
  const exchange = useCallback(async (said: string, heardAloud = true) => {
    /*
      "Enough" comes off the front of everything else.

      It can be the whole sentence, in which case there is nothing to answer
      and the only right reply is no reply: close the microphone and stop. A
      "sure, done" after "enough" is exactly the noise being asked for less
      of. Or it can be the last word of a real sentence, in which case the
      sentence runs normally and only the window afterwards is dropped.

      Read before anything else looks at the words, so a confirmation sees the
      sentence without it and the model never has to be told the word exists.

      Spoken input only. The word exists to shut a listening window, and the
      typed box has none — so typing "enough" there would have produced no
      reply and nothing on screen to say why, which is the typed version of
      the press that does nothing. Typed text is also deliberate in a way
      dictation is not: taking a word off the end of something somebody
      actually typed is a worse trade than taking it off a transcript.
    */
    const shut = heardAloud ? closing(said) : { text: said, closed: false };
    const text = shut.text.trim();
    if (!text) {
      // A confirmation left armed is a booby trap, and "enough" is not a yes.
      // Neither is it a no worth teaching anything from: an offer cleared here
      // is cleared without being counted, the same as any sentence that moved
      // on rather than refusing.
      awaitingYes.current = null;
      offered.current = null;
      if (shut.closed) console.log('[grove:listen] closed on request');
      // No sound said from here. Dropping out of 'listening' is itself the
      // closing transition, so `soundFor` makes the one noise this deserves —
      // and `onPartial` has already cleared `quietListen`, so it makes it
      // even for a window Grove opened itself. Saying it again here was two
      // taps for one event.
      setState(restingState());
      return;
    }

    const turn = ++turnSeq.current;
    if (shut.closed) hushAfter.current = turn;
    /** Whether this turn is still the one the user is waiting on. */
    const mine = () => mounted.current && turn === turnSeq.current;

    const { persona: voice, facts: known, uid: account } = live.current;

    // When the day started. Marked here, on something the person said, rather
    // than on anything Grove said first — a leave-by reminder landing at seven
    // before they have spoken would file every day as an early one.
    void noteTurn(account);
    // Talking shortly after an unprompted line is the only evidence there is
    // that the line was wanted. It feeds the bar in interrupt.ts, and does
    // nothing at all unless there is a recent one to credit.
    void noteAnswered(account);

    // How they talk, counted locally from their own words. Shapes every reply
    // after this one; see rapport.ts.
    void noticeRapport(account, text);
    const asked = text;

    // Whatever Grove was still saying is finished with.
    //
    // Without this, speaking to Grove while it was mid-sentence left the old
    // sentence playing and queued the new answer behind it through
    // whenQuiet() — so replies arrived minutes late, in order, like a backlog
    // being worked through. The turn counter above has already invalidated the
    // previous turn, so nothing it does after this can speak again.
    stopSpeaking();

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
      // Changing the tone, which is neither a yes nor a no — see redraftTone.
      // Only mail has a tone, and only mail accepts this.
      const toned =
        /^\s*(?:(?:make|keep) it |more |be |a bit )?(casual|chatty|informal|friendly|relaxed|formal|professional|proper)\b/i.exec(
          asked
        );
      if (toned && holding.ability.id.startsWith('mail.')) {
        clearTimeout(holdTimer);
        awaitingYes.current = null;
        if (!fresh) {
          utter('That one timed out. Ask me again.');
          return;
        }
        await redraftTone(
          holding,
          /casual|chatty|informal|friendly|relaxed/i.test(toned[1]) ? 'casual' : 'professional'
        );
        return;
      }
      // Anything else means they moved on, and a confirmation nobody answered
      // must not survive into a later turn.
      awaitingYes.current = null;
    }

    /*
      An answer to something Grove offered to do.

      Cleared whatever the answer is, so an offer captures exactly one reply
      and never lingers into a later turn — the same rule as a confirmation
      and for the same reason.

      Only an outright yes or no teaches anything. Someone who answers an
      offer with a different sentence has not refused it, they have moved on,
      and counting that as a refusal would switch a whole kind off for a
      conversation that simply went somewhere else.
    */
    const proposed = offered.current;
    offered.current = null;
    if (proposed && Date.now() - proposed.at <= OFFER_WINDOW_MS) {
      const yes =
        /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|go on|go ahead|do it|please(?: do)?|sounds good|that would be good|why not|definitely|alright)\s*[.!]?\s*$/i.test(
          asked
        );
      const no =
        /^\s*(?:no|nope|nah|no thanks|no thank you|not now|not right now|later|maybe later|don'?t|i'?m good|it'?s fine|leave it)\s*[.!]?\s*$/i.test(
          asked
        );
      /*
        "Stop offering that" is a different sentence from "no".

        This is the distinction the first version did not have, and not having
        it was the bug. Two nos to two badly-chosen links used to switch links
        off for good — which read a verdict on two offers as an instruction
        about a whole ability, and made something genuinely useful look
        broken. Declining is now rest, and only this pattern is permanent.

        Deliberately a phrase and not a word. Nothing in here can be reached
        by a bare "no", so Grove can never infer a veto; it has to be asked
        for, in a sentence, which is the right asymmetry for a switch that
        stays off.
      */
      const veto =
        /\b(?:stop|quit|never|don'?t|do not)\b[^.?!]{0,30}\b(?:offer|offering|offers|ask|asking|suggest|suggesting|prompt|prompting|bring(?:ing)? (?:that|this) up)\b/i.test(
          asked
        ) || /\b(?:stop|quit)\s+(?:that|it|doing that)\b/i.test(asked);
      if (yes) {
        clearTimeout(holdTimer);
        // An accept clears the run of declines and lifts any veto: they said
        // stop once and have now said yes, and the second is more recent and
        // more specific than the first.
        void answeredOffer(account, proposed.kind, 'accepted');
        const doing = abilityById(proposed.ability);
        if (!doing) {
          // An offer naming an ability that no longer exists. verify checks
          // for this, so it should be unreachable — and saying so is better
          // than a press that does nothing.
          utter("I offered that and now I can't find it. Ask me directly?");
          return;
        }
        running.current = true;
        setState('working');
        /*
          Run from the beginning, with nothing filled in that the person did
          not give. In particular never `confirmed` — an ability that asks for
          a press still asks for it, so a yes to Grove's own question can
          never be the thing that sends, books or buys. That is the rule the
          whole feature is built around.
        */
        const slow = doing.slow === true;
        if (slow) utter(holdingFor(voice), false, true);
        const outcome = await runAbility(doing, proposed.args);
        running.current = false;
        if (!mine()) return;
        if (outcome.needsConfirming) {
          awaitingYes.current = { ability: doing, args: outcome.confirmArgs ?? proposed.args, at: Date.now() };
        }
        if (outcome.ok && !doing.reads) doneChime();
        history.current = [...history.current, newTurn('user', text), newTurn('assistant', outcome.spoken)].slice(-24);
        setCaption(outcome.spoken);
        await whenQuiet();
        if (!mine()) return;
        utter(outcome.ok ? outcome.spoken : shortFailure(outcome.spoken), false, false, () => {
          if (awaitingYes.current) awaitingYes.current.at = Date.now();
        });
        return;
      }
      if (veto) {
        clearTimeout(holdTimer);
        void answeredOffer(account, proposed.kind, 'vetoed');
        // Said back plainly rather than in character, because this is the one
        // answer here that changes something lasting and they should hear
        // that it landed. It can be taken back from the Memory screen, or by
        // ever saying yes to one again.
        utter("Right — I'll stop offering that.");
        return;
      }
      if (no) {
        clearTimeout(holdTimer);
        // Rest, not an off switch. A no is a verdict on this offer; it buys
        // the kind a quiet day or two and nothing more. See the Score note in
        // offers.ts for why those are different things.
        void answeredOffer(account, proposed.kind, 'declined');
        // Said, not silent: falling quiet after a no is indistinguishable
        // from the app not having heard it. In the voice, because this is one
        // of the lines said most often.
        utter(fineFor(voice));
        return;
      }
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
      // Through plainFailure, because `error.message` here is whatever threw —
      // and a thrown message is as likely to be a framework code as a
      // sentence. The raw text is filed; what is said is in words.
      const message = plainFailure(error, fallback.stuck());
      void noteTrouble(
        live.current.uid,
        error instanceof Error ? error.message : String(error),
        'thinking'
      );
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
    /*
     * An action's reply waits for the action.
     *
     * The model writes the line it would say once the thing has worked, in the
     * same breath as calling the tool — so the natural sentence costs nothing,
     * where asking for it afterwards cost a whole extra round trip on every
     * action. It is held here and spoken once the outcome is known, which is
     * what keeps it honest: if the tool fails, the failure is said instead and
     * this line is never heard.
     *
     * Two exceptions, and both are cases where the ability never runs this
     * turn:
     *
     *   - A slow ability. Half a minute of silence while a document is written
     *     reads as a crash, so that one acknowledges first.
     *   - A standing job. "Every morning at eight, tell me the weather" names
     *     an ability and then saves a spark instead of running it, and the
     *     branch that does so returns — so a line held here was never spoken
     *     at all. Setting a spark went completely silent, which is the exact
     *     shape of failure this app can least afford.
     */
    const holdsReply = Boolean(reply.ability) && !reply.ability?.slow;
    if (!reply.holdForTool && !holdsReply) {
      /*
        One sentence added to the end, sometimes.

        The microphone has to open after it, because an offer is a question
        with something waiting on the answer — which is the only thing that
        has ever been allowed to open it (see `utter`). That is also the
        honest version of the cost: an offer spends a listening window, and
        the window shuts itself in silence.
      */
      const offer = await considerOffer(reply.offer);
      if (!mine()) return;
      utter(
        offer ? `${reply.text} ${offer.say}` : reply.text,
        offer ? true : Boolean(reply.expectsReply)
      );
      if (offer) offerSpoken(offer);
    }

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

    // Nothing to run means nothing to do — the reply has already been spoken.
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

    /*
     * The sentence is written while the work is being done, not after it.
     *
     * When the model hands back an action without words — which it does more
     * often than not, whatever the rules ask of it — the line has to come from
     * a second call. Waiting for the tool first and then making that call adds
     * both together; started here they overlap, and on a phone where writing a
     * reminder or inserting a calendar event takes most of a second, that is
     * the whole of the second call hidden behind work already happening.
     *
     * It is written from what was asked for rather than what came back, which
     * is the trade: slightly less to go on, and it is checked against the real
     * outcome before anything is said. Nothing is spoken if the tool fails.
     */
    const phrasing = reply.holdForTool
      ? phraseAction(
          { persona: voice, facts: known },
          text,
          `About to ${ability.name.toLowerCase()}${
            Object.values(reply.args).filter(Boolean).length
              ? `: ${Object.entries(reply.args)
                  .filter(([name, value]) => value && name !== 'confirmed' && name !== 'draft')
                  .map(([name, value]) => `${name} ${value}`)
                  .join(', ')}`
              : ''
          }. It worked.`,
          ''
        ).catch(() => null)
      : null;

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

    // An ability that could not do its job is the kind of failure worth
    // keeping: the spoken line is already gone by the time anyone wonders
    // whether the calendar has been refusing all week.
    if (!outcome.ok && outcome.spoken) {
      void noteTrouble(live.current.uid, outcome.spoken, ability.id);
    }

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
    // Shown on screen, so it refreshes as soon as something changes it rather
    // than on the next launch.
    if (outcome.ok && ability.id === 'memory.friction') {
      void struggles.loadStruggles(account).then((list) => mounted.current && setStuck(list));
    }

    /*
     * What gets said, in the order it is cheapest to say it.
     *
     *   - It failed: said plainly and now. A failure is the one thing nobody
     *     should wait an extra second to hear phrased nicely.
     *   - The model wrote the line already, held above. Free, and the usual
     *     case now that the rules ask for it.
     *   - It did not, so the outcome goes back for one bounded line in the
     *     right voice with what else is waiting. A round trip, paid only when
     *     the first one came back wordless.
     *   - Spoken earlier, before a slow ability: nothing to add.
     *
     * Either way the line is checked against what actually happened. The model
     * writes it before the tool runs, so it is working from what was asked for
     * rather than what was done, and "at seven" coming back as "at six" is the
     * one difference that costs something.
     */
    /*
     * Some abilities answer; most only confirm.
     *
     * The model writes its line before the tool runs, so it can only ever
     * confirm — and where the tool comes back with something the model could
     * not have known, the tool has to win. Missing that swallowed a question
     * whole — the tool asked one, the model's own line replaced it, and the
     * microphone opened for an answer to a question nobody had been asked —
     * and a finished document lost its result the same way.
     *
     * Three tells, and all three are already declared: a line the microphone
     * opens after is a question, a slow ability was acknowledged before it
     * started so its result is still owed, and a queued track is named by the
     * tool and guessed at by the model.
     */
    const toolAnswers =
      outcome.listenAfter === true || ability.slow === true || outcome.resumeMusicWhenQuiet === true;

    let heard = outcome.ok ? outcome.spoken : shortFailure(outcome.spoken);
    if (outcome.ok && toolAnswers) {
      heard = outcome.spoken;
    } else if (outcome.ok && holdsReply && reply.text.trim() && reply.wroteForAction) {
      heard = agreesOnTime(reply.text, [outcome.spoken, outcome.detail].filter(Boolean).join(' '))
        ? reply.text
        : outcome.spoken;
    } else if (outcome.ok && holdsReply && reply.text.trim()) {
      /*
       * The line answers a different part of the sentence.
       *
       * "What's the weather and remind me to call mum at six" runs the weather
       * inside the model's own turn and hands back the reminder, so the line
       * in hand is the forecast — which says nothing about the reminder.
       * Substituting it set the reminder and never mentioned it. Both get
       * said, in the order they were asked for.
       */
      heard = [reply.text, outcome.spoken].filter(Boolean).join(' ');
    } else if (outcome.ok && phrasing) {
      const phrased = await phrasing;
      if (!mine()) return;
      // Written before the tool answered, so it is checked against what the
      // tool actually did — "at seven" coming back as "at six" is the one
      // difference here that costs something.
      if (phrased && agreesOnTime(phrased, [outcome.spoken, outcome.detail].filter(Boolean).join(' '))) {
        heard = phrased;
      }
    }
    // The result of work you interrupted is not something you still want read
    // out — you have already moved on and asked something else.
    // An ability that asked for a missing detail — "what's your home address?"
    // — is waiting on the answer, so the microphone opens for it.
    //
    // Nothing left to say means the reply already said it. The state still has
    // to settle, and anything queued behind the turn — a song waiting for the
    // last word — still has to happen, so this does not return early.
    if (!mine()) return;
    if (heard) {
      // Not after a failure, and not after something that is still waiting on
      // an answer. A thing that just went wrong followed by Grove proposing a
      // different piece of work is the worst version of this feature.
      const offer =
        outcome.ok && pending.current === null && outcome.listenAfter !== true
          ? await considerOffer(reply.offer)
          : null;
      if (!mine()) return;
      utter(
        offer ? `${heard} ${offer.say}` : heard,
        offer ? true : pending.current !== null || outcome.listenAfter === true
      );
      if (offer) offerSpoken(offer);
    } else setState(restingState());

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
  const considerSpeaking = useCallback(async (urgentOnly = false) => {
    if (!mounted.current) return;
    const resting = stateNow.current === 'idle' || stateNow.current === 'asleep';
    if (!resting || running.current || isSpeaking() || awaitingYes.current) return;
    // One switch, and it is theirs. The rationing is interrupt.ts's job.
    if (live.current.persona.speaksUp === false) return;

    const account = live.current.uid;
    // Opening the app is not an invitation to be told things.
    //
    // The first check runs the moment Grove comes forward, and anything soft
    // reaching it lands as a lecture before the screen has even settled: "you
    // still haven't done the dishes" is a miserable way to be greeted by your
    // own assistant. A leave-by is different — that is the one thing worth
    // interrupting a launch for, and waiting ninety seconds to say it defeats
    // the whole point of saying it.
    const moment = await whatMatters(attention.current, account, !urgentOnly);
    // It records what it offered before it is spoken, so the state is
    // re-checked here rather than after: a press that landed during the
    // calendar read means this turn is over.
    if (!mounted.current || (stateNow.current !== 'idle' && stateNow.current !== 'asleep')) return;

    const say = moment?.say ?? null;
    if (!say || !mounted.current) return;
    if (stateNow.current !== 'idle' && stateNow.current !== 'asleep') return;

    attention.current.said.add(moment!.id);
    lastVolunteered.current = new Date().toISOString();
    setCaption(say);
    // Spoken, never listened after — even the lines that end in a question.
    // Grove started this, the phone is in a pocket, and nobody asked for a
    // microphone to come on. One unasked-for noise is the most this is worth.
    // The press is there if they want to answer.
    //
    // This used to be true by construction, because a reply only ever opened
    // the microphone when something was waiting on an answer. The grace
    // window after every reply made it untrue without anything here changing,
    // and nothing said so — which is the shape of invariant worth stating in
    // code rather than only in a comment. `utter` reads the turn number back.
    hushAfter.current = turnSeq.current;
    utter(say);

    if (account && account !== 'anon') {
      const entries = await transcript.record(account, { said: '', replied: say });
      if (mounted.current) setActivity(entries);
    }
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
        // A holding line is said in the middle of a turn, not at the end of
        // one. Dropping to resting after it showed Ready while the answer was
        // still on its way, so people pressed — which abandons the turn — and
        // the next question got another holding line, and the next. Every
        // reply became "give me a sec" and nothing else.
        //
        // Checked before the grace window, because a turn still in flight is
        // the one moment where opening the microphone would be wrong: you
        // would be talking over an answer that is still coming.
        if (stillWorking) {
          setState((current) => (current === 'speaking' ? 'thinking' : current));
          return;
        }
        /*
          Every reply ends with a moment you can talk into.

          This used to open only when something was genuinely waiting on an
          answer, because an earlier version opened after anything ending in a
          question mark and a personality that ends half its replies on a joke
          opened the mic at random. That reasoning still holds — punctuation
          was never the signal — but the conclusion was too strong. Having to
          reach for the ring again to add one more sentence is its own kind of
          wrong, and it is the common case.

          What makes it safe is that the window shuts itself. Two seconds of
          silence and it is closed, with no sound at either end, so a window
          nobody used costs nothing and leaves no trace. A question gets seven,
          because Grove has just asked for something and thinking takes longer
          than breathing.
        */
        /*
          The tail has to finish before the microphone opens.

          `onDone` is the synthesiser saying it has queued its last buffer,
          not the sound saying it has left the speaker, and opening the
          recogniser takes the audio route — so the last word of every reply
          was being cut off by the thing listening for the next one. The gap
          costs nothing: the window that follows is seconds long, and a reply
          you can actually hear the end of is the point of saying it.

          Still "speaking" while it drains, because it audibly is. Dropping to
          Ready and then opening the mic a moment later would flicker through
          a state that was never true.
        */
        /*
          A window that was asked not to open.

          Only the grace window, never the one after a real question. "Enough"
          means "I have finished talking", and if Grove has nonetheless had to
          ask for something, leaving it asking with no way to answer is the
          worse of the two failures — and unprompted lines never set
          `listenAfter` in the first place, so the distinction costs them
          nothing.

          Still spent inside the tail below rather than returning here, so the
          state drops to Ready when the sound stops and not while it is still
          audibly draining — which is the same reason the tail exists at all.
        */
        const hushed = !listenAfter && hushAfter.current === turn;
        /*
          A song Grove paused is a song that gets the window instead.

          The grace window is a microphone opened on spec, in case there is
          one more sentence. Opening it while a track is paused mid-song is
          the worst of both: on Bluetooth glasses the route has no input to
          give it, so it fails for the reason in Settings and the music waits
          three more seconds for nothing — and on anything else it works and
          the track is still stopped. Either way the song has been chopped so
          that Grove could listen to silence.

          So a press still gets the microphone, and everything after it gets
          the music back. The window is the one of the two that can wait: it
          exists to save a press, and this costs exactly that one press.
        */
        const playing = pausedMusic.current;
        const window = listenAfter ? ANSWER_MS : GRACE_MS;
        setTimeout(() => {
          if (!mounted.current) return;
          // A newer press or a newer line owns the app now, and owns the
          // state with it.
          if (turn !== turnSeq.current || isSpeaking()) return;
          if (!running.current && !hushed && !(playing && !listenAfter)) {
            void beginListening(false, false, { window, quiet: !listenAfter });
            return;
          }
          // And even within the same turn, only speaking becomes resting. If
          // anything downstream has already moved on, it keeps its state.
          setState((current) => (current === 'speaking' ? restingState() : current));
        }, SPEECH_TAIL_MS);
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

  const gotStruggle = useCallback(async (id: string) => {
    setStuck(await struggles.gotIt(live.current.uid, id));
  }, []);

  const forgetStruggle = useCallback(async (id: string) => {
    setStuck(await struggles.forget(live.current.uid, id));
  }, []);

  const forgetEntity = useCallback(async (id: string) => {
    setLifeMemory(await life.updateLife(live.current.uid, (now) => life.forgetEntity(now, id)));
  }, []);

  const forgetEpisode = useCallback(async (id: string) => {
    setLifeMemory(await life.updateLife(live.current.uid, (now) => life.forgetEpisode(now, id)));
  }, []);

  const clearSilence = useCallback(() => {
    if (silence.current) {
      clearTimeout(silence.current);
      silence.current = null;
    }
  }, []);

  /*
    A pair of Bluetooth glasses cannot play music and hear you at the same
    time, and no amount of audio session is going to change that.

    Bluetooth has two profiles. A2DP carries stereo in one direction and has
    **no microphone at all**. HFP has a microphone and is mono, at telephone
    quality. A headset does one or the other, and switching between them is a
    route change that stops whatever was playing.

    So while a song is going, the glasses are in A2DP and there is no input
    anywhere for a recogniser to open. That is what "The audio input is busy"
    in Settings actually means: not a device in use by someone else, but
    `inputNode.outputFormat` coming back with a sample rate of nought, because
    the current route has no input side.

    And Grove may not simply take it. A mixable session is one that has
    promised not to interrupt anybody, which is exactly what forcing the
    glasses from A2DP to HFP would do — so the route switch is refused rather
    than granted, and the microphone never opens.

    Which is the other half of the error list: `!int`,
    `AVAudioSessionErrorCodeCannotInterruptOthers`. The session must stay
    mixable, because a non-mixable one **cannot be activated from the
    background at all** and that is where every ring press comes from.

    The way out is not an option on the session. It is to stop the music
    first, the way every assistant on a phone does: the track pauses, the
    route is free, the microphone opens, and the track comes back when Grove
    has finished. Only ever a track Grove paused itself — a song somebody
    stopped on purpose must stay stopped.
  */
  const pausedMusic = useRef(false);

  const hushMusic = useCallback(async () => {
    if (pausedMusic.current) return;
    try {
      if (!trigger.musicPlaying()) return;
      pausedMusic.current = true;
      await trigger.controlMusic('pause');
    } catch {
      // No music half on this build is not a reason to refuse to listen.
    }
  }, []);

  const resumeMusic = useCallback(async () => {
    if (!pausedMusic.current) return;
    pausedMusic.current = false;
    try {
      await trigger.controlMusic('play');
    } catch {
      // As above. A song that does not come back is better than a turn that
      // never finishes.
    }
  }, []);

  const beginListening = useCallback(
    async (
      continuous: boolean,
      retrying = false,
      opts: { window?: number; quiet?: boolean } = {}
    ) => {
      const window = opts.window ?? SILENCE_TIMEOUT_MS;
      // Re-taking the session is asynchronous, and the state says 'listening'
      // for that whole window — so a second press arrives, stops a recogniser
      // that has not started, and the original start then runs anyway against
      // a session being reconfigured underneath it. This claim makes the last
      // press win instead.
      const turn = ++listenSeq.current;

      setProblem(null);
      setHeard('');
      setLevel(0);

      quietListen.current = Boolean(opts.quiet);
      listenStartedAt.current = Date.now();
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

      // And before that, the music, because on Bluetooth glasses there is no
      // microphone to open until the track lets go of the route. See hushMusic.
      await hushMusic();
      if (turn !== listenSeq.current || !mounted.current) return;

      /**
       * Nothing said at all: close the recogniser rather than leave it holding
       * the microphone with the UI insisting it is listening.
       */
      const armSilence = () => {
        clearSilence();
        silence.current = setTimeout(() => {
          if (!mounted.current || turn !== listenSeq.current) return;
          console.log('[grove:listen] nothing heard in', window, 'ms — cancelling');
          abortListening();
          setState(restingState());
        }, window);
      };

      /*
        The window is measured from the microphone opening, not from asking it
        to open.

        `startListening` returning true means the recogniser accepted the
        request. Bringing up the audio engine takes a few hundred milliseconds
        after that, and on a short window most of it was being charged to the
        person — who then found that talking straight away sometimes worked
        and sometimes did not, for no reason they could see.

        A level reading is the first thing that cannot happen until a
        microphone is actually being read, so the first one restarts the
        clock. Exactly the first: the readings arrive every hundred
        milliseconds whether or not anyone is speaking, so re-arming on each
        one would be a window that never closes.

        And it only ever *delays* the close — the timer is armed below either
        way, so a build whose native half never reports a level still shuts
        the microphone on time rather than holding it open for ever.
      */
      let micLive = false;
      let heardSomething = false;

      const started = startListening(
        {
          onPartial: (text) => {
            /*
              Re-armed, not cancelled.

              Hearing a word used to clear the give-up timer outright, which
              meant one word followed by silence left nothing at all able to
              close the microphone: if the recogniser then never fired its own
              end — and coming back from the background it sometimes does not —
              the screen said Listening until the next press. That is the state
              it got stuck in.

              A pause mid-sentence gets longer than an empty window, because
              cutting someone off for drawing breath is the worse failure.
            */
            if (text.trim()) {
              quietListen.current = false;
              heardSomething = true;
              clearSilence();
              silence.current = setTimeout(() => {
                if (!mounted.current || turn !== listenSeq.current) return;
                console.log('[grove:listen] trailing silence — settling');
                stopListening();
              }, TRAILING_MS);
            }
            if (mounted.current) setHeard(text);
          },
          onFinal: (text) => {
            // Belt and braces with onPartial. Partials nearly always arrive
            // first, but a very short utterance can produce only a final — and
            // then a level reading landing in the gap before the recogniser's
            // own end would re-arm the no-speech timer, which three seconds
            // later would abort a turn already in flight and drop the screen
            // to Ready while Grove was still thinking.
            heardSomething = true;
            clearSilence();
            console.log('[grove:listen] final', JSON.stringify(text));
            void exchange(text);
          },
          onLevel: (value) => {
            // The microphone is real as of now. Give the window back the time
            // the audio engine spent coming up — but never once a word has
            // arrived, because from there on the pause belongs to onPartial.
            if (!micLive) {
              micLive = true;
              if (!heardSomething && turn === listenSeq.current) armSilence();
            }
            if (mounted.current) setLevel(value);
          },
          onError: (message) => {
            console.log('[grove:listen] ERROR', message);
            if (!mounted.current) return;
            setProblem(message);
            /*
              Filed, never shown.

              The recogniser reports its failures as framework text — "The
              operation couldn't be completed. (OSStatus error 560557684.)" —
              and that was going straight to the caption, so a code appeared
              on the one screen in the app with no room for anything that is
              not a sentence Grove would say.

              It is not replaced with a friendlier sentence either, because
              there is nothing worth saying: `onEnd` below already hands the
              audio graph back and tries again, and the only honest line —
              "I couldn't open the microphone" — is said by the path that has
              actually run out of retries. Until then the last reply stays on
              screen, which is true, and the chimes say what happened.
            */
            void noteTrouble(live.current.uid, message, listeningContext());
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

      armSilence();
    },
    // utter is a useCallback with no deps, so it is stable; listing it would
    // rebuild this and, through `press`, resubscribe the ring on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [exchange, clearSilence, setState]
  );

  beginListeningRef.current = beginListening;

  /*
    A claim to be listening has to be backed by a recogniser.

    There is already a recovery for this, but only on a press: press while the
    state says listening and nothing is recording, and it starts a fresh turn
    rather than stopping one that does not exist. That fixes it for someone who
    presses. It does nothing for someone who glances at the screen, sees
    Listening, and has no reason to think the app is wrong — which is how this
    was found.

    So it is checked passively too. The grace period before the check matters:
    coming back from the background, the state says listening for the whole
    session handover, which is honest and takes a moment.
  */
  /*
    The track comes back when Grove is finished, wherever it finished.

    One place rather than three, because the ways a turn can end are not three
    — a press that heard nothing, a question answered, a question answered
    with nothing to say, an ability that failed, a window that timed out — and
    threading a resume through each is how one of them gets missed. The one
    that gets missed leaves somebody's music silently stopped, which is worse
    than any of the paths that are easy to remember.

    Settling is the signal: Grove is at rest, nothing is being said and
    nothing is being listened for. `resumeMusic` is a no-op unless Grove was
    the thing that paused it.
  */
  useEffect(() => {
    if (state !== 'idle' && state !== 'asleep') return;
    if (!pausedMusic.current) return;
    void resumeMusic();
  }, [state, resumeMusic]);

  useEffect(() => {
    if (state !== 'listening') return;
    const watch = setInterval(() => {
      if (!mounted.current || stateNow.current !== 'listening') return;
      if (Date.now() - listenStartedAt.current < LISTEN_GRACE_MS) return;
      if (isListening()) return;
      console.log('[grove:listen] desync — listening with no recogniser, resetting');
      clearSilence();
      setState(restingState());
    }, 1000);
    return () => clearInterval(watch);
  }, [state, setState, clearSilence]);

  /**
   * The trigger.
   *
   * Every route into Grove funnels through here — the ring, the on-screen
   * button, the keyboard — so all three behave identically by construction
   * rather than by three implementations agreeing with each other.
   */
  /** Do the thing that was waiting on a yes. */
  /**
   * A tone, said instead of a yes.
   *
   * The confirmation reads the draft out and then waits, and the one thing
   * people want to change at that moment is how it sounds — a mate getting a
   * composed three-sentence paragraph, or a professor getting something too
   * loose. Having to cancel, re-dictate the whole request and listen to a
   * second draft is a lot of work for a word.
   *
   * So "casual" is an answer to the confirmation in its own right. It
   * re-drafts and reads the new one back, rather than sending: the press
   * always sends the words that were actually read out, which is the rule the
   * whole confirmation exists to keep.
   *
   * And it is remembered for that person, so this is a question asked once
   * rather than a decision made every time — the same bargain as the home
   * town. See `registerFor` in abilities.ts.
   */
  const redraftTone = useCallback(
    async (
      waiting: { ability: Ability; args: Record<string, string> },
      register: 'professional' | 'casual'
    ) => {
      setState('working');
      // `draft` cleared, so it is actually written again rather than re-read.
      const args = { ...waiting.args, draft: '', register };
      const outcome = await runAbility(waiting.ability, args);
      if (!mounted.current) return;

      const who = (waiting.args.to ?? '').trim();
      if (who) void rememberTone(who, register);

      if (outcome.needsConfirming) {
        awaitingYes.current = {
          ability: waiting.ability,
          args: outcome.confirmArgs ?? args,
          at: Date.now(),
        };
      }
      history.current = [...history.current, newTurn('assistant', outcome.spoken)].slice(-24);
      setCaption(outcome.spoken);
      await whenQuiet();
      if (!mounted.current) return;
      // The clock starts when the reading stops, not when it starts: a long
      // draft takes most of the window to read out, and a confirmation that
      // expired while being read is a press that does nothing.
      utter(outcome.ok ? outcome.spoken : shortFailure(outcome.spoken), false, false, () => {
        if (awaitingYes.current) awaitingYes.current.at = Date.now();
      });
    },
    // setState, utter and whenQuiet are all stable — useCallback with no deps
    // of their own — so listing them would change nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  /**
   * Whether this finished turn ends with something Grove offers to do.
   *
   * Cheap by construction: `offerFor` is pure and synchronous and says no to
   * nearly every turn, so the ledger is only read when there is actually
   * something to weigh. An ordinary conversation touches no storage and makes
   * no model call, which is what lets this run on every single reply.
   */
  const considerOffer = useCallback(async (proposal?: Proposal): Promise<Offer | null> => {
    // Never stacked on something already waiting on the person. A question
    // and an offer in the same breath are two things to answer at once, and
    // an offer on top of an armed confirmation is worse than that — the next
    // yes would be ambiguous about which one it meant.
    if (!proposal || pending.current || awaitingYes.current) {
      turnsSinceOffer.current += 1;
      return null;
    }
    // Checked against the real ability set, not taken on trust: the model
    // proposes and this decides whether what it proposed is a thing Grove
    // can actually do with the arguments it supplied. See offers.ts.
    const candidate = offerFrom(proposal, ABILITIES.filter((a) => a.wired));
    if (!candidate) {
      turnsSinceOffer.current += 1;
      return null;
    }
    const verdict = await worthOffering(live.current.uid, candidate, turnsSinceOffer.current);
    if (!verdict.offer) {
      turnsSinceOffer.current += 1;
      return null;
    }
    return verdict.chosen;
  }, []);

  /** Charged once the words are actually out, never before. */
  const offerSpoken = useCallback((offer: Offer) => {
    // The clock starts when Grove stops talking, for the same reason the
    // confirmation's does: a window that began while the sentence was still
    // being read is shorter than it says it is.
    offered.current = { ...offer, at: Date.now() };
    turnsSinceOffer.current = 0;
    void offerMade(live.current.uid, offer);
  }, []);

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
    // stable and listing them changes nothing but the lint.
     
  }, [beginListening, confirmNow, utter]);

  const say = useCallback(
    async (text: string) => {
      stopSpeaking();
      // Typed, not heard — see the top of `exchange`.
      await exchange(text, false);
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
          // A held button means "I am still talking" — keep the recogniser
          // open rather than letting it endpoint at the first pause.
          if (stateNow.current !== 'listening') void beginListening(true);
          break;
        case 'hold-end':
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
    // Time-critical only on this first one: see the note in considerSpeaking.
    void considerSpeaking(true);

    // What the Talk screen shows without being asked. A minute is finer than
    // anyone needs and still cheap.
    const refreshNext = async () => {
      const [found, reminder] = await Promise.all([
        nextUp().catch(() => null),
        dueToday().catch(() => null),
      ]);
      if (mounted.current) {
        setNext(found);
        setDue(reminder);
      }
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
     
  }, [status, press, beginListening, considerSpeaking, setState]);

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
      next,
      due,
      fillDemo,
      struggles: stuck,
      gotStruggle,
      forgetStruggle,
      life: lifeMemory,
      forgetEntity,
      forgetEpisode,
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
      next,
      due,
      fillDemo,
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
/**
 * Where a listening failure happened, not just that it did.
 *
 * Every one of these arrives as a four-character CoreAudio code and nothing
 * else — `!int`, `what`, "The audio input is busy" — and the code alone does
 * not separate the three causes this app actually has. They are all the same
 * sentence on screen, and working out which one it was has twice meant
 * reasoning from a screenshot rather than reading an answer off it.
 *
 * The three things that decide it are all free to ask for at the moment it
 * fails: whether Grove was in the background (a session that cannot activate
 * there is a different fault from one that cannot record), whether the route
 * is Bluetooth, and whether that route has a microphone at all — which is the
 * A2DP-versus-HFP split, and the difference between "no input" and "input
 * refused".
 *
 * It rides in `where`, which the Settings list already prints under each
 * line, so the next report says which of the three it was.
 */
function listeningContext(): string {
  const parts = ['listening', AppState.currentState === 'active' ? 'foreground' : 'background'];
  try {
    const route = trigger.currentRoute();
    parts.push(route.isBluetooth ? `bluetooth:${route.name}` : route.name || 'phone');
    // The one that explains "the audio input is busy": a pair connected for
    // playback only has nothing to record with.
    parts.push(route.hasExternalMic ? 'has-mic' : 'playback-only');
  } catch {
    // A build with no native half has no route to report, and a diagnostic
    // that throws is worse than one that is short.
  }
  if (trigger.musicPlaying()) parts.push('music-playing');
  return parts.join(' · ');
}

async function whenQuiet(timeoutMs = 12_000): Promise<void> {
  const started = Date.now();
  while (isSpeaking() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}
