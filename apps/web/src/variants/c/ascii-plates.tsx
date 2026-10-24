import { Fragment, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useReducedMotion } from 'motion/react';
import { useReveal } from './highlighter';

/**
 * Plates are authored from geometry: a character grid, a few shape helpers, one palette.
 * The finding diamond is the only coloured glyph (#c80c68 on the porcelain ground).
 */
const FINDING = '◆';
const GLYPHS = '.:-=+*#';

function createGrid(cols: number, rows: number) {
  const cells = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '));
  const put = (x: number, y: number, glyph: string) => {
    const row = cells[Math.round(y)];
    const column = Math.round(x);
    if (row && column >= 0 && column < cols) row[column] = glyph;
  };
  const text = (x: number, y: number, value: string) => [...value].forEach((glyph, index) => { if (glyph !== ' ') put(x + index, y, glyph); });
  /** Outlined box; the interior is cleared so boxes can be stacked back to front. */
  const box = (x: number, y: number, width: number, height: number) => {
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) {
      const edgeX = column === x || column === x + width - 1, edgeY = row === y || row === y + height - 1;
      put(column, row, edgeX && edgeY ? '+' : edgeX ? '|' : edgeY ? '-' : ' ');
    }
  };
  return { put, text, box, lines: () => cells.map(row => row.join('')) };
}

/** Cells are twice as tall as wide, so ring maths runs in square space (dx halved). */
function ringGlyph(dx: number, dy: number) {
  const length = Math.hypot(dx, dy) || 1;
  if (Math.abs(dx) / length > 0.88) return dx < 0 ? '(' : ')';
  if (Math.abs(dy) / length > 0.88) return '-';
  return dx * dy < 0 ? '\\' : '/';
}

// ─── 02 · Snapshot with its fingerprint ───────────────────────────────────────

function folderArt() {
  const grid = createGrid(56, 18);
  grid.box(6, 0, 22, 12);
  grid.box(3, 2, 22, 13);
  grid.box(0, 4, 22, 13);
  grid.text(3, 6, '=====  ========  ==');
  grid.text(3, 8, `${FINDING} ===========  ===`);
  grid.text(3, 10, '======  ====  =======');
  grid.text(3, 12, '===  ===========');
  grid.text(3, 14, '=======  ==  =====');
  // Fingerprint: whorled ridges around a finding.
  const cx = 43, cy = 7, radius = 6;
  for (let y = 0; y <= 14; y++) for (let x = 30; x < 56; x++) {
    const dx = (x - cx) / 2, dy = y - cy;
    const r = Math.hypot(dx, dy);
    if (r > radius + 0.5) continue;
    if (x === cx && y === cy) { grid.put(x, y, FINDING); continue; }
    if (r < 0.9) continue;
    const wobble = Math.sin(2 * Math.atan2(dy, dx) + r * 1.1) * 0.32 * Math.min(1, r / 3);
    if (((r + wobble) % 1) < 0.52) grid.put(x, y, ringGlyph(dx, dy));
  }
  grid.text(cx - 3, 16, 'SHA-256');
  return grid.lines();
}

// ─── 03 · Globe ──────────────────────────────────────────────────────────────

const GLOBE = { cols: 45, rows: 23, markerLatitude: 0.35, restLongitude: 0.45 };

/** Wireframe sphere seen from `longitude` (radians); the domain marker rides on it. */
function globeArt(longitude: number) {
  const { cols, rows } = GLOBE;
  const grid = createGrid(cols, rows);
  const cx = (cols - 1) / 2, cy = (rows - 1) / 2, ry = rows / 2 - 0.5, rx = ry * 2;
  const step = Math.PI / 6;
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const u = (x - cx) / rx, v = (y - cy) / ry;
    const d = u * u + v * v;
    if (d > 1) continue;
    const r = Math.sqrt(d);
    if (r > 0.9) { grid.put(x, y, ringGlyph((x - cx) / 2, y - cy)); continue; }
    const z = Math.sqrt(1 - d);
    const latitude = Math.asin(-v);
    const lon = Math.atan2(u, z) + longitude;
    const phase = ((lon % step) + step) % step;
    const meridian = Math.min(phase, step - phase) * Math.max(z, 0.25) * rx < 0.62;
    const nearest = Math.round(latitude / step) * step;
    const parallel = Math.abs(latitude - nearest) * Math.cos(latitude) * ry < 0.55;
    if (meridian && parallel) grid.put(x, y, '+');
    else if (parallel) grid.put(x, y, nearest === 0 ? '=' : '-');
    else if (meridian) grid.put(x, y, u < -0.4 ? '(' : u > 0.4 ? ')' : '|');
  }
  const view = -longitude;
  if (Math.cos(view) > 0.05) {
    const mx = cx + rx * Math.cos(GLOBE.markerLatitude) * Math.sin(view), my = cy - ry * Math.sin(GLOBE.markerLatitude);
    grid.text(Math.round(mx) - 1, Math.round(my), `[${FINDING}]`);
  }
  return grid.lines();
}

// ─── 04 · Two overlapping circles ────────────────────────────────────────────

const VENN = { cols: 66, rows: 25, radius: 11.5, centres: [25, 41] as const };

