import { useRef, useState, type KeyboardEvent } from 'react';
import { UiIcon } from './ui';
import { Hero } from './hero';
import { Convergence } from './convergence';
import { BlueprintGrid } from './blueprint-grid';
import { DotMatrix } from './dot-matrix';
import { GotchuMark } from './gotchu-mark';
import { ProductFlow, useChapterTracking } from './product-flow';
import './landing.css';

const perspectives = [
  { id: 'code', label: 'Código', title: 'Mira lo que hay en el código.', description: 'Sube una copia del código, ponle versión y revisa posibles riesgos sin ejecutarlo ni instalar paquetes.', facts: ['Patrones de código riesgosos', 'Posibles secretos expuestos', 'Avisos de dependencias, si los hay'], icon: 'code', pictogram: 'code' },
  { id: 'https', label: 'HTTPS', title: 'Mira cómo responde tu web.', description: 'Revisa cómo responde el origen HTTPS de tu dominio, sin compartir el código fuente.', facts: ['Propiedad verificada por DNS', 'Sin cookies', 'Sin seguir redirecciones'], icon: 'globe', pictogram: 'globe' },
  { id: 'both', label: 'Ambas', title: 'Haz que las dos miradas se crucen.', description: 'Cruza las dos revisiones y distingue qué apareció en ambas, solo en el código o solo en la web.', facts: ['Comparación de hallazgos', 'Evidencia de cada revisión', 'Cobertura y límites explícitos'], icon: 'report', pictogram: 'mark' },
] as const;
const chapters = [
  { title: 'Sube una copia de tu código.', text: 'Para revisar código, sube una copia de la carpeta de tu app, etiqueta la versión y guárdala con su huella SHA-256.', id: 'codigo' },
  { title: 'Confirma que el dominio es tuyo.', text: 'Para revisar la web, publica el TXT en _gotchu.<dominio>, verifica la propiedad y autoriza la revisión.', id: 'https' },
  { title: 'Llévate todo por escrito.', text: 'Consulta la cobertura, los límites y, si revisaste código y web, sus coincidencias y diferencias; descarga el reporte en JSON.', id: 'evidencia' },
];
const questions = [
  ['¿Tengo que compartir mi código?', 'No. Puedes revisar el origen HTTPS de un dominio que controles sin compartir código. Tú eliges código, web o ambas opciones.'],
  ['¿Puedo revisar cualquier sitio?', 'Solo dominios que controles. Debes demostrar la propiedad con un registro DNS TXT en _gotchu.<dominio> y dar tu consentimiento.'],
  ['¿Gotchu cambia algo en mi aplicación?', 'No. Gotchu solo observa: no modifica tu código, no aplica correcciones ni bloquea tráfico. Tampoco monitorea de forma continua ni confirma ataques.'],
  ['¿Sin hallazgos significa que estoy a salvo?', 'No. Significa que esa revisión no produjo hallazgos dentro de su alcance. Consulta la cobertura y las limitaciones: no es una garantía de seguridad.'],
];
const exportShape = [
  ['{', ''],
  ['  "internal": ', '{ "findings": […], "coverage": […] },'],
  ['  "external": ', '{ "findings": […], "coverage": […] },'],
  ['  "comparison": ', '[…],'],
  ['  "limitations": ', '[…],'],
  ['  "responseMode": ', '"observation",'],
  ['  "actionsPerformed": ', '[]'],
  ['}', ''],
] as const;

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [perspective, setPerspective] = useState(0);
  const [keyboardSelection, setKeyboardSelection] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const { container, active } = useChapterTracking();
  const current = perspectives[perspective] ?? perspectives[0];
  function tabKeys(event: KeyboardEvent<HTMLButtonElement>) {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!delta && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? perspectives.length - 1 : (perspective + delta + perspectives.length) % perspectives.length;
    setKeyboardSelection(true); setPerspective(next); tabs.current[next]?.focus();
  }
  function closeMenu() { setMenuOpen(false); }
  return <div className="g-page">
    <a className="g-skip" href="#contenido">Saltar al contenido</a>
    <header className="g-header">
      <div className="g-nav-shell">
        <a className="g-brand" href="/" aria-label="Gotchu, inicio"><GotchuMark size={30} /><span>Gotchu</span></a>
        <button ref={menuButton} className="g-menu-button" type="button" aria-expanded={menuOpen} aria-controls="gotchu-nav" onKeyDown={event => { if (event.key === 'Escape') closeMenu(); }} onClick={() => setMenuOpen(!menuOpen)}><UiIcon name={menuOpen ? 'close' : 'grid'} />{menuOpen ? 'Cerrar' : 'Menú'}</button>
        <nav id="gotchu-nav" className={menuOpen ? 'g-nav is-open' : 'g-nav'} aria-label="Navegación principal" onKeyDown={event => { if (event.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus(); } }}>
          <a href="#codigo" onClick={closeMenu}><span className="g-nav-number" aria-hidden="true">01 /</span>Cómo funciona</a><a href="#perspectivas" onClick={closeMenu}><span className="g-nav-number" aria-hidden="true">02 /</span>Alcance</a><a href="#preguntas" onClick={closeMenu}><span className="g-nav-number" aria-hidden="true">03 /</span>Preguntas</a>
          <a className="g-button g-button-small" href="/dashboard" data-catch>Abrir Gotchu <UiIcon name="arrow" /></a>
        </nav>
      </div>
    </header>
    <main id="contenido" tabIndex={-1}>
      <Hero />
      <Convergence />
      <section ref={container} className="g-journey" aria-label="Cómo entra cada perspectiva">
        <BlueprintGrid />
        <div className="g-journey-inner g-container">
          <div className="g-journey-visual"><ProductFlow step={active} /><div className="g-chapter-marker" aria-hidden="true">{chapters.map((chapter, index) => <span key={chapter.id} className={active === index ? 'is-current' : active > index ? 'is-done' : ''}><span /></span>)}</div></div>
          <div className="g-chapters">{chapters.map((chapter, index) => <article key={chapter.id} id={chapter.id} data-chapter={index} className={active === index ? 'is-current' : ''}><h2>{chapter.title}</h2><p>{chapter.text}</p><ProductFlow step={index} className="g-mobile-flow" /></article>)}</div>
        </div>
      </section>
      <section id="perspectivas" className="g-perspectives g-card g-card-silver" aria-labelledby="perspectives-title">
        <div className="g-perspectives-heading"><h2 id="perspectives-title">Tú eliges dónde mirar.</h2><p>Código, HTTPS o las dos miradas juntas.</p></div>
        <div className="g-perspective-controls" role="tablist" aria-label="Perspectiva de evaluación">
          <span className="g-tab-indicator" aria-hidden="true" style={{ transform: `translateX(${perspective * 100}%)` }} />
          {perspectives.map((item, index) => <button id={`tab-${item.id}`} key={item.id} ref={element => { tabs.current[index] = element; }} role="tab" type="button" aria-controls={`panel-${item.id}`} aria-selected={perspective === index} tabIndex={perspective === index ? 0 : -1} onClick={() => { setKeyboardSelection(false); setPerspective(index); }} onKeyDown={tabKeys}><UiIcon name={item.icon} size={20} />{item.label}</button>)}
        </div>
        <div className="g-perspective-layout">
          <div className="g-perspective-panels" data-keyboard={keyboardSelection}>{perspectives.map((item, index) => <div key={item.id} role="tabpanel" id={`panel-${item.id}`} aria-labelledby={`tab-${item.id}`} hidden={perspective !== index} tabIndex={0} className="g-perspective-panel"><h3>{item.title}</h3><p>{item.description}</p><ul>{item.facts.map(fact => <li key={fact}><span aria-hidden="true" />{fact}</li>)}</ul><a className="g-secondary-link" href="/dashboard">Probar con mi app <UiIcon name="arrow" /></a></div>)}</div>
          <div className="g-scope-stage g-card g-card-ink" aria-hidden="true"><DotMatrix name={current.pictogram} /></div>
        </div>
      </section>
      <section className="g-workflow g-container" aria-labelledby="workflow-title">
        <h2 id="workflow-title">Que el equipo tenga contexto.</h2>
        <div className="g-workflow-grid">
          <article className="g-card g-card-ink g-workflow-wide"><DotMatrix name="workspace" /><div><h3>Un espacio para cada equipo</h3><p>Organiza tus aplicaciones en espacios de trabajo y define quién puede hacer qué mediante roles.</p></div></article>
          <article className="g-card g-card-magenta g-workflow-history"><DotMatrix name="history" /><div><h3>Cada revisión, en su lugar</h3><p>Consulta el historial de reportes para volver a lo que se revisó y a lo que se encontró.</p></div></article>
          <article className="g-card g-card-ink g-workflow-export">
            <div><DotMatrix name="json" /><h3>Llévate los datos contigo</h3><p>Descarga el reporte en JSON para trabajar con sus datos fuera de Gotchu.</p><a className="g-secondary-link" href="/dashboard">Ir a mis aplicaciones <UiIcon name="arrow" /></a></div>
            <figure className="g-export" aria-label="Estructura del informe exportado">
              <figcaption className="g-tag">informe.json</figcaption>
              <pre tabIndex={0}><code>{exportShape.map(([key, value], index) => <span key={index}><i>{index + 1}</i>{key.includes('"') ? <><b>{key}</b>{value}</> : key}</span>)}</code></pre>
            </figure>
          </article>
        </div>
      </section>
      <section id="preguntas" className="g-faq g-container" aria-labelledby="faq-title"><h2 id="faq-title">Antes de dar el paso.</h2><div>{questions.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true"><UiIcon name="plus" /></span></summary><p>{answer}</p></details>)}</div></section>
      <section className="g-closing g-card g-card-magenta" aria-labelledby="closing-title">
        <div className="g-closing-radar" aria-hidden="true"><span /><span /><span /><span /><GotchuMark size={0} /></div>
        <h2 id="closing-title">Dale otra mirada.<br /><span>Da el paso.</span></h2>
        <a className="g-button g-button-ink" href="/dashboard" data-catch>Empezar mi revisión <UiIcon name="arrow" /></a>
      </section>
    </main>
    <footer className="g-footer">
      <a href="#contenido" aria-label="Gotchu, volver al inicio" className="g-footer-wordmark">Gotchu<GotchuMark size={0} /></a>
      <div className="g-footer-row"><p className="g-lockup"><GotchuMark size={26} />Tu app merece otra mirada.</p><a href="/dashboard">Abrir Gotchu <UiIcon name="arrow" /></a></div>
    </footer>
  </div>;
}
