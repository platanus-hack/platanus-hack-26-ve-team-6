/**
 * The Gotchu mark: two scope brackets closing on a finding.
 * Units are a 24×24 box centred on the origin; the ASCII renderer extrudes the same boxes.
 */
export type MarkBox = { x: number; y: number; w: number; h: number };

export const BAR = 1.7;
const bracket = (side: -1 | 1): MarkBox[] => [
  { x: side * 9.3, y: 0, w: BAR, h: 9.6 },
  { x: side * 6.6, y: -7.9, w: 4.4, h: BAR },
  { x: side * 6.6, y: 7.9, w: 4.4, h: BAR },
];
export const LEFT_BRACKET = bracket(-1);
export const RIGHT_BRACKET = bracket(1);
export const FINDING_RADIUS = 4.1;

const rect = ({ x, y, w, h }: MarkBox) => <rect x={x - w + 12} y={y - h + 12} width={w * 2} height={h * 2} />;

/** Flat mark for lockups; brackets take the current colour, the finding stays magenta. */
export function GotchuMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  const r = FINDING_RADIUS;
  return <svg className={`g-mark ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <g fill="currentColor">{[...LEFT_BRACKET, ...RIGHT_BRACKET].map((box, index) => <g key={index}>{rect(box)}</g>)}</g>
    <path d={`M12 ${12 - r}L${12 + r} 12L12 ${12 + r}L${12 - r} 12Z`} fill="#e7147d" />
  </svg>;
}
