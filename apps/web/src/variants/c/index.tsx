import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import '../../styles/tokens.css';
import './c.css';
import { AsciiMark } from '../../components/ascii-mark';
import { GotchuMark } from '../../components/gotchu-mark';
import { UiIcon } from '../../components/ui';
import { FolderPlate, GlobePlate, VennPlate } from './ascii-plates';
import { Display, Mark, Note, Ref } from './highlighter';
import { IndexRail, SECTIONS, pad, useCurrentSection } from './index-rail';

const domain = '_gotchu.<dominio>';

const lookFor = ['Patrones de código riesgosos', 'Posibles secretos expuestos', 'Avisos de dependencias, si los hay'];
const domainFacts = ['Propiedad verificada por DNS', 'Sin cookies', 'Sin seguir redirecciones', 'Sin compartir el código fuente'];
const glossary = [
  ['Hallazgo', 'Qué es y dónde está'],
  ['Severidad', 'De informativa a crítica'],
  ['Confianza', 'Observada, inferida o incierta'],
  ['Evidencia', 'El fragmento que lo demuestra'],
  ['Cobertura', 'Lo que se revisó y lo que quedó fuera'],
] as const;
const scopes = [
  { name: 'Código', title: 'Mira lo que hay en el código.', text: 'Sube una copia del código, ponle versión y revisa posibles riesgos sin ejecutarlo ni instalar paquetes.', facts: lookFor, action: 'Revisar mi código' },
  { name: 'HTTPS', title: 'Mira cómo responde tu web.', text: 'Revisa cómo responde el origen HTTPS de tu dominio, sin compartir el código fuente.', facts: ['Propiedad verificada por DNS', 'Sin cookies', 'Sin seguir redirecciones'], action: 'Revisar mi web' },
  { name: 'Ambas', title: 'Haz que las dos miradas se crucen.', text: 'Cruza las dos revisiones y distingue qué apareció en ambas, solo en el código o solo en la web.', facts: ['Comparación de hallazgos', 'Evidencia de cada revisión', 'Cobertura y límites explícitos'], action: 'Revisar ambas' },
] as const;
const team = [
  'Organiza tus aplicaciones en espacios de trabajo y define quién puede hacer qué mediante roles.',
  'Consulta el historial de reportes para volver a lo que se revisó y a lo que se encontró.',
  'Descarga el reporte en JSON para trabajar con sus datos fuera de Gotchu.',
];
const reportJson = `{
  "internal": {
    "findings": […],
    "coverage": […]
  },
  "external": {
    "findings": […],
    "coverage": […]
  },
  "comparison": […],
  "limitations": […],
  "responseMode": "observation",
  "actionsPerformed": []
}`.split('\n');
const questions = [
  ['¿Tengo que compartir mi código?', 'No. Puedes revisar el origen HTTPS de un dominio que controles sin compartir código. Tú eliges código, web o ambas opciones.'],
  ['¿Puedo revisar cualquier sitio?', 'Solo dominios que controles. Debes demostrar la propiedad con un registro DNS TXT en _gotchu.<dominio> y dar tu consentimiento.'],
  ['¿Gotchu cambia algo en mi aplicación?', 'No. Gotchu solo observa: no modifica tu código, no aplica correcciones ni bloquea tráfico. Tampoco monitorea de forma continua ni confirma ataques.'],
  ['¿Sin hallazgos significa que estoy a salvo?', 'No. Significa que esa revisión no produjo hallazgos dentro de su alcance. Consulta la cobertura y las limitaciones: no es una garantía de seguridad.'],
] as const;

/** Tucks the header away while scrolling down and returns it on any scroll up. */
function useHeaderTucking() {
  const [tucked, setTucked] = useState(false);
  useEffect(() => {
    let last = scrollY, pending = 0;
    const update = () => {
      pending = 0;
      const delta = scrollY - last;
      if (Math.abs(delta) < 8) return;
      setTucked(delta > 0 && scrollY > 160);
      last = scrollY;
    };
    const onScroll = () => { if (!pending) pending = requestAnimationFrame(update); };
    addEventListener('scroll', onScroll, { passive: true });
    return () => { removeEventListener('scroll', onScroll); cancelAnimationFrame(pending); };
  }, []);
  return tucked;
}

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

