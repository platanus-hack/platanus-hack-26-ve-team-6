import { useEffect, useState, type ReactNode } from 'react';
import { ArrowRightIcon, PauseIcon, PlayIcon } from 'lucide-react';
import './landing.css';
import { GotchuMark } from '../components/gotchu-mark';
import { DotPlate } from '../components/dot-field/dot-plate';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Toggle } from '@/components/ui/toggle';
import { FolderPlate, VennPlate } from './ascii-plates';
import { CODE_LOOKS, DOMAIN_FACTS, DOMAIN_RECORD, GLOSSARY, QUESTIONS, REPORT_JSON, SCOPES, TEAM, VENN_LABELS, VIGILANCE_FACTS } from './copy';
import { Display, Mark, Note, Ref } from './editorial';
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

function TextLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return <a href={href} data-slot="button" className={cn(buttonVariants({ variant: 'link' }), className)}>{children}<ArrowRightIcon aria-hidden="true" /></a>;
}

/** Prose with its margin notes beside it (inline below 1100px). */
function Block({ children, notes, className = '', blockClass = '' }: { children: ReactNode; notes?: ReactNode; className?: string; blockClass?: string }) {
  return <div className={`gl-block ${blockClass}`}>
    <div className={`gl-block-main ${className}`}>{children}</div>
    {notes && <div className="gl-notes">{notes}</div>}
  </div>;
}

function Section({ id, titleId, title, children, className = '', titleClass = '' }: { id?: string; titleId: string; title: ReactNode[]; children: ReactNode; className?: string; titleClass?: string }) {
  return <section id={id} className={`gl-section ${className}`} aria-labelledby={titleId}>
    <Display id={titleId} className={`gl-section-title ${titleClass}`} lines={title} />
    {children}
  </section>;
}

