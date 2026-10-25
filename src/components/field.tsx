/**
 * The field.
 *
 * Behind every tab is one moving gradient, full screen, in the colour chosen
 * in Settings — Tide, Ember, Moss or Aurora, each with its own pace. It is
 * drawn once, by the tab layout, so moving from Talk to Memory keeps the same
 * water in the same place and only the glass on top of it changes. It
 * replaced the horizon, which was a
 * landscape and only looked right in portrait — a laptop window turned its
 * crests into long flat swells. A field has no orientation to get wrong.
 *
 * State is in how it moves, never in a new colour. Listening quickens it and
 * the microphone brightens it as you talk; thinking runs it fastest; speaking
 * pulses in syllables. Nothing spins. The lab version wound up a swirl when
 * it started thinking, and anything that spins on a change of state reads as
 * a loading spinner.
 *
 * Every value eases towards its target rather than switching, and the clock
 * is advanced by the current speed rather than scaled from a global one, so a
 * change of state speeds the water up from where it is instead of jumping it.
 *
 * The shader is in field-shader.ts; the drawing, per platform, in
 * field-canvas.tsx and field-canvas.web.tsx.
 */

import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';

import type { AgentState } from '@/context/agent';
import type { Persona } from '@/lib/persona';

import { FieldCanvas } from './field-canvas';
import { fieldColour, rgb, type FieldUniforms, type Palette } from './field-shader';

/** How fast the colour moves in each state, before the personality's own pace. */
const FLOW: Record<AgentState, number> = {
  asleep: 0.5,
  idle: 1.0,
  listening: 1.7,
  thinking: 2.6,
  working: 2.6,
  speaking: 1.9,
  noting: 1.7,
};

/**
 * The word under the field while something is happening.
 *
 * The movement says what is happening without being read; this says it for
 * the times you are actually looking.
 */
export const STATE_WORD: Record<AgentState, string> = {
  asleep: 'Asleep',
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  working: 'Working',
  noting: 'Taking notes',
};

/**
 * The field's clock and everything it eases, shared by every canvas showing
 * it. The Talk screen draws it twice — the whole screen, and the band that
 * stays at the top when you scroll — and both have to be the same water.
 */
export function useField(state: AgentState, persona: Persona, level: number): {
  uniforms: SharedValue<FieldUniforms>;
  palette: Palette;
} {
  const look = fieldColour(persona.sky);
  const target = look.c.flatMap(rgb);

  const [still, setStill] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setStill).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setStill);
    return () => sub.remove();
  }, []);

  const uniforms = useSharedValue<FieldUniforms>({ t: 0, rt: 0, level: 0, warp: look.warp, c: target });
  const flowTo = useSharedValue(FLOW.idle * look.speed);
  const warpTo = useSharedValue(look.warp);
  const colourTo = useSharedValue(target);
  const mic = useSharedValue(0);
  const mode = useSharedValue(0); // 0 quiet, 1 hearing, 2 talking

  const key = target.join(',');
  useEffect(() => {
    flowTo.value = (FLOW[state] ?? 1) * look.speed * (still ? 0.35 : 1);
    warpTo.value = look.warp;
    colourTo.value = key.split(',').map(Number);
    mode.value = state === 'speaking' ? 2 : state === 'listening' || state === 'noting' ? 1 : 0;
  }, [state, look.speed, look.warp, key, still, flowTo, warpTo, colourTo, mode]);
  useEffect(() => {
    mic.value = Math.max(0, Math.min(1, level));
  }, [level, mic]);

  const flow = useSharedValue(flowTo.value);
  const voice = useSharedValue(0);
  const syllable = useSharedValue({ to: 0, next: 0 });

  useFrameCallback((frame) => {
    'worklet';
    const dt = Math.min(0.05, (frame.timeSincePreviousFrame ?? 16) / 1000);
    const now = frame.timestamp;

    // Speaking has no level to read — the voice is going out, not coming in —
    // so it is syllables of random strength with the odd pause between words.
    if (now > syllable.value.next) {
      const pause = Math.random() < 0.18;
      syllable.value = {
        to: mode.value === 2 && !pause ? 0.25 + Math.random() * 0.4 : 0,
        next: now + (pause ? 260 + Math.random() * 300 : 90 + Math.random() * 120),
      };
    }
    const want = mode.value === 2 ? syllable.value.to : mode.value === 1 ? mic.value : 0;
    voice.value += (want - voice.value) * Math.min(1, dt * 14);

    const k = Math.min(1, dt * 3);
    flow.value += (flowTo.value - flow.value) * k;
    const u = uniforms.value;
    const kc = Math.min(1, dt * 2.5);
    const c = u.c.map((v, i) => v + (colourTo.value[i] - v) * kc);

    uniforms.value = {
      t: u.t + dt * flow.value,
      rt: now / 1000,
      level: voice.value,
      warp: u.warp + (warpTo.value - u.warp) * k,
      c,
    };
  }, true);

  return { uniforms, palette: look.c };
}

export function Field({
  uniforms,
  palette,
  width,
  fullHeight,
  height = fullHeight,
}: {
  uniforms: SharedValue<FieldUniforms>;
  palette: Palette;
  width: number;
  fullHeight: number;
  height?: number;
}) {
  return (
    <FieldCanvas uniforms={uniforms} palette={palette} width={width} fullHeight={fullHeight} height={height} />
  );
}