function Button({ href, children, large = false }: { href: string; children: ReactNode; large?: boolean }) {
  return <a className={`vc-btn${large ? ' vc-btn--large' : ''}`} href={href} data-catch>{children}<span className="vc-arrow"><UiIcon name="arrow" size={18} /></span></a>;
}

function Header({ tucked }: { tucked: boolean }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  return <header className={`vc-header${tucked && !open ? ' is-tucked' : ''}`} onKeyDown={event => { if (event.key === 'Escape' && open) { close(); toggle.current?.focus(); } }}>
    <div className="vc-header-in">
      <a className="vc-brand" href="#vc-mirada" aria-label="Gotchu, inicio"><GotchuMark size={28} /><span>Gotchu</span></a>
      <button ref={toggle} className="vc-menu-button" type="button" aria-expanded={open} aria-controls="vc-nav" onClick={() => setOpen(!open)}>
        <UiIcon name={open ? 'close' : 'grid'} size={18} />{open ? 'Cerrar' : 'Menú'}
      </button>
      <nav id="vc-nav" className={`vc-nav${open ? ' is-open' : ''}`} aria-label="Navegación principal">
        <a href="#vc-codigo" onClick={close}>Cómo funciona</a>
        <a href="#vc-alcance" onClick={close}>Alcance</a>
        <a href="#vc-preguntas" onClick={close}>Preguntas</a>
        <a className="vc-btn vc-btn--small" href="/dashboard">Abrir Gotchu</a>
      </nav>
    </div>
  </header>;
}

/** Big outlined section number; drifts up 40px across its section. */
function Numeral({ index, target }: { index: number; target: RefObject<HTMLElement | null> }) {
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target, offset: ['start end', 'end start'] });
  const y = useTransform(scrollYProgress, [0, 1], [0, reduced ? 0 : -40]);
  return <motion.span className="vc-numeral" style={{ y }} aria-hidden="true">{pad(index)}</motion.span>;
}

/** Prose with its margin notes beside it (inline below 1100px). */
function Block({ children, notes, className = '', stack = false }: { children: ReactNode; notes?: ReactNode; className?: string; stack?: boolean }) {
  return <div className={`vc-block${stack ? ' vc-block--stack' : ''}`}>
    <div className={`vc-block-main ${className}`}>{children}</div>
    {notes && <div className="vc-notes">{notes}</div>}
  </div>;
}

function Section({ index, titleId, title, children, className = '', titleClass = '' }: { index: number; titleId: string; title: ReactNode[]; children: ReactNode; className?: string; titleClass?: string }) {
  const ref = useRef<HTMLElement>(null);
  const section = SECTIONS[index];
  return <section ref={ref} id={section?.id} className={`vc-section ${className}`} aria-labelledby={titleId}>
    <div className="vc-section-head">
      <Numeral index={index} target={ref} />
      <div>
        <p className="vc-kicker">{pad(index)} — {section?.label}</p>
        <Display id={titleId} className={titleClass} lines={title} />
      </div>
    </div>
    {children}
  </section>;
}

function Hero() {
  const ref = useRef<HTMLElement>(null);
  return <section ref={ref} id="vc-mirada" className="vc-hero" aria-labelledby="vc-titulo">
    <div className="vc-masthead">
      <p className="vc-kicker">01 — Mirada</p>
      <p className="vc-kicker vc-masthead-scope">Código · Web (HTTPS) · Ambas</p>
    </div>
    <div className="vc-hero-title">
      <Display as="h1" id="vc-titulo" eager className="vc-display--hero" lines={['Mira de cerca.', <Mark key="m" size="big" load>Decide con pruebas.</Mark>]} />
      <div className="vc-plate-dark" aria-hidden="true"><div className="vc-plate-fill"><AsciiMark rest={0.4} /></div></div>
      <Numeral index={0} target={ref} />
    </div>
    <div className="vc-hero-grid">
      <Block stack notes={<Note n={1}><strong>Tú eliges</strong> código, web o ambas.</Note>}>
        <p className="vc-lead">Revisa el código de tu app, tu web o ambos, con evidencia para entender cada hallazgo y saber por dónde seguir.<Ref n={1} /></p>
        <div className="vc-actions">
          <Button href="/dashboard" large>Revisar mi aplicación</Button>
          <a className="vc-link" href="#vc-codigo">Cómo funciona</a>
        </div>
      </Block>
    </div>
  </section>;
}