function Hero({ paused, onPause, motion }: { paused: boolean; onPause: (paused: boolean) => void; motion: boolean }) {
  return <section id="gl-mirada" className="gl-hero" aria-labelledby="gl-titulo">
    <div className="gl-hero-copy">
      <Display as="h1" id="gl-titulo" eager className="gl-display--hero" lines={['Mira de cerca.', <Mark key="m" size="big" load>Decide con pruebas.</Mark>]} />
      <Block notes={<Note n={1}><strong>Tú eliges</strong> código, web o ambas.</Note>}>
        <p className="gl-lead">Revisa el código de tu app, tu web o ambos, con evidencia para entender cada hallazgo y saber por dónde seguir.<Ref n={1} /></p>
        <div className="gl-actions">
          <Action href="/dashboard" size="lg">Revisar mi aplicación</Action>
          <TextLink href="#gl-codigo">Cómo funciona</TextLink>
        </div>
      </Block>
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

function Code() {
  return <Section id="gl-codigo" titleId="gl-codigo-titulo" title={['Sube una copia', 'de tu código.']}>
    <Block className="gl-cols" notes={<><Note n={2}><strong>Huella SHA-256:</strong> identifica exactamente la copia revisada.</Note><Note n={3}><strong>La copia nunca se ejecuta.</strong> No se instalan paquetes.</Note></>}>
      <p className="gl-dropcap">Sube una instantánea de tu app, etiqueta la versión y guarda su <Mark>huella SHA-256</Mark>.<Ref n={2} /></p>
      <p>Gotchu revisa archivos JS, TS, JSON, YAML y TOML con análisis acotados. <Mark delay={120}>No ejecuta el código ni instala paquetes.</Mark><Ref n={3} /></p>
    </Block>
    <div className="gl-split">
      <FolderPlate />
      <div>
        <h3 className="gl-label">Qué busca</h3>
        <ul className="gl-rules">{CODE_LOOKS.map((item, index) => <li key={item}><span aria-hidden="true">{String.fromCharCode(97 + index)}</span>{item}</li>)}</ul>
      </div>
    </div>
  </Section>;
}

function Domain({ paused }: { paused: boolean }) {
  return <Section titleId="gl-dominio-titulo" title={['Demuestra que', <>controlas el <Mark size="big">dominio.</Mark></>]}>
    <Block notes={<Note n={4}><strong>El TXT prueba control DNS, no titularidad legal.</strong> Autoriza solo orígenes que puedes controlar.</Note>}>
      <p>Para autorizar la revisión, publica un TXT en <code className="gl-code">{DOMAIN_RECORD}</code>. Gotchu comprueba el control DNS antes de consultar el origen.<Ref n={4} /></p>
    </Block>
    <p className="gl-record"><span className="gl-sr">Registro DNS: </span>{DOMAIN_RECORD}<span aria-hidden="true">{'  '}</span><span className="gl-record-type">TXT</span></p>
    <Block notes={<Note n={5}><strong>Sin cookies, credenciales ni redirecciones.</strong> Gotchu valida el certificado y el nombre TLS.</Note>}>
      <p>Con el perfil raíz, Gotchu hace una sola petición GET a la página principal (/). Si autorizas la superficie pública, puede hacer hasta diez peticiones GET al mismo origen. No necesitas compartir tu código fuente.<Ref n={5} /></p>
    </Block>
    <div className="gl-split gl-split--globe">
      <div className="gl-globe"><DotPlate formation="globe" paused={paused} /></div>
      <ul className="gl-rules gl-rules--facts">{DOMAIN_FACTS.map(fact => <li key={fact}><span aria-hidden="true" className="gl-bullet" />{fact}</li>)}</ul>
    </div>
  </Section>;
}

function TwoLooks() {
  return <Section titleId="gl-miradas-titulo" title={['Dos miradas.', 'Más contexto.']}>
    <Block notes={<Note n={6}>La cobertura parcial o no solicitada <strong>no demuestra que falten hallazgos.</strong></Note>}>
      <p>Gotchu agrupa hallazgos por señales compartidas para comparar ambas revisiones. Un grupo común no prueba que describan el mismo fallo o despliegue.<Ref n={6} /></p>
    </Block>
    <VennPlate labels={VENN_LABELS} />
  </Section>;
}

function Evidence() {
  return <Section titleId="gl-evidencia-titulo" title={['Cada hallazgo.', <Mark key="m" size="big">Su evidencia.</Mark>]}>
    <Block notes={<Note n={7}><strong>La evidencia conserva su procedencia:</strong> fragmento, respuesta HTTP o dato de herramienta.</Note>}>
      <p>El reporte enlaza evidencia con cada hallazgo. La severidad puede quedar sin evaluar; la confianza distingue observaciones, inferencias e incertidumbre. La explotabilidad permanece desconocida: no intentamos explotar nada.<Ref n={7} /></p>
    </Block>
    <dl className="gl-glossary">
      {GLOSSARY.map(([term, definition], index) => <div className="gl-term" key={term}>
        <dt><Mark size="big" delay={index * 90}>{term}</Mark></dt>
        <span className="gl-leader" aria-hidden="true" />
        <dd>{definition}</dd>
      </div>)}
    </dl>
    <Block notes={<Note n={8}><strong>Sin hallazgos no es una garantía de seguridad.</strong></Note>}>
      <p>Sin hallazgos significa que la revisión no encontró observaciones en lo que alcanzó a revisar. Lo parcial o no solicitado no descarta riesgos; no es una garantía de seguridad.<Ref n={8} /></p>
    </Block>
  </Section>;
}

function Scope() {
  return <Section id="gl-alcance" titleId="gl-alcance-titulo" title={['Tú eliges', 'dónde mirar.']}>
    <div className="gl-scopes">
      {SCOPES.map(scope => <article className="gl-col gl-sweep-host" key={scope.name}>
        <h3 className="gl-col-name"><Mark size="big" hover>{scope.name}</Mark></h3>
        <p className="gl-col-title">{scope.title}</p>
        <p>{scope.text}</p>
        <ul className="gl-rules gl-rules--facts">{scope.facts.map(fact => <li key={fact}><span aria-hidden="true" className="gl-bullet" />{fact}</li>)}</ul>
        <div className="gl-col-action"><TextLink href="/dashboard">{scope.action}</TextLink></div>
      </article>)}
    </div>
  </Section>;
}

function Vigilance() {
  return <Section id="gl-vigilancia" titleId="gl-vigilancia-titulo" title={['Tú marcas el ritmo.', <Mark key="m" size="big">Cada 1–24 h.</Mark>]}>
    <Block notes={<Note n={9}>Las revisiones no son en tiempo real; las alertas se ven dentro de Gotchu. No hay avisos fuera y una alerta no confirma un ataque.</Note>}>
      <p>Tú eliges cada cuánto revisar. Gotchu reúne lo autorizado y los eventos firmados para dar contexto a los incidentes.<Ref n={9} /></p>
    </Block>
    <ul className="gl-rules gl-rules--facts gl-vigilance-list">
      {VIGILANCE_FACTS.map(fact => <li key={fact}><span aria-hidden="true" className="gl-bullet" />{fact}</li>)}
    </ul>
  </Section>;
}

function JsonExhibit() {
  return <figure className="gl-exhibit" aria-label="Estructura del reporte en JSON">
    <pre tabIndex={0}><code>{REPORT_JSON.map((line, index) => <span className="gl-jl" key={index}>
      <span className="gl-jn" aria-hidden="true">{index + 1}</span>
      {line.split(/("(?:[^"\\]|\\.)*"\s*:?)/).map((part, at) => part.endsWith(':') ? <span className="gl-jk" key={at}>{part}</span> : part.startsWith('"') ? <span className="gl-js" key={at}>{part}</span> : part)}
    </span>)}</code></pre>
  </figure>;
}

function Team() {
  return <Section titleId="gl-equipo-titulo" title={['Que el equipo', 'tenga contexto.']}>
    <ol className="gl-numbered">
      {TEAM.map((item, index) => <li key={item}><span aria-hidden="true">{['i', 'ii', 'iii', 'iv'][index]}</span><p>{item}</p></li>)}
    </ol>
    <Block blockClass="gl-block--exhibit" notes={<Note n={10}><strong>La copia corregida es privada.</strong> No modifica el repositorio ni producción, no se publica ni despliega y no ejecuta pruebas de comportamiento.</Note>}>
      <JsonExhibit />
    </Block>
  </Section>;
}

function Questions() {
  return <Section id="gl-preguntas" titleId="gl-preguntas-titulo" title={['Antes de', 'dar el paso.']}>
    <Accordion className="gl-qa">
      {QUESTIONS.map(([question, answer]) => <AccordionItem key={question} value={question} className="gl-qa-item">
        <AccordionTrigger className="gl-qa-trigger py-[22px]">{question}</AccordionTrigger>
        <AccordionContent className="gl-qa-answer"><p>{answer}</p></AccordionContent>
      </AccordionItem>)}
    </Accordion>
  </Section>;
}

function Closing({ paused }: { paused: boolean }) {
  return <Section titleId="gl-paso-titulo" className="gl-closing" titleClass="gl-display--closing" title={['Dale otra mirada.', <Mark key="m" size="big">Da el paso.</Mark>]}>
    <div className="gl-wordmark"><DotPlate formation="wordmark" paused={paused} /></div>
    <div className="gl-closing-actions"><Action href="/dashboard" size="lg">Empezar mi revisión</Action></div>
  </Section>;
}

function Footer() {
  return <footer className="gl-footer">
    <div className="gl-footer-in">
      <a className="gl-brand" href="#gl-mirada" aria-label="Gotchu, inicio"><GotchuMark size={32} /><span>Gotchu</span></a>
      <p>Tu app merece otra mirada.</p>
      <TextLink href="/dashboard" className="text-(--footer-fg) decoration-(--footer-fg) hover:text-(--footer-accent) hover:decoration-brand">Abrir Gotchu</TextLink>
    </div>
  </footer>;
}

/**
 * The landing: an editorial dossier (headline reveals, highlighter, margin notes, ASCII plates) with
 * living dot fields for the mark, the domain and the closing wordmark. Follows the light, dark or
 * system theme.
 */
export function Landing() {
  const motionAllowed = useMotionAllowed();
  const [paused, setPaused] = useState(false);
  return <div className="g-page gl gl-page" data-motion={motionAllowed ? 'on' : 'off'}>
    <a className="gl-skip" href="#contenido">Saltar al contenido</a>
    <Header />
    <main id="contenido" tabIndex={-1} className="gl-main">
      <Hero paused={paused} onPause={setPaused} motion={motionAllowed} />
      <Code />
      <Domain paused={paused} />
      <TwoLooks />
      <Evidence />
      <Scope />
      <Vigilance />
      <Team />
      <Questions />
      <Closing paused={paused} />
    </main>
    <Footer />
  </div>;
}
