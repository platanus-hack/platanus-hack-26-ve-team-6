import { useCallback, useEffect, useRef, useState } from 'react';
import { frame, useMotionValue, useMotionValueEvent, useScroll, useSpring } from 'motion/react';
import { UiIcon } from './ui';
import { LensEye } from './lens-eye';
import { CodeSlab, OriginGlobe, ReportSheet } from './spatial-objects';
import './convergence.css';

const LIVE_QUERY = '(min-width: 761px) and (min-height: 560px) and (prefers-reduced-motion: no-preference)';

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
type Vector = { x: number; y: number };
const centre = (element: Element): Vector => {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
};

/** Hero and scroll story: code and web drift into the lens, which returns the report. */
export function Convergence() {
  const stage = useRef<HTMLElement>(null);
  const parts = useRef<Record<'code' | 'web' | 'tagline' | 'lead' | 'actions' | 'slab' | 'globe' | 'lens' | 'two' | 'one' | 'report' | 'beam', HTMLElement | null>>({
    code: null, web: null, tagline: null, lead: null, actions: null, slab: null, globe: null, lens: null, two: null, one: null, report: null, beam: null,
  });
  const offsets = useRef({ slab: { x: 0, y: 0 }, globe: { x: 0, y: 0 }, report: { x: 0, y: 0 }, shift: 0 });
  const live = useLiveStage();
  const { scrollYProgress } = useScroll({ target: stage, offset: ['start start', 'end end'] });
  const progress = useSpring(scrollYProgress, { duration: 0.3, bounce: 0 });
  const boost = useMotionValue(0);
  const spin = useMotionValue(0);
  const bind = (key: keyof typeof parts.current) => (element: HTMLElement | null) => { parts.current[key] = element; };

  const reset = useCallback(() => {
    for (const element of Object.values(parts.current)) {
      if (!element) continue;
      element.style.transform = '';
      element.style.opacity = '';
      element.style.pointerEvents = '';
    }
    boost.set(0);
    spin.set(0);
  }, [boost, spin]);

  const draw = useCallback(() => {
    if (!live) return;
    const p = progress.get();
    const seg = (start: number, end: number) => clamp((p - start) / (end - start));
    const set = (key: keyof typeof parts.current, transform: string, opacity: number) => {
      const element = parts.current[key];
      if (!element) return;
      element.style.transform = transform;
      element.style.opacity = opacity.toFixed(3);
      element.style.pointerEvents = opacity < .2 ? 'none' : '';
    };
    const { slab, globe, report, shift } = offsets.current;
    const leave = ease(seg(.02, .2));
    const fade = 1 - seg(0, .14);
    set('code', `translate3d(${(-leave * 9).toFixed(2)}vw, 0, 0)`, 1 - leave);
    set('web', `translate3d(${(leave * 9).toFixed(2)}vw, 0, 0)`, 1 - leave);
    for (const key of ['tagline', 'lead', 'actions'] as const) set(key, `translate3d(0, ${(-leave * 24).toFixed(1)}px, 0)`, fade);
    const gather = ease(seg(.06, .4));
    const sink = 1 - seg(.33, .41);
    set('slab', `translate3d(${(slab.x * gather).toFixed(1)}px, ${(slab.y * gather).toFixed(1)}px, 0) scale(${(1 - .85 * gather).toFixed(3)})`, sink);
    set('globe', `translate3d(${(globe.x * gather).toFixed(1)}px, ${(globe.y * gather).toFixed(1)}px, 0) scale(${(1 - .85 * gather).toFixed(3)})`, sink);
    const emit = ease(seg(.5, .76));
    set('lens', `translate3d(${(-shift * emit).toFixed(1)}px, 0, 0) scale(${(1 + .08 * seg(.2, .4) - .22 * emit).toFixed(3)})`, 1);
    set('report', `translate3d(${(report.x * (1 - emit)).toFixed(1)}px, ${(report.y * (1 - emit)).toFixed(1)}px, 0) scale(${(.2 + .8 * emit).toFixed(3)})`, seg(.5, .6));
    set('beam', `scaleX(${ease(seg(.58, .8)).toFixed(3)})`, seg(.56, .62));
    const two = seg(.24, .34) * (1 - seg(.47, .55));
    set('two', `translate3d(0, ${((1 - seg(.24, .34)) * 24).toFixed(1)}px, 0)`, two);
    const one = seg(.68, .78);
    set('one', `translate3d(0, ${((1 - one) * 24).toFixed(1)}px, 0)`, one);
    boost.set(seg(.18, .4) * (1 - seg(.44, .56)));
    spin.set(p * 260);
  }, [boost, live, progress, spin]);

  const measure = useCallback(() => {
    reset();
    const { slab, globe, lens, report } = parts.current;
    if (!live || !slab || !globe || !lens || !report) return;
    const target = centre(lens);
    const offset = (element: Element) => { const from = centre(element); return { x: target.x - from.x, y: target.y - from.y }; };
    const shift = innerWidth * .2;
    offsets.current = { slab: offset(slab), globe: offset(globe), report: offset(report), shift };
    const { beam } = parts.current;
    const frameBox = beam?.offsetParent?.getBoundingClientRect();
    if (beam && frameBox) {
      const lensBox = lens.getBoundingClientRect();
      const reportBox = report.getBoundingClientRect();
      const start = target.x - shift + lensBox.width * .39;
      beam.style.left = `${(start - frameBox.left).toFixed(1)}px`;
      beam.style.top = `${(target.y - frameBox.top).toFixed(1)}px`;
      beam.style.width = `${Math.max(0, reportBox.left - start + 12).toFixed(1)}px`;
    }
    draw();
  }, [draw, live, reset]);

  useEffect(() => {
    measure();
    void document.fonts.ready.then(measure, () => undefined);
    addEventListener('resize', measure);
    return () => removeEventListener('resize', measure);
  }, [measure]);
  useMotionValueEvent(progress, 'change', () => { frame.render(draw); });

  function returnToStart() {
    if (live && scrollYProgress.get() > .05 && stage.current) scrollTo({ top: stage.current.offsetTop, behavior: 'smooth' });
  }

  return <section ref={stage} className="g-stage" data-live={live} aria-labelledby="hero-title">
    <div className="g-stage-frame">
      <div className="g-hero-grid">
        <h1 id="hero-title" className="g-hero-title">
          <span ref={bind('code')} className="g-word g-word-code">Tu código.</span>
          <span ref={bind('web')} className="g-word g-word-web">Tu web.</span>
          <span ref={bind('tagline')} className="g-word g-word-tagline">Bajo la misma lupa.</span>
        </h1>
        <div ref={bind('lens')} className="g-hero-lens"><LensEye greet boost={boost} spin={spin} /></div>
        <div ref={bind('slab')} className="g-hero-slab"><CodeSlab /></div>
        <div ref={bind('globe')} className="g-hero-globe"><OriginGlobe spin={spin} /></div>
        <p ref={bind('lead')} className="g-hero-lead">Sube una versión de tu código o autoriza tu dominio por DNS. Gotchu reúne los hallazgos, su evidencia y lo que no pudo comprobar.</p>
        <div ref={bind('actions')} className="g-hero-actions" onFocus={returnToStart}>
          <a className="g-button" href="/dashboard" data-lens-focus>Revisar mi aplicación <UiIcon name="arrow" /></a>
          <a className="g-secondary-link" href="#codigo">Cómo funciona <UiIcon name="chevron" /></a>
        </div>
      </div>
      <div className="g-caption g-caption-two">
        <div ref={bind('two')} className="g-caption-text">
          <h2>Dos perspectivas.<br /><span>Un solo informe.</span></h2>
          <p>La instantánea de código y el origen HTTPS autorizado se evalúan por separado. Gotchu contrasta lo que ve cada una sin perder su procedencia.</p>
        </div>
      </div>
      <div className="g-caption g-caption-one">
        <div ref={bind('one')} className="g-caption-text">
          <h2>Cada hallazgo,<br /><span>con su evidencia.</span></h2>
          <p>Severidad, confianza, extractos y la herramienta que lo detectó. También lo que quedó fuera de la cobertura, para que nadie lo confunda con una garantía.</p>
        </div>
        <div ref={bind('beam')} className="g-stage-beam" aria-hidden="true" />
        <div ref={bind('report')} className="g-stage-report"><ReportSheet /></div>
      </div>
    </div>
  </section>;
}
