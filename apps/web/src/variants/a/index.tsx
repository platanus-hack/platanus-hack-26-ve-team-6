import { useEffect, useRef, useState, type ReactNode } from 'react';
import '../../styles/tokens.css';
import { DotMatrix, type PictogramName } from '../../components/dot-matrix';
import { GotchuMark } from '../../components/gotchu-mark';
import { UiIcon } from '../../components/ui';
import { DnsFigure, SnapshotFigure } from './figures';
import { MergeSection } from './merge';
import { Arrow, Reveal, useLive, type Side } from './parts';
import { SeamHandle } from './seam';
import { CodeWorld, PixelDefs, WebWorld } from './textures';
import './a.css';

const nav = [['Cómo funciona', '#va-codigo'], ['Alcance', '#va-alcance'], ['Preguntas', '#va-preguntas']] as const;

const codeFacts = ['Patrones de código riesgosos', 'Posibles secretos expuestos', 'Avisos de dependencias, si los hay'] as const;
const webFacts = ['Propiedad verificada por DNS', 'Sin cookies', 'Sin seguir redirecciones'] as const;

const terms = [
  ['Hallazgo', 'Qué es y dónde está.'],
  ['Severidad', 'De informativa a crítica.'],
  ['Confianza', 'Observada, inferida o incierta.'],
  ['Evidencia', 'El fragmento que lo demuestra.'],
  ['Cobertura', 'Lo que se revisó y lo que quedó fuera.'],
] as const;

const team: readonly { icon: PictogramName; title: string; text: string }[] = [
  { icon: 'workspace', title: 'Espacios de trabajo', text: 'Organiza tus aplicaciones en espacios de trabajo y define quién puede hacer qué mediante roles.' },
  { icon: 'history', title: 'Historial de reportes', text: 'Consulta el historial de reportes para volver a lo que se revisó y a lo que se encontró.' },
  { icon: 'json', title: 'Reporte en JSON', text: 'Descarga el reporte en JSON para trabajar con sus datos fuera de Gotchu.' },
];

const exportShape = [
  ['{', ''],
  ['  "internal"', ': { "findings": […], "coverage": […] },'],
  ['  "external"', ': { "findings": […], "coverage": […] },'],
  ['  "comparison"', ': […],'],
  ['  "limitations"', ': […],'],
  ['  "responseMode"', ': "observation",'],
  ['  "actionsPerformed"', ': []'],
  ['}', ''],
] as const;

const questions = [
  ['¿Tengo que compartir mi código?', 'No. Puedes revisar el origen HTTPS de un dominio que controles sin compartir código. Tú eliges código, web o ambas opciones.'],
  ['¿Puedo revisar cualquier sitio?', 'Solo dominios que controles. Debes demostrar la propiedad con un registro DNS TXT en _gotchu.<dominio> y dar tu consentimiento.'],
  ['¿Gotchu cambia algo en mi aplicación?', 'No. Gotchu solo observa: no modifica tu código, no aplica correcciones ni bloquea tráfico. Tampoco monitorea de forma continua ni confirma ataques.'],
  ['¿Sin hallazgos significa que estoy a salvo?', 'No. Significa que esa revisión no produjo hallazgos dentro de su alcance. Consulta la cobertura y las limitaciones: no es una garantía de seguridad.'],
] as const;

/** Tucks the header away while scrolling down and returns it on any upward scroll. */
function useHeaderTucking() {
  const [tucked, setTucked] = useState(false);
  useEffect(() => {
    let last = scrollY;
    let pending = 0;
    const update = () => {
      pending = 0;
      const y = scrollY;
      const delta = y - last;
      if (y < 48) { setTucked(false); last = y; return; }
      if (Math.abs(delta) < 6) return;
      setTucked(delta > 0 && y > 120);
      last = y;
    };
    const onScroll = () => { if (!pending) pending = requestAnimationFrame(update); };
    addEventListener('scroll', onScroll, { passive: true });
    return () => { removeEventListener('scroll', onScroll); cancelAnimationFrame(pending); };
  }, []);
  return tucked;
}

function Header() {
  const [open, setOpen] = useState(false);
  const tucked = useHeaderTucking();
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);
  const hidden = tucked && !open;
  return <header className="va-header" data-hidden={hidden || undefined} data-open={open || undefined}>
    <a className="va-brand" href="#va-top" onClick={() => setOpen(false)}><GotchuMark size={26} /><span>Gotchu</span></a>
    <nav id="va-nav" className="va-nav" aria-label="Principal">
      {nav.map(([label, href]) => <a key={href} href={href} onClick={() => setOpen(false)}>{label}</a>)}
      <a className="va-btn va-btn-small" href="/dashboard">Abrir Gotchu<Arrow /></a>
    </nav>
    <button ref={button} type="button" className="va-menu" aria-expanded={open} aria-controls="va-nav" aria-label={open ? 'Cerrar menú' : 'Abrir menú'} onClick={() => setOpen(!open)}>
      <UiIcon name={open ? 'close' : 'grid'} size={20} />
    </button>
  </header>;
}

