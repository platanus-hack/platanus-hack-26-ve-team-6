import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { useMotionValue, useMotionValueEvent, useReducedMotion, useScroll, useSpring } from 'motion/react';

/** Decorative product geometry. No result, score or running assessment is depicted. */
export function EvidenceLens({ perspective = 0, compact = false }: { perspective?: number; compact?: boolean }) {
  const surface = useRef<HTMLDivElement>(null);
  const object = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [finePointer, setFinePointer] = useState(false);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const smoothX = useSpring(x, { duration: .4, bounce: 0 });
  const smoothY = useSpring(y, { duration: .4, bounce: 0 });
  const { scrollYProgress } = useScroll({ target: surface, offset: ['start end', 'end start'] });
  useEffect(() => {
    const media = matchMedia('(hover: hover) and (pointer: fine)');
    const update = () => setFinePointer(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const draw = useCallback(() => {
    if (!object.current) return;
    const scrollTravel = (scrollYProgress.get() - .5) * -18;
    const transform = `translate3d(0, ${scrollTravel}px, 0) rotateX(${smoothY.get()}deg) rotateY(${smoothX.get()}deg)`;
    object.current.style.transform = reduced ? 'none' : transform;
  }, [reduced, scrollYProgress, smoothX, smoothY]);
  useMotionValueEvent(smoothX, 'change', draw);
  useMotionValueEvent(smoothY, 'change', draw);
  useMotionValueEvent(scrollYProgress, 'change', draw);
  useEffect(() => { draw(); }, [draw]);
  function track(event: PointerEvent<HTMLDivElement>) {
    if (!finePointer || reduced || event.pointerType === 'touch') return;
    const bounds = event.currentTarget.getBoundingClientRect();
    x.set(((event.clientX - bounds.left) / bounds.width - .5) * 12);
    y.set(((event.clientY - bounds.top) / bounds.height - .5) * -8);
  }
  return <div ref={surface} className={`g-scene${compact ? ' g-scene-compact' : ''}`} data-perspective={perspective} onPointerMove={track} onPointerLeave={() => { x.set(0); y.set(0); }} aria-hidden="true">
    <div className="g-scene-shadow" />
    <div ref={object} className="g-object">
      <div className="g-source-layer"><img src="/landing/source-snapshot.svg" width="360" height="280" alt="" /><span>Código fuente</span></div>
      <div className="g-origin-layer"><img src="/landing/https-origin.svg" width="300" height="300" alt="" /><span>Origen HTTPS</span></div>
      <div className="g-lens-layer"><img src="/landing/evidence-lens.svg" width="520" height="540" alt="" fetchPriority={compact ? 'auto' : 'high'} /></div>
    </div>
  </div>;
}

export function useChapterTracking() {
  const container = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!container.current) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.chapter));
      }
    }, { rootMargin: '-25% 0px -35% 0px', threshold: 0 });
    container.current.querySelectorAll('[data-chapter]').forEach(chapter => observer.observe(chapter));
    return () => observer.disconnect();
  }, []);
  return { container, active };
}
