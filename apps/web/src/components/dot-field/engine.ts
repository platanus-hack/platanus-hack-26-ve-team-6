/**
 * Dot field engine: pure geometry (formations as target point lists) and physics (springs, pointer
 * ripple, catch) over typed arrays. No React and no per-frame allocation. Rendered as plates on the page.
 */
import { FINDING_RADIUS, LEFT_BRACKET, RIGHT_BRACKET } from '../gotchu-mark';

export const FORMATION_NAMES = ['mark', 'code', 'globe', 'both', 'report', 'wordmark', 'none'] as const;
export type FormationName = (typeof FORMATION_NAMES)[number];
export const isFormationName = (value: string | undefined): value is FormationName => FORMATION_NAMES.some(name => name === value);

/** Two structure tones, two finding tones, two dust tones; supplied per theme by the caller. */
export type Palette = readonly [string, string, string, string, string, string];
const TONES = 6;
const GLYPHS = ['.', ':', '+', '*', '#', '{', '}', '<', '>', '/'] as const;

const STRUCTURE = 0, FINDING = 1, DUST = 2, FAINT = 3;
const STAGGER_MS = 250;
const SPIN_RATE = 0.00028;
const SPIN_START = -0.25;
const TILT = 0.38;
const POINTER_RADIUS = 120;
const SPRING = 0.055;
const DAMPING = 0.82;

/* ---------- layout ---------- */

export type Layout = {
  width: number; height: number; mobile: boolean;
  /** The canvas is a plate in the page flow: the formation fills it, centred, with no hero offsets. */
  plate: boolean;
  /** Formation region: centre and size. */
  cx: number; cy: number; w: number; h: number;
  /** Base grid spacing for sampling. */
  spacing: number;
  particles: number;
  /** Most target points a formation may use; the rest of the particles stay ambient dust. */
  budget: number;
};

/** About 3,000 at 1440x900 and 1,100 at 390x844, capped at 4,000. */
export function particleCount(width: number, height: number) {
  return Math.min(4000, Math.round(0.1007 * (width * height) ** 0.7318));
}

export function layoutFor(width: number, height: number): Layout {
  const mobile = width < 1024;
  const particles = particleCount(width, height);
  const budget = Math.floor(particles * 0.72);
  if (mobile) return { width, height, mobile, plate: false, cx: width / 2, cy: height * 0.235, w: width * 0.9, h: height * 0.4, spacing: 6, particles, budget };
  return { width, height, mobile, plate: false, cx: width * 0.68, cy: height * 0.5, w: width * 0.52, h: height * 0.76, spacing: width > 1700 ? 8 : 7, particles, budget };
}

/** Layout for a canvas sitting in the page: the formation is centred and fills about 90% of it. */
export function plateLayout(width: number, height: number): Layout {
  const particles = Math.max(500, Math.min(2600, Math.round(particleCount(width, height) * 1.1)));
  const spacing = width < 480 ? 5 : width < 900 ? 6 : 7;
  return { width, height, mobile: false, plate: true, cx: width / 2, cy: height / 2, w: width * 0.92, h: height * 0.9, spacing, particles, budget: Math.floor(particles * 0.8) };
}

/* ---------- formations ---------- */

export type Globe = { cx: number; cy: number; r: number };
export type Formation = {
  count: number;
  /** Screen target, or unit-sphere x for spinning points. */
  x: Float32Array; y: Float32Array; z: Float32Array;
  spin: Uint8Array;
  kind: Uint8Array;
  globe: Globe | null;
  /** Horizontal band where spinning points turn into findings ("in both"). */
  zone: readonly [number, number] | null;
  centre: { x: number; y: number };
  finding: { x: number; y: number };
};

type Points = { xs: number[]; ys: number[]; zs: number[]; spins: number[]; kinds: number[]; sx: number[]; sy: number[]; globe: Globe | null };
const points = (): Points => ({ xs: [], ys: [], zs: [], spins: [], kinds: [], sx: [], sy: [], globe: null });

