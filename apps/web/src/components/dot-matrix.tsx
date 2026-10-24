import { useRef, type PointerEvent } from 'react';
import './dot-matrix.css';

const SIZE = 11;
const CENTRE = (SIZE - 1) / 2;
type Cell = [number, number];

const ring = (radius: number, width = .5): Cell[] => grid().filter(([r, c]) => Math.abs(Math.hypot(r - CENTRE, c - CENTRE) - radius) < width);
function grid(): Cell[] { return Array.from({ length: SIZE * SIZE }, (_, i): Cell => [Math.floor(i / SIZE), i % SIZE]); }
const parse = (rows: string[]): Cell[] => rows.flatMap((row, r) => [...row].flatMap((ch, c): Cell[] => ch === 'X' ? [[r, c]] : []));
const unique = (cells: Cell[]) => [...new Map(cells.map(cell => [cell.join(), cell])).values()];

/** 11×11 pictograms of real product concepts, authored as cells. */
export const pictograms = {
  code: parse([
    '...........',
    '......X....',
    '...X..XX...',
    '..X..X..X..',
    '.X...X...X.',
    'X....X....X',
    '.X...X...X.',
    '..X.X...X..',
    '...XX..X...',
    '....X......',
    '...........',
  ]),
  globe: unique([...ring(4.7), ...grid().filter(([r, c]) => r === CENTRE && Math.abs(c - CENTRE) < 4.5), ...grid().filter(([r, c]) => Math.abs(((c - CENTRE) / 2.1) ** 2 + ((r - CENTRE) / 4.7) ** 2 - 1) < .28)]),
  mark: parse([
    'XXX.....XXX',
    'X.........X',
    'X....X....X',
    'X...XXX...X',
    'X..XXXXX..X',
    'X.XXXXXXX.X',
    'X..XXXXX..X',
    'X...XXX...X',
    'X....X....X',
    'X.........X',
    'XXX.....XXX',
  ]),
  workspace: parse([
    '...........',
    '.XXXX.XXXX.',
    '.X..X.X..X.',
    '.X..X.X..X.',
    '.XXXX.XXXX.',
    '...........',
    '.XXXX.XXXX.',
    '.X..X.X..X.',
    '.X..X.X..X.',
    '.XXXX.XXXX.',
    '...........',
  ]),
  history: unique([...ring(4.7), ...parse(['', '', '.....X', '.....X', '.....X', '.....XXX'])]),
  json: parse([
    '...........',
    '...XX..XX..',
    '...X....X..',
    '...X....X..',
    '...X....X..',
    '..X..X...X.',
    '...X....X..',
    '...X....X..',
    '...X....X..',
    '...XX..XX..',
    '...........',
  ]),
} satisfies Record<string, Cell[]>;
export type PictogramName = keyof typeof pictograms;

const DOTS = Math.max(...Object.values(pictograms).map(cells => cells.length));
/** Cells sorted by angle so dots travel short arcs when one pictogram morphs into another. */
const ordered = (cells: Cell[]) => [...cells].sort(([r1, c1], [r2, c2]) => Math.atan2(r1 - CENTRE, c1 - CENTRE) - Math.atan2(r2 - CENTRE, c2 - CENTRE));

/** Pixel pictogram whose dots morph between shapes and shy away from the pointer. */
export function DotMatrix({ name, className = '' }: { name: PictogramName; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const cells = ordered(pictograms[name]);
  function repel(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch' || !root.current) return;
    const box = root.current.getBoundingClientRect();
    const px = (event.clientX - box.left) / box.width * SIZE - .5, py = (event.clientY - box.top) / box.height * SIZE - .5;
    root.current.querySelectorAll<HTMLElement>('[data-cell]').forEach(dot => {
      const [r, c] = (dot.dataset.cell ?? '0,0').split(',').map(Number) as [number, number];
      const dx = c - px, dy = r - py, distance = Math.hypot(dx, dy);
      const push = distance < 2.6 ? (2.6 - distance) * 22 : 0;
      dot.style.setProperty('translate', push ? `${(dx / (distance || 1) * push).toFixed(1)}% ${(dy / (distance || 1) * push).toFixed(1)}%` : '0 0');
    });
  }
  function settle() { root.current?.querySelectorAll<HTMLElement>('[data-cell]').forEach(dot => dot.style.setProperty('translate', '0 0')); }
  return <div ref={root} className={`g-dots ${className}`} onPointerMove={repel} onPointerLeave={settle} aria-hidden="true">
    {Array.from({ length: DOTS }, (_, index) => {
      const cell = cells[index];
      const [r, c] = cell ?? [CENTRE, CENTRE];
      return <span key={index} data-cell={cell ? `${r},${c}` : undefined} style={{ transform: `translate(${c * 100}%, ${r * 100}%) scale(${cell ? 1 : 0})`, transitionDelay: `${index * 5}ms` }}><i /></span>;
    })}
  </div>;
}