function Code() {
  return <Section index={1} titleId="vc-codigo-titulo" title={['Sube una copia', 'de tu código.']}>
    <Block notes={<><Note n={2}><strong>Huella SHA-256:</strong> identifica exactamente la copia revisada.</Note><Note n={3}><strong>La copia nunca se ejecuta.</strong> No se instalan paquetes.</Note></>} className="vc-cols">
      <p className="vc-dropcap">Para revisar código, sube una copia de la carpeta de tu app, etiqueta la versión y guárdala con su <Mark>huella SHA-256</Mark>.<Ref n={2} /></p>
      <p>Gotchu revisa posibles riesgos <Mark delay={120}>sin ejecutarlo ni instalar paquetes</Mark>. La copia queda guardada con su versión, para saber siempre qué se revisó.<Ref n={3} /></p>
    </Block>
    <div className="vc-split">
      <FolderPlate />
      <div>
        <p className="vc-kicker">Qué busca</p>
        <ul className="vc-rules">{lookFor.map((item, index) => <li key={item}><span aria-hidden="true">{String.fromCharCode(97 + index)}</span>{item}</li>)}</ul>
      </div>
    </div>
  </Section>;
}

function Domain() {
  return <Section index={2} titleId="vc-dominio-titulo" title={['Confirma que', <>el dominio es <Mark size="big">tuyo.</Mark></>]}>
    <Block notes={<Note n={4}><strong>Solo dominios que controles.</strong> Debes demostrar la propiedad con un registro DNS TXT y dar tu consentimiento.</Note>}>
      <p>Para revisar la web, publica el TXT en <code className="vc-code">{domain}</code>, verifica la propiedad y autoriza la revisión.<Ref n={4} /></p>
    </Block>
    <p className="vc-record"><span className="vc-sr">Registro DNS: </span>{domain}<span aria-hidden="true">{'  '}</span><span className="vc-record-type">TXT</span></p>
    <Block notes={<Note n={5}><strong>Sin cookies.</strong> Sin seguir redirecciones.</Note>}>
      <p>Después, Gotchu revisa cómo responde el origen HTTPS de tu dominio, sin compartir el código fuente.<Ref n={5} /></p>
    </Block>
    <div className="vc-split vc-split--globe">
      <GlobePlate />
      <ul className="vc-rules vc-rules--facts">{domainFacts.map(fact => <li key={fact}><span aria-hidden="true" className="vc-bullet" />{fact}</li>)}</ul>
    </div>
  </Section>;
}

function TwoLooks() {
  return <Section index={3} titleId="vc-miradas-titulo" title={['Dos miradas.', 'Más contexto.']}>
    <Block notes={<Note n={6}>Si revisas código y web, el reporte incluye <strong>sus coincidencias y diferencias.</strong></Note>}>
      <p>Revisa el código y la web juntos para distinguir qué coincide y qué aparece en una sola revisión.<Ref n={6} /></p>
    </Block>
    <VennPlate />
  </Section>;
}

function Evidence() {
  return <Section index={4} titleId="vc-evidencia-titulo" title={['Cada hallazgo.', <Mark key="m" size="big">Su evidencia.</Mark>]}>
    <Block notes={<Note n={7}><strong>Evidencia:</strong> el fragmento, la herramienta o un checksum.</Note>}>
      <p>Cada hallazgo indica gravedad y confianza, con evidencia; el reporte aclara qué se revisó, qué quedó fuera y sus límites.<Ref n={7} /></p>
    </Block>
    <dl className="vc-glossary">
      {glossary.map(([term, definition], index) => <div className="vc-term" key={term}>
        <dt><Mark size="big" delay={index * 90}>{term}</Mark></dt>
        <span className="vc-leader" aria-hidden="true" />
        <dd>{definition}</dd>
      </div>)}
    </dl>
    <Block notes={<Note n={8}><strong>Sin hallazgos no es una garantía de seguridad.</strong></Note>}>
      <p>Sin hallazgos significa que esa revisión no produjo hallazgos dentro de su alcance. Consulta la cobertura y las limitaciones.<Ref n={8} /></p>
    </Block>
  </Section>;
}