function add(p: Points, x: number, y: number, kind: number) {
  p.xs.push(x); p.ys.push(y); p.zs.push(0); p.spins.push(0); p.kinds.push(kind); p.sx.push(x); p.sy.push(y);
}
function addSpin(p: Points, gx: number, gy: number, gz: number, kind: number, globe: Globe) {
  p.xs.push(gx); p.ys.push(gy); p.zs.push(gz); p.spins.push(1); p.kinds.push(kind);
  p.sx.push(globe.cx + gx * globe.r); p.sy.push(globe.cy + gy * globe.r);
}

/** Grid-aligned fill so neighbouring shapes share one lattice. */
function fillRect(p: Points, x0: number, y0: number, x1: number, y1: number, s: number, kind: number) {
  for (let y = (Math.ceil(y0 / s - 0.5) + 0.5) * s; y <= y1; y += s) {
    for (let x = (Math.ceil(x0 / s - 0.5) + 0.5) * s; x <= x1; x += s) add(p, x, y, kind);
  }
}
function fillDiamond(p: Points, cx: number, cy: number, r: number, s: number, kind: number) {
  for (let y = cy - r + s / 2; y < cy + r; y += s) {
    for (let x = cx - r + s / 2; x < cx + r; x += s) if (Math.abs(x - cx) + Math.abs(y - cy) <= r) add(p, x, y, kind);
  }
}
function polyline(p: Points, path: readonly (readonly [number, number])[], step: number, kind: number) {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (!a || !b) continue;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const count = Math.max(1, Math.round(length / step));
    for (let j = 0; j < count; j++) add(p, a[0] + (b[0] - a[0]) * j / count, a[1] + (b[1] - a[1]) * j / count, kind);
  }
}

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function markPoints(L: Layout, s: number): Points {
  const p = points();
  const k = Math.min(L.w / 22, L.h / 19.6) * (L.mobile || L.plate ? 1 : 0.74);
  // Nudged right on the full-screen desktop field so giant hero type clears the left bracket.
  const cx = L.cx + (L.mobile || L.plate ? 0 : L.width * 0.03);
  for (const b of [...LEFT_BRACKET, ...RIGHT_BRACKET]) fillRect(p, cx + (b.x - b.w) * k, L.cy + (b.y - b.h) * k, cx + (b.x + b.w) * k, L.cy + (b.y + b.h) * k, s, STRUCTURE);
  fillDiamond(p, cx, L.cy, FINDING_RADIUS * k, s * 0.72, FINDING);
  return p;
}

/** A file seen from afar: dashes at varied indentation, framed by curly braces; one row is tinted. */
function codeBlock(p: Points, s: number, left: number, width: number, top: number, height: number) {
  const next = seeded(11);
  const ds = s * 0.6;
  const braceW = Math.min(width * 0.09, 56);
  const brace: readonly (readonly [number, number])[] = [[1, 0], [0.55, 0.03], [0.5, 0.12], [0.5, 0.42], [0.42, 0.47], [0, 0.5], [0.42, 0.53], [0.5, 0.58], [0.5, 0.88], [0.55, 0.97], [1, 1]];
  polyline(p, brace.map(([u, v]) => [left + u * braceW, top + v * height] as const), ds * 1.4, STRUCTURE);
  polyline(p, brace.map(([u, v]) => [left + width - u * braceW, top + v * height] as const), ds * 1.4, STRUCTURE);
  const rowLeft = left + braceW * 1.9, rowWidth = width - braceW * 3.8, indent = rowWidth * 0.07;
  const pitch = s * 2.6, rows = Math.floor(height / pitch), tinted = Math.floor(rows * 0.38);
  let level = 0;
  for (let row = 0; row < rows; row++) {
    const roll = next();
    level = roll < 0.18 ? Math.min(4, level + 1) : roll < 0.36 ? Math.max(0, level - 1) : level;
    if (row !== tinted && next() < 0.1) continue;
    const y = top + (row + 0.5) * pitch;
    const start = rowLeft + level * indent, room = rowWidth - level * indent;
    let x = start;
    const segments = row === tinted ? 3 : 1 + Math.floor(next() * 4);
    for (let i = 0; i < segments; i++) {
      const length = Math.min(room * (0.1 + next() * 0.26), start + room - x);
      if (length < ds * 2) break;
      polyline(p, [[x, y], [x + length, y]], row === tinted ? ds * 0.62 : ds, row === tinted ? FINDING : STRUCTURE);
      x += length + room * 0.035;
    }
  }
}

