import { useReducedMotion, useSpring } from 'motion/react';
import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

const MIN = 32;
const MAX = 68;
const STEP = 4;
const REST = 50;
const SPLIT_LAYOUT = '(min-width: 760px)';

const clamp = (value: number) => Math.min(MAX, Math.max(MIN, value));

/**
 * The draggable seam. One spring owns the shared split; every change is written to `--va-split`
 * on the page root (never to React state), so each split section reshapes together.
 * Dragging follows the pointer 1:1; keyboard steps and reset glide through the spring.
 */
export function SeamHandle({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const layer = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const grab = useRef<{ pointerId: number; offset: number } | null>(null);
  const target = useRef(REST);
  const reduced = useReducedMotion();
  const split = useSpring(REST, { stiffness: 320, damping: 34 });

  useEffect(() => {
    const root = rootRef.current;
    const slider = handle.current;
    if (!root || !slider) return;
    return split.on('change', value => {
      const next = clamp(value);
      root.style.setProperty('--va-split', next.toFixed(2));
      const code = Math.round(next);
      slider.setAttribute('aria-valuenow', String(code));
      slider.setAttribute('aria-valuetext', `Código ${code} %, web ${100 - code} %`);
    });
  }, [rootRef, split]);

  // Visible only while the middle of the viewport sits inside a split section.
  useEffect(() => {
    const root = rootRef.current;
    const element = layer.current;
    if (!root || !element) return;
    const inside = new Set<Element>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) inside.add(entry.target); else inside.delete(entry.target);
      }
      element.dataset.visible = String(inside.size > 0);
    }, { rootMargin: '-50% 0px -50% 0px' });
    root.querySelectorAll('[data-va-zone]').forEach(zone => observer.observe(zone));
    return () => observer.disconnect();
  }, [rootRef]);

  const moveTo = (clientX: number, offset: number) => {
    const root = rootRef.current;
    if (!root) return;
    const box = root.getBoundingClientRect();
    const next = clamp((clientX - offset - box.left) / box.width * 100);
    target.current = next;
    split.jump(next);
  };

  const begin = (pointerId: number, clientX: number, offset: number) => {
    const root = rootRef.current;
    const slider = handle.current;
    if (!root || !slider) return;
    slider.setPointerCapture(pointerId);
    grab.current = { pointerId, offset };
    root.dataset.dragging = 'true';
    moveTo(clientX, offset);
  };

  const end = () => {
    grab.current = null;
    delete rootRef.current?.dataset.dragging;
  };

  // Any part of a seam line can be grabbed, not only the handle.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onDown = (event: globalThis.PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('.va-seam')) return;
      if (!matchMedia(SPLIT_LAYOUT).matches) return;
      event.preventDefault();
      handle.current?.focus({ preventScroll: true });
      begin(event.pointerId, event.clientX, 0);
    };
    root.addEventListener('pointerdown', onDown);
    return () => root.removeEventListener('pointerdown', onDown);
  }, [rootRef]);

  const glide = (value: number) => {
    target.current = clamp(value);
    if (reduced) split.jump(target.current); else split.set(target.current);
  };

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    const box = event.currentTarget.getBoundingClientRect();
    begin(event.pointerId, event.clientX, event.clientX - (box.left + box.width / 2));
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (grab.current?.pointerId === event.pointerId) moveTo(event.clientX, grab.current.offset);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, () => void> = {
      ArrowLeft: () => glide(target.current - STEP),
      ArrowDown: () => glide(target.current - STEP),
      ArrowRight: () => glide(target.current + STEP),
      ArrowUp: () => glide(target.current + STEP),
      Home: () => glide(MIN),
      End: () => glide(MAX),
      Enter: () => glide(REST),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    move();
  }

  return <div ref={layer} className="va-handle-layer" data-visible="true">
    <div
      ref={handle}
      className="va-handle"
      role="slider"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="Repartir el espacio entre código y web"
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      aria-valuenow={REST}
      aria-valuetext="Código 50 %, web 50 %"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
      onDoubleClick={() => glide(REST)}
    >
      <span className="va-handle-diamond" />
    </div>
  </div>;
}
