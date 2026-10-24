import { useRef, useState, type KeyboardEvent } from 'react';
import { Brand, UiIcon } from './ui';
import { Convergence } from './convergence';
import { LensEye } from './lens-eye';
import { CodeSlab, OriginGlobe } from './spatial-objects';
import { ProductFlow, useChapterTracking } from './product-flow';
import './landing.css';

const perspectives = [
  { id: 'code', label: 'Código', title: 'Lo que está en tu código.', description: 'Revisa una instantánea de tu aplicación sin ejecutarla. Conserva la versión analizada y la evidencia de cada hallazgo.', facts: ['Patrones de código y posibles secretos', 'Avisos de dependencias cuando están disponibles', 'Revisión y huella de los archivos analizados'], icon: 'code' },
  { id: 'https', label: 'HTTPS', title: 'Lo que responde tu aplicación.', description: 'Revisa la respuesta HTTPS de un origen que controlas, sin cookies ni redirecciones. Puedes empezar sin compartir el código fuente.', facts: ['Autorización mediante DNS', 'Evaluación sin acceso al código', 'Cobertura y límites por comprobación'], icon: 'globe' },
  { id: 'both', label: 'Ambas', title: 'Dos perspectivas. Un informe.', description: 'Contrasta las señales de la instantánea con las del origen autorizado. Identifica coincidencias y diferencias sin perder su procedencia.', facts: ['Evaluación interna y externa', 'Comparación de hallazgos', 'Evidencia de cada perspectiva'], icon: 'report' },
] as const;
const chapters = [
  { title: 'Sube los archivos. Conserva la revisión.', text: 'Selecciona una carpeta y etiqueta la versión. Gotchu guarda una instantánea con su huella SHA-256 y revisa código, posibles secretos y dependencias según el perfil disponible.', detail: 'Instantánea', id: 'codigo' },
  { title: 'Tu dominio. Tu autorización.', text: 'Registra un origen HTTPS, confirma que puedes evaluarlo y publica el registro TXT que te entrega Gotchu. La evaluación externa puede iniciarse sin subir código.', detail: 'Autorización DNS', id: 'https' },
  { title: 'Del hallazgo a su evidencia.', text: 'Abre una observación para revisar su severidad, confianza, extractos y herramienta de origen. Consulta la cobertura, contrasta ambas perspectivas y descarga el informe completo en JSON.', detail: 'Informe y evidencia', id: 'evidencia' },
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
          <a href="#codigo" onClick={closeMenu}>Cómo funciona</a><a href="#perspectivas" onClick={closeMenu}>Alcance</a><a href="#preguntas" onClick={closeMenu}>Preguntas</a>
          <a className="g-button g-button-small" href="/dashboard" data-lens-focus>Abrir Gotchu <UiIcon name="arrow" /></a>
        </nav>
      </div>
    </header>
    <main id="contenido" tabIndex={-1}>
      <Convergence />
      <section ref={container} className="g-journey g-container" aria-label="Cómo entra cada perspectiva">
        <div className="g-journey-visual"><ProductFlow step={active} /><div className="g-chapter-marker" aria-hidden="true">{chapters.map((chapter, index) => <span key={chapter.id} className={active === index ? 'is-current' : active > index ? 'is-done' : ''}><span />{chapter.detail}</span>)}</div></div>
        <div className="g-chapters">{chapters.map((chapter, index) => <article key={chapter.id} id={chapter.id} data-chapter={index} className={active === index ? 'is-current' : ''}><h2>{chapter.title}</h2><p>{chapter.text}</p><ProductFlow step={index} className="g-mobile-flow" /></article>)}</div>
      </section>
      <section id="perspectivas" className="g-perspectives" aria-labelledby="perspectives-title">
        <div className="g-container">
          <div className="g-perspectives-heading"><h2 id="perspectives-title">Empieza donde<br />lo necesitas.</h2><p>Una aplicación. Tres formas de revisarla. Tú eliges el alcance.</p></div>
          <div className="g-perspective-controls" role="tablist" aria-label="Perspectiva de evaluación">
            <span className="g-tab-indicator" aria-hidden="true" style={{ transform: `translateX(${perspective * 100}%)` }} />
            {perspectives.map((item, index) => <button id={`tab-${item.id}`} key={item.id} ref={element => { tabs.current[index] = element; }} role="tab" type="button" aria-controls={`panel-${item.id}`} aria-selected={perspective === index} tabIndex={perspective === index ? 0 : -1} onClick={() => { setKeyboardSelection(false); setPerspective(index); }} onKeyDown={tabKeys}><UiIcon name={item.icon} size={20} />{item.label}</button>)}
          </div>
          <div className="g-perspective-layout">
            <div className="g-perspective-panels" data-keyboard={keyboardSelection}>{perspectives.map((item, index) => <div key={item.id} role="tabpanel" id={`panel-${item.id}`} aria-labelledby={`tab-${item.id}`} hidden={perspective !== index} tabIndex={0} className="g-perspective-panel"><h3>{item.title}</h3><p>{item.description}</p><ul>{item.facts.map(fact => <li key={fact}><UiIcon name="shield" />{fact}</li>)}</ul><a className="g-secondary-link" href="/dashboard">Abrir Gotchu <UiIcon name="arrow" /></a></div>)}</div>
            <div className="g-scope-stage" data-scope={perspectives[perspective]?.id} aria-hidden="true">
              <div className="g-scope-slab"><CodeSlab /></div>
              <div className="g-scope-lens"><LensEye /></div>
              <div className="g-scope-globe"><OriginGlobe /></div>
            </div>
          </div>
        </div>
      </section>
      <section className="g-workflow g-container" aria-labelledby="workflow-title"><h2 id="workflow-title">Cada revisión, en su sitio.</h2><dl><div><dt>Espacios y aplicaciones</dt><dd>Organiza tus aplicaciones por espacio de trabajo y conserva los permisos de cada rol.</dd></div><div><dt>Historial de evaluaciones</dt><dd>Sigue los trabajos en cola o en curso y vuelve a consultar los informes guardados.</dd></div><div><dt>Exportación JSON</dt><dd>Descarga el informe completo con sus hallazgos, evidencia, cobertura y limitaciones.</dd></div></dl><a className="g-secondary-link" href="/dashboard">Ir a mis aplicaciones <UiIcon name="arrow" /></a></section>
      <section id="preguntas" className="g-faq g-container" aria-labelledby="faq-title"><h2 id="faq-title">Antes de<br />dar el paso.</h2><div>{questions.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true"><UiIcon name="plus" /></span></summary><p>{answer}</p></details>)}</div></section>
      <section className="g-closing" aria-labelledby="closing-title"><div className="g-container"><h2 id="closing-title">La próxima decisión.<br /><span>Con la evidencia a mano.</span></h2><a className="g-button" href="/dashboard" data-lens-focus>Empezar mi revisión <UiIcon name="arrow" /></a></div></section>
    </main>
    <footer className="g-footer g-container"><a href="#contenido" aria-label="Gotchu, volver al inicio" className="g-footer-wordmark">gotchu<span>.</span></a><div><p>Código. HTTPS. Evidencia.</p><a href="/dashboard">Abrir Gotchu <UiIcon name="arrow" /></a></div></footer>
  </div>;
}
