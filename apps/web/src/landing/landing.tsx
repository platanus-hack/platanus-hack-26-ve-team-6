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
        <p className="gl-lead">Sube código o verifica un dominio con DNS TXT.</p>
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

/** The core promise: one field shows code (inside) and the web (outside); each side's column sits under its half. */
function BothSides({ motion, paused }: Motion) {
  return <Section motion={motion} id="gl-auditoria" titleId="gl-auditoria-titulo" title={['Te auditamos', <Mark key="m" size="big">por los dos lados.</Mark>]}>
    <p className="gl-section-lead">Revisamos tu código por dentro y tu web por fuera, y comparamos lo que ve cada lado.</p>
    <div className="gl-both-field" data-depth=""><DotPlate formation="both" paused={paused} /></div>
    <div className="gl-sides">
      {SIDES.map(side => <article key={side.id} id={side.id} className="gl-side" aria-labelledby={`${side.id}-titulo`}>
        <h3 id={`${side.id}-titulo`} className="gl-side-name">{side.name}</h3>
        <p>{side.text}</p>
        <ul className="gl-side-tags">{side.tags.map(tag => <li key={tag}>{tag}</li>)}</ul>
        <Action href="/registro">{side.action}</Action>
      </article>)}
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
 * The landing: a hero, the audit from both sides, evidence, questions and the invitation to start.
 */
export function Landing() {
  const motionAllowed = useMotionAllowed();
  const [paused, setPaused] = useState(false);
  return <div className="g-page gl gl-page" data-motion={motionAllowed ? 'on' : 'off'}>
    <a className="gl-skip" href="#contenido">Saltar al contenido</a>
    <Header />
    <main id="contenido" tabIndex={-1} className="gl-main">
      <Hero paused={paused} onPause={setPaused} motion={motionAllowed} />
      <BothSides motion={motionAllowed} paused={paused} />
      <Evidence motion={motionAllowed} paused={paused} />
      <Questions motion={motionAllowed} />
      <Closing motion={motionAllowed} paused={paused} />
    </main>
    <Footer />
  </div>;
}
