/**
 * The mouth.
 *
 * Grove speaks through whatever iOS says the current audio route is, which
 * means that once the glasses are paired this file needs to know nothing about
 * them — the route is the OS's problem and the glasses are just a headset. That
 * is the whole reason there is no Bluetooth code in Grove.
 *
 * WHY IT SOUNDS ROBOTIC, AND WHAT ACTUALLY FIXES IT
 *
 * Three things are true and worth writing down, because the obvious assumption
 * about each one is wrong:
 *
 *   Siri's voice is not available. AVSpeechSynthesizer does not expose it to
 *   third-party apps, at any price, with any entitlement. Nothing in this file
 *   can produce it.
 *
 *   The default voices are the robotic ones. iOS ships every language with a
 *   small "compact" voice and offers a much better "enhanced" (and on newer
 *   iOS, "premium") download. Until someone fetches one, the synthesiser is
 *   using the compact voice — and that, not the code, is what makes it sound
 *   like a satnav from 2009. Downloading one is the single biggest quality
 *   jump available and it costs nothing.
 *
 *   Which voice you get is not chosen for you. `getAvailableVoicesAsync`
 *   returns dozens, in a device-specific order, and the first one is rarely the
 *   best. So this file scores them and picks, rather than letting the platform
 *   default decide.
 *
 * Anything genuinely indistinguishable from a person means a neural TTS API,
 * which costs per character and adds a network round trip to every reply. For
 * something you talk to hands-free, that latency is a worse problem than the
 * timbre — so the system synthesiser stays, driven properly.
 */

import * as Speech from 'expo-speech';

import type { Delivery } from './persona';

export type SpeakHandlers = {
  onStart?: () => void;
  /** Fires once however speech finishes: completed, stopped or failed. */
  onDone?: () => void;
};

let speaking = false;

export function isSpeaking(): boolean {
  return speaking;
}

/* ------------------------------------------------------------- choosing */

/**
 * Voices that read as measured and male in English, which is the register
 * people mean when they say they want it to sound like Jarvis.
 *
 * Matched by name because identifiers are unstable across iOS versions and
 * carry no gender or character information — `com.apple.voice.enhanced.en-GB.Daniel`
 * on one release is `com.apple.ttsbundle.Daniel-premium` on another.
 */
const PREFERRED_NAMES = [
  // The iOS 17 premium English voices come first: they are the ones worth
  // downloading, and the ones people mean when they say it sounds real.
  'oliver', // en-GB premium, the best of these when installed
  'daniel', // en-GB, the classic British male
  'arthur', // en-GB
  'jamie',
  'lee', // en-AU
  'aaron', // en-US
  'evan',
  'nathan',
  'tom',
  'joelle',
  'zoe',
  'ava',
];

/** Higher is better. Quality dominates, because it is the audible difference. */
function scoreVoice(voice: Speech.Voice): number {
  let score = 0;

  // An enhanced voice beats a compact one of any accent, by a distance.
  if (voice.quality === Speech.VoiceQuality.Enhanced) score += 40;

  // Premium is a third tier iOS added above Enhanced, and it is the one that
  // stops sounding synthetic. expo-speech's VoiceQuality enum predates it and
  // reports Premium as Enhanced, so the only way to tell them apart is the
  // identifier — which is exactly why this is checked here and not by quality.
  if (/premium/i.test(voice.identifier || '')) score += 25;

  const lang = (voice.language || '').toLowerCase();
  if (lang.startsWith('en-gb')) score += 12;
  else if (lang.startsWith('en-au') || lang.startsWith('en-ie')) score += 6;
  else if (lang.startsWith('en')) score += 4;
  else return -1; // not English at all; never pick it

  const name = (voice.name || '').toLowerCase();
  const rank = PREFERRED_NAMES.findIndex((n) => name.includes(n));
  if (rank !== -1) score += 10 - rank;

  // Novelty voices are installed by default on some devices and are unusable.
  if (/bells|bubbles|jester|organ|cellos|zarvox|trinoids|whisper|bad news|good news/.test(name)) {
    return -1;
  }
  return score;
}

let cached: Speech.Voice[] | null = null;

/** Every installed voice, English first, best first. Read once per run. */
export async function availableVoices(): Promise<Speech.Voice[]> {
  if (cached) return cached;
  try {
    const all = await Speech.getAvailableVoicesAsync();
    cached = all
      .map((voice) => ({ voice, score: scoreVoice(voice) }))
      .filter((v) => v.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((v) => v.voice);
    return cached;
  } catch {
    cached = [];
    return cached;
  }
}

/**
 * The best voice on this device, or null to let the platform decide.
 *
 * Called once and remembered, because enumerating voices is not free and the
 * set does not change while the app is running.
 */
let best: string | null | undefined;

export async function bestVoiceId(): Promise<string | null> {
  if (best !== undefined) return best;
  const voices = await availableVoices();
  best = voices[0]?.identifier ?? null;
  return best;
}

/**
 * Whether the good voices are actually installed.
 *
 * Drives the one piece of advice in Settings worth giving, because no amount of
 * rate and pitch tuning rescues a compact voice.
 */
export async function hasEnhancedVoice(): Promise<boolean> {
  const voices = await availableVoices();
  return voices.some((v) => v.quality === Speech.VoiceQuality.Enhanced);
}

/* -------------------------------------------------------------- talking */

export function speak(text: string, delivery: Delivery, handlers: SpeakHandlers = {}): void {
  const trimmed = text.trim();
  if (!trimmed) {
    handlers.onDone?.();
    return;
  }

  stopSpeaking();

  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    speaking = false;
    handlers.onDone?.();
  };

  speaking = true;
  handlers.onStart?.();

  // The chosen voice wins; otherwise the best installed one; otherwise the
  // platform default. Resolved lazily so the first reply is never delayed
  // waiting on a voice list.
  const start = (voice?: string) => {
    Speech.speak(trimmed, {
      rate: delivery.rate,
      pitch: delivery.pitch,
      voice,
      language: 'en-GB',
      onDone: done,
      onStopped: done,
      onError: done,
    });
  };

  if (delivery.voiceId) {
    start(delivery.voiceId);
    return;
  }
  if (best !== undefined) {
    start(best ?? undefined);
    return;
  }
  void bestVoiceId().then((id) => start(id ?? undefined));
}

/**
 * Cut Grove off mid-sentence.
 *
 * Called the instant the ring is pressed, before anything else happens, so that
 * talking over Grove works the way it does with a person rather than queueing
 * behind whatever it was saying.
 */
export function stopSpeaking(): void {
  speaking = false;
  Speech.stop();
}
