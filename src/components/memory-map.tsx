/**
 * The memory map.
 *
 * Everything Grove is holding, drawn as one disc of dots instead of listed as
 * five sections. It packs outward from the middle, so the size of the thing is
 * the size of what it knows: a quiet first week is a small circle, a year in is
 * a wide one. Each kind of memory takes a wedge of the disc rather than its own
 * floating blob, because five blobs are five things and this has to read as one
 * mind.
 *
 * Dots link to their nearest neighbours regardless of which wedge they fall in,
 * so the plot is genuinely connected across the seams. Scrolling the list
 * underneath lights that wedge and cools the rest to grey — the map is the
 * scrollbar.
 *
 * WHY IT DOES NOT ANIMATE
 *
 * A hundred circles and three hundred lines is cheap to draw once and
 * expensive to redraw sixty times a second. The drift it has in the sandbox is
 * the first thing that would cost someone a frame on an older phone, and it
 * earns nothing: the information is which wedge is lit, and that changes when
 * you scroll, not when time passes.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Rect, Stop } from 'react-native-svg';

export type MapSection = 'did' | 'open' | 'repeats' | 'people' | 'happened' | 'about';

/** In the order the screen lists them, so the map reads top to bottom too. */
export const MAP_SECTIONS: { id: MapSection; label: string; colour: string }[] = [
  { id: 'did', label: 'What it did', colour: '#7DD3FC' },
  { id: 'open', label: 'Still to do', colour: '#F3A063' },
  { id: 'repeats', label: 'Keeps tripping', colour: '#F0836A' },
  { id: 'people', label: 'People and projects', colour: '#86EFAC' },
  { id: 'happened', label: 'What happened', colour: '#5EEAD4' },
  { id: 'about', label: 'About you', colour: '#C4B5FD' },
];

/** What an unlit wedge cools to. Dimming a blue dot still reads as blue. */
const COLD = '#7E8AA6';

/**
 * Cheap integer hash, kept in 32 bits the whole way.
 *
 * Math.random would reshuffle the map on every render, which turns a scroll
 * into a visible twitch — the scatter has to be a pure function of the index.
 * The obvious one-liner, n*(n*n*15731+789221), leaves 32-bit range around
 * n = 1300 and lands on a float past 2^53 where the low bits are gone; every
 * index above that collapses onto a handful of values and whole wedges pile
 * onto one point. Math.imul keeps every step a real 32-bit multiply.
 */
function hash(n: number): number {
  let v = (n | 0) ^ 0x27d4eb2d;
  v = Math.imul(v ^ (v >>> 15), 0x2c1b3c6d);
  v = Math.imul(v ^ (v >>> 12), 0x297a2d39);
  return ((v ^ (v >>> 15)) >>> 0) / 4294967296;
}

type Node = { x: number; y: number; r: number; section: number };

export function MemoryMap({
  counts,
  active,
  width,
  height = 152,
}: {
  counts: Record<MapSection, number>;
  active: MapSection;
  width: number;
  height?: number;
}) {
  const { nodes, links } = useMemo(() => {
    const total = MAP_SECTIONS.reduce((n, s) => n + Math.max(0, counts[s.id] ?? 0), 0);
    if (total === 0) return { nodes: [] as Node[], links: [] as [number, number][] };

    // Radius grows with the square root of the count, so doubling what Grove
    // remembers widens the disc without quadrupling it.
    const spread = Math.min(0.3, 0.105 * Math.sqrt(total / 12));

    const out: Node[] = [];
    let placed = 0;
    MAP_SECTIONS.forEach((section, si) => {
      const n = Math.max(0, counts[section.id] ?? 0);
      const from = (placed / total) * 6.283;
      const span = (n / total) * 6.283;
      for (let i = 0; i < n; i++) {
        const seed = si * 1013 + i * 7;
        // Square-rooted radius, or everything crowds the rim and the middle
        // comes out hollow.
        const rad = Math.sqrt(0.06 + hash(seed + 2) * 0.94) * spread;
        // Spilled a little past the wedge, so the seams are not five hard
        // pie slices.
        const ang = from + (hash(seed + 1) * 1.1 - 0.05) * span;
        out.push({
          x: (0.5 + Math.cos(ang) * rad * 1.52) * width,
          y: (0.5 + Math.sin(ang) * rad * 1.45) * height,
          r: 0.9 + hash(seed + 3) * 1.1,
          section: si,
        });
      }
      placed += n;
    });

    // Nearest neighbours across the whole disc, not within a wedge: that is
    // the difference between one connected plot and five constellations
    // sharing a frame.
    const edges: [number, number][] = [];
    for (let i = 0; i < out.length; i++) {
      const near: [number, number][] = [];
      for (let j = 0; j < out.length; j++) {
        if (i === j) continue;
        const dx = out[i].x - out[j].x;
        const dy = out[i].y - out[j].y;
        near.push([dx * dx + dy * dy, j]);
      }
      near.sort((a, b) => a[0] - b[0]);
      for (let k = 0; k < 3 && k < near.length; k++) edges.push([i, near[k][1]]);
    }
    return { nodes: out, links: edges };
  }, [counts, width, height]);

  const lit = MAP_SECTIONS.findIndex((s) => s.id === active);

  return (
    <View style={{ width, height, borderRadius: 18, overflow: 'hidden' }}>
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="grove-map-bg" x1="0" y1="0" x2="0.4" y2="1">
            <Stop offset="0" stopColor="#171C2E" />
            <Stop offset="0.58" stopColor="#0B0F1A" />
            <Stop offset="1" stopColor="#1C1526" />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={width} height={height} fill="url(#grove-map-bg)" />

        {links.map(([i, j], k) => {
          const on = nodes[i].section === lit || nodes[j].section === lit;
          return (
            <Line
              key={k}
              x1={nodes[i].x}
              y1={nodes[i].y}
              x2={nodes[j].x}
              y2={nodes[j].y}
              stroke={on ? MAP_SECTIONS[nodes[i].section].colour : COLD}
              strokeWidth={0.6}
              opacity={on ? 0.5 : 0.16}
            />
          );
        })}

        {nodes.map((node, i) => {
          const on = node.section === lit;
          return (
            <Circle
              key={i}
              cx={node.x}
              cy={node.y}
              r={node.r * (on ? 1.7 : 1.1)}
              fill={on ? MAP_SECTIONS[node.section].colour : COLD}
              opacity={on ? 1 : 0.42}
            />
          );
        })}
      </Svg>
    </View>
  );
}
