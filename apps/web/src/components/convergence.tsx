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
    <header><span className="g-tag">[ Informe de evaluación ]</span><span className="g-tag g-report-json">JSON</span></header>
    <dl>
      <div><dt>Hallazgo</dt><dd>Título, ubicación y regla</dd></div>
      <div><dt>Severidad</dt><dd>Desconocida · informativa · baja · media · alta · crítica</dd></div>
      <div><dt>Confianza</dt><dd>Observada · inferida · incierta</dd></div>
      <div><dt>Evidencia</dt><dd>Extracto, herramienta y checksum</dd></div>
      <div><dt>Cobertura</dt><dd>Inspeccionado · no solicitado · no compatible · no disponible</dd></div>
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
      for (const element of Object.values(parts.current)) if (element) { element.style.transform = ''; element.style.opacity = ''; }
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
    const flash = seg(.47, .52) * (1 - seg(.62, .68));
    set('flash', `scale(${(1.06 - .06 * seg(.47, .58)).toFixed(3)})`, flash);
    const emit = ease(seg(.68, .86));
    set('mark', `translate3d(${(-emit * 21).toFixed(2)}vw, 0, 0) scale(${(1 - .12 * emit).toFixed(3)})`, 1);
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
          <h2 id="stage-title">Dos perspectivas.<br /><span>Un mismo hallazgo.</span></h2>
          <p>La instantánea de código y el origen HTTPS autorizado se evalúan por separado. Gotchu contrasta lo que ve cada una sin perder su procedencia.</p>
        </div>
      </div>
      <div className="g-stage-step g-stage-one">
        <div ref={bind('one')} className="g-stage-copy">
          <h2>Cada hallazgo,<br /><span>con su evidencia.</span></h2>
          <p>Severidad, confianza, extractos y la herramienta que lo detectó. También lo que quedó fuera de la cobertura, para que nadie lo confunda con una garantía.</p>
        </div>
        <div ref={bind('report')} className="g-stage-report"><ReportCard /></div>
      </div>
    </div>
  </section>;
}
