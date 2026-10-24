import { useEffect, useState } from 'react';
import { motion, useReducedMotion, useScroll, type MotionValue } from 'motion/react';

export const SECTIONS = [
  { id: 'vc-mirada', label: 'Mirada' },
  { id: 'vc-codigo', label: 'Código' },
  { id: 'vc-dominio', label: 'Dominio' },
  { id: 'vc-miradas', label: 'Dos miradas' },
  { id: 'vc-evidencia', label: 'Evidencia' },
  { id: 'vc-alcance', label: 'Alcance' },
  { id: 'vc-equipo', label: 'Equipo' },
  { id: 'vc-preguntas', label: 'Preguntas' },
  { id: 'vc-paso', label: 'El paso' },
] as const;

export const pad = (index: number) => String(index + 1).padStart(2, '0');

/** Index of the section crossing the reading line (a band just above the viewport middle). */
export function useCurrentSection() {
  const [current, setCurrent] = useState(0);
  useEffect(() => {
    const visible = new Set<number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const index = SECTIONS.findIndex(section => section.id === entry.target.id);
        if (entry.isIntersecting) visible.add(index); else visible.delete(index);
      }
      if (visible.size) setCurrent(Math.min(...visible));
    }, { rootMargin: '-40% 0px -55% 0px' });
    for (const { id } of SECTIONS) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
  return current;
}

const ITEM = 32;

/** Sticky numbered index on wide screens; a slim strip under the header below 1100px. */
export function IndexRail({ current, progress }: { current: number; progress: MotionValue<number> }) {
  const reduced = useReducedMotion();
  const section = SECTIONS[current] ?? SECTIONS[0];
  return <>
    <nav className="vc-rail" aria-label="Índice del expediente">
      <ol className="vc-rail-list">
        {SECTIONS.map((item, index) => <li key={item.id}>
          <a href={`#${item.id}`} aria-current={index === current ? 'location' : undefined}><span>{pad(index)}</span>{item.label}</a>
        </li>)}
      </ol>
      <span className="vc-rail-track" aria-hidden="true">
        <motion.span className="vc-rail-fill" style={{ scaleY: reduced ? 0 : progress }} />
        <span className="vc-rail-marker" style={{ transform: `translateY(${current * ITEM + 6}px)` }} />
      </span>
    </nav>
    <div className="vc-strip" aria-hidden="true">
      <span>{pad(current)} / {pad(SECTIONS.length - 1)} — {section.label}</span>
      <motion.span className="vc-strip-fill" style={{ scaleX: reduced ? 0 : progress }} />
    </div>
  </>;
}