/** A single heading whose two halves sit on the two worlds (screen readers read it as one line). */
function PairTitle({ as: Tag, id, left, right }: { as: 'h1' | 'h2'; id?: string; left: string; right: string }) {
  return <Tag className="va-pair" id={id}>
    <span className="va-half is-l"><Reveal as="span" side="l" className="va-title">{left}</Reveal></span>{' '}
    <span className="va-half is-r"><Reveal as="span" side="r" index={1} className="va-title">{right}</Reveal></span>
  </Tag>;
}

function WorldLabel({ side }: { side: Exclude<Side, 'c'> }) {
  return <Reveal side={side} className={`va-label is-${side}`}>{side === 'l' ? 'Código' : 'Web'}</Reveal>;
}

function FactList({ side, facts }: { side: Exclude<Side, 'c'>; facts: readonly string[] }) {
  return <ul className="va-facts">
    {facts.map((fact, index) => <Reveal key={fact} as="li" side={side} index={index + 2}><span className="va-pixel" aria-hidden="true" />{fact}</Reveal>)}
  </ul>;
}

function PauseIcon({ paused }: { paused: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true" focusable="false">
    {paused ? <path d="M3 1h2v12H3zM5 3h2v8H5zM7 5h2v4H7zM9 6h2v2H9z" /> : <path d="M3 1h3v12H3zM8 1h3v12H8z" />}
  </svg>;
}

function Hero() {
  const ref = useRef<HTMLElement>(null);
  const live = useLive(ref);
  const [paused, setPaused] = useState(false);
  return <section ref={ref} className="va-stage va-hero" data-live={live} data-paused={paused} aria-label="Gotchu">
    <span className="va-zone" data-va-zone aria-hidden="true" />
    <div className="va-pane is-l" aria-hidden="true"><CodeWorld stream /></div>
    <div className="va-pane is-r" aria-hidden="true"><WebWorld pulse /></div>
    <span className="va-seam" aria-hidden="true" />
    <WorldLabel side="l" />
    <WorldLabel side="r" />
    <PairTitle as="h1" left="Mira de cerca." right="Decide con pruebas." />
    <Reveal as="p" side="l" index={2} className="va-lead is-l">Revisa el código de tu app, tu web o ambos, con evidencia para entender cada hallazgo y saber por dónde seguir.</Reveal>
    <div className="va-globe-cell is-r">
      <Reveal side="r" index={3}><DotMatrix name="globe" className="va-globe" /></Reveal>
      <button className="va-pause" type="button" aria-pressed={paused} aria-label={paused ? 'Reanudar animación' : 'Pausar animación'} onClick={() => setPaused(!paused)}><PauseIcon paused={paused} /></button>
    </div>
    <div className="va-cta-seam"><a className="va-btn" href="/dashboard" data-catch>Revisar mi aplicación<Arrow /></a></div>
  </section>;
}

function Steps() {
  return <section id="va-codigo" className="va-stage va-steps">
    <span className="va-zone" data-va-zone aria-hidden="true" />
    <div className="va-pane is-l" aria-hidden="true"><CodeWorld /></div>
    <div className="va-pane is-r" aria-hidden="true"><WebWorld /></div>
    <span className="va-seam" aria-hidden="true" />
    <div className="va-cell is-l">
      <WorldLabel side="l" />
      <Reveal as="h2" side="l" index={1} className="va-h2">Sube una copia de tu código.</Reveal>
      <Reveal as="p" side="l" index={2} className="va-body">Para revisar código, sube una copia de la carpeta de tu app, etiqueta la versión y guárdala con su huella SHA-256.</Reveal>
      <Reveal side="l" index={3}><SnapshotFigure /></Reveal>
    </div>
    <div className="va-cell is-r">
      <WorldLabel side="r" />
      <Reveal as="h2" side="r" index={1} className="va-h2"><span id="va-https">Confirma que el dominio es tuyo.</span></Reveal>
      <Reveal as="p" side="r" index={2} className="va-body">Para revisar la web, publica el TXT en _gotchu.&lt;dominio&gt;, verifica la propiedad y autoriza la revisión.</Reveal>
      <Reveal side="r" index={3}><DnsFigure /></Reveal>
    </div>
  </section>;
}

function Scope() {
  return <section className="va-stage va-scope">
    <span className="va-zone" data-va-zone aria-hidden="true" />
    <div className="va-pane is-l" aria-hidden="true"><CodeWorld /></div>
    <div className="va-pane is-r" aria-hidden="true"><WebWorld /></div>
    <span className="va-seam" aria-hidden="true" />
    <div className="va-cell is-l">
      <Reveal side="l"><DotMatrix name="code" className="va-pictogram" /></Reveal>
      <Reveal as="h2" side="l" index={1} className="va-h2">Mira lo que hay en el código.</Reveal>
      <Reveal as="p" side="l" index={2} className="va-body">Sube una copia del código, ponle versión y revisa posibles riesgos sin ejecutarlo ni instalar paquetes.</Reveal>
      <FactList side="l" facts={codeFacts} />
    </div>
    <div className="va-cell is-r">
      <Reveal side="r"><DotMatrix name="globe" className="va-pictogram" /></Reveal>
      <Reveal as="h2" side="r" index={1} className="va-h2">Mira cómo responde tu web.</Reveal>
      <Reveal as="p" side="r" index={2} className="va-body">Revisa cómo responde el origen HTTPS de tu dominio, sin compartir el código fuente.</Reveal>
      <FactList side="r" facts={webFacts} />
    </div>
  </section>;
}

function Compare() {
  return <section id="va-alcance" className="va-stage va-compare" aria-labelledby="va-compare-title">
    <span className="va-zone" data-va-zone aria-hidden="true" />
    <div className="va-pane is-l" aria-hidden="true"><CodeWorld /></div>
    <div className="va-pane is-r" aria-hidden="true"><WebWorld /></div>
    <span className="va-seam" aria-hidden="true" />
    <PairTitle as="h2" id="va-compare-title" left="Dos miradas." right="Más contexto." />
    <Reveal as="p" side="l" index={2} className="va-body is-l">Revisa el código y la web juntos para distinguir qué coincide y qué aparece en una sola revisión.</Reveal>
    <Reveal as="p" side="r" index={3} className="va-pick is-r">Tú eliges dónde mirar: código, web o ambas.</Reveal>
    <div className="va-triple">
      <Reveal side="l" index={1} className="va-col is-l"><h3>Solo en el código</h3><p>Aparece solo al revisar el código.</p></Reveal>
      <Reveal side="c" index={2} className="va-col va-both"><GotchuMark size={44} /><h3>En ambas</h3><p>Aparece en las dos revisiones.</p></Reveal>
      <Reveal side="r" index={3} className="va-col is-r"><h3>Solo en la web</h3><p>Aparece solo al revisar la web.</p></Reveal>
    </div>
  </section>;
}

function Vocabulary() {
  return <section className="va-vocab" aria-label="Qué contiene cada hallazgo">
    <dl className="va-terms">
      {terms.map(([term, meaning], index) => <Reveal key={term} index={index} className="va-term"><dt>{term}</dt><dd>{meaning}</dd></Reveal>)}
    </dl>
  </section>;
}

function Team() {
  return <section className="va-team" aria-labelledby="va-team-title">
    <Reveal as="h2" className="va-h2 va-wide" ><span id="va-team-title">Que el equipo tenga contexto.</span></Reveal>
    <div className="va-team-cols">
      {team.map((item, index) => <Reveal key={item.title} index={index + 1} className="va-team-col">
        <DotMatrix name={item.icon} className="va-pictogram-sm" />
        <h3>{item.title}</h3>
        <p>{item.text}</p>
      </Reveal>)}
    </div>
    <Reveal index={2} className="va-json">
      <pre aria-label="Estructura del reporte en JSON"><code>{exportShape.map(([key, rest], index) => <span className="va-line" key={index}><span className={key.includes('"') ? 'va-key' : undefined}>{key}</span>{rest}</span>)}</code></pre>
    </Reveal>
  </section>;
}

function Faq() {
  return <section id="va-preguntas" className="va-faq" aria-labelledby="va-faq-title">
    <Reveal as="h2" className="va-h2"><span id="va-faq-title">Antes de dar el paso.</span></Reveal>
    <div className="va-faq-list">
      {questions.map(([question, answer], index) => <Reveal key={question} index={index} className="va-faq-item">
        <details>
          <summary><span>{question}</span><span className="va-plus" aria-hidden="true"><UiIcon name="plus" size={22} /></span></summary>
          <p>{answer}</p>
        </details>
      </Reveal>)}
    </div>
  </section>;
}

function Closing() {
  return <section className="va-stage va-closing" aria-labelledby="va-closing-title">
    <span className="va-zone" data-va-zone aria-hidden="true" />
    <div className="va-pane is-l" aria-hidden="true"><CodeWorld /></div>
    <div className="va-pane is-r" aria-hidden="true"><WebWorld /></div>
    <span className="va-seam" aria-hidden="true" />
    <PairTitle as="h2" id="va-closing-title" left="Dale otra mirada." right="Da el paso." />
    <div className="va-cta-seam"><a className="va-btn" href="/dashboard" data-catch>Empezar mi revisión<Arrow /></a></div>
  </section>;
}

function Footer() {
  return <footer className="va-footer">
    <div className="va-lockup"><GotchuMark size={32} /><span>Gotchu</span></div>
    <p>Tu app merece otra mirada.</p>
    <a className="va-link-quiet" href="/dashboard">Abrir Gotchu<Arrow /></a>
  </footer>;
}

/** Landing variant A, "Doble pantalla": a code world and a web world joined by a draggable seam. */
export function VariantA(): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  return <div ref={root} id="va-top" className="g-page v-a">
    <a className="va-skip" href="#contenido">Saltar al contenido</a>
    <PixelDefs />
    <Header />
    <SeamHandle rootRef={root} />
    <main id="contenido" tabIndex={-1}>
      <Hero />
      <Steps />
      <Scope />
      <Compare />
      <MergeSection />
      <Vocabulary />
      <Team />
      <Faq />
      <Closing />
    </main>
    <Footer />
  </div>;
}
