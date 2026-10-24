import { useCallback, useEffect, useRef } from 'react';
import { frame, useReducedMotion, useScroll } from 'motion/react';
import { useFacing } from './pointer-field';
import { GotchuMark } from './gotchu-mark';
import './wordmark-rows.css';

/** Repeated wordmark texture: alternate rows drift against each other with scroll and lean toward the pointer. */
export function WordmarkRows({ rows = 5, className = '' }: { rows?: number; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const lines = useRef<(HTMLDivElement | null)[]>([]);
  const reduced = useReducedMotion();
  const look = useFacing(root, 900);
  const { scrollYProgress } = useScroll({ target: root, offset: ['start end', 'end start'] });
  const draw = useCallback(() => {
    const progress = reduced ? .5 : scrollYProgress.get();
    const lean = reduced ? 0 : look.x.get();
    lines.current.forEach((line, index) => {
      const direction = index % 2 ? -1 : 1;
      if (line) line.style.transform = `translate3d(${(-25 + direction * ((progress - .5) * 22 + lean * 3)).toFixed(2)}%, 0, 0)`;
    });
  }, [look.x, reduced, scrollYProgress]);
  useEffect(() => {
    const schedule = () => { frame.render(draw); };
    const stops = [scrollYProgress.on('change', schedule), look.x.on('change', schedule)];
    schedule();
    return () => stops.forEach(stop => stop());
  }, [draw, look.x, scrollYProgress]);
  return <div ref={root} className={`g-wordrows ${className}`} aria-hidden="true">
    {Array.from({ length: rows }, (_, index) => <div key={index} ref={element => { lines.current[index] = element; }} className={index % 2 ? 'is-outline' : ''}>
      {Array.from({ length: 6 }, (_, word) => <span key={word} data-word="GOTCHU"><GotchuMark size={0} /></span>)}
    </div>)}
  </div>;
}
