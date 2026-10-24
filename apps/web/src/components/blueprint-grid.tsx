import { useEffect, useRef } from 'react';
import './blueprint-grid.css';

/** Hairline grid behind a section; the cell under a fine pointer lights up and follows it. */
export function BlueprintGrid() {
  const cell = 96;
  const root = useRef<HTMLDivElement>(null);
  const spot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = root.current?.parentElement;
    if (!host || !matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    let pending = 0;
    let target: { x: number; y: number } | null = null;
    const paint = () => {
      pending = 0;
      if (!spot.current) return;
      spot.current.style.opacity = target ? '1' : '0';
      if (target) spot.current.style.transform = `translate3d(${target.x}px, ${target.y}px, 0)`;
    };
    const move = (event: PointerEvent) => {
      const box = host.getBoundingClientRect();
      target = { x: Math.floor((event.clientX - box.left) / cell) * cell, y: Math.floor((event.clientY - box.top) / cell) * cell };
      if (!pending) pending = requestAnimationFrame(paint);
    };
    const leave = () => { target = null; if (!pending) pending = requestAnimationFrame(paint); };
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerleave', leave);
    return () => { host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', leave); cancelAnimationFrame(pending); };
  }, [cell]);
  return <div ref={root} className="g-blueprint" style={{ ['--cell' as string]: `${cell}px` }} aria-hidden="true"><div ref={spot} className="g-blueprint-spot" /></div>;
}
