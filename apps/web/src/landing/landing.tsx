import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRightIcon, PauseIcon, PlayIcon } from 'lucide-react';
import './landing.css';
import { GotchuMark } from '../components/gotchu-mark';
import { DotPlate } from '../components/dot-field/dot-plate';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { buttonVariants } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { FolderPlate, LensPlate, ReportPlate } from './ascii-plates';
import { HOW_STEPS, QUESTIONS, REPORT_JSON } from './copy';
import { Display, Mark } from './editorial';
import { Header } from './header';
import { FixTrack, IntervalDay, ReviewMatrix } from './walkthrough';

/** True when motion is welcome; resolved after mount so server and first client render agree. */
function useMotionAllowed() {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setAllowed(!query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return allowed;
}

// Navigation stays a real link styled as a shadcn button; Base UI's Button would announce it as a button.

/** Primary path into the product. `data-catch` pulls the dot fields toward their finding while hovered. */
function Action({ href, children, size = 'default' }: { href: string; children: ReactNode; size?: 'default' | 'lg' }) {
  return <a href={href} data-slot="button" data-catch="" className={buttonVariants({ size })}>
    {children}<ArrowRightIcon aria-hidden="true" />
  </a>;
}

function Section({ id, titleId, title, children, className = '' }: { id?: string; titleId: string; title: ReactNode[]; children: ReactNode; className?: string }) {
  return <section id={id} className={`gl-section ${className}`} aria-labelledby={titleId}>
    <Display id={titleId} className="gl-section-title" lines={title} />
    {children}
  </section>;
}

function Hero({ paused, onPause, motion }: { paused: boolean; onPause: (paused: boolean) => void; motion: boolean }) {
  return <section id="gl-mirada" className="gl-hero" aria-labelledby="gl-titulo">
    <div className="gl-hero-copy">
      <Display as="h1" id="gl-titulo" eager className="gl-display--hero" lines={['Mira de cerca.', <Mark key="m" size="big" load>Decide con pruebas.</Mark>]} />
      <div className="gl-hero-action">
        <p className="gl-lead">Sube código o verifica un dominio con DNS TXT.</p>
        <Action href="/dashboard" size="lg">Revisar una app</Action>
      </div>
    </div>
    <div className="gl-hero-field">
      <DotPlate formation="mark" paused={paused} />
      {motion && <Toggle
        className="gl-pause bg-background"
        variant="outline"
        size="default"
        pressed={paused}
        onPressedChange={onPause}
        aria-label={paused ? 'Reanudar animación' : 'Pausar animación'}>
        {paused ? <PlayIcon aria-hidden="true" className="size-3" /> : <PauseIcon aria-hidden="true" className="size-3" />}
      </Toggle>}
    </div>
  </section>;
}

const STEP_PLATES = [FolderPlate, LensPlate, ReportPlate];

function HowItWorks() {
  return <Section id="gl-funciona" titleId="gl-funciona-titulo" title={['Cómo funciona.']}>
    <ol className="gl-steps">
      {HOW_STEPS.map(([title, detail], index) => {
        const Plate = STEP_PLATES[index] ?? FolderPlate;
        return <li key={title}>
          <span className="gl-step-number" aria-hidden="true">0{index + 1}</span>
          <div><h3>{title}</h3><p>{detail}</p></div>
          <div className="gl-step-plate"><Plate /></div>
        </li>;
      })}
    </ol>
  </Section>;
}

function Reviews() {
  return <Section id="gl-revisiones" titleId="gl-revisiones-titulo" title={['Seis revisiones.', <Mark key="m" size="big">Un informe.</Mark>]}>
    <ReviewMatrix />
  </Section>;
}

function Fixes() {
  return <Section id="gl-correccion" titleId="gl-correccion-titulo" title={['Corrige con', <Mark key="m" size="big">tu aprobación.</Mark>]}>
    <p className="gl-section-lead">Para algunos hallazgos, Gotchu prepara la corrección y la vuelve a analizar antes de pedirte permiso.</p>
    <FixTrack />
  </Section>;
}

function Evidence() {
  return <Section id="gl-informe" titleId="gl-informe-titulo" className="gl-report-section" title={['Cada hallazgo.', <Mark key="m" size="big">Su evidencia.</Mark>]}>
    <div className="gl-report-copy"><p>El informe muestra confianza y cobertura.</p><JsonExhibit /></div>
  </Section>;
}

function Vigilance() {
  return <Section id="gl-vigilancia" titleId="gl-vigilancia-titulo" className="gl-vigilance-section" title={['Programa evaluaciones', <Mark key="m" size="big">cada 1–24 h.</Mark>]}>
    <div className="gl-vigilance-body">
      <p className="gl-vigilance-copy">No son evaluaciones en tiempo real.</p>
      <IntervalDay />
    </div>
  </Section>;
}

function JsonExhibit() {
  return <figure className="gl-exhibit" aria-label="Estructura del reporte en JSON">
    <pre tabIndex={0}><code>{REPORT_JSON.map((line, index) => <span className="gl-jl" key={index}>
      {line.split(/("(?:[^"\\]|\\.)*"\s*:?)/).map((part, at) => part.endsWith(':') ? <span className="gl-jk" key={at}>{part}</span> : part.startsWith('"') ? <span className="gl-js" key={at}>{part}</span> : part)}
    </span>)}</code></pre>
  </figure>;
}

function Questions() {
  return <Section id="gl-preguntas" titleId="gl-preguntas-titulo" title={['Preguntas.']}>
    <Accordion className="gl-qa">
      {QUESTIONS.map(([question, answer]) => <AccordionItem key={question} value={question} className="gl-qa-item">
        <AccordionTrigger className="gl-qa-trigger py-[22px]">{question}</AccordionTrigger>
        <AccordionContent className="gl-qa-answer"><p>{answer}</p></AccordionContent>
      </AccordionItem>)}
    </Accordion>
  </Section>;
}

function Closing({ paused }: { paused: boolean }) {
  return <Section id="gl-cierre" titleId="gl-paso-titulo" className="gl-closing" title={['¿Qué tan seguros', 'están tus proyectos?', 'No te preocupes,', <Mark key="m" size="big">we Gotchu.</Mark>]}>
    <div className="gl-wordmark"><DotPlate formation="wordmark" paused={paused} /></div>
    <div className="gl-closing-actions"><Action href="/dashboard" size="lg">Revisa tu primer proyecto</Action></div>
  </Section>;
}

function Footer() {
  return <footer className="gl-footer">
    <div className="gl-footer-in">
      <a className="gl-brand" href="#gl-mirada" aria-label="Gotchu, inicio"><GotchuMark size={32} /><span>Gotchu</span></a>
      <a href="/dashboard" className="gl-footer-login">Entrar</a>
    </div>
  </footer>;
}

/**
 * The landing uses short product steps and report evidence alongside authored visual plates.
 */
export function Landing() {
  const motionAllowed = useMotionAllowed();
  const [paused, setPaused] = useState(false);
  return <div className="g-page gl gl-page" data-motion={motionAllowed ? 'on' : 'off'}>
    <a className="gl-skip" href="#contenido">Saltar al contenido</a>
    <Header />
    <main id="contenido" tabIndex={-1} className="gl-main">
      <Hero paused={paused} onPause={setPaused} motion={motionAllowed} />
      <HowItWorks />
      <Reviews />
      <Evidence />
      <Fixes />
      <Vigilance />
      <Questions />
      <Closing paused={paused} />
    </main>
    <Footer />
  </div>;
}