function codePoints(L: Layout, s: number): Points {
  const p = points();
  codeBlock(p, s, L.cx - L.w / 2, L.w, L.cy - L.h * 0.45, L.h * 0.9);
  return p;
}

const LAT_RINGS = [-60, -30, 0, 30, 60].map(deg => deg * Math.PI / 180);
const MERIDIANS = 10;
const DOT_LAT = 18 * Math.PI / 180, DOT_LON = 35 * Math.PI / 180;

/** Dotted sphere: latitude rings and meridians on the unit sphere, a limb outline, and a finding dot. */
function globePoints(p: Points, globe: Globe, s: number, zone: readonly [number, number] | null) {
  p.globe = globe;
  const step = s * 1.3 / globe.r;
  const onSphere = (lat: number, lon: number) => [Math.cos(lat) * Math.sin(lon), -Math.sin(lat), Math.cos(lat) * Math.cos(lon)] as const;
  for (const lat of LAT_RINGS) {
    const count = Math.max(8, Math.round(2 * Math.PI * Math.cos(lat) / step));
    for (let i = 0; i < count; i++) addSpin(p, ...onSphere(lat, i / count * 2 * Math.PI), STRUCTURE, globe);
  }
  for (let m = 0; m < MERIDIANS; m++) {
    for (let lat = -78 * Math.PI / 180; lat <= 78 * Math.PI / 180; lat += step) {
      if (LAT_RINGS.some(ring => Math.abs(ring - lat) < step * 0.6)) continue;
      addSpin(p, ...onSphere(lat, m / MERIDIANS * 2 * Math.PI), STRUCTURE, globe);
    }
  }
  const limb = Math.round(2 * Math.PI * globe.r / (s * 1.3));
  for (let i = 0; i < limb; i++) {
    const x = globe.cx + Math.cos(i / limb * 2 * Math.PI) * globe.r;
    add(p, x, globe.cy + Math.sin(i / limb * 2 * Math.PI) * globe.r, zone && x >= zone[0] && x <= zone[1] ? FINDING : STRUCTURE);
  }
  for (const dLat of [-1, 0, 1]) for (const dLon of [-1, 0, 1]) addSpin(p, ...onSphere(DOT_LAT + dLat * 0.045, DOT_LON + dLon * 0.045), FINDING, globe);
}

function globeOnly(L: Layout, s: number): Points {
  const p = points();
  globePoints(p, { cx: L.cx, cy: L.cy, r: Math.min(L.w * 0.44, L.h * 0.48) }, s, null);
  return p;
}

function bothPoints(L: Layout, s: number): Points {
  const p = points();
  const r = Math.min(L.w * 0.3, L.h * 0.46);
  const left = L.cx - L.w / 2, right = L.cx + L.w / 2;
  const codeWidth = L.w * 0.58;
  const zone: readonly [number, number] = [right - 2 * r, left + codeWidth];
  codeBlock(p, s, left, codeWidth, L.cy - L.h * 0.45, L.h * 0.9);
  p.kinds.forEach((_, i) => { const x = p.xs[i] ?? 0; if (x >= zone[0] && x <= zone[1]) p.kinds[i] = FINDING; });
  globePoints(p, { cx: right - r, cy: L.cy, r }, s, zone);
  return p;
}

function reportPoints(L: Layout, s: number): Points {
  const p = points();
  const next = seeded(23);
  const ds = s * 0.6;
  const ph = L.h * 0.95, pw = Math.min(L.w * 0.72, ph * 0.74);
  const left = L.cx - pw / 2, top = L.cy - ph / 2;
  const edge = s * 1.15;
  polyline(p, [[left, top], [left + pw, top], [left + pw, top + ph], [left, top + ph], [left, top]], edge * 0.85, FAINT);
  const margin = pw * 0.1, inner = left + margin, width = pw - margin * 2;
  fillRect(p, inner, top + margin, inner + width * 0.55, top + margin + s * 1.9, s * 0.7, STRUCTURE);
  polyline(p, [[inner, top + margin + s * 3.4], [inner + width * 0.32, top + margin + s * 3.4]], ds, STRUCTURE);
  const startY = top + margin + s * 6.4, rows = 11;
  const pitch = (top + ph - margin - startY) / rows;
  for (let row = 0; row < rows; row++) {
    const y = startY + (row + 0.5) * pitch;
    const hot = row === 4;
    const kind = hot ? FINDING : STRUCTURE;
    const tick = hot ? 3 : 1 + Math.floor(next() * 3);
    fillRect(p, inner, y - tick * ds / 2, inner + ds * 1.4, y + tick * ds / 2, ds, kind);
    const length = width * (hot ? 0.85 : 0.35 + next() * 0.6);
    polyline(p, [[inner + ds * 4, y], [inner + ds * 4 + length - ds * 4, y]], hot ? ds * 0.62 : ds, kind);
  }
  return p;
}

