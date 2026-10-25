import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRightIcon, PauseIcon, PlayIcon } from 'lucide-react';
import './landing.css';
import { GotchuMark } from '../components/gotchu-mark';
import { DotPlate } from '../components/dot-field/dot-plate';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { buttonVariants } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { EVIDENCE, QUESTIONS, SIDES } from './copy';
import { Display, Mark, useParallax } from './editorial';
import { Header } from './header';

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

/** A page section; with motion its headline lines and `data-depth` children move with scroll (parallax). */
function Section({ id, titleId, title, children, className = '', motion }: { id?: string; titleId: string; title: ReactNode[]; children: ReactNode; className?: string; motion: boolean }) {
  const ref = useParallax<HTMLElement>(motion);
  return <section ref={ref} id={id} className={`gl-section ${className}`} aria-labelledby={titleId}>
    <Display id={titleId} className="gl-section-title" lines={title} />
    {children}
  </section>;
}

function Hero({ paused, onPause, motion }: { paused: boolean; onPause: (paused: boolean) => void; motion: boolean }) {
  return <section id="gl-mirada" className="gl-hero" aria-labelledby="gl-titulo">
    <div className="gl-hero-copy">
      <Display as="h1" id="gl-titulo" eager className="gl-display--hero" lines={['Mira de cerca.', <Mark key="m" size="big" load>Decide con pruebas.</Mark>]} />
      <div className="gl-hero-action">
        <p className="gl-lead">Todo tu proyecto bajo la lupa: tu código por dentro y tu web por fuera.</p>
        <Action href="/registro" size="lg">Audita tu primer proyecto</Action>
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

type Motion = { motion: boolean; paused: boolean };

/** One side of the audit: its dot field (with a scan line that follows scroll) beside what you get. */
function Side({ side, motion, paused }: Motion & { side: (typeof SIDES)[number] }) {
  return <Section motion={motion} id={side.id} titleId={`${side.id}-titulo`} className="gl-side" title={[side.title, <Mark key="m" size="big">{side.mark}</Mark>]}>
    <div className="gl-split">
      <div className="gl-split-field" data-depth=""><DotPlate formation={side.formation} paused={paused} /><span className="gl-scan" aria-hidden="true" /></div>
      <div className="gl-split-copy">
        <p className="gl-section-lead">{side.lead}</p>
        <ul className="gl-benefits">
          {side.benefits.map(([title, text], index) => <li key={title} style={{ '--gl-i': index }}><strong>{title}</strong><span>{text}</span></li>)}
        </ul>
        <Action href="/registro">{side.action}</Action>
      </div>
    </div>
  </Section>;
}

function Evidence({ motion, paused }: Motion) {
  return <Section motion={motion} id="gl-evidencia" titleId="gl-evidencia-titulo" title={['Cada hallazgo.', <Mark key="m" size="big">Con su prueba.</Mark>]}>
    <div className="gl-evidence">
      <div className="gl-evidence-field" data-depth=""><DotPlate formation="report" paused={paused} /></div>
      <dl className="gl-terms">
        {EVIDENCE.map(([term, definition], index) => <div key={term}>
          <dt><Mark size="big" delay={index * 120}>{term}</Mark></dt>
          <dd>{definition}</dd>
        </div>)}
      </dl>
    </div>
  </Section>;
}

function Questions({ motion }: { motion: boolean }) {
  return <Section motion={motion} id="gl-preguntas" titleId="gl-preguntas-titulo" title={['Preguntas.']}>
    <Accordion className="gl-qa">
      {QUESTIONS.map(([question, answer]) => <AccordionItem key={question} value={question} className="gl-qa-item">
        <AccordionTrigger className="gl-qa-trigger py-[22px]">{question}</AccordionTrigger>
        <AccordionContent className="gl-qa-answer"><p>{answer}</p></AccordionContent>
      </AccordionItem>)}
    </Accordion>
  </Section>;
}

function Closing({ motion, paused }: Motion) {
  return <Section motion={motion} id="gl-cierre" titleId="gl-paso-titulo" className="gl-closing" title={['¿Qué tan seguros', 'están tus proyectos?', 'No te preocupes,', <Mark key="m" size="big">we Gotchu.</Mark>]}>
    <div className="gl-wordmark"><DotPlate formation="wordmark" paused={paused} /></div>
    <div className="gl-closing-actions">
      <Action href="/registro" size="lg">Crea tu cuenta</Action>
      <a href="/entrar" className="gl-text-link">Ya tengo cuenta</a>
    </div>
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
 * The landing: a hero, the audit from inside and outside, evidence, questions and the invitation to start.
 */
export function Landing() {
  const motionAllowed = useMotionAllowed();
  const [paused, setPaused] = useState(false);
  return <div className="g-page gl gl-page" data-motion={motionAllowed ? 'on' : 'off'}>
    <a className="gl-skip" href="#contenido">Saltar al contenido</a>
    <Header />
    <main id="contenido" tabIndex={-1} className="gl-main">
      <Hero paused={paused} onPause={setPaused} motion={motionAllowed} />
      {SIDES.map(side => <Side key={side.id} side={side} motion={motionAllowed} paused={paused} />)}
      <Evidence motion={motionAllowed} paused={paused} />
      <Questions motion={motionAllowed} />
      <Closing motion={motionAllowed} paused={paused} />
    </main>
    <Footer />
  </div>;
}
