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
import { askGrove, newTurn, type Turn, type TurnTool } from '@/lib/grove';
import { abortListening, startListening, stopListening } from '@/lib/listen';
import {
  DEFAULT_PERSONA,
  fallback,
  loadPersona,
  savePersona,
  type Persona,
} from '@/lib/persona';
import { isSpeaking, speak, stopSpeaking } from '@/lib/speak';
import * as memory from '@/lib/memory';
import * as sparks from '@/lib/sparks';
import * as transcript from '@/lib/transcript';
import * as trigger from '@/lib/trigger';
import { useSession } from './session';

export type AgentState =
  | 'asleep'
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'working';

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
  /** The live audio route — the glasses, when they're on. */
  route: trigger.AudioRoute;
  /** Something the user should know about, e.g. a denied microphone. */
  problem: string | null;

  persona: Persona;
  updatePersona: (next: Persona) => Promise<void>;

  activity: transcript.Entry[];
  clearActivity: () => Promise<void>;

  /** The small set of durable facts Grove keeps. Readable and deletable. */
  facts: memory.Fact[];
  forgetFact: (id: string) => Promise<void>;
  forgetEverything: () => Promise<void>;

  /** Standing jobs, newest first. */
  sparks: sparks.Spark[];
  setSparkEnabled: (id: string, enabled: boolean) => Promise<void>;
  deleteSpark: (id: string) => Promise<void>;

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

  const [state, setState] = useState<AgentState>('asleep');
  const [caption, setCaption] = useState('');
  const [heard, setHeard] = useState('');
  const [level, setLevel] = useState(0);
  const [armed, setArmed] = useState(false);
  const [route, setRoute] = useState<trigger.AudioRoute>(() => trigger.currentRoute());
  const [problem, setProblem] = useState<string | null>(null);
  const [persona, setPersona] = useState<Persona>(DEFAULT_PERSONA);
  const [activity, setActivity] = useState<transcript.Entry[]>([]);
  const [facts, setFacts] = useState<memory.Fact[]>([]);
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
  const live = useRef({ state, persona, facts, uid });
  live.current = { state, persona, facts, uid };
  const mounted = useRef(true);

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
    setPersona(next);
    await savePersona(next);
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
    void memory.loadFacts(uid).then((f) => {
      if (mounted.current) setFacts(f);
    });
    void sparks.loadSparks(uid).then((s) => {
      if (mounted.current) setSparkList(s);
    });
  }, [status, uid]);

  const clearActivity = useCallback(async () => {
    setActivity(await transcript.clearActivity(live.current.uid));
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

    const { persona: voice, facts: known, uid: account } = live.current;

    setHeard('');
    setCaption(text);
    setState('thinking');

    let reply;
    try {
      reply = await askGrove(history.current, text, { persona: voice, facts: known });
    } catch (error) {
      const message = error instanceof Error ? error.message : fallback.stuck();
      if (!mounted.current) return;
      setCaption(message);
      utter(message);
      return;
    }
    if (!mounted.current) return;

    history.current = [
      ...history.current,
      newTurn('user', text),
      newTurn('assistant', reply.text),
      // Only the last dozen turns are ever sent anywhere, so there is no
      // reason to hold a whole day of conversation in memory.
    ].slice(-24);

    setCaption(reply.text);
    utter(reply.text);

    // Anything worth remembering was pulled locally, by keyword, from what was
    // said — never inferred by a model and stored where you cannot see it.
    if (reply.fact) {
      const next = await memory.remember(account, reply.fact.key, reply.fact.value);
      if (mounted.current) setFacts(next);
    }

    const entries = await transcript.record(account, {
      said: text,
      replied: reply.text,
      tool: reply.ability ? { name: reply.ability.name, state: 'running' } : undefined,
    });
    if (!mounted.current) return;
    setActivity(entries);
    const entryId = entries[0]?.id;

    if (!reply.ability) return;

    // A recurrence makes this a standing job rather than a one-off. Saved and
    // not run now: the point of "every morning" is that it happens then.
    if (reply.schedule) {
      const spark = await sparks.createSpark(account, {
        said: text,
        abilityId: reply.ability.id,
        args: reply.args,
      });
      if (spark && mounted.current) setSparkList(await sparks.loadSparks(account));
      return;
    }

    // The reply is already being spoken; the run happens behind it. The flag
    // is what stops the end of that speech from reporting the turn as over.
    running.current = true;
    setState((current) => (current === 'speaking' ? current : 'working'));

    let outcome;
    try {
      outcome = await reply.ability.run(reply.args);
    } catch (error) {
      outcome = {
        ok: false,
        spoken: error instanceof Error ? error.message : `${reply.ability.name} failed.`,
      };
    }
    running.current = false;
    if (!mounted.current) return;

    const record: TurnTool = {
      name: reply.ability.name,
      state: outcome.ok ? 'done' : 'failed',
      detail: outcome.spoken,
      needs: reply.ability.needs,
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
    if (mounted.current) utter(outcome.spoken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Speak, and let the state follow the audio rather than a timer. */
  const utter = useCallback((text: string) => {
    setState('speaking');
    speak(text, live.current.persona.delivery, {
      onDone: () => {
        if (mounted.current) setState(restingState());
      },
    });
  }, []);

  const beginListening = useCallback(
    (continuous: boolean) => {
      setProblem(null);
      setHeard('');
      setLevel(0);
      setState('listening');

      const started = startListening(
        {
          onPartial: (text) => {
            if (mounted.current) setHeard(text);
          },
          onFinal: (text) => {
            void exchange(text);
          },
          onLevel: (value) => {
            if (mounted.current) setLevel(value);
          },
          onError: (message) => {
            if (!mounted.current) return;
            setProblem(message);
            setCaption(message);
          },
          onEnd: () => {
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

      if (!started) {
        setState(restingState());
      }
    },
    [exchange]
  );

  /**
   * The trigger.
   *
   * Every route into Grove funnels through here — the ring, the on-screen
   * button, the keyboard — so all three behave identically by construction
   * rather than by three implementations agreeing with each other.
   */
  const press = useCallback(() => {
    const current = live.current.state;

    // The only confirmation available to someone whose phone is in a pocket
    // and whose ring has no feedback of its own. Without it there is a silent
    // gap between pressing and Grove being ready, and people press again.
    buzz();

    // Barge-in. Stop talking and start listening, in that order.
    if (current === 'speaking' || isSpeaking()) {
      stopSpeaking();
      beginListening(false);
      return;
    }
    if (current === 'listening') {
      // Settle what's been said rather than discarding it.
      stopListening();
      return;
    }
    if (current === 'thinking' || current === 'working') return;

    beginListening(false);
  }, [beginListening]);

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
      switch (event.kind) {
        case 'tap':
          press();
          break;
        case 'hold-start':
          // A held button means "I am still talking" — keep the recogniser
          // open rather than letting it endpoint at the first pause.
          if (live.current.state !== 'listening') beginListening(true);
          break;
        case 'hold-end':
          if (live.current.state === 'listening') stopListening();
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
      if (next === 'active') void arm();
    };
    const appSub = AppState.addEventListener('change', onAppState);

    return () => {
      cancelled = true;
      offTrigger();
      offRoute();
      appSub.remove();
    };
  }, [status, press, beginListening]);

  /**
   * The volume-down fallback follows the preference, but only once the session
   * is actually held — enabling it against a module that is not holding the
   * audio session would install a volume observer with nothing to observe.
   */
  useEffect(() => {
    if (!armed) return;
    void trigger.setVolumeFallback(persona.volumeTrigger);
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
  }, [status]);

  const value = useMemo<AgentValue>(
    () => ({
      state,
      caption,
      heard,
      level,
      armed,
      route,
      problem,
      persona,
      updatePersona,
      activity,
      clearActivity,
      facts,
      forgetFact,
      forgetEverything,
      sparks: sparkList,
      setSparkEnabled,
      deleteSpark,
      press,
      say,
    }),
    [
      state,
      caption,
      heard,
      level,
      armed,
      route,
      problem,
      persona,
      updatePersona,
      activity,
      clearActivity,
      facts,
      forgetFact,
      forgetEverything,
      sparkList,
      setSparkEnabled,
      deleteSpark,
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