function vennArt() {
  const { cols, rows, radius, centres } = VENN;
  const cy = (rows - 1) / 2;
  const [a, b] = [createGrid(cols, rows), createGrid(cols, rows)];
  const lens: { y: number; x0: number; x1: number }[] = [];
  for (let y = 0; y < rows; y++) {
    let x0 = -1, x1 = -1;
    for (let x = 0; x < cols; x++) {
      const dy = y - cy;
      const [da, db] = [(x - centres[0]) / 2, (x - centres[1]) / 2];
      const [ra, rb] = [Math.hypot(da, dy), Math.hypot(db, dy)];
      if (Math.abs(ra - radius) < 0.55) a.put(x, y, ringGlyph(da, dy));
      if (Math.abs(rb - radius) < 0.55) b.put(x, y, ringGlyph(db, dy));
      if (ra < radius + 0.5 && rb < radius + 0.5) { if (x0 < 0) x0 = x; x1 = x; }
    }
    if (x0 >= 0) lens.push({ y, x0, x1 });
  }
  return { a: a.lines(), b: b.lines(), lens };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/** Splits on the finding glyph so it can carry the action colour. */
function Art({ text }: { text: string }) {
  const parts = text.split(FINDING);
  return <>{parts.map((part, index) => <Fragment key={index}>{index > 0 && <span className="vc-find">{FINDING}</span>}{part}</Fragment>)}</>;
}

function hash(index: number) {
  const value = Math.sin(index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/** Resolves random `.:-=+*#` glyphs into the final art, once, when the plate scrolls into view. */
function useDevelop(final: string, ref: RefObject<HTMLElement | null>, duration = 900) {
  const reduced = useReducedMotion();
  const [text, setText] = useState(final);
  useEffect(() => {
    const element = ref.current;
    if (reduced) { setText(final); return; }
    if (!element) return;
    const rows = final.split('\n');
    const thresholds = rows.flatMap((row, y) => [...row].map((_, x) => 0.06 + 0.5 * (0.6 * x / row.length + 0.4 * y / rows.length) + 0.44 * hash(x * 131 + y * 17)));
    const scramble = (progress: number) => {
      let index = 0;
      return rows.map(row => [...row].map(glyph => {
        const threshold = thresholds[index++] ?? 0;
        return glyph === ' ' || progress >= threshold ? glyph : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }).join('')).join('\n');
    };
    setText(scramble(0));
    let frame = 0, start = 0, last = 0;
    const run = (now: number) => {
      start ||= now;
      const progress = Math.min(1, (now - start) / duration);
      if (progress >= 1) { setText(final); return; }
      if (now - last > 40) { last = now; setText(scramble(progress)); }
      frame = requestAnimationFrame(run);
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      frame = requestAnimationFrame(run);
    }, { rootMargin: '0px 0px -20% 0px' });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [final, reduced, ref, duration]);
  return text;
}

const folder = folderArt().join('\n');

/** A stack of versions with its SHA-256 fingerprint; develops from noise when scrolled into view. */
export function FolderPlate() {
  const ref = useRef<HTMLPreElement>(null);
  const text = useDevelop(folder, ref);
  return <pre ref={ref} className="vc-plate" aria-hidden="true"><Art text={text} /></pre>;
}

const GLOBE_SECONDS = 6;
const globeRest = globeArt(-GLOBE.restLongitude).join('\n');

/** Globe that turns while in view for a few seconds, decelerates, and settles with the domain facing us. */
export function GlobePlate() {
  const ref = useRef<HTMLPreElement>(null);
  const reduced = useReducedMotion();
  const [text, setText] = useState(globeRest);
  useEffect(() => {
    const element = ref.current;
    if (reduced) { setText(globeRest); return; }
    if (!element) return;
    const rest = -GLOBE.restLongitude;
    const lonAt = (progress: number) => rest + Math.PI * Math.pow(1 - progress, 3);
    setText(globeArt(lonAt(0)).join('\n'));
    let frame = 0, start = 0, last = 0;
    const run = (now: number) => {
      start ||= now;
      const progress = Math.min(1, (now - start) / (GLOBE_SECONDS * 1000));
      if (progress >= 1) { setText(globeRest); return; }
      if (now - last > 40) { last = now; setText(globeArt(lonAt(progress)).join('\n')); }
      frame = requestAnimationFrame(run);
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      observer.disconnect();
      frame = requestAnimationFrame(run);
    }, { rootMargin: '0px 0px -20% 0px' });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [reduced]);
  return <pre ref={ref} className="vc-plate vc-plate--globe" aria-hidden="true" suppressHydrationWarning><Art text={text} /></pre>;
}

const venn = vennArt();
const labels: { text: ReactNode; x: number; className?: string }[] = [
  { text: 'Solo en el código', x: 11 },
  { text: 'En ambas', x: 33, className: 'is-both' },
  { text: 'Solo en la web', x: 55 },
];

/** Two circles slide together, then the overlap is struck with the highlighter. */
export function VennPlate() {
  const ref = useReveal<HTMLDivElement>('0px 0px -25% 0px');
  return <div ref={ref} className="vc-venn">
    <pre className="vc-venn-layer vc-venn-lens" aria-hidden="true">{venn.lens.map(({ y, x0, x1 }) => {
      const row = ' '.repeat(x0);
      return <Fragment key={y}>{y === venn.lens[0]?.y ? ' \n'.repeat(y) : '\n'}{row}<span className="vc-lens-row" style={{ '--vc-i': y - (venn.lens[0]?.y ?? 0) }}>{' '.repeat(x1 - x0 + 1)}</span></Fragment>;
    })}</pre>
    <pre className="vc-venn-layer vc-venn-a" aria-hidden="true">{venn.a.join('\n')}</pre>
    <pre className="vc-venn-layer vc-venn-b" aria-hidden="true">{venn.b.join('\n')}</pre>
    <ul className="vc-venn-labels">
      {labels.map(({ text, x, className }) => <li key={x} className={className} style={{ left: `${x / VENN.cols * 100}%` }}>{text}</li>)}
    </ul>
  </div>;
}
