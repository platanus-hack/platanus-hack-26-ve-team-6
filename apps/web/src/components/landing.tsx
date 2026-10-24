import { useRef, useState, type KeyboardEvent } from 'react';
import { Brand, UiIcon } from './ui';
import { EvidenceLens, useChapterTracking } from './evidence-lens';
import './landing.css';

const perspectives = [
  { id: 'code', label: 'Código', title: 'Lo que está en tu código.', description: 'Revisa una instantánea de tu aplicación sin ejecutarla. Conserva la versión analizada y la evidencia de cada hallazgo.', facts: ['Instantáneas inmutables', 'Análisis sin ejecutar tu código', 'Hallazgos vinculados a evidencia'], icon: 'code' },
  { id: 'https', label: 'HTTPS', title: 'Lo que responde tu aplicación.', description: 'Evalúa la superficie HTTPS de un origen que controlas. Puedes empezar sin compartir el código fuente.', facts: ['Autorización mediante DNS', 'Evaluación sin acceso al código', 'Cobertura y límites por comprobación'], icon: 'globe' },
  { id: 'both', label: 'Ambas', title: 'Dos perspectivas. Un informe.', description: 'Contrasta las señales de la instantánea con las del origen autorizado. Identifica coincidencias y diferencias sin perder su procedencia.', facts: ['Evaluación interna y externa', 'Comparación de hallazgos', 'Evidencia de cada perspectiva'], icon: 'report' },
] as const;
const chapters = [
  { title: 'El código cuenta una parte.', text: 'Una instantánea conserva lo que analizaste. Revisa sus hallazgos sin ejecutar el código ni modificar tu aplicación.', detail: 'Código fuente', id: 'codigo' },
  { title: 'Tu web cuenta otra.', text: 'Observa cómo responde el origen HTTPS que autorizaste. Una segunda perspectiva, incluso sin acceso al código.', detail: 'HTTPS autorizado', id: 'https' },
  { title: 'La evidencia las conecta.', text: 'Encuentra qué se observó, dónde y con qué confianza. Compara ambas perspectivas y lleva el contexto a la siguiente revisión de tu equipo.', detail: 'Hallazgos · Cobertura · Comparación', id: 'evidencia' },
];
const questions = [
  ['¿Tengo que compartir mi código?', 'No. Puedes evaluar únicamente un origen HTTPS autorizado. Para el análisis interno, cargas una instantánea del código que quieres revisar.'],
  ['¿Puedo evaluar cualquier sitio?', 'Solo un origen que tengas autorización para evaluar. Gotchu verifica el control mediante un registro DNS y requiere tu consentimiento antes de iniciar la evaluación.'],
  ['¿Gotchu aplica cambios por mí?', 'No. La evaluación conserva observaciones y evidencia. Tu equipo decide y aplica los cambios; el análisis no ejecuta ni modifica el código recibido.'],
  ['¿Qué significa un resultado sin hallazgos?', 'Que no se encontraron hallazgos dentro del alcance y las capacidades utilizadas. El informe también conserva lo que no se pudo comprobar; no equivale a una garantía de seguridad.'],
];

