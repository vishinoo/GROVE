/**
 * The field's shader, in the two dialects it has to be written in.
 *
 * It was designed in a WebGL page (the orb lab) and these are that page's
 * full-screen form, line for line, with one thing taken out: the swirl that
 * wound up whenever the state changed. A thing that spins each time it moves
 * from listening to thinking reads as a loading spinner, which is exactly
 * what Grove is not supposed to look like.
 *
 * GLSL for the web, because a browser has WebGL and the page should be the
 * page that was approved; SkSL for iOS, through Skia. They must say the same
 * thing. If you change one, change the other — the only intended differences
 * are the entry point and which way up the coordinates run.
 */

export type Palette = readonly [string, string, string, string];

export type FieldColour = {
  key: string;
  label: string;
  /** Said under the swatch in Settings. */
  blurb: string;
  /** Deep, mid, light, accent. */
  c: Palette;
  /** How fast the colour moves, and how much it folds. */
  speed: number;
  warp: number;
};

/**
 * Four colours, all from outdoors, chosen in the orb lab.
 *
 * Colour is its own choice and not the personality's. It was the
 * personality's once — Jarvis gold, Alfred amber, HAL steel — and that broke
 * on the fourth option: a manner someone has written themselves has no
 * colour, and guessing one for it is the app deciding what their words look
 * like. So the voice decides how Grove talks and this decides what it looks
 * like, and neither knows about the other.
 *
 * Each carries its own pace, because the same motion does not suit all four:
 * a tide swells, fire flickers, moss barely moves.
 */
export const FIELD_COLOURS: FieldColour[] = [
  { key: 'tide', label: 'Tide', blurb: 'Deep sea, teal and seafoam', c: ['#061C26', '#1F7A8C', '#C9EDE6', '#E3B868'], speed: 0.8, warp: 1.6 },
  { key: 'ember', label: 'Ember', blurb: 'Wildfire at dusk', c: ['#2A0C07', '#C9431C', '#FBD29A', '#8E2A4A'], speed: 1.2, warp: 2.0 },
  { key: 'moss', label: 'Moss', blurb: 'Forest floor and lichen', c: ['#0B1710', '#2E6A45', '#DCE6B8', '#A8873A'], speed: 0.55, warp: 1.3 },
  { key: 'aurora', label: 'Aurora', blurb: 'Northern lights', c: ['#060A1E', '#22B394', '#D2F3E6', '#7B4FD4'], speed: 0.9, warp: 2.2 },
];

/** The chosen colour, or Tide. An old horizon sky key ("dusk", "ash") is not one of these. */
export function fieldColour(key: string | undefined): FieldColour {
  return FIELD_COLOURS.find((c) => c.key === key) ?? FIELD_COLOURS[0];
}

/** Shared body: noise, warp and paint. Written in the subset both dialects accept. */
const BODY = (vec2: string, vec3: string, mat2: string) => `
float hash(${vec2} p){ p = fract(p * ${vec2}(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(${vec2} p){
  ${vec2} i = floor(p);
  ${vec2} f = fract(p);
  ${vec2} u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + ${vec2}(1.0, 0.0)), u.x), mix(hash(i + ${vec2}(0.0, 1.0)), hash(i + ${vec2}(1.0, 1.0)), u.x), u.y);
}
float fbm(${vec2} p){
  float v = 0.0;
  float a = 0.5;
  ${mat2} m = ${mat2}(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
${mat2} rot(float a){ float c = cos(a); float s = sin(a); return ${mat2}(c, -s, s, c); }

${vec3} paint(${vec2} p, float t){
  ${vec2} q = ${vec2}(fbm(p * 1.1 + ${vec2}(0.0, t * 0.12)), fbm(p * 1.1 + ${vec2}(5.2, 1.3) - t * 0.10));
  ${vec2} r = ${vec2}(fbm(p + uWarp * q + ${vec2}(1.7, 9.2) + t * 0.15), fbm(p + uWarp * q + ${vec2}(8.3, 2.8) - t * 0.13));
  float f = fbm(p + uWarp * r);
  ${vec3} col = mix(uC0, uC1, smoothstep(0.18, 0.62, f));
  col = mix(col, uC3, smoothstep(0.35, 0.75, r.y) * 0.7);
  col = mix(col, uC2, smoothstep(0.45, 0.95, length(q)) * 0.9);
  return col;
}

${vec3} field(${vec2} frag){
  ${vec2} uv = (frag - 0.5 * uRes) / min(uRes.x, uRes.y);
  float t = uT;
  // Stretched along a slanting wind, so it streaks like a long exposure.
  ${vec2} p = rot(0.5) * uv;
  p = ${vec2}(p.x * 0.38 + t * 0.06, p.y * 1.5) * 1.6;
  ${vec3} col = paint(p, t);
  col *= 1.0 - 0.32 * dot(uv, uv);
  col += uC2 * 0.12 * uLevel;
  // Grain, so the gradients never band and the surface has some tooth.
  col += (hash(frag + fract(uRT) * 61.0) - 0.5) * 0.035;
  return clamp(col, 0.0, 1.0);
}
`;

/**
 * WebGL. `uOffset` places a canvas that shows only the top of the field —
 * the band that stays when you scroll — at the right place in the whole.
 */
export const FIELD_GLSL = `
precision highp float;
uniform vec2 uRes;
uniform vec2 uOffset;
uniform float uT;
uniform float uRT;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform float uLevel;
uniform float uWarp;
${BODY('vec2', 'vec3', 'mat2')}
void main(){ gl_FragColor = vec4(field(gl_FragCoord.xy + uOffset), 1.0); }
`;

/**
 * Skia. Its coordinates run top-down in points, so they are flipped to
 * GLSL's bottom-up before anything else happens. `uScale` undoes the canvas
 * being drawn at a fraction of the screen: the field is soft anyway, and a
 * full-resolution warp on every pixel of a phone is battery spent on nothing
 * anyone can see.
 */
export const FIELD_SKSL = `
uniform float2 uRes;
uniform float uScale;
uniform float uT;
uniform float uRT;
uniform float3 uC0;
uniform float3 uC1;
uniform float3 uC2;
uniform float3 uC3;
uniform float uLevel;
uniform float uWarp;
${BODY('float2', 'float3', 'float2x2')}
half4 main(float2 fc){
  float2 frag = float2(fc.x * uScale, uRes.y - fc.y * uScale);
  return half4(half3(field(frag)), 1.0);
}
`;

/** Everything the shader needs that changes from frame to frame. */
export type FieldUniforms = {
  t: number;
  rt: number;
  level: number;
  warp: number;
  /** Four colours as twelve floats, 0–1. */
  c: number[];
};

export function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}