function wordmarkPoints(L: Layout, s: number): Points {
  const p = points();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return p;
  const targetWidth = L.width * (L.mobile || L.plate ? 0.9 : 0.86);
  const centreY = L.mobile || L.plate ? L.cy : L.height * 0.36;
  ctx.font = '700 100px "Gotchu Display"';
  const probe = ctx.measureText('GOTCHU');
  const cap = probe.actualBoundingBoxAscent || 70;
  const gap = cap * 0.28, diamond = cap * 0.5;
  const scale = targetWidth / (probe.width + gap + diamond * 2);
  const size = 100 * scale, capHeight = cap * scale;
  const pad = 4;
  canvas.width = Math.ceil(probe.width * scale) + pad * 2;
  canvas.height = Math.ceil(size * 1.4);
  ctx.font = `700 ${size}px "Gotchu Display"`;
  ctx.fillStyle = '#fff';
  const baseline = size * 1.1;
  ctx.fillText('GOTCHU', pad, baseline);
  const { data, width } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const left = (L.width - targetWidth) / 2;
  const topOffset = centreY - capHeight / 2 - (baseline - capHeight);
  for (let y = s / 2; y < canvas.height; y += s) {
    for (let x = s / 2; x < canvas.width; x += s) {
      if ((data[((Math.floor(y) * width) + Math.floor(x)) * 4 + 3] ?? 0) > 128) add(p, left + x - pad, topOffset + y, STRUCTURE);
    }
  }
  fillDiamond(p, left + probe.width * scale + gap * scale + diamond * scale, centreY, diamond * scale, s, FINDING);
  return p;
}

const BUILDERS: Record<FormationName, (L: Layout, s: number) => Points> = {
  mark: markPoints, code: codePoints, globe: globeOnly, both: bothPoints, report: reportPoints, wordmark: wordmarkPoints,
  none: () => points(),
};

function finish(name: FormationName, p: Points, L: Layout): Formation {
  const centre = name === 'wordmark' ? { x: L.width / 2, y: L.mobile || L.plate ? L.cy : L.height * 0.36 } : { x: L.cx, y: L.cy };
  const order = p.xs.map((_, i) => i);
  const angle = (i: number) => Math.atan2((p.sy[i] ?? 0) - centre.y, (p.sx[i] ?? 0) - centre.x);
  order.sort((a, b) => angle(a) - angle(b));
  const pick = (values: number[]) => Float32Array.from(order, i => values[i] ?? 0);
  let fx = 0, fy = 0, fn = 0;
  for (const i of order) if (p.kinds[i] === FINDING) { fx += p.sx[i] ?? 0; fy += p.sy[i] ?? 0; fn++; }
  const globe = p.globe;
  const zone = name === 'both' && globe ? ([globe.cx - globe.r, (L.cx - L.w / 2) + L.w * 0.58] as const) : null;
  return {
    count: order.length, x: pick(p.xs), y: pick(p.ys), z: pick(p.zs),
    spin: Uint8Array.from(order, i => p.spins[i] ?? 0), kind: Uint8Array.from(order, i => p.kinds[i] ?? 0),
    globe, zone, centre, finding: fn ? { x: fx / fn, y: fy / fn } : centre,
  };
}

/** Thins the sampling grid until the formation fits the particle budget. */
export function buildFormation(name: FormationName, L: Layout): Formation {
  let s = name === 'wordmark' && L.mobile ? 4 : L.spacing;
  let p = BUILDERS[name](L, s);
  for (let attempt = 0; attempt < 16 && p.xs.length > L.budget; attempt++) {
    s *= 1.07;
    p = BUILDERS[name](L, s);
  }
  return finish(name, p, L);
}

