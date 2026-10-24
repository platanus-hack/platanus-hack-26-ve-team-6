import { motion, useScroll, useTransform } from 'motion/react';
import { useRef, type ReactNode } from 'react';

/** Small seeded generator so the authored textures are identical on server and client. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- Code world: a rhythm of glyphs and indentation, never readable code ---------- */

const TOKENS = ['{', '}', '(', ')', ';', '=', '=>', '[', ']', '//', '___', '__', '_____', '--', '::', ',', '.', '==', '&&'];
const WIDTH = 112;
const PERIOD = 24;

function buildCode() {
  const rand = seeded(207);
  const dim: string[] = [];
  const bright: string[] = [];
  let depth = 1;
  for (let row = 0; row < PERIOD; row++) {
    if (rand() < 0.12) { dim.push(''); bright.push(''); continue; }
    const step = rand();
    depth = Math.max(0, Math.min(5, depth + (step < 0.3 ? 1 : step < 0.6 ? -1 : 0)));
    let line = ' '.repeat(depth * 4);
    const goal = Math.min(WIDTH, line.length + 10 + Math.floor(rand() * 70));
    while (line.length < goal) line += `${TOKENS[Math.floor(rand() * TOKENS.length)] ?? '_'} `;
    let quiet = '', loud = '';
    for (const glyph of line.trimEnd()) {
      if (glyph === ' ') { quiet += ' '; loud += ' '; } else if (rand() < 0.14) { quiet += ' '; loud += glyph; } else { quiet += glyph; loud += ' '; }
    }
    dim.push(quiet); bright.push(loud);
  }
  return { dim, bright };
}
const CODE = buildCode();

function CodeLines({ repeats, stream }: { repeats: number; stream: boolean }) {
  const dim = Array.from({ length: repeats }, () => CODE.dim.join('\n')).join('\n');
  const bright = Array.from({ length: repeats }, () => CODE.bright.join('\n')).join('\n');
  return <div className={stream ? 'va-code va-stream' : 'va-code'}>
    <pre className="va-code-dim">{dim}</pre>
    <pre className="va-code-bright">{bright}</pre>
  </div>;
}

/* ---------- Web world: concentric pixel arcs and response lines on a 2px grid ---------- */

const PIXELS_W = 1000;
const PIXELS_H = 1800;
const CENTRE_Y = PIXELS_H / 2;
const snap = (value: number) => Math.round(value / 2) * 2;

type Strokes = { dim: string; bright: string; accent: string };
const dot = (x: number, y: number) => `M${snap(x)} ${snap(y)}h2v2h-2z`;

function buildWeb() {
  const rand = seeded(11);
  const groups: Strokes[] = [{ dim: '', bright: '', accent: '' }, { dim: '', bright: '', accent: '' }, { dim: '', bright: '', accent: '' }];
  for (let ring = 0; ring < 10; ring++) {
    const radius = 110 + ring * 88;
    const group = groups[ring % 3];
    if (!group) continue;
    for (let angle = -Math.PI / 2; angle <= Math.PI / 2; angle += 8 / radius) {
      const x = radius * Math.cos(angle);
      const y = CENTRE_Y + radius * Math.sin(angle);
      if (y < 0 || y > PIXELS_H || x > PIXELS_W) continue;
      const roll = rand();
      if (roll < 0.014) group.accent += dot(x, y);
      else if (roll < 0.3) group.bright += dot(x, y);
      else group.dim += dot(x, y);
    }
  }
  const lines: Strokes = { dim: '', bright: '', accent: '' };
  for (let row = -24; row <= 24; row++) {
    if (rand() < 0.45) continue;
    const y = CENTRE_Y + row * 36;
    const dashes = 1 + Math.floor(rand() * 3);
    for (let n = 0; n < dashes; n++) {
      const x = snap(rand() * PIXELS_W * 0.9);
      const length = snap(12 + rand() * 80);
      const target = rand() < 0.15 ? 'bright' : 'dim';
      lines[target] += `M${x} ${snap(y)}h${length}v2h-${length}z`;
    }
  }
  return { groups, lines };
}
const WEB = buildWeb();

function PixelPaths() {
  const layer = (strokes: Strokes) => <>
    <path d={strokes.dim} fill="#3d3b4c" />
    <path d={strokes.bright} fill="#646174" />
    <path d={strokes.accent} fill="#e7147d" />
  </>;
  return <>{WEB.groups.map((group, index) => <g key={index}>{layer(group)}</g>)}{layer(WEB.lines)}</>;
}

/** One hidden definition shared by every static web texture. */
export function PixelDefs() {
  return <svg className="va-defs" width="0" height="0" aria-hidden="true" focusable="false">
    <defs><g id="va-pixels" shapeRendering="crispEdges"><PixelPaths /></g></defs>
  </svg>;
}

function WebPixels({ pulse }: { pulse: boolean }) {
  const box = { width: PIXELS_W, height: PIXELS_H, viewBox: `0 0 ${PIXELS_W} ${PIXELS_H}`, shapeRendering: 'crispEdges' } as const;
  if (!pulse) return <svg className="va-pixels" {...box}><use href="#va-pixels" /></svg>;
  // Each third of the rings is its own layer so the outward pulse stays on the compositor.
  return <div className="va-pixels va-pulse">
    {WEB.groups.map((group, index) => <svg key={index} className="va-ring-layer" style={{ animationDelay: `${-(6.4 - index * 1.6)}s` }} {...box}>
      <path d={group.dim} fill="#3d3b4c" /><path d={group.bright} fill="#646174" /><path d={group.accent} fill="#e7147d" />
    </svg>)}
    <svg className="va-ring-lines" {...box}>
      <path d={WEB.lines.dim} fill="#3d3b4c" /><path d={WEB.lines.bright} fill="#646174" />
    </svg>
  </div>;
}

/* ---------- Parallax wrapper: transform only, text above it never moves ---------- */

function Parallax({ amplitude, children }: { amplitude: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], [amplitude, -amplitude]);
  return <div ref={ref} className="va-tex" aria-hidden="true"><motion.div className="va-tex-in" style={{ y }}>{children}</motion.div></div>;
}

/** Left texture drifts up about -0.25 x scroll. */
export function CodeWorld({ stream = false }: { stream?: boolean }) {
  return <Parallax amplitude={230}><CodeLines repeats={stream ? 4 : 3} stream={stream} /></Parallax>;
}

/** Right texture drifts up about -0.08 x scroll. */
export function WebWorld({ pulse = false }: { pulse?: boolean }) {
  return <Parallax amplitude={75}><WebPixels pulse={pulse} /></Parallax>;
}
