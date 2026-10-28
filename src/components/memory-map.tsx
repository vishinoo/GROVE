/**
 * The memory map.
 *
 * Every dot is a thing Grove actually remembers — a person, a project, a dated
 * thing that happened, a fact, a promise, something that keeps going wrong.
 * The lines come first from the data: an episode knows which entities it was
 * about; a fact knows whose it is.
 *
 * Everything else is joined to its own section, and every island to the main
 * body, so the map is one connected thing. Loose dots read as a rendering
 * fault rather than as "not linked to anything", which is what they meant.
 * Section is still a real relationship — both are things it did — just a
 * weaker one than a name in common.
 *
 * Every dot is the same size. Sizing by weight made a few planets and a lot
 * of specks, and the specks were the ones you could not tap.
 *
 * It used to be counts. Six numbers went in, a hundred anonymous dots came
 * out, arranged in wedges — a diagram of how much Grove remembered rather than
 * of what. Tapping it could not do anything useful because there was nothing
 * underneath to show you.
 *
 * LAYOUT
 *
 * Positions come from a short spring-and-repulsion relaxation, run once per
 * change of content and never per frame. Wedges put every person in one arc
 * and every episode in another, which is filing, not structure; letting the
 * edges pull makes a person sit with the things that happened to them, and
 * that is the shape worth looking at.
 *
 * It is deterministic. The seed is the index, so the same memories always
 * produce the same map and it does not rearrange itself under you on a
 * re-render.
 */

import { useMemo } from 'react';
import { View, type GestureResponderEvent } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Line,
  RadialGradient,
  Rect,
  Stop,
} from 'react-native-svg';

export type MapSection = 'open' | 'repeats' | 'people' | 'happened' | 'about';

/** In the order the screen lists them, so the map reads top to bottom too. */
export const MAP_SECTIONS: { id: MapSection; label: string; colour: string }[] = [
  { id: 'open', label: 'Still to do', colour: '#F3A063' },
  { id: 'repeats', label: 'Keeps tripping', colour: '#F0836A' },
  { id: 'people', label: 'People and projects', colour: '#86EFAC' },
  { id: 'happened', label: 'What happened', colour: '#5EEAD4' },
  { id: 'about', label: 'About you', colour: '#C4B5FD' },
];

export type MapItem = {
  id: string;
  /** What it says when you tap it. */
  label: string;
  section: MapSection;
  /**
   * How much there is behind it: times a friction has recurred, facts known
   * about a person, entities an episode touched. No longer drawn as size —
   * every dot is the same — but it still re-lays the map when it changes.
   */
  weight?: number;
  /** Ids this is genuinely connected to. */
  links?: string[];
};

/** What an unlit section cools to. Dimming a blue dot still reads as blue. */
const COLD = '#AEB6C8';

/** Every dot's radius. The same for all of them; see the note at the top. */
const DOT = 3.2;

/** Beyond this the relaxation gets slow and the picture gets unreadable. */
const MAX_NODES = 130;

function hash(n: number): number {
  let v = (n | 0) ^ 0x27d4eb2d;
  v = Math.imul(v ^ (v >>> 15), 0x2c1b3c6d);
  v = Math.imul(v ^ (v >>> 12), 0x297a2d39);
  return ((v ^ (v >>> 15)) >>> 0) / 4294967296;
}

type Node = { id: string; x: number; y: number; r: number; section: number; label: string };