/* ---------- particles ---------- */

export type FieldState = {
  n: number; width: number; height: number;
  x: Float32Array; y: Float32Array; vx: Float32Array; vy: Float32Array;
  tx: Float32Array; ty: Float32Array; nx: Float32Array; ny: Float32Array;
  px: Float32Array; py: Float32Array;
  /** Virtual time at which a pending target takes over (0 = none). */
  rel: Float32Array;
  tone: Float32Array; phase: Float32Array; size: Float32Array;
  gx: Float32Array; gy: Float32Array; gz: Float32Array;
  kind: Uint8Array; spin: Uint8Array; cls: Uint8Array; glyph: Int8Array;
  order: Uint16Array; angle: Float32Array; used: Uint8Array;
  formation: Formation;
  /** Animation clock in ms; advances only while the loop runs. */
  vt: number;
  catchAmount: number;
};

const EMPTY: Formation = { count: 0, x: new Float32Array(0), y: new Float32Array(0), z: new Float32Array(0), spin: new Uint8Array(0), kind: new Uint8Array(0), globe: null, zone: null, centre: { x: 0, y: 0 }, finding: { x: 0, y: 0 } };

/** Creates particles scattered as dust; carries positions over from `previous` when resizing. */
export function createState(n: number, width: number, height: number, previous?: FieldState): FieldState {
  const f32 = () => new Float32Array(n), u8 = () => new Uint8Array(n);
  const s: FieldState = {
    n, width, height, x: f32(), y: f32(), vx: f32(), vy: f32(), tx: f32(), ty: f32(), nx: f32(), ny: f32(), px: f32(), py: f32(),
    rel: f32(), tone: f32(), phase: f32(), size: f32(), gx: f32(), gy: f32(), gz: f32(),
    kind: u8(), spin: u8(), cls: u8(), glyph: new Int8Array(n), order: new Uint16Array(n), angle: f32(), used: u8(),
    formation: previous?.formation ?? EMPTY, vt: previous?.vt ?? 0, catchAmount: previous?.catchAmount ?? 0,
  };
  const sx = previous ? width / previous.width : 1, sy = previous ? height / previous.height : 1;
  for (let i = 0; i < n; i++) {
    const old = previous && i < previous.n;
    const x = old ? (previous.x[i] ?? 0) * sx : Math.random() * width;
    const y = old ? (previous.y[i] ?? 0) * sy : Math.random() * height;
    s.x[i] = x; s.y[i] = y; s.tx[i] = x; s.ty[i] = y; s.nx[i] = x; s.ny[i] = y;
    s.kind[i] = DUST;
    s.tone[i] = Math.random(); s.phase[i] = Math.random() * 6.283;
    s.glyph[i] = Math.random() < 0.14 ? Math.floor(Math.random() * GLYPHS.length) : -1;
    s.size[i] = 2;
  }
  return s;
}

function spinAngle(s: FieldState) { return SPIN_START + s.vt * SPIN_RATE; }

/** Writes the current spinning targets and the colour class of every particle. */
function aim(s: FieldState) {
  const { globe, zone } = s.formation;
  const angle = spinAngle(s);
  const cos = Math.cos(angle), sin = Math.sin(angle), cosT = Math.cos(TILT), sinT = Math.sin(TILT);
  for (let i = 0; i < s.n; i++) {
    let kind = s.kind[i] ?? DUST;
    let back = false;
    if (s.spin[i] && globe) {
      const gx = s.gx[i] ?? 0, gy = s.gy[i] ?? 0, gz = s.gz[i] ?? 0;
      const x1 = gx * cos + gz * sin, z1 = -gx * sin + gz * cos;
      const y1 = gy * cosT - z1 * sinT, depth = gy * sinT + z1 * cosT;
      const nx = globe.cx + x1 * globe.r;
      s.nx[i] = nx; s.ny[i] = globe.cy + y1 * globe.r;
      back = depth < -0.05;
      if (zone && nx >= zone[0] && nx <= zone[1]) kind = FINDING;
    }
    const tone = s.tone[i] ?? 0;
    s.cls[i] = kind === FAINT ? 4 : kind === DUST ? (tone < 0.5 ? 4 : 5)
      : kind === FINDING ? (back ? 4 : tone < 0.65 ? 2 : 3)
        : back ? 5 : tone < 0.6 ? 0 : 1;
  }
}

