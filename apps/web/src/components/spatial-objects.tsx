import { useCallback, useEffect, useId, useRef } from 'react';
import { frame, useMotionValueEvent, type MotionValue } from 'motion/react';
import { useFacing } from './pointer-field';
import './spatial-objects.css';

type ObjectProps = { className?: string; spin?: MotionValue<number> };

export function useTilt(pose: (x: number, y: number) => string, spin?: MotionValue<number>, extra?: (x: number, y: number, spin: number) => void) {
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const look = useFacing(root);
  const draw = useCallback(() => {
    const x = look.x.get();
    const y = look.y.get();
    if (body.current) body.current.style.transform = pose(x, y);
    extra?.(x, y, spin?.get() ?? 0);
  }, [extra, look.x, look.y, pose, spin]);
  const schedule = useCallback(() => { frame.render(draw); }, [draw]);
  useMotionValueEvent(look.x, 'change', schedule);
  useMotionValueEvent(look.y, 'change', schedule);
  useEffect(() => {
    const stop = spin?.on('change', schedule);
    schedule();
    return () => stop?.();
  }, [schedule, spin]);
  return { root, body };
}

const slabPose = (x: number, y: number) => `rotateX(${(10 - y * 16).toFixed(2)}deg) rotateY(${(16 + x * 22).toFixed(2)}deg) rotateZ(-3deg)`;

/** A source snapshot: a thick file sheet with its SHA-256 digest floating above it. */
export function CodeSlab({ className = '', spin }: ObjectProps) {
  const { root, body } = useTilt(slabPose, spin);
  return <div ref={root} className={`g-object g-slab ${className}`} aria-hidden="true">
    <div className="g-object-shadow" />
    <div ref={body} className="g-object-body" style={{ transform: slabPose(0, 0) }}>
      {[4, 3, 2, 1].map(depth => <div key={depth} className="g-slab-edge" style={{ transform: `translateZ(${-depth * 5}px)` }} />)}
      <img className="g-slab-face" src="/landing/code-slab.svg" width="400" height="290" alt="" draggable={false} />
      <span className="g-object-chip g-slab-chip"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M7 15a5 5 0 0 1 10 0M4 15a8 8 0 0 1 16 0M10 15a2 2 0 0 1 4 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>SHA-256</span>
    </div>
  </div>;
}

const RADIUS = 100;
const ORBIT_TILT = 1.15;
type Point = [number, number, number];

function rotate([x, y, z]: Point, yaw: number, pitch: number): Point {
  const x1 = x * Math.cos(yaw) + z * Math.sin(yaw);
  const z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
  return [x1, y * Math.cos(pitch) - z1 * Math.sin(pitch), y * Math.sin(pitch) + z1 * Math.cos(pitch)];
}

/** Projects closed 3D curves orthographically, splitting each into the strokes in front of and behind the sphere. */
function project(curves: Point[][], yaw: number, pitch: number) {
  let front = '';
  let back = '';
  for (const curve of curves) {
    let previous: boolean | null = null;
    for (const point of curve) {
      const [x, y, z] = rotate(point, yaw, pitch);
      const visible = z >= 0;
      const command = `${previous === visible ? 'L' : 'M'}${(150 + x).toFixed(1)} ${(150 + y).toFixed(1)}`;
      if (visible) front += command; else back += command;
      previous = visible;
    }
  }
  return { front, back };
}

const circle = (point: (t: number) => Point) => Array.from({ length: 49 }, (_, index) => point(index / 48 * Math.PI * 2));
const GRID: Point[][] = [
  ...Array.from({ length: 6 }, (_, index) => {
    const longitude = index * Math.PI / 6;
    return circle(t => [RADIUS * Math.sin(t) * Math.sin(longitude), -RADIUS * Math.cos(t), RADIUS * Math.sin(t) * Math.cos(longitude)]);
  }),
  ...[-60, -30, 0, 30, 60].map(degrees => {
    const latitude = degrees * Math.PI / 180;
    return circle(t => [RADIUS * Math.cos(latitude) * Math.sin(t), -RADIUS * Math.sin(latitude), RADIUS * Math.cos(latitude) * Math.cos(t)]);
  }),
];
const orbitPoint = (t: number): Point => [138 * Math.cos(t), 138 * Math.sin(t) * Math.cos(ORBIT_TILT), 138 * Math.sin(t) * Math.sin(ORBIT_TILT)];
const ORBIT = [circle(orbitPoint)];
const globeAngles = (x: number, y: number, spin: number) => ({ yaw: 0.45 + x * 0.9 + spin * Math.PI / 180, pitch: -0.32 + y * 0.45 });
const initial = globeAngles(0, 0, 0);
const initialGrid = project(GRID, initial.yaw, initial.pitch);
const initialOrbit = project(ORBIT, initial.yaw, initial.pitch);
const globePose = (x: number, y: number) => `rotateX(${(4 - y * 12).toFixed(2)}deg) rotateY(${(-14 + x * 16).toFixed(2)}deg)`;

