import { Fragment, useEffect, useRef, useState, type RefObject } from 'react';
import { useReducedMotion } from 'motion/react';
import { useReveal } from './editorial';

/**
 * Plates are authored from geometry: a character grid, a few shape helpers, one palette.
 * The finding diamond is the only coloured glyph (the brand-ink token, so it follows the theme).
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

// ─── Lens over a sheet of code ────────────────────────────────────────────────

const LENS = { cols: 48, rows: 18, finding: [22, 10] as const, radius: 4.6 };

function lensArt() {
  const sheet = createGrid(LENS.cols, LENS.rows);
  sheet.box(0, 0, 40, 17);
  const code = ['=====  =======', '  ====  ===  ========', '  ======  ====', '', '====  ======  ===', '  ===  =========', '  =======  ==  ====', '  ====  ======', `====  ======  ===  ${FINDING} =====`, '', '=====  ====  ======', '  ======  =='];
  code.forEach((line, row) => sheet.text(3, 2 + row, line));
  const [fx, fy] = LENS.finding;

  // The lens is drawn on its own layer around the finding, so it can slide across the sheet.
  const lens = createGrid(LENS.cols, LENS.rows);
  for (let y = 0; y < LENS.rows; y++) for (let x = 0; x < LENS.cols; x++) {
    const dx = (x - fx) / 2, dy = y - fy;
    if (Math.abs(Math.hypot(dx, dy) - LENS.radius) < 0.5) lens.put(x, y, ringGlyph(dx, dy));
  }
  for (let step = 1; step <= 3; step++) {
    const y = fy + Math.round(LENS.radius * 0.72) + step;
    const x = fx + Math.round(LENS.radius * 1.44) + step * 2;
    lens.text(x - 1, y, '\\\\');
  }
  return { sheet: sheet.lines().join('\n'), lens: lens.lines() };
}

// ─── A finding as the report records it ──────────────────────────────────────

function reportArt() {
  const grid = createGrid(46, 18);
  grid.box(4, 0, 42, 16);
  grid.box(2, 1, 42, 16);
  grid.box(0, 2, 42, 16);
  grid.text(3, 4, `${FINDING} ==========  ======`);
  grid.text(3, 7, 'SEVERIDAD   [####..]');
  grid.text(3, 9, 'CONFIANZA   [###...]');
  grid.text(3, 11, 'EVIDENCIA   > ====  ========');
  grid.text(15, 12, '> ======  ===');
  grid.text(3, 14, 'COBERTURA   [#######...]');
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
  return <>{parts.map((part, index) => <Fragment key={index}>{index > 0 && <span className="gl-find">{FINDING}</span>}{part}</Fragment>)}</>;
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
  return <pre ref={ref} className="gl-plate" style={{ '--gl-cols': 56 }} aria-hidden="true"><Art text={text} /></pre>;
}

const lens = lensArt();

/** A lens slides across a sheet of code and comes to rest on the finding. */
export function LensPlate() {
  const ref = useReveal<HTMLDivElement>('0px 0px -25% 0px');
  return <div ref={ref} className="gl-lens" style={{ '--gl-cols': LENS.cols }} aria-hidden="true">
    <pre className="gl-plate"><Art text={lens.sheet} /></pre>
    {/* Each glyph of the lens carries the ground colour, so it covers the code it passes over. */}
    <pre className="gl-plate gl-lens-glass">{lens.lens.map((row, y) => <Fragment key={y}>
      {y > 0 && '\n'}
      {row.split(/(\S+)/).map((run, at) => at % 2 ? <span key={at}>{run}</span> : run)}
    </Fragment>)}</pre>
  </div>;
}

const report = reportArt().join('\n');

/** The fields every finding carries; develops from noise when scrolled into view. */
export function ReportPlate() {
  const ref = useRef<HTMLPreElement>(null);
  const text = useDevelop(report, ref);
  return <pre ref={ref} className="gl-plate" style={{ '--gl-cols': 46 }} aria-hidden="true"><Art text={text} /></pre>;
}

const venn = vennArt();

/** Two circles slide together, then the overlap is struck with the highlighter. */
export function VennPlate({ labels }: { labels: readonly [string, string, string] }) {
  const ref = useReveal<HTMLDivElement>('0px 0px -25% 0px');
  return <div ref={ref} className="gl-venn">
    <pre className="gl-venn-layer gl-venn-lens" aria-hidden="true">{venn.lens.map(({ y, x0, x1 }) => {
      const row = ' '.repeat(x0);
      return <Fragment key={y}>{y === venn.lens[0]?.y ? ' \n'.repeat(y) : '\n'}{row}<span className="gl-lens-row" style={{ '--gl-i': y - (venn.lens[0]?.y ?? 0) }}>{' '.repeat(x1 - x0 + 1)}</span></Fragment>;
    })}</pre>
    <pre className="gl-venn-layer gl-venn-a" aria-hidden="true">{venn.a.join('\n')}</pre>
    <pre className="gl-venn-layer gl-venn-b" aria-hidden="true">{venn.b.join('\n')}</pre>
    <ul className="gl-venn-labels">
      {labels.map((text, index) => <li key={index} className={index === 1 ? 'is-both' : undefined} style={{ left: `${(11 + index * 22) / VENN.cols * 100}%` }}>{text}</li>)}
    </ul>
  </div>;
}
