/**
 * The field on iOS, drawn by Skia.
 *
 * Skia is a native module, so it is required lazily inside a try, like every
 * other native dependency (see capabilities.ts). A build without it — Expo
 * Go, or a binary older than the one that added it — gets a still gradient in
 * the same four colours rather than a crash before the first screen.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { FIELD_SKSL, type FieldUniforms, type Palette } from './field-shader';

/* eslint-disable @typescript-eslint/no-require-imports */
let skia: typeof import('@shopify/react-native-skia') | null = null;
let effect: ReturnType<typeof import('@shopify/react-native-skia').Skia.RuntimeEffect.Make> = null;
try {
  skia = require('@shopify/react-native-skia') as typeof import('@shopify/react-native-skia');
  effect = skia.Skia.RuntimeEffect.Make(FIELD_SKSL);
} catch {
  skia = null;
}
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * The canvas is drawn at half the screen's size and scaled back up. The field
 * has no hard edges to lose, and this quarters the pixels the warp is run on.
 */
const SCALE = 2;

export function FieldCanvas({
  uniforms,
  width,
  fullHeight,
  height,
  palette,
}: {
  uniforms: SharedValue<FieldUniforms>;
  width: number;
  /** The whole screen's height: the pattern is laid out against this. */
  fullHeight: number;
  /** How much of it, from the top, this canvas shows. */
  height: number;
  palette: Palette;
}) {
  const shaderUniforms = useDerivedValue(() => {
    const u = uniforms.value;
    return {
      uRes: [width, fullHeight],
      uScale: SCALE,
      uT: u.t,
      uRT: u.rt,
      uC0: [u.c[0], u.c[1], u.c[2]],
      uC1: [u.c[3], u.c[4], u.c[5]],
      uC2: [u.c[6], u.c[7], u.c[8]],
      uC3: [u.c[9], u.c[10], u.c[11]],
      uLevel: u.level,
      uWarp: u.warp,
    };
  });

  const still = useMemo(() => <Still width={width} height={height} palette={palette} />, [width, height, palette]);
  if (!skia || !effect) return still;

  const { Canvas, Fill, Shader } = skia;
  return (
    <View style={{ width, height, overflow: 'hidden' }} pointerEvents="none">
      <Canvas
        style={{
          width: width / SCALE,
          height: height / SCALE,
          transform: [{ scale: SCALE }],
          transformOrigin: 'top left',
        }}
      >
        <Fill>
          <Shader source={effect} uniforms={shaderUniforms} />
        </Fill>
      </Canvas>
    </View>
  );
}

/** What a build without Skia shows: the same colours, standing still. */
function Still({ width, height, palette }: { width: number; height: number; palette: Palette }) {
  return (
    <Svg width={width} height={height} pointerEvents="none">
      <Defs>
        <LinearGradient id="grove-field-still" x1="0" y1="0" x2="0.6" y2="1">
          <Stop offset="0" stopColor={palette[0]} />
          <Stop offset="0.45" stopColor={palette[1]} />
          <Stop offset="0.75" stopColor={palette[3]} />
          <Stop offset="1" stopColor={palette[2]} />
        </LinearGradient>
      </Defs>
      <Rect x={0} y={0} width={width} height={height} fill="url(#grove-field-still)" />
    </Svg>
  );
}