/** An authorized HTTPS origin: a wireframe globe that turns toward the pointer, ringed by its DNS record. */
export function OriginGlobe({ className = '', spin }: ObjectProps) {
  const paths = useRef<{ front: SVGPathElement | null; back: SVGPathElement | null; orbitFront: SVGPathElement | null; orbitBack: SVGPathElement | null; node: SVGCircleElement | null }>({ front: null, back: null, orbitFront: null, orbitBack: null, node: null });
  const redraw = useCallback((x: number, y: number, turn: number) => {
    const { yaw, pitch } = globeAngles(x, y, turn);
    const grid = project(GRID, yaw, pitch);
    const orbit = project(ORBIT, yaw, pitch);
    const { front, back, orbitFront, orbitBack, node } = paths.current;
    front?.setAttribute('d', grid.front);
    back?.setAttribute('d', grid.back);
    orbitFront?.setAttribute('d', orbit.front);
    orbitBack?.setAttribute('d', orbit.back);
    const [nx, ny, nz] = rotate(orbitPoint(-0.6 - x * 0.8), yaw, pitch);
    node?.setAttribute('cx', (150 + nx).toFixed(1));
    node?.setAttribute('cy', (150 + ny).toFixed(1));
    node?.setAttribute('opacity', nz >= 0 ? '1' : '.35');
  }, []);
  const { root, body } = useTilt(globePose, spin, redraw);
  const id = `g-globe${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return <div ref={root} className={`g-object g-globe ${className}`} aria-hidden="true">
    <div className="g-object-shadow" />
    <div ref={body} className="g-object-body" style={{ transform: globePose(0, 0) }}>
      <svg className="g-globe-art" viewBox="0 0 300 300">
        <defs>
          <radialGradient id={`${id}-glass`} cx=".38" cy=".3" r=".75"><stop stopColor="#4a1b3c" /><stop offset=".55" stopColor="#1d1825" /><stop offset="1" stopColor="#09080d" /></radialGradient>
          <linearGradient id={`${id}-line`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#fbe3ef" /><stop offset=".6" stopColor="#ff8fbe" /><stop offset="1" stopColor="#c80c68" /></linearGradient>
        </defs>
        <path ref={element => { paths.current.orbitBack = element; }} d={initialOrbit.back} fill="none" stroke="#ff8fbe" strokeOpacity=".3" strokeWidth="1.6" strokeDasharray="2 6" strokeLinecap="round" />
        <circle cx="150" cy="150" r={RADIUS} fill={`url(#${id}-glass)`} />
        <path ref={element => { paths.current.back = element; }} d={initialGrid.back} fill="none" stroke="#c7bfbd" strokeOpacity=".16" strokeWidth="1" />
        <path ref={element => { paths.current.front = element; }} d={initialGrid.front} fill="none" stroke={`url(#${id}-line)`} strokeWidth="1.5" />
        <circle cx="150" cy="150" r={RADIUS} fill="none" stroke="#fffefa" strokeOpacity=".22" />
        <path d="M84 96a92 92 0 0 1 58-38" fill="none" stroke="#fffefa" strokeOpacity=".55" strokeWidth="3" strokeLinecap="round" />
        <path ref={element => { paths.current.orbitFront = element; }} d={initialOrbit.front} fill="none" stroke="#ff8fbe" strokeWidth="1.8" strokeLinecap="round" />
        <circle ref={element => { paths.current.node = element; }} cx="150" cy="150" r="7" fill="#e7147d" stroke="#fffefa" strokeWidth="2" />
      </svg>
      <span className="g-object-chip g-globe-chip">TXT <code>{'_gotchu.<dominio>'}</code></span>
    </div>
  </div>;
}

const reportPose = (x: number, y: number) => `rotateX(${(6 - y * 12).toFixed(2)}deg) rotateY(${(-18 + x * 20).toFixed(2)}deg)`;

/** The report the lens returns: findings, evidence excerpt, coverage and JSON export. */
export function ReportSheet({ className = '' }: { className?: string }) {
  const { root, body } = useTilt(reportPose);
  return <div ref={root} className={`g-object g-report-sheet ${className}`} aria-hidden="true">
    <div className="g-object-shadow" />
    <div ref={body} className="g-object-body" style={{ transform: reportPose(0, 0) }}>
      {[4, 3, 2, 1].map(depth => <div key={depth} className="g-report-edge" style={{ transform: `translateZ(${-depth * 4}px)` }} />)}
      <img className="g-report-face" src="/landing/report-sheet.svg" width="360" height="430" alt="" draggable={false} />
    </div>
  </div>;
}