/** Sends every particle to its place in `formation`, short arcs first (both lists sorted by angle). */
export function retarget(s: FieldState, formation: Formation, animate: boolean) {
  s.formation = formation;
  const { n } = s;
  const count = Math.min(formation.count, n);
  for (let i = 0; i < n; i++) {
    s.angle[i] = Math.atan2((s.y[i] ?? 0) - formation.centre.y, (s.x[i] ?? 0) - formation.centre.x);
    s.order[i] = i;
  }
  s.order.sort((a, b) => (s.angle[a] ?? 0) - (s.angle[b] ?? 0));
  s.used.fill(0);
  for (let j = 0; j < count; j++) {
    const i = s.order[Math.floor(j * n / count)] ?? 0;
    const f = Math.floor(j * formation.count / count);
    s.used[i] = 1;
    s.kind[i] = formation.kind[f] ?? STRUCTURE;
    s.spin[i] = formation.spin[f] ?? 0;
    if (s.spin[i]) { s.gx[i] = formation.x[f] ?? 0; s.gy[i] = formation.y[f] ?? 0; s.gz[i] = formation.z[f] ?? 0; }
    else { s.nx[i] = formation.x[f] ?? 0; s.ny[i] = formation.y[f] ?? 0; }
    s.size[i] = 2;
    s.rel[i] = animate ? s.vt + (j / count) * STAGGER_MS + 0.001 : 0;
  }
  for (let i = 0; i < n; i++) {
    if (s.used[i] || s.kind[i] === DUST) continue;
    s.kind[i] = DUST; s.spin[i] = 0;
    s.nx[i] = Math.random() * s.width; s.ny[i] = Math.random() * s.height;
    s.size[i] = (s.tone[i] ?? 0) < 0.5 ? 2 : 1;
    s.rel[i] = animate ? s.vt + Math.random() * STAGGER_MS + 0.001 : 0;
  }
  aim(s);
  if (!animate) snap(s);
}

/** Places every particle exactly on its target (reduced motion, paused, resize without animation). */
export function snap(s: FieldState) {
  aim(s);
  for (let i = 0; i < s.n; i++) {
    s.tx[i] = s.nx[i] ?? 0; s.ty[i] = s.ny[i] ?? 0;
    s.x[i] = s.tx[i] ?? 0; s.y[i] = s.ty[i] ?? 0;
    s.vx[i] = 0; s.vy[i] = 0; s.rel[i] = 0;
  }
}

export type StepInput = {
  /** Pointer in canvas coordinates; strength 0 turns the ripple off. */
  pointerX: number; pointerY: number; pointerStrength: number;
  catching: boolean;
};

