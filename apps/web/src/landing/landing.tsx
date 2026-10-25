import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRightIcon, PauseIcon, PlayIcon } from 'lucide-react';
import './landing.css';
import { GotchuMark } from '../components/gotchu-mark';
import { DotPlate } from '../components/dot-field/dot-plate';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { buttonVariants } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { QUESTIONS } from './copy';
import { Display, Mark } from './editorial';
import { Header } from './header';
import { RepoFlow, WebFlow } from './flows';

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

function RepoAudit({ motion, paused }: { motion: boolean; paused: boolean }) {
  return <Section id="gl-repo" titleId="gl-repo-titulo" title={['Audita tu', <Mark key="m" size="big">repositorio.</Mark>]}>
    <p className="gl-section-lead">Conecta GitHub y Gotchu revisa una copia de tu código sin ejecutarla.</p>
    <RepoFlow motion={motion} paused={paused} action={<Action href="/registro">Audita tu repositorio</Action>} />
  </Section>;
}

function WebAudit({ motion, paused }: { motion: boolean; paused: boolean }) {
  return <Section id="gl-web" titleId="gl-web-titulo" title={['Audita tu web', <Mark key="m" size="big">desde fuera.</Mark>]}>
    <p className="gl-section-lead">Sin acceso a tu código: solo demuestras que controlas el dominio.</p>
    <WebFlow motion={motion} paused={paused} action={<Action href="/registro">Audita tu web</Action>} />
  </Section>;
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
 * The landing: a hero, the two audits as animated diagrams, questions and the invitation to start.
 */
export function Landing() {
  const motionAllowed = useMotionAllowed();
  const [paused, setPaused] = useState(false);
  return <div className="g-page gl gl-page" data-motion={motionAllowed ? 'on' : 'off'}>
    <a className="gl-skip" href="#contenido">Saltar al contenido</a>
    <Header />
    <main id="contenido" tabIndex={-1} className="gl-main">
      <Hero paused={paused} onPause={setPaused} motion={motionAllowed} />
      <RepoAudit motion={motionAllowed} paused={paused} />
      <WebAudit motion={motionAllowed} paused={paused} />
      <Questions />
      <Closing paused={paused} />
    </main>
    <Footer />
  </div>;
}