function Scope() {
  return <Section index={5} titleId="vc-alcance-titulo" title={['Tú eliges', 'dónde mirar.']}>
    <div className="vc-scopes">
      {scopes.map(scope => <article className="vc-col vc-sweep-host" key={scope.name}>
        <h3 className="vc-col-name"><Mark size="big" hover>{scope.name}</Mark></h3>
        <p className="vc-col-title">{scope.title}</p>
        <p>{scope.text}</p>
        <ul className="vc-rules vc-rules--facts">{scope.facts.map(fact => <li key={fact}><span aria-hidden="true" className="vc-bullet" />{fact}</li>)}</ul>
        <a className="vc-link" href="/dashboard">{scope.action}<span className="vc-arrow"><UiIcon name="arrow" size={16} /></span></a>
      </article>)}
    </div>
  </Section>;
}

function JsonExhibit() {
  return <figure className="vc-exhibit" aria-label="Estructura del reporte en JSON">
    <pre><code>{reportJson.map((line, index) => <span className="vc-jl" key={index}>
      <span className="vc-jn" aria-hidden="true">{index + 1}</span>
      {line.split(/("(?:[^"\\]|\\.)*"\s*:?)/).map((part, at) => part.endsWith(':') ? <span className="vc-jk" key={at}>{part}</span> : part.startsWith('"') ? <span className="vc-js" key={at}>{part}</span> : part)}
    </span>)}</code></pre>
  </figure>;
}

function Team() {
  return <Section index={6} titleId="vc-equipo-titulo" title={['Que el equipo', 'tenga contexto.']}>
    <ol className="vc-numbered">
      {team.map((item, index) => <li key={item}><span aria-hidden="true">{['i', 'ii', 'iii'][index]}</span><p>{item}</p></li>)}
    </ol>
    <Block notes={<Note n={9}><strong>Gotchu solo observa:</strong> no cambia tu código ni aplica correcciones.</Note>}>
      <JsonExhibit />
    </Block>
  </Section>;
}

function Questions() {
  return <Section index={7} titleId="vc-preguntas-titulo" title={['Antes de', 'dar el paso.']}>
    <div className="vc-qa">
      {questions.map(([question, answer], index) => <div className="vc-qa-item" key={question}>
        <span className="vc-qa-n" aria-hidden="true">{pad(index)}</span>
        <h3>{question}</h3>
        <p>{answer}</p>
      </div>)}
    </div>
  </Section>;
}

function Closing() {
  return <Section index={8} titleId="vc-paso-titulo" className="vc-closing" titleClass="vc-display--closing" title={['Dale otra mirada.', <Mark key="m" size="big">Da el paso.</Mark>]}>
    <div className="vc-closing-actions"><Button href="/dashboard" large>Empezar mi revisión</Button></div>
  </Section>;
}

function Footer() {
  return <footer className="vc-footer">
    <div className="vc-footer-in">
      <a className="vc-brand" href="#vc-mirada" aria-label="Gotchu, inicio"><GotchuMark size={36} /><span>Gotchu</span></a>
      <p>Tu app merece otra mirada.</p>
      <a className="vc-link" href="/dashboard">Abrir Gotchu<span className="vc-arrow"><UiIcon name="arrow" size={16} /></span></a>
    </div>
  </footer>;
}

/** Landing variant C, "Expediente": a light editorial dossier with a sticky index, margin notes and a highlighter. */
export function VariantC() {
  const tucked = useHeaderTucking();
  const motionAllowed = useMotionAllowed();
  const current = useCurrentSection();
  const { scrollYProgress } = useScroll();
  return <div className="g-page v-c" data-motion={motionAllowed ? 'on' : 'off'} data-tucked={tucked}>
    <a className="vc-skip" href="#contenido">Saltar al contenido</a>
    <Header tucked={tucked} />
    <div className="vc-shell">
      <IndexRail current={current} progress={scrollYProgress} />
      <main id="contenido" tabIndex={-1}>
        <Hero />
        <Code />
        <Domain />
        <TwoLooks />
        <Evidence />
        <Scope />
        <Team />
        <Questions />
        <Closing />
      </main>
    </div>
    <Footer />
  </div>;
}
