import { useEffect, useRef } from 'react';
import { buildFormation, createState, draw, plateLayout, retarget, step, type FieldState, type FormationName, type Palette } from './engine';
import './dot-plate.css';

/** Reads the six dot tones from `--dot-1` … `--dot-6` so the field follows the page theme. */
function readPalette(element: Element): Palette {
  const style = getComputedStyle(element);
  const tone = (index: number, fallback: string) => style.getPropertyValue(`--dot-${index}`).trim() || fallback;
  return [tone(1, '#191923'), tone(2, '#646174'), tone(3, '#e7147d'), tone(4, '#c80c68'), tone(5, '#c7bfbd'), tone(6, '#e6e1df')];
}

type DotPlateProps = {
  /** Changing it morphs the particles already on screen into the new formation. */
  formation: FormationName;
  className?: string;
  /** Holds the field still, e.g. from a visible pause control. */
  paused?: boolean;
};

/**
 * One dot formation drawn on a canvas that fills its parent. Particles fly into place when the plate
 * first scrolls into view, ripple away from a fine pointer and pull toward the finding while a
 * `[data-catch]` action is hovered or focused. Sleeps off screen, in hidden tabs, when paused and under
 * reduced motion (where it draws the settled formation once).
 */
export function DotPlate({ formation, className = '', paused = false }: DotPlateProps) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  const formationRef = useRef(formation);
  const wake = useRef<() => void>(() => undefined);
  const morph = useRef<() => void>(() => undefined);

  useEffect(() => { pausedRef.current = paused; wake.current(); }, [paused]);
  useEffect(() => { formationRef.current = formation; morph.current(); }, [formation]);

  useEffect(() => {
    const element = canvas.current;
    const host = root.current;
    const ctx = element?.getContext('2d');
    if (!element || !host || !ctx) return;
    const reducedQuery = matchMedia('(prefers-reduced-motion: reduce)');
    let state: FieldState | null = null;
    let palette = readPalette(element);
    let frameId = 0, last = 0, visible = false, entered = false, catching = false, disposed = false, size = '';
    const pointer = { x: -9999, y: -9999, lastMove: 0 };

    const canRun = () => visible && !pausedRef.current && !reducedQuery.matches && document.visibilityState === 'visible';
    const paint = () => { if (state) { draw(ctx, state, canRun(), palette); host.dataset.ready = 'true'; } };
    const frame = (now: number) => {
      frameId = 0;
      if (!state) return;
      const dt = Math.min(40, Math.max(1, now - last));
      last = now;
      const box = element.getBoundingClientRect();
      const inside = pointer.x >= box.left - 40 && pointer.x <= box.right + 40 && pointer.y >= box.top - 40 && pointer.y <= box.bottom + 40;
      const strength = inside ? Math.max(0, 1 - (now - pointer.lastMove) / 700) : 0;
      const more = step(state, dt, { pointerX: pointer.x - box.left, pointerY: pointer.y - box.top, pointerStrength: strength, catching });
      // Paused or hidden while this frame was queued: draw the still frame so later repaints match it.
      const running = canRun();
      draw(ctx, state, running, palette);
      host.dataset.ready = 'true';
      if (more && running) frameId = requestAnimationFrame(frame);
    };
    const start = () => {
      if (frameId || !state) return;
      if (!canRun()) { paint(); return; }
      last = performance.now();
      frameId = requestAnimationFrame(frame);
    };
    wake.current = start;

    const build = (animate: boolean) => {
      const box = element.getBoundingClientRect();
      const width = Math.round(box.width), height = Math.round(box.height);
      if (!width || !height) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const layout = plateLayout(width, height);
      state = createState(layout.particles, width, height, state ?? undefined);
      // Until the plate is first seen the particles stay as dust, so they can fly in when it appears.
      if (entered) retarget(state, buildFormation(formationRef.current, layout), animate && canRun());
      start();
    };
    morph.current = () => {
      if (!state || !entered) return;
      retarget(state, buildFormation(formationRef.current, plateLayout(state.width, state.height)), canRun());
      start();
    };
    const resize = () => {
      const box = element.getBoundingClientRect();
      const next = `${Math.round(box.width)}x${Math.round(box.height)}`;
      if (next === size) return;
      size = next;
      build(false);
    };

    const sizer = new ResizeObserver(resize);
    sizer.observe(element);
    const watcher = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      if (visible && !entered) { entered = true; size = ''; build(true); return; }
      start();
    }, { rootMargin: '120px 0px' });
    watcher.observe(element);

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      pointer.x = event.clientX; pointer.y = event.clientY; pointer.lastMove = performance.now();
      if (visible) start();
    };
    const setCatching = (event: Event) => {
      const next = event.target instanceof Element && event.target.closest('[data-catch]') !== null;
      if (next !== catching) { catching = next; start(); }
    };
    const refreshPalette = () => { palette = readPalette(element); paint(); };
    const themeWatcher = new MutationObserver(refreshPalette);
    themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const colorQuery = matchMedia('(prefers-color-scheme: dark)');
    const onMotionChange = () => { if (state) { retarget(state, state.formation, false); start(); } };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerover', setCatching);
    window.addEventListener('focusin', setCatching);
    window.addEventListener('focusout', setCatching);
    document.addEventListener('visibilitychange', start);
    colorQuery.addEventListener('change', refreshPalette);
    reducedQuery.addEventListener('change', onMotionChange);

    // The wordmark is sampled from text, so rebuild it once the display face is ready.
    if (formationRef.current === 'wordmark') {
      void Promise.all([document.fonts.load('700 100px "Gotchu Display"'), document.fonts.ready]).catch(() => undefined).then(() => { if (!disposed && state) build(false); });
    }
    resize();

    return () => {
      disposed = true;
      wake.current = () => undefined;
      morph.current = () => undefined;
      cancelAnimationFrame(frameId);
      sizer.disconnect(); watcher.disconnect(); themeWatcher.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerover', setCatching);
      window.removeEventListener('focusin', setCatching);
      window.removeEventListener('focusout', setCatching);
      document.removeEventListener('visibilitychange', start);
      colorQuery.removeEventListener('change', refreshPalette);
      reducedQuery.removeEventListener('change', onMotionChange);
    };
  }, []);

  return <div ref={root} className={`g-dot-plate ${className}`} aria-hidden="true"><canvas ref={canvas} /></div>;
}
