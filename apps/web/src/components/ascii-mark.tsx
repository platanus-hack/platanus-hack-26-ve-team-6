import { useEffect, useRef } from 'react';
import { useReducedMotion, useSpring, type MotionValue } from 'motion/react';
import { useFacing } from './pointer-field';
import { FINDING_RADIUS, GotchuMark, LEFT_BRACKET, RIGHT_BRACKET, type MarkBox } from './gotchu-mark';
import './ascii-mark.css';

const RAMP = '.:-=+*#%@';
const DEPTH = 2.4;
const OPEN_TRAVEL = 7;
const CELL_W = 8;
const CELL_H = 14;
const FONT = '600 12px ui-monospace, SFMono-Regular, Consolas, monospace';
const LIGHT = normalise([-0.45, -0.6, -0.66]);

type Vec = [number, number, number];
function normalise([x, y, z]: Vec): Vec { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }

function boxDistance(px: number, py: number, pz: number, b: MarkBox) {
  const qx = Math.abs(px - b.x) - b.w;
  const qy = Math.abs(py - b.y) - b.h;
  const qz = Math.abs(pz) - DEPTH;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
}

type Scene = { open: number; spin: number };
/** Signed distance to the extruded mark; material 1 = brackets, 2 = finding. */
function scene(px: number, py: number, pz: number, { open, spin }: Scene): [number, number] {
  let brackets = Infinity;
  const shift = open * OPEN_TRAVEL;
  for (const b of LEFT_BRACKET) brackets = Math.min(brackets, boxDistance(px + shift, py, pz, b));
  for (const b of RIGHT_BRACKET) brackets = Math.min(brackets, boxDistance(px - shift, py, pz, b));
  const c = Math.cos(spin), s = Math.sin(spin);
  const fx = px * c - pz * s, fz = px * s + pz * c;
  const finding = (Math.abs(fx) + Math.abs(py) + Math.abs(fz) - FINDING_RADIUS * (1 + (1 - open) * .12)) * 0.57735;
  return finding < brackets ? [finding, 2] : [brackets, 1];
}

type View = { yaw: number; pitch: number } & Scene;

/** Ray-marches the mark once per character cell and paints a density ramp in brand colours. */
function paint(context: CanvasRenderingContext2D, width: number, height: number, view: View) {
  context.clearRect(0, 0, width, height);
  const cols = Math.floor(width / CELL_W);
  const rows = Math.floor(height / CELL_H);
  const unit = 34 / Math.min(cols * CELL_W, rows * CELL_H * 1.05);
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
  // World → object rotation (inverse of yaw then pitch), applied to ray, direction and light.
  const toObject = ([x, y, z]: Vec): Vec => {
    const y1 = y * cp + z * sp, z1 = -y * sp + z * cp;
    return [x * cy - z1 * sy, y1, x * sy + z1 * cy];
  };
  const dir = toObject([0, 0, 1]);
  const light = toObject(LIGHT);
  const ox = (cols * CELL_W) / 2, oy = (rows * CELL_H) / 2;
  const bracketsLow: [number, number, string][] = [], bracketsHigh: [number, number, string][] = [], findingLow: [number, number, string][] = [], findingHigh: [number, number, string][] = [], dust: [number, number][] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = (col * CELL_W + CELL_W / 2 - ox) * unit, syw = (row * CELL_H + CELL_H / 2 - oy) * unit;
      if (Math.hypot(sx, syw) > 22) { if ((row + col) % 3 === 0 && row % 2 === 0) dust.push([col, row]); continue; }
      let [px, py, pz] = toObject([sx, syw, -30]);
      let travelled = 0, material = 0;
      for (let step = 0; step < 56 && travelled < 60; step++) {
        const [distance, hit] = scene(px, py, pz, view);
        if (distance < 0.03) { material = hit; break; }
        px += dir[0] * distance; py += dir[1] * distance; pz += dir[2] * distance; travelled += distance;
      }
      if (!material) { if ((row + col) % 3 === 0 && row % 2 === 0) dust.push([col, row]); continue; }
      const e = 0.04;
      const nx = scene(px + e, py, pz, view)[0] - scene(px - e, py, pz, view)[0];
      const ny = scene(px, py + e, pz, view)[0] - scene(px, py - e, pz, view)[0];
      const nz = scene(px, py, pz + e, view)[0] - scene(px, py, pz - e, view)[0];
      const [n0, n1, n2] = normalise([nx, ny, nz]);
      const shade = Math.min(1, 0.16 + 0.84 * Math.max(0, n0 * light[0] + n1 * light[1] + n2 * light[2]));
      const glyph = RAMP[Math.min(RAMP.length - 1, Math.floor(shade * RAMP.length))] ?? '@';
      const bucket = material === 2 ? (shade > .62 ? findingHigh : findingLow) : (shade > .55 ? bracketsHigh : bracketsLow);
      bucket.push([col, row, glyph]);
    }
  }
  context.font = FONT;
  context.textBaseline = 'top';
  context.fillStyle = '#3d3b4c';
  for (const [col, row] of dust) context.fillText('.', col * CELL_W, row * CELL_H);
  const layers: [string, [number, number, string][]][] = [['#8f8896', bracketsLow], ['#fffefa', bracketsHigh], ['#c80c68', findingLow], ['#ff8fbe', findingHigh]];
  for (const [colour, cells] of layers) {
    context.fillStyle = colour;
    for (const [col, row, glyph] of cells) context.fillText(glyph, col * CELL_W, row * CELL_H);
  }
}

