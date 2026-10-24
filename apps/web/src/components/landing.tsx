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
  { id: 'code', label: 'Código', title: 'Lo que está en tu código.', description: 'Revisa una instantánea de tu aplicación sin ejecutarla. Conserva la versión analizada y la evidencia de cada hallazgo.', facts: ['Patrones de código y posibles secretos', 'Avisos de dependencias cuando están disponibles', 'Revisión y huella de los archivos analizados'], icon: 'code', pictogram: 'code' },
  { id: 'https', label: 'HTTPS', title: 'Lo que responde tu aplicación.', description: 'Revisa la respuesta HTTPS de un origen que controlas, sin cookies ni redirecciones. Puedes empezar sin compartir el código fuente.', facts: ['Autorización mediante DNS', 'Evaluación sin acceso al código', 'Cobertura y límites por comprobación'], icon: 'globe', pictogram: 'globe' },
  { id: 'both', label: 'Ambas', title: 'Coincidencias y diferencias, lado a lado.', description: 'Contrasta las señales de la instantánea con las del origen autorizado. Identifica coincidencias y diferencias sin perder su procedencia.', facts: ['Evaluación interna y externa', 'Comparación de hallazgos', 'Evidencia de cada perspectiva'], icon: 'report', pictogram: 'mark' },
] as const;
const chapters = [
  { title: 'Sube tu código. Nada se ejecuta.', text: 'Arrastra una carpeta y ponle nombre a la versión. Gotchu la guarda con su huella y busca patrones de riesgo, posibles secretos y dependencias con avisos conocidos, sin ejecutar una sola línea.', id: 'codigo' },
  { title: 'Tu dominio. Tu permiso.', text: 'Demuestra que el dominio es tuyo con un registro DNS y Gotchu revisa lo que tu web responde. Para esto no necesitas compartir tu código.', id: 'https' },
  { title: 'Todo queda por escrito.', text: 'Mira qué se revisó y qué no, compara lo que encontró cada mirada y llévate el informe completo en JSON.', id: 'evidencia' },
];
const questions = [
  ['¿Tengo que compartir mi código?', 'No. Puedes evaluar únicamente un origen HTTPS autorizado. Para el análisis interno, cargas una instantánea del código que quieres revisar.'],
  ['¿Puedo evaluar cualquier sitio?', 'Solo un origen que tengas autorización para evaluar. Gotchu verifica el control mediante un registro DNS y requiere tu consentimiento antes de iniciar la evaluación.'],
  ['¿Gotchu aplica cambios por mí?', 'No. La evaluación conserva observaciones y evidencia. Tu equipo decide y aplica los cambios; el análisis no ejecuta ni modifica el código recibido.'],
  ['¿Qué significa un resultado sin hallazgos?', 'Que no se encontraron hallazgos dentro del alcance y las capacidades utilizadas. El informe también conserva lo que no se pudo comprobar; no equivale a una garantía de seguridad.'],
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
        <div className="g-perspectives-heading"><h2 id="perspectives-title">Empieza donde lo necesitas.</h2><p>Una aplicación. Tres formas de revisarla. Tú eliges el alcance.</p></div>
        <div className="g-perspective-controls" role="tablist" aria-label="Perspectiva de evaluación">
          <span className="g-tab-indicator" aria-hidden="true" style={{ transform: `translateX(${perspective * 100}%)` }} />
          {perspectives.map((item, index) => <button id={`tab-${item.id}`} key={item.id} ref={element => { tabs.current[index] = element; }} role="tab" type="button" aria-controls={`panel-${item.id}`} aria-selected={perspective === index} tabIndex={perspective === index ? 0 : -1} onClick={() => { setKeyboardSelection(false); setPerspective(index); }} onKeyDown={tabKeys}><UiIcon name={item.icon} size={20} />{item.label}</button>)}
        </div>
        <div className="g-perspective-layout">
          <div className="g-perspective-panels" data-keyboard={keyboardSelection}>{perspectives.map((item, index) => <div key={item.id} role="tabpanel" id={`panel-${item.id}`} aria-labelledby={`tab-${item.id}`} hidden={perspective !== index} tabIndex={0} className="g-perspective-panel"><h3>{item.title}</h3><p>{item.description}</p><ul>{item.facts.map(fact => <li key={fact}><span aria-hidden="true" />{fact}</li>)}</ul><a className="g-secondary-link" href="/dashboard">Abrir Gotchu <UiIcon name="arrow" /></a></div>)}</div>
          <div className="g-scope-stage g-card g-card-ink" aria-hidden="true"><DotMatrix name={current.pictogram} /><p className="g-tag">[ {current.label} ]</p></div>
        </div>
      </section>
      <section className="g-workflow g-container" aria-labelledby="workflow-title">
        <h2 id="workflow-title">Cada revisión, en su sitio.</h2>
        <div className="g-workflow-grid">
          <article className="g-card g-card-ink g-workflow-wide"><DotMatrix name="workspace" /><div><h3>Espacios y aplicaciones</h3><p>Organiza tus aplicaciones por espacio de trabajo y conserva los permisos de cada rol.</p></div></article>
          <article className="g-card g-card-magenta g-workflow-history"><DotMatrix name="history" /><div><h3>Historial de evaluaciones</h3><p>Sigue los trabajos en cola o en curso y vuelve a consultar los informes guardados.</p></div></article>
          <article className="g-card g-card-ink g-workflow-export">
            <div><DotMatrix name="json" /><h3>Exportación JSON</h3><p>Descarga el informe completo con sus hallazgos, evidencia, cobertura y limitaciones.</p><a className="g-secondary-link" href="/dashboard">Ir a mis aplicaciones <UiIcon name="arrow" /></a></div>
            <figure className="g-export" aria-label="Estructura del informe exportado">
              <figcaption className="g-tag">[ informe.json ]</figcaption>
              <pre tabIndex={0}><code>{exportShape.map(([key, value], index) => <span key={index}><i>{index + 1}</i>{key.includes('"') ? <><b>{key}</b>{value}</> : key}</span>)}</code></pre>
            </figure>
          </article>
        </div>
      </section>
      <section id="preguntas" className="g-faq g-container" aria-labelledby="faq-title"><h2 id="faq-title">Antes de dar el paso.</h2><div>{questions.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true"><UiIcon name="plus" /></span></summary><p>{answer}</p></details>)}</div></section>
      <section className="g-closing g-card g-card-magenta" aria-labelledby="closing-title">
        <div className="g-closing-radar" aria-hidden="true"><span /><span /><span /><span /><GotchuMark size={0} /></div>
        <h2 id="closing-title">La próxima decisión.<br /><span>Con la evidencia a{'\u00a0'}mano.</span></h2>
        <a className="g-button g-button-ink" href="/dashboard" data-catch>Empezar mi revisión <UiIcon name="arrow" /></a>
      </section>
    </main>
    <footer className="g-footer">
      <a href="#contenido" aria-label="Gotchu, volver al inicio" className="g-footer-wordmark">Gotchu<GotchuMark size={0} /></a>
      <div className="g-footer-row"><p className="g-lockup"><GotchuMark size={26} />Revisa lo que importa</p><p className="g-tag">[ Código · HTTPS · Evidencia ]</p><a href="/dashboard">Abrir Gotchu <UiIcon name="arrow" /></a></div>
    </footer>
  </div>;
}
