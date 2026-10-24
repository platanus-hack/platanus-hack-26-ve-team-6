import { useEffect, useId, useRef } from 'react';
import { useReducedMotion, useSpring } from 'motion/react';
import { useFacing } from './pointer-field';
import { FINDING_RADIUS, LEFT_BRACKET, RIGHT_BRACKET, type MarkBox } from './gotchu-mark';

type Vec = [number, number, number];
type Face = { points: Vec[]; normal: Vec };
const DEPTH = 2.6;
const OPEN_TRAVEL = 6;
const FOCAL = 70;
const LIGHT: Vec = normalise([-0.5, -0.7, -0.5]);

function normalise([x, y, z]: Vec): Vec { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }

/** Six square faces of one extruded bar, each with its outward normal. */
function boxFaces({ x, y, w, h }: MarkBox, shift: number): Face[] {
  const cx = x + shift;
  const v = (sx: number, sy: number, sz: number): Vec => [cx + sx * w, y + sy * h, sz * DEPTH];
  return [
    { points: [v(-1, -1, -1), v(1, -1, -1), v(1, 1, -1), v(-1, 1, -1)], normal: [0, 0, -1] },
    { points: [v(1, -1, 1), v(-1, -1, 1), v(-1, 1, 1), v(1, 1, 1)], normal: [0, 0, 1] },
    { points: [v(-1, -1, 1), v(1, -1, 1), v(1, -1, -1), v(-1, -1, -1)], normal: [0, -1, 0] },
    { points: [v(-1, 1, -1), v(1, 1, -1), v(1, 1, 1), v(-1, 1, 1)], normal: [0, 1, 0] },
    { points: [v(-1, -1, 1), v(-1, -1, -1), v(-1, 1, -1), v(-1, 1, 1)], normal: [-1, 0, 0] },
    { points: [v(1, -1, -1), v(1, -1, 1), v(1, 1, 1), v(1, 1, -1)], normal: [1, 0, 0] },
  ];
}

/** The finding as an octahedron: eight triangular facets. */
function findingFaces(radius: number): Face[] {
  const faces: Face[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    faces.push({ points: [[sx * radius, 0, 0], [0, sy * radius, 0], [0, 0, sz * radius]], normal: normalise([sx, sy, sz]) });
  }
  return faces;
}

/** Solid blocks must not overlap or the painter's sort fights at the corners: the uprights stop where the arms begin. */
const solid = (boxes: MarkBox[]) => boxes.map((box, index) => index === 0 ? { ...box, h: box.h - (box.h - 7.9 + 1.7) } : box);
const LEFT_BLOCKS = solid(LEFT_BRACKET);
const RIGHT_BLOCKS = solid(RIGHT_BRACKET);
const FACE_COUNT = (LEFT_BLOCKS.length + RIGHT_BLOCKS.length) * 6 + 8;

/** The mark as solid square prisms with brand gradients, painted back to front in SVG. */
export function PrismMark({ className = '', paused = false }: { className?: string; paused?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const layer = useRef<SVGGElement>(null);
  const id = `g-prism${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const reduced = useReducedMotion();
  const look = useFacing(root, 760);
  const catching = useSpring(look.focus, { duration: 0.35, bounce: 0.35 });

  useEffect(() => {
    const group = layer.current;
    if (!group) return;
    const paths = Array.from({ length: FACE_COUNT }, () => group.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path')));
    let frameId = 0, visible = true, start = performance.now();
    const still = reduced || paused;
    const draw = (time: number) => {
      frameId = 0;
      const t = still ? 0 : (time - start) / 1000;
      const yaw = -0.42 + look.x.get() * 0.7 + Math.sin(t * 0.5) * 0.12;
      const pitch = 0.3 + look.y.get() * 0.45 + Math.sin(t * 0.37) * 0.05;
      const open = 0.3 * (1 - catching.get());
      const spin = t * 0.6 + 0.4;
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const rotate = ([x, y, z]: Vec): Vec => {
        const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
        return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
      };
      const cs = Math.cos(spin), ss = Math.sin(spin);
      const spun = ([x, y, z]: Vec): Vec => [x * cs + z * ss, y, -x * ss + z * cs];
      const faces = [
        ...LEFT_BLOCKS.flatMap(box => boxFaces(box, -open * OPEN_TRAVEL)),
        ...RIGHT_BLOCKS.flatMap(box => boxFaces(box, open * OPEN_TRAVEL)),
        ...findingFaces(FINDING_RADIUS * 1.05).map(face => ({ points: face.points.map(spun), normal: spun(face.normal), finding: true })),
      ].map(face => {
        const points = face.points.map(rotate);
        const normal = rotate(face.normal);
        const depth = points.reduce((sum, p) => sum + p[2], 0) / points.length;
        const light = normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2];
        return { points, normal, depth, light, finding: 'finding' in face };
      }).filter(face => face.normal[2] < 0).sort((a, b) => b.depth - a.depth);
      paths.forEach((path, index) => {
        const face = faces[index];
        if (!face) { path.setAttribute('d', ''); return; }
        const d = face.points.map(([x, y, z], i) => {
          const scale = FOCAL / (FOCAL + z);
          return `${i ? 'L' : 'M'}${(x * scale).toFixed(2)} ${(y * scale).toFixed(2)}`;
        }).join('') + 'Z';
        const tone = face.light > .55 ? 'lit' : face.light > .1 ? 'mid' : 'shade';
        path.setAttribute('d', d);
        path.setAttribute('fill', `url(#${id}-${face.finding ? 'finding' : 'bar'}-${tone})`);
        group.appendChild(path);
      });
      root.current?.setAttribute('data-ready', 'true');
      if (visible && !still && document.visibilityState === 'visible') frameId = requestAnimationFrame(draw);
    };
    const kick = () => { if (!frameId) frameId = requestAnimationFrame(draw); };
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; if (visible) kick(); });
    if (root.current) observer.observe(root.current);
    const stops = [look.x, look.y, catching].map(value => value.on('change', kick));
    document.addEventListener('visibilitychange', kick);
    start = performance.now();
    kick();
    return () => { cancelAnimationFrame(frameId); observer.disconnect(); stops.forEach(stop => stop()); document.removeEventListener('visibilitychange', kick); paths.forEach(path => path.remove()); };
  }, [catching, id, look.x, look.y, paused, reduced]);

  const gradient = (name: string, from: string, via: string, to: string) => <linearGradient id={`${id}-${name}`} x1="0" y1="0" x2="1" y2="1"><stop stopColor={from} /><stop offset=".55" stopColor={via} /><stop offset="1" stopColor={to} /></linearGradient>;
  return <div ref={root} className={`g-prism ${className}`} aria-hidden="true">
    <svg viewBox="-17 -15 34 30">
      <defs>
        {gradient('bar-lit', '#fffefa', '#ff8fbe', '#e7147d')}
        {gradient('bar-mid', '#ff4fa0', '#e7147d', '#9d0c54')}
        {gradient('bar-shade', '#c80c68', '#5c0a37', '#191923')}
        {gradient('finding-lit', '#fffefa', '#fffefa', '#c7bfbd')}
        {gradient('finding-mid', '#fffefa', '#c7bfbd', '#8f8896')}
        {gradient('finding-shade', '#8f8896', '#3d3b4c', '#191923')}
      </defs>
      <g ref={layer} stroke="#fffefa" strokeOpacity=".22" strokeWidth=".08" strokeLinejoin="miter" />
    </svg>
  </div>;
}
