import { useCallback, useEffect, useRef, useState } from 'react';
import { frame, useMotionValue, useMotionValueEvent, useScroll, useSpring } from 'motion/react';
import { AsciiMark } from './ascii-mark';
import { BlueprintGrid } from './blueprint-grid';
import './convergence.css';

const LIVE_QUERY = '(min-width: 761px) and (min-height: 560px) and (prefers-reduced-motion: no-preference)';
const REST = .35;

/** The pinned sequence runs only on roomy screens with motion allowed; everything else keeps the stacked layout. */
function useLiveStage() {
  const [live, setLive] = useState(false);
  useEffect(() => {
    const media = matchMedia(LIVE_QUERY);
    const update = () => setLive(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return live;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));
const ease = (t: number) => t < .5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
type Part = 'mark' | 'left' | 'right' | 'flash' | 'two' | 'one' | 'report';

/** Real report vocabulary from the assessment contract; no values. */
function ReportCard() {
  return <div className="g-report-card">
    <header><span className="g-report-title">Tu informe</span><span className="g-tag g-report-json">JSON</span></header>
    <dl>
      <div><dt>Hallazgo</dt><dd>Qué es y dónde está</dd></div>
      <div><dt>Severidad</dt><dd>De informativa a crítica</dd></div>
      <div><dt>Confianza</dt><dd>Observada, inferida o incierta</dd></div>
      <div><dt>Evidencia</dt><dd>El fragmento que lo demuestra</dd></div>
      <div><dt>Cobertura</dt><dd>Lo que se revisó y lo que quedó fuera</dd></div>
    </dl>
  </div>;
}

/** Scroll story: code and HTTPS separate, close on one finding, then the report arrives. */
export function Convergence() {
  const stage = useRef<HTMLElement>(null);
  const parts = useRef<Record<Part, HTMLElement | null>>({ mark: null, left: null, right: null, flash: null, two: null, one: null, report: null });
  const live = useLiveStage();
  const { scrollYProgress } = useScroll({ target: stage, offset: ['start start', 'end end'] });
  const progress = useSpring(scrollYProgress, { duration: 0.3, bounce: 0 });
  const open = useMotionValue(REST);
  const bind = (key: Part) => (element: HTMLElement | null) => { parts.current[key] = element; };

  const draw = useCallback(() => {
    const set = (key: Part, transform: string, opacity: number) => {
      const element = parts.current[key];
      if (!element) return;
      element.style.transform = transform;
      element.style.opacity = opacity.toFixed(3);
    };
    if (!live) {
      for (const element of Object.values(parts.current)) if (element) { element.style.transform = ''; element.style.opacity = ''; element.style.removeProperty('clip-path'); }
      open.set(REST);
      return;
    }
    const p = progress.get();
    const seg = (start: number, end: number) => clamp((p - start) / (end - start));
    const spread = REST + (1 - REST) * ease(seg(.02, .3));
    open.set(spread * (1 - ease(seg(.42, .5))));
    const labels = seg(.02, .12) * (1 - seg(.42, .48));
    const drift = ease(seg(.02, .3)) * 7;
    set('left', `translate3d(${-drift}vw, 0, 0)`, labels);
    set('right', `translate3d(${drift}vw, 0, 0)`, labels);
    set('two', `translate3d(0, ${((1 - seg(.02, .1)) * 24).toFixed(1)}px, 0)`, seg(.02, .1) * (1 - seg(.4, .46)));
    // The catch wipes in from below and out through the top, so the field is never a translucent tint.
    const wipeIn = ease(seg(.47, .53)), wipeOut = ease(seg(.62, .68));
    set('flash', 'none', wipeIn > 0 && wipeOut < 1 ? 1 : 0);
    parts.current.flash?.style.setProperty('clip-path', `inset(${((1 - wipeIn) * 100).toFixed(2)}% 0 ${(wipeOut * 100).toFixed(2)}% 0)`);
    const emit = ease(seg(.68, .86));
    set('mark', `translate3d(${(-emit * 24).toFixed(2)}vw, ${(-emit * 5).toFixed(2)}svh, 0) scale(${(1 - .25 * emit).toFixed(3)})`, 1);
    set('report', `translate3d(${((1 - emit) * 12).toFixed(2)}vw, 0, 0)`, seg(.7, .78));
    const one = seg(.8, .88);
    set('one', `translate3d(0, ${((1 - one) * 24).toFixed(1)}px, 0)`, one);
  }, [live, open, progress]);
  useEffect(() => { draw(); }, [draw]);
  useMotionValueEvent(progress, 'change', () => { frame.render(draw); });

  return <section ref={stage} className="g-stage" data-live={live} aria-labelledby="stage-title">
    <div className="g-stage-frame">
      <BlueprintGrid />
      <p ref={bind('flash')} className="g-stage-flash" aria-hidden="true">Gotchu.</p>
      <div ref={bind('mark')} className="g-stage-mark"><AsciiMark open={open} /></div>
      <p ref={bind('left')} className="g-tag g-stage-label g-stage-label-left" aria-hidden="true">[ Código ]</p>
      <p ref={bind('right')} className="g-tag g-stage-label g-stage-label-right" aria-hidden="true">[ HTTPS ]</p>
      <div className="g-stage-step g-stage-two">
        <div ref={bind('two')} className="g-stage-copy">
          <h2 id="stage-title">Dos miradas.<br /><span>Más contexto.</span></h2>
          <p>Revisa el código y la web juntos para distinguir qué coincide y qué aparece en una sola revisión.</p>
        </div>
      </div>
      <div className="g-stage-step g-stage-one">
        <div ref={bind('one')} className="g-stage-copy">
          <h2>Cada hallazgo.<br /><span>Su evidencia.</span></h2>
          <p>Cada hallazgo indica gravedad y confianza, con evidencia; el reporte aclara qué se revisó, qué quedó fuera y sus límites.</p>
        </div>
        <div ref={bind('report')} className="g-stage-report"><ReportCard /></div>
      </div>
    </div>
  </section>;
}