/** One physics step (dt in ms). Returns true while the field still needs frames. */
export function step(s: FieldState, dt: number, input: StepInput): boolean {
  const k = dt / 16.667;
  s.vt += dt;
  const catchTarget = input.catching ? 1 : 0;
  s.catchAmount += (catchTarget - s.catchAmount) * Math.min(1, 0.14 * k);
  if (Math.abs(catchTarget - s.catchAmount) < 0.004) s.catchAmount = catchTarget;
  aim(s);
  const { formation: f, catchAmount } = s;
  const damping = DAMPING ** k, accel = SPRING * k;
  const ripple = input.pointerStrength > 0;
  let maxSpeed = 0, maxGap = 0, pending = false;
  for (let i = 0; i < s.n; i++) {
    const release = s.rel[i] ?? 0;
    if (release > 0 && s.vt < release) pending = true;
    else { s.rel[i] = 0; s.tx[i] = s.nx[i] ?? 0; s.ty[i] = s.ny[i] ?? 0; }
    const kind = s.kind[i] ?? DUST;
    let ex = s.tx[i] ?? 0, ey = s.ty[i] ?? 0;
    if (catchAmount > 0 && kind !== DUST && kind !== FAINT) {
      const finding = kind === FINDING;
      const pull = catchAmount * (finding ? 0.3 : 0.04), centre = finding ? f.finding : f.centre;
      ex += (centre.x - ex) * pull; ey += (centre.y - ey) * pull;
    }
    const x = s.x[i] ?? 0, y = s.y[i] ?? 0;
    let vx = s.vx[i] ?? 0, vy = s.vy[i] ?? 0;
    vx += (ex - x) * accel; vy += (ey - y) * accel;
    if (ripple) {
      const dx = x - input.pointerX, dy = y - input.pointerY, d2 = dx * dx + dy * dy;
      if (d2 < POINTER_RADIUS * POINTER_RADIUS && d2 > 0.01) {
        const d = Math.sqrt(d2), fall = 1 - d / POINTER_RADIUS;
        const push = fall * fall * 2.4 * input.pointerStrength * k / d;
        vx += dx * push; vy += dy * push;
      }
    }
    vx *= damping; vy *= damping;
    s.vx[i] = vx; s.vy[i] = vy;
    s.x[i] = x + vx * k; s.y[i] = y + vy * k;
    maxSpeed = Math.max(maxSpeed, Math.abs(vx), Math.abs(vy));
    maxGap = Math.max(maxGap, Math.abs(ex - x), Math.abs(ey - y));
  }
  return pending || maxSpeed > 0.02 || maxGap > 0.6 || ripple || s.catchAmount !== catchTarget || f.globe !== null;
}

/* ---------- drawing ---------- */

const GLYPH_FONT = '600 11px ui-monospace, SFMono-Regular, Consolas, monospace';
const counts = new Uint16Array(TONES * 2 + 1);
const cursor = new Uint16Array(TONES * 2 + 1);
let bucket = new Uint16Array(0);

/** Batches by colour: one fillStyle per group, pixels with fillRect and glyphs with fillText. */
export function draw(ctx: CanvasRenderingContext2D, s: FieldState, wobble: boolean, palette: Palette) {
  ctx.clearRect(0, 0, s.width, s.height);
  if (bucket.length < s.n) bucket = new Uint16Array(s.n);
  counts.fill(0);
  const t = s.vt;
  for (let i = 0; i < s.n; i++) {
    const cls = s.cls[i] ?? 0;
    let x = s.x[i] ?? 0, y = s.y[i] ?? 0;
    if (wobble) {
      const amp = s.kind[i] === DUST ? 5 : 0.15, tone = s.tone[i] ?? 0, phase = s.phase[i] ?? 0;
      x += Math.sin(t * 0.0007 * (0.6 + tone) + phase) * amp;
      y += Math.cos(t * 0.0006 * (0.7 + tone) + phase * 0.8) * amp;
    }
    s.px[i] = x; s.py[i] = y;
    const slot = cls * 2 + ((s.glyph[i] ?? -1) >= 0 ? 1 : 0) + 1;
    counts[slot] = (counts[slot] ?? 0) + 1;
  }
  for (let key = 1; key < counts.length; key++) counts[key] = (counts[key] ?? 0) + (counts[key - 1] ?? 0);
  cursor.set(counts);
  for (let i = 0; i < s.n; i++) {
    const key = (s.cls[i] ?? 0) * 2 + ((s.glyph[i] ?? -1) >= 0 ? 1 : 0);
    bucket[cursor[key] ?? 0] = i;
    cursor[key] = (cursor[key] ?? 0) + 1;
  }
  ctx.font = GLYPH_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let cls = 0; cls < TONES; cls++) {
    ctx.fillStyle = palette[cls] ?? '#888';
    ctx.globalAlpha = cls >= 4 ? 0.8 : 1;
    for (let key = cls * 2; key < cls * 2 + 2; key++) {
      for (let at = counts[key] ?? 0; at < (counts[key + 1] ?? 0); at++) {
        const i = bucket[at] ?? 0;
        const x = s.px[i] ?? 0, y = s.py[i] ?? 0;
        if (key % 2 === 0) {
          const size = s.size[i] ?? 2;
          ctx.fillRect(Math.round(x - size / 2), Math.round(y - size / 2), size, size);
        } else ctx.fillText(GLYPHS[s.glyph[i] ?? 0] ?? '.', Math.round(x), Math.round(y));
      }
    }
  }
  ctx.globalAlpha = 1;
}
