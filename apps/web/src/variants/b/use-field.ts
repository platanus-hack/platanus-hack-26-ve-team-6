import { useEffect, useRef, type RefObject } from 'react';
import { buildFormation, createState, draw, isFormationName, layoutFor, retarget, step, type FieldState, type Formation, type FormationName, type Layout } from './field';

type FieldOptions = {
  paused: boolean;
  reduced: boolean;
  /** Formation shown while the section marked `data-formation="scope"` is active. */
  scope: FormationName;
};

/**
 * Drives the fixed background canvas: one rAF loop that sleeps when the field has settled, the tab is
 * hidden or motion is off. Sections choose the formation with `data-formation`.
 */
export function useField(canvasRef: RefObject<HTMLCanvasElement | null>, { paused, reduced, scope }: FieldOptions) {
  const live = useRef({ paused, reduced, scope });
  const sync = useRef<(() => void) | null>(null);

  useEffect(() => {
    live.current = { paused, reduced, scope };
    sync.current?.();
  }, [paused, reduced, scope]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let layout: Layout | null = null;
    let state: FieldState | null = null;
    let active: FormationName | 'scope' = 'mark';
    let placed: FormationName | null = null;
    let frameId = 0, last = 0, resizeTimer = 0, catching = false, disposed = false;
    const cache = new Map<FormationName, Formation>();
    const pointer = { x: -9999, y: -9999, lastMove: 0, inside: false };

    const resolved = (): FormationName => (active === 'scope' ? live.current.scope : active);
    const formation = (name: FormationName) => {
      const cached = cache.get(name);
      if (cached) return cached;
      const built = buildFormation(name, layout ?? layoutFor(canvas.clientWidth, canvas.clientHeight));
      cache.set(name, built);
      return built;
    };
    const canRun = () => !live.current.paused && !live.current.reduced && document.visibilityState === 'visible';
    const paint = () => { if (state) draw(ctx, state, !live.current.reduced); };

    const frame = (now: number) => {
      frameId = 0;
      if (!state) return;
      const dt = Math.min(40, Math.max(1, now - last));
      last = now;
      const strength = pointer.inside ? Math.max(0, 1 - (now - pointer.lastMove) / 700) : 0;
      const more = step(state, dt, { pointerX: pointer.x, pointerY: pointer.y, pointerStrength: strength, catching });
      draw(ctx, state, true);
      if (more && canRun()) frameId = requestAnimationFrame(frame);
    };
    const start = () => {
      if (frameId || !state || !canRun()) return;
      last = performance.now();
      frameId = requestAnimationFrame(frame);
    };

    /** Moves the field to the active formation: flying when motion is on, snapping when paused or reduced. */
    const place = (animate: boolean) => {
      if (!state || !layout) return;
      placed = resolved();
      retarget(state, formation(placed), animate && canRun());
      paint();
      start();
    };

    const measure = () => {
      const box = canvas.getBoundingClientRect();
      const width = Math.round(box.width), height = Math.round(box.height);
      if (!width || !height || (layout?.width === width && layout.height === height)) return;
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      layout = layoutFor(width, height);
      cache.clear();
      state = createState(layout.particles, width, height, state ?? undefined);
      place(true);
    };

    sync.current = () => {
      if (live.current.reduced) place(false);
      else if (resolved() !== placed) place(true);
      else start();
    };

    const sections = new IntersectionObserver(entries => {
      const before = resolved();
      for (const entry of entries) {
        if (!entry.isIntersecting || !(entry.target instanceof HTMLElement)) continue;
        const name = entry.target.dataset.formation;
        if (name === 'scope' || isFormationName(name)) active = name;
      }
      if (resolved() !== before) place(true);
    }, { rootMargin: '-45% 0px -45% 0px' });
    document.querySelectorAll('[data-formation]').forEach(section => sections.observe(section));

    const resizer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(measure, state ? 150 : 0);
    });
    resizer.observe(canvas);

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      pointer.x = event.clientX; pointer.y = event.clientY; pointer.inside = true; pointer.lastMove = performance.now();
      start();
    };
    const onLeave = () => { pointer.inside = false; catching = false; start(); };
    const setCatching = (event: Event) => {
      const next = event.target instanceof Element && event.target.closest('[data-catch]') !== null;
      if (next !== catching) { catching = next; start(); }
    };
    const onVisibility = () => { if (document.visibilityState === 'visible') start(); };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointerover', setCatching);
    window.addEventListener('focusin', setCatching);
    window.addEventListener('focusout', setCatching);
    document.addEventListener('visibilitychange', onVisibility);

    // The wordmark is sampled from text, so rebuild it once the display face is available.
    // A failed font load only means the sample uses the fallback face.
    void Promise.all([document.fonts.load('700 100px "Gotchu Display"'), document.fonts.ready]).catch(() => undefined).then(() => {
      if (disposed) return;
      cache.delete('wordmark');
      if (resolved() === 'wordmark') place(true);
    });

    measure();

    return () => {
      disposed = true;
      sync.current = null;
      cancelAnimationFrame(frameId);
      window.clearTimeout(resizeTimer);
      sections.disconnect();
      resizer.disconnect();
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointerover', setCatching);
      window.removeEventListener('focusin', setCatching);
      window.removeEventListener('focusout', setCatching);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [canvasRef]);
}
