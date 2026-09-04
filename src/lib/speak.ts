/**
 * The mouth.
 *
 * Deliberately thin. Grove speaks through whatever iOS says the current audio
 * route is, which means that once the glasses are paired this file needs to
 * know nothing about them — the route is the OS's problem and the glasses are
 * just a headset. That is the whole reason there is no Bluetooth code in Grove.
 *
 * Delivery (rate and pitch) is read from the persona rather than fixed, so
 * "talk faster" and "be calmer" are things the user can actually change. The
 * `voiceId` seam is honoured here but nothing sets it yet — swappable voices
 * are a later job, and this is the hook they will hang on.
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

  Speech.speak(trimmed, {
    rate: delivery.rate,
    pitch: delivery.pitch,
    voice: delivery.voiceId,
    language: 'en-US',
    onDone: done,
    onStopped: done,
    onError: done,
  });
}

/**
 * Cut Grove off mid-sentence.
 *
 * Called the instant the ring is pressed, before anything else happens, so
 * that talking over Grove works the way it does with a person rather than
 * queueing behind whatever it was saying.
 */
export function stopSpeaking(): void {
  speaking = false;
  Speech.stop();
}

/** The installed system voices, for the picker this file is waiting on. */
export async function availableVoices(): Promise<Speech.Voice[]> {
  try {
    return await Speech.getAvailableVoicesAsync();
  } catch {
    return [];
  }
}