export function MemoryMap({
  items,
  active,
  picked,
  onPick,
  width,
  height = 152,
}: {
  items: MapItem[];
  active: MapSection;
  picked?: string;
  onPick?: (item: MapItem) => void;
  width: number;
  height?: number;
}) {
  /*
    Keyed on the content, not the array.

    `items` is rebuilt on every render of the screen above, so a memo that
    depended on it would relax the whole layout sixty times a second while you
    scroll. The key changes when the memories change, which is the only time
    the picture should move.
  */
  const key = items
    .slice(0, MAX_NODES)
    .map((item) => `${item.id}:${item.weight ?? 1}`)
    .join('|');

  const { nodes, edges } = useMemo(() => {
    const use = items.slice(0, MAX_NODES);
    if (use.length === 0) return { nodes: [] as Node[], edges: [] as [number, number][] };

    const index = new Map(use.map((item, i) => [item.id, i]));
    const sectionOf = (item: MapItem) =>
      Math.max(0, MAP_SECTIONS.findIndex((s) => s.id === item.section));

    // Seeded on a ring by section, so the relaxation starts somewhere sane and
    // colours do not have to travel across the whole picture to find a home.
    const px = new Float64Array(use.length);
    const py = new Float64Array(use.length);
    use.forEach((item, i) => {
      const si = sectionOf(item);
      const angle = ((si + 0.5) / MAP_SECTIONS.length) * 6.283 + (hash(i * 3) - 0.5) * 1.1;
      const radius = 0.22 + hash(i * 3 + 1) * 0.26;
      px[i] = 0.5 + Math.cos(angle) * radius;
      py[i] = 0.5 + Math.sin(angle) * radius;
    });

    // Edges from the data first: an episode to the entities it was about, a
    // fact to whoever it is about.
    const edges: [number, number][] = [];
    use.forEach((item, i) => {
      for (const other of item.links ?? []) {
        const j = index.get(other);
        if (j !== undefined && j !== i) edges.push([i, j]);
      }
    });

    // Then joined up. A dot with no edge links to the last one in its section,
    // so a section is a chain rather than a scatter; then every island is tied
    // to the largest body by one edge, through a dot of the same section when
    // the body has one.
    const parent = use.map((_, i) => i);
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    const join = (i: number, j: number) => {
      edges.push([i, j]);
      parent[root(i)] = root(j);
    };
    for (const [i, j] of edges) parent[root(i)] = root(j);

    const linked = new Set(edges.flat());
    const lastIn = new Map<number, number>();
    use.forEach((item, i) => {
      const si = sectionOf(item);
      const before = lastIn.get(si);
      if (!linked.has(i) && before !== undefined) join(i, before);
      lastIn.set(si, i);
    });

    const members = new Map<number, number[]>();
    use.forEach((_, i) => {
      const r = root(i);
      members.set(r, [...(members.get(r) ?? []), i]);
    });
    const islands = [...members.values()].sort((a, b) => b.length - a.length);
    const body = islands[0];
    for (const island of islands.slice(1)) {
      const from = island[0];
      const si = sectionOf(use[from]);
      const to = body.find((i) => sectionOf(use[i]) === si) ?? body[0];
      join(from, to);
    }

    /*
      Relaxation. Repulsion between every pair, springs along the edges, and a
      weak pull to the middle so disconnected satellites do not drift off.

      Sixty passes over at most a hundred and thirty nodes is about a million
      operations, once, when the memories change. It is not cheap enough to do
      per frame and does not need to be.
    */
    for (let pass = 0; pass < 70; pass++) {
      const fx = new Float64Array(use.length);
      const fy = new Float64Array(use.length);

      for (let i = 0; i < use.length; i++) {
        for (let j = i + 1; j < use.length; j++) {
          let dx = px[i] - px[j];
          let dy = py[i] - py[j];
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.0001) {
            // Exactly coincident points have no direction to be pushed apart
            // in, so give them one rather than dividing by nothing.
            dx = (hash(i * 7 + j) - 0.5) * 0.01;
            dy = (hash(j * 7 + i) - 0.5) * 0.01;
            d2 = 0.0001;
          }
          const push = 0.00016 / d2;
          fx[i] += dx * push;
          fy[i] += dy * push;
          fx[j] -= dx * push;
          fy[j] -= dy * push;
        }
      }

      for (const [i, j] of edges) {
        const dx = px[j] - px[i];
        const dy = py[j] - py[i];
        const pull = 0.012;
        fx[i] += dx * pull;
        fy[i] += dy * pull;
        fx[j] -= dx * pull;
        fy[j] -= dy * pull;
      }

      for (let i = 0; i < use.length; i++) {
        fx[i] += (0.5 - px[i]) * 0.012;
        fy[i] += (0.5 - py[i]) * 0.012;
        // Cooling, so late passes settle instead of oscillating.
        const step = 1 - pass / 80;
        px[i] += Math.max(-0.05, Math.min(0.05, fx[i])) * step;
        py[i] += Math.max(-0.05, Math.min(0.05, fy[i])) * step;
      }
    }

    /*
      Centred on the mass, not on the bounding box.

      Scaling min-to-max lets three far-flung satellites set the scale, and the
      dense middle — the part worth looking at — gets squeezed into a corner
      with half the panel empty. Centring on the mean and scaling by the spread
      puts the crowd in the middle and lets the stragglers sit near the edge,
      clamped so none of them leaves.
    */
    let meanX = 0, meanY = 0;
    for (let i = 0; i < use.length; i++) { meanX += px[i]; meanY += py[i]; }
    meanX /= use.length; meanY /= use.length;
    let varX = 0, varY = 0;
    for (let i = 0; i < use.length; i++) {
      varX += (px[i] - meanX) ** 2;
      varY += (py[i] - meanY) ** 2;
    }
    const sdX = Math.max(0.02, Math.sqrt(varX / use.length));
    const sdY = Math.max(0.02, Math.sqrt(varY / use.length));
    const SPREAD = 2.4;
    const pad = 0.08;
    const fit = (v: number) => Math.max(pad, Math.min(1 - pad, v));

    const nodes: Node[] = use.map((item, i) => ({
      id: item.id,
      label: item.label,
      section: sectionOf(item),
      x: fit(0.5 + ((px[i] - meanX) / (sdX * SPREAD)) * (0.5 - pad)) * width,
      y: fit(0.5 + ((py[i] - meanY) / (sdY * SPREAD)) * (0.5 - pad)) * height,
      r: DOT,
    }));

    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, width, height]);

  const lit = MAP_SECTIONS.findIndex((s) => s.id === active);

  const tap = (event: GestureResponderEvent) => {
    if (!onPick || nodes.length === 0) return;
    const { locationX, locationY } = event.nativeEvent;
    let best = 0;
    let bestD = Infinity;
    nodes.forEach((node, i) => {
      const dx = node.x - locationX;
      const dy = node.y - locationY;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    });
    // A tap well away from everything is a tap on the background, not a
    // clumsy tap on the nearest dot forty pixels off.
    if (bestD > 34 * 34) return;
    const hit = items.find((item) => item.id === nodes[best].id);
    if (hit) onPick(hit);
  };

  return (
    <View
      style={{
        width,
        height,
        borderRadius: 22,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.14)',
      }}
      onStartShouldSetResponder={() => true}
      onResponderRelease={tap}
      accessibilityRole="image"
      accessibilityLabel={`A map of ${items.length} things Grove remembers. Tap a dot to read it.`}
    >
      <Svg width={width} height={height}>
        <Defs>
          {/* A light behind the densest part, so the thing has a middle. */}
          <RadialGradient id="grove-map-glow" cx="0.5" cy="0.45" r="0.62">
            <Stop offset="0" stopColor={MAP_SECTIONS[Math.max(0, lit)]?.colour ?? '#7DD3FC'} stopOpacity="0.18" />
            <Stop offset="1" stopColor="#0C101C" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        {/* A pane of glass over the field rather than a dark panel of its own:
            the map sits in the same colour as everything else. */}
        <Rect x={0} y={0} width={width} height={height} fill="#FFFFFF" fillOpacity={0.07} />
        <Rect x={0} y={0} width={width} height={height} fill="url(#grove-map-glow)" />

        {edges.map(([i, j], k) => {
          const on = nodes[i].section === lit || nodes[j].section === lit;
          return (
            <Line
              key={k}
              x1={nodes[i].x}
              y1={nodes[i].y}
              x2={nodes[j].x}
              y2={nodes[j].y}
              stroke={on ? MAP_SECTIONS[nodes[i].section].colour : COLD}
              strokeWidth={0.9}
              opacity={on ? 0.75 : 0.32}
            />
          );
        })}

        {nodes.map((node) => {
          const on = node.section === lit;
          const chosen = picked === node.id;
          const colour = on || chosen ? MAP_SECTIONS[node.section].colour : COLD;
          return (
            <Circle
              key={node.id}
              cx={node.x}
              cy={node.y}
              // Same size lit or not; the picked one is marked by its ring.
              r={node.r}
              fill={colour}
              opacity={chosen ? 1 : on ? 1 : 0.5}
              stroke={chosen ? '#FFFFFF' : undefined}
              strokeWidth={chosen ? 1.6 : 0}
            />
          );
        })}
      </Svg>
    </View>
  );
}
