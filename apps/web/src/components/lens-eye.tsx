import { useCallback, useEffect, useId, useRef } from 'react';
import { animate, frame, useMotionValue, useMotionValueEvent, useReducedMotion, type MotionValue } from 'motion/react';
import { useFacing } from './pointer-field';
import './lens-eye.css';

const CENTER = 200;
const BLADES = 8;
const REST = 0.72;
const FOCUSED = 0.22;
const TICKS = Array.from({ length: 72 }, (_, index) => {
  const angle = index * Math.PI / 36;
  const inner = index % 6 === 0 ? 156 : 162;
  const point = (radius: number) => `${(CENTER + radius * Math.cos(angle)).toFixed(2)} ${(CENTER + radius * Math.sin(angle)).toFixed(2)}`;
  return `M${point(inner)}L${point(170)}`;
}).join('');

/** One aperture blade: a strip whose curved inner edge sits `radius` from the centre; closing also twists the opening. */
export function bladePath(index: number, opening: number) {
  const radius = 16 + opening * 94;
  const angle = index * Math.PI * 2 / BLADES + (1 - opening) * 0.7;
  const nx = Math.cos(angle);
  const ny = Math.sin(angle);
  const point = (along: number, out: number) => `${(CENTER + nx * out - ny * along).toFixed(2)} ${(CENTER + ny * out + nx * along).toFixed(2)}`;
  return `M${point(-190, radius)}Q${point(0, radius * 1.12)} ${point(190, radius)}L${point(190, radius + 180)}L${point(-190, radius + 180)}Z`;
}

type LensEyeProps = {
  className?: string;
  /** Extra opening driven by the page, 0–1, added to the resting aperture. */
  boost?: MotionValue<number>;
  /** Focus-ring rotation in degrees, driven by the page. */
  spin?: MotionValue<number>;
  /** Blink once after hydration. */
  greet?: boolean;
};

/** The Gotchu lens: a machined aperture whose iris follows the pointer and narrows on primary actions. */
export function LensEye({ className = '', boost, spin, greet = false }: LensEyeProps) {
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const bezel = useRef<HTMLDivElement>(null);
  const pupil = useRef<HTMLDivElement>(null);
  const glare = useRef<HTMLDivElement>(null);
  const ticks = useRef<SVGGElement>(null);
  const iris = useRef<SVGGElement>(null);
  const blades = useRef<(SVGPathElement | null)[]>([]);
  const id = `g-lens${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const reduced = useReducedMotion();
  const look = useFacing(root);
  const opening = useMotionValue(REST);

  const draw = useCallback(() => {
    const x = look.x.get();
    const y = look.y.get();
    const open = Math.min(1, Math.max(0, opening.get() + (boost?.get() ?? 0) * 0.28));
    if (body.current) body.current.style.transform = `rotateX(${(-y * 13).toFixed(2)}deg) rotateY(${(x * 15).toFixed(2)}deg)`;
    if (bezel.current) bezel.current.style.transform = `rotate(${(x * 34 - y * 20).toFixed(2)}deg)`;
    if (pupil.current) pupil.current.style.transform = `translate3d(${(x * 9).toFixed(2)}%, ${(y * 9).toFixed(2)}%, -18px)`;
    if (glare.current) glare.current.style.transform = `translate3d(${(-x * 5).toFixed(2)}%, ${(-y * 5).toFixed(2)}%, 22px)`;
    ticks.current?.setAttribute('transform', `rotate(${((spin?.get() ?? 0) + x * 10).toFixed(2)} ${CENTER} ${CENTER})`);
    iris.current?.setAttribute('transform', `translate(${(x * 8).toFixed(2)} ${(y * 8).toFixed(2)})`);
    blades.current.forEach((blade, index) => blade?.setAttribute('d', bladePath(index, open)));
  }, [boost, look.x, look.y, opening, spin]);
  const schedule = useCallback(() => { frame.render(draw); }, [draw]);
  useMotionValueEvent(look.x, 'change', schedule);
  useMotionValueEvent(look.y, 'change', schedule);
  useMotionValueEvent(opening, 'change', schedule);
  useEffect(() => {
    const unsubscribe = [boost?.on('change', schedule), spin?.on('change', schedule)];
    schedule();
    return () => unsubscribe.forEach(stop => stop?.());
  }, [boost, schedule, spin]);

  useMotionValueEvent(look.focus, 'change', focused => {
    animate(opening, focused ? FOCUSED : REST, { type: 'spring', duration: 0.45, bounce: focused ? 0.2 : 0 });
  });
  useEffect(() => {
    if (!greet || reduced) return;
    const blink = animate(opening, [REST, 0.04, REST], { duration: 0.75, times: [0, 0.22, 1], ease: ['easeIn', 'easeOut'], delay: 0.5 });
    return () => blink.stop();
  }, [greet, opening, reduced]);

  return <div ref={root} className={`g-lens ${className}`} aria-hidden="true">
    <div className="g-lens-shadow" />
    <div ref={body} className="g-lens-body">
      {[5, 4, 3, 2, 1].map(depth => <div key={depth} className="g-lens-edge" style={{ transform: `translateZ(${-depth * 4}px)` }} />)}
      <div ref={pupil} className="g-lens-pupil" />
      <div ref={bezel} className="g-lens-bezel" />
      <svg className="g-lens-face" viewBox="0 0 400 400">
        <defs>
          <linearGradient id={`${id}-blade`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#5d5265" /><stop offset=".45" stopColor="#2a2431" /><stop offset="1" stopColor="#141119" /></linearGradient>
          <linearGradient id={`${id}-step`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#efe6eb" /><stop offset=".3" stopColor="#4c4856" /><stop offset=".62" stopColor="#24222c" /><stop offset="1" stopColor="#a99ea8" /></linearGradient>
          <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#ffa8cf" /><stop offset=".45" stopColor="#e7147d" /><stop offset="1" stopColor="#6d0b41" /></linearGradient>
          <clipPath id={`${id}-chamber`}><circle cx={CENTER} cy={CENTER} r="124" /></clipPath>
        </defs>
        <circle cx={CENTER} cy={CENTER} r="176" fill="#16131c" />
        <g ref={ticks} stroke="#b8aebb" strokeOpacity=".75" strokeWidth="1.6"><path d={TICKS} /><path d="M200 26v20M374 200h-20M200 374v-20M26 200h20" stroke="#ff8fbe" strokeOpacity="1" strokeWidth="3" /></g>
        <circle cx={CENTER} cy={CENTER} r="145" fill="none" stroke={`url(#${id}-step)`} strokeWidth="10" />
        <circle cx={CENTER} cy={CENTER} r="135" fill="none" stroke={`url(#${id}-rim)`} strokeWidth="9" />
        <circle cx={CENTER} cy={CENTER} r="127" fill="none" stroke="#08070c" strokeWidth="6" />
        <g clipPath={`url(#${id}-chamber)`}><g ref={iris}>
          {Array.from({ length: BLADES }, (_, index) => <path key={index} ref={element => { blades.current[index] = element; }} d={bladePath(index, REST)} fill={`url(#${id}-blade)`} stroke="#f2dbe7" strokeOpacity=".28" strokeWidth="1" />)}
        </g></g>
        <circle cx={CENTER} cy={CENTER} r="124" fill="none" stroke="#fffefa" strokeOpacity=".1" />
      </svg>
      <div ref={glare} className="g-lens-glare" />
    </div>
  </div>;
}