export function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [perspective, setPerspective] = useState(0);
  const [keyboardSelection, setKeyboardSelection] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const { container, active } = useChapterTracking();
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
      <div className="g-nav-shell"><Brand />
        <button ref={menuButton} className="g-menu-button" type="button" aria-expanded={menuOpen} aria-controls="gotchu-nav" onKeyDown={event => { if (event.key === 'Escape') closeMenu(); }} onClick={() => setMenuOpen(!menuOpen)}><UiIcon name={menuOpen ? 'close' : 'grid'} />{menuOpen ? 'Cerrar' : 'Menú'}</button>
        <nav id="gotchu-nav" className={menuOpen ? 'g-nav is-open' : 'g-nav'} aria-label="Navegación principal" onKeyDown={event => { if (event.key === 'Escape') { setMenuOpen(false); menuButton.current?.focus(); } }}>
          <a href="#perspectivas" onClick={closeMenu}>Qué revisamos</a><a href="#evidencia" onClick={closeMenu}>La evidencia</a><a href="#preguntas" onClick={closeMenu}>Preguntas</a>
          <a className="g-button g-button-small" href="/dashboard">Abrir Gotchu <UiIcon name="arrow" /></a>
        </nav>
      </div>
    </header>
    <main id="contenido" tabIndex={-1}>
      <section className="g-hero" aria-labelledby="hero-title">
        <h1 id="hero-title">Tu código y tu web.<br /><span>Bajo la misma lupa.</span></h1>
        <p className="g-hero-description">Cruza lo que dice tu código con lo que expone tu aplicación. Hallazgos, evidencia y límites en un solo informe.</p>
        <div className="g-hero-actions"><a className="g-button" href="/dashboard">Revisar mi aplicación <UiIcon name="arrow" /></a><a className="g-secondary-link" href="#perspectivas">Conocer Gotchu <UiIcon name="chevron" /></a></div>
        <EvidenceLens />
        <div className="g-hero-foot"><span>Código fuente</span><span>HTTPS autorizado</span><span>Evidencia trazable</span></div>
      </section>
      <section ref={container} className="g-journey g-container" aria-label="Del análisis a la evidencia">
        <div className="g-journey-visual"><EvidenceLens compact perspective={active} /><div className="g-chapter-marker" aria-hidden="true">{chapters.map((chapter, index) => <span key={chapter.id} className={active === index ? 'is-current' : ''}><span />{chapter.detail}</span>)}</div></div>
        <div className="g-chapters">{chapters.map((chapter, index) => <article key={chapter.id} id={chapter.id} data-chapter={index}><h2>{chapter.title}</h2><p>{chapter.text}</p></article>)}</div>
      </section>
      <section id="perspectivas" className="g-perspectives" aria-labelledby="perspectives-title">
        <div className="g-container"><div className="g-perspectives-heading"><h2 id="perspectives-title">Empieza donde<br />lo necesitas.</h2><p>Una aplicación. Tres formas de revisarla.<br />Tú eliges el alcance.</p></div>
          <div className="g-perspective-layout">
            <div className="g-perspective-controls" role="tablist" aria-label="Perspectiva de evaluación">{perspectives.map((item, index) => <button id={`tab-${item.id}`} key={item.id} ref={element => { tabs.current[index] = element; }} role="tab" type="button" aria-controls={`panel-${item.id}`} aria-selected={perspective === index} tabIndex={perspective === index ? 0 : -1} onClick={() => { setKeyboardSelection(false); setPerspective(index); }} onKeyDown={tabKeys}><UiIcon name={item.icon} size={24} />{item.label}<UiIcon name="arrow" /></button>)}</div>
            <div className="g-perspective-panels" data-keyboard={keyboardSelection}>{perspectives.map((item, index) => <div key={item.id} role="tabpanel" id={`panel-${item.id}`} aria-labelledby={`tab-${item.id}`} hidden={perspective !== index} tabIndex={0} className="g-perspective-panel"><h3>{item.title}</h3><p>{item.description}</p><ul>{item.facts.map(fact => <li key={fact}><UiIcon name="shield" />{fact}</li>)}</ul><a className="g-secondary-link" href="/dashboard">Abrir Gotchu <UiIcon name="arrow" /></a></div>)}</div>
          </div>
        </div>
      </section>
      <section id="preguntas" className="g-faq g-container" aria-labelledby="faq-title"><h2 id="faq-title">Antes de<br />dar el paso.</h2><div>{questions.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true"><UiIcon name="plus" /></span></summary><p>{answer}</p></details>)}</div></section>
      <section className="g-closing" aria-labelledby="closing-title"><div className="g-container"><h2 id="closing-title">La próxima decisión.<br /><span>Con la evidencia a mano.</span></h2><a className="g-button" href="/dashboard">Empezar mi revisión <UiIcon name="arrow" /></a></div></section>
    </main>
    <footer className="g-footer g-container"><a href="#contenido" aria-label="Gotchu, volver al inicio" className="g-footer-wordmark">gotchu<span>.</span></a><div><p>Código. HTTPS. Evidencia.</p><a href="/dashboard">Abrir Gotchu <UiIcon name="arrow" /></a></div></footer>
  </div>;
}
