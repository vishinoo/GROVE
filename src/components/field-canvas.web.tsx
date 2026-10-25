/**
 * The field in a browser: plain WebGL, running the same GLSL the orb lab ran.
 *
 * Skia would work here too, but only by downloading CanvasKit first — several
 * megabytes of WebAssembly to draw one shader the browser can already draw.
 */

import { createElement, useEffect, useRef } from 'react';
import type { SharedValue } from 'react-native-reanimated';

import { FIELD_GLSL, type FieldUniforms, type Palette } from './field-shader';

const VERT = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';
const NAMES = ['uRes', 'uOffset', 'uT', 'uRT', 'uC0', 'uC1', 'uC2', 'uC3', 'uLevel', 'uWarp'] as const;

export function FieldCanvas({
  uniforms,
  width,
  fullHeight,
  height,
}: {
  uniforms: SharedValue<FieldUniforms>;
  width: number;
  fullHeight: number;
  height: number;
  palette: Palette;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // Read inside the loop, so a resize never restarts the GL context.
  const size = useRef({ width, fullHeight, height });
  size.current = { width, fullHeight, height };

  useEffect(() => {
    const canvas = ref.current;
    const gl = canvas?.getContext('webgl', { antialias: false });
    if (!canvas || !gl) return;

    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FIELD_GLSL));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    const U = Object.fromEntries(NAMES.map((n) => [n, gl.getUniformLocation(prog, n)]));

    let raf = 0;
    const draw = () => {
      const { width: w, fullHeight: full, height: h } = size.current;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      gl.viewport(0, 0, pw, ph);
      const u = uniforms.value;
      gl.uniform2f(U.uRes, pw, full * dpr);
      // GL counts up from the bottom; this canvas is the top `h` of the whole.
      gl.uniform2f(U.uOffset, 0, (full - h) * dpr);
      gl.uniform1f(U.uT, u.t);
      gl.uniform1f(U.uRT, u.rt);
      gl.uniform3f(U.uC0, u.c[0], u.c[1], u.c[2]);
      gl.uniform3f(U.uC1, u.c[3], u.c[4], u.c[5]);
      gl.uniform3f(U.uC2, u.c[6], u.c[7], u.c[8]);
      gl.uniform3f(U.uC3, u.c[9], u.c[10], u.c[11]);
      gl.uniform1f(U.uLevel, u.level);
      gl.uniform1f(U.uWarp, u.warp);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [uniforms]);

  return createElement('canvas', {
    ref,
    style: { width, height, display: 'block', pointerEvents: 'none' },
  });
}
