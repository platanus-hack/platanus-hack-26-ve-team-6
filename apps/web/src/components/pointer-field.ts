import { useEffect, type RefObject } from 'react';
import { useMotionValue, useReducedMotion, useSpring } from 'motion/react';

export type PointerSample = { x: number; y: number; focus: boolean };
type Listener = (sample: PointerSample | null) => void;

const listeners = new Set<Listener>();
let sample: PointerSample | null = null;
let pending = 0;

function flush() {
  pending = 0;
  for (const listener of listeners) listener(sample);
}
function schedule() {
  if (!pending) pending = requestAnimationFrame(flush);
}
function track(event: PointerEvent) {
  const target = event.target instanceof Element ? event.target : null;
  sample = { x: event.clientX, y: event.clientY, focus: Boolean(target?.closest('[data-catch]')) };
  schedule();
}
function leave(event: PointerEvent) {
  if (event.relatedTarget) return;
  sample = null;
  schedule();
}

/** One set of window listeners shared by every object that turns toward the pointer. */
function subscribePointer(listener: Listener) {
  if (!listeners.size) {
    addEventListener('pointermove', track, { passive: true });
    addEventListener('pointerdown', track, { passive: true });
    addEventListener('scroll', schedule, { passive: true });
    document.addEventListener('pointerout', leave);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    removeEventListener('pointermove', track);
    removeEventListener('pointerdown', track);
    removeEventListener('scroll', schedule);
    document.removeEventListener('pointerout', leave);
    cancelAnimationFrame(pending);
    pending = 0;
  };
}

const LOOK_SPRING = { duration: 0.5, bounce: 0.15 };

/**
 * Springs pointing from the element's centre toward the pointer, each in [-1, 1].
 * `focus` is 1 while the pointer rests on an element marked `data-catch`.
 * Settles to rest under reduced motion or while the element is off screen.
 */
export function useFacing(target: RefObject<HTMLElement | null>, reach = 560) {
  const reduced = useReducedMotion();
  const x = useSpring(0, LOOK_SPRING);
  const y = useSpring(0, LOOK_SPRING);
  const focus = useMotionValue(0);
  useEffect(() => {
    const element = target.current;
    if (reduced || !element) { x.jump(0); y.jump(0); return; }
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; });
    observer.observe(element);
    const unsubscribe = subscribePointer(current => {
      if (!visible) return;
      if (!current) { x.set(0); y.set(0); focus.set(0); return; }
      const box = element.getBoundingClientRect();
      const dx = current.x - (box.left + box.width / 2);
      const dy = current.y - (box.top + box.height / 2);
      const distance = Math.hypot(dx, dy) || 1;
      const strength = Math.min(1, distance / reach);
      x.set(dx / distance * strength);
      y.set(dy / distance * strength);
      focus.set(current.focus ? 1 : 0);
    });
    return () => { unsubscribe(); observer.disconnect(); };
  }, [focus, reach, reduced, target, x, y]);
  return { x, y, focus };
}