type AsciiMarkProps = {
  className?: string;
  /** Bracket separation, 0 closed on the finding to 1 wide apart. */
  open?: MotionValue<number>;
  /** Resting separation when no `open` value is supplied. */
  rest?: number;
};

/** The mark extruded in 3D and drawn in characters; turns toward the pointer and closes on primary actions. */
export function AsciiMark({ className = '', open, rest = .35 }: AsciiMarkProps) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const look = useFacing(root, 700);
  const catching = useSpring(look.focus, { duration: 0.35, bounce: 0.35 });

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context || !root.current) return;
    let width = 0, height = 0, frameId = 0, visible = false, last = 0, spin = 0.6;
    const resize = () => {
      const box = element.getBoundingClientRect();
      const ratio = Math.min(2, devicePixelRatio || 1);
      width = box.width; height = box.height;
      element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const draw = (time: number) => {
      frameId = 0;
      if (!reduced) spin += Math.min(64, time - (last || time)) * 0.0006;
      last = time;
      const separation = (open?.get() ?? rest) * (1 - catching.get());
      paint(context, width, height, { yaw: -0.5 + look.x.get() * 0.75 + 0.35, pitch: 0.28 + look.y.get() * 0.45, open: Math.max(0, separation), spin });
      root.current?.setAttribute('data-ready', 'true');
      if (visible && !reduced && document.visibilityState === 'visible') frameId = requestAnimationFrame(draw);
    };
    const start = () => { if (!frameId) frameId = requestAnimationFrame(draw); };
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; if (visible) start(); });
    const sizer = new ResizeObserver(() => { resize(); start(); });
    observer.observe(element); sizer.observe(element);
    const stops = [look.x, look.y, catching, ...(open ? [open] : [])].map(value => value.on('change', start));
    document.addEventListener('visibilitychange', start);
    resize(); start();
    return () => {
      cancelAnimationFrame(frameId); observer.disconnect(); sizer.disconnect();
      stops.forEach(stop => stop()); document.removeEventListener('visibilitychange', start);
    };
  }, [catching, look.x, look.y, open, reduced, rest]);

  return <div ref={root} className={`g-ascii ${className}`} aria-hidden="true">
    <GotchuMark className="g-ascii-fallback" size={160} />
    <canvas ref={canvas} />
  </div>;
}
