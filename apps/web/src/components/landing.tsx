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
  { id: 'code', label: 'Código', title: 'Lo que vive en tu código.', description: 'Revisamos una copia de tu aplicación sin ejecutarla. Cada hallazgo apunta a la versión exacta que subiste.', facts: ['Patrones de riesgo y posibles secretos', 'Dependencias con avisos conocidos', 'La huella de lo que se revisó'], icon: 'code', pictogram: 'code' },
  { id: 'https', label: 'HTTPS', title: 'Lo que tu web le muestra al mundo.', description: 'Revisamos cómo responde tu dominio, sin cookies ni redirecciones. Puedes empezar sin compartir el código fuente.', facts: ['Permiso por DNS', 'Sin acceso a tu código', 'Límites claros en cada prueba'], icon: 'globe', pictogram: 'globe' },
  { id: 'both', label: 'Ambas', title: 'Dos miradas. Una sola historia.', description: 'Cruza lo que ve tu código con lo que responde tu web y descubre qué coincide y qué no.', facts: ['Comparación de hallazgos', 'Lo que solo ve cada mirada', 'La evidencia de cada lado'], icon: 'report', pictogram: 'mark' },
] as const;
const chapters = [
  { title: 'Sube tu código. Nada se ejecuta.', text: 'Arrastra una carpeta y ponle nombre a la versión. Gotchu la guarda con su huella y busca patrones de riesgo, posibles secretos y dependencias con avisos conocidos, sin ejecutar una sola línea.', id: 'codigo' },
  { title: 'Tu dominio. Tu permiso.', text: 'Demuestra que el dominio es tuyo con un registro DNS y Gotchu revisa lo que tu web responde. Para esto no necesitas compartir tu código.', id: 'https' },
  { title: 'Todo queda por escrito.', text: 'Mira qué se revisó y qué no, compara lo que encontró cada mirada y llévate el informe completo en JSON.', id: 'evidencia' },
];
const questions = [
  ['¿Tengo que compartir mi código?', 'No. Puedes empezar solo con tu dominio. Si quieres que revisemos el código, subes una copia de la versión que te interesa.'],
  ['¿Puedo revisar cualquier sitio?', 'Solo los que son tuyos. Lo demuestras con un registro DNS y das tu consentimiento antes de que empiece la revisión.'],
  ['¿Gotchu cambia algo por mí?', 'No. Gotchu observa y te muestra la evidencia; tu equipo decide qué cambiar. Tu código nunca se ejecuta ni se modifica.'],
  ['¿Sin hallazgos significa que estoy seguro?', 'Significa que no encontramos nada dentro de lo que revisamos. El informe te dice qué quedó fuera, porque ninguna revisión es una garantía.'],
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
        <div className="g-perspectives-heading"><h2 id="perspectives-title">Empieza donde lo necesitas.</h2><p>Solo el código, solo tu web o las dos a la vez.</p></div>
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
        <h2 id="workflow-title">Todo tu trabajo, en orden.</h2>
        <div className="g-workflow-grid">
          <article className="g-card g-card-ink g-workflow-wide"><DotMatrix name="workspace" /><div><h3>Un espacio para tu equipo</h3><p>Agrupa tus aplicaciones y decide quién puede ver y lanzar cada revisión.</p></div></article>
          <article className="g-card g-card-magenta g-workflow-history"><DotMatrix name="history" /><div><h3>Un historial que no se pierde</h3><p>Sigue cada revisión mientras corre y vuelve a cualquier informe cuando lo necesites.</p></div></article>
          <article className="g-card g-card-ink g-workflow-export">
            <div><DotMatrix name="json" /><h3>Tus datos, en JSON</h3><p>Descarga el informe completo y llévalo a donde ya trabaja tu equipo.</p><a className="g-secondary-link" href="/dashboard">Ir a mis aplicaciones <UiIcon name="arrow" /></a></div>
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
        <h2 id="closing-title">Deja de adivinar.<br /><span>Empieza a revisar.</span></h2>
        <a className="g-button g-button-ink" href="/dashboard" data-catch>Empezar mi revisión <UiIcon name="arrow" /></a>
      </section>
    </main>
    <footer className="g-footer">
      <a href="#contenido" aria-label="Gotchu, volver al inicio" className="g-footer-wordmark">Gotchu<GotchuMark size={0} /></a>
      <div className="g-footer-row"><p className="g-lockup"><GotchuMark size={26} />Revisa lo que importa</p><a href="/dashboard">Abrir Gotchu <UiIcon name="arrow" /></a></div>
    </footer>
  </div>;
}
