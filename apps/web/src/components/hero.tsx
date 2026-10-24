import { useState } from 'react';
import { UiIcon } from './ui';
import { AsciiMark } from './ascii-mark';
import { BlueprintGrid } from './blueprint-grid';
import './hero.css';

const verbs = [
  { label: 'Subir', href: '#codigo' },
  { label: 'Autorizar', href: '#https' },
  { label: 'Evaluar', href: '#perspectivas' },
  { label: 'Exportar', href: '#evidencia' },
];

/** First viewport: the claim and the mark share one blueprint field; the flow follows in a band. */
export function Hero() {
  const [paused, setPaused] = useState(false);
  return <>
    <section className={`g-hero${paused ? ' is-paused' : ''}`} aria-labelledby="hero-title">
      <BlueprintGrid />
      <span className="g-hero-glow" aria-hidden="true" />
      <span className="g-hero-scan" aria-hidden="true" />
      <div className="g-hero-inner g-wrap">
        <div className="g-hero-copy">
          <h1 id="hero-title">Mira de cerca. <span>Decide con pruebas.</span></h1>
          <p className="g-hero-lead">Revisa el código de tu app, tu web o ambos, con evidencia para entender cada hallazgo y saber por dónde seguir.</p>
          <div className="g-hero-actions">
            <a className="g-button g-button-paper" href="/dashboard" data-catch>Revisar mi aplicación <UiIcon name="arrow" /></a>
            <a className="g-text-link" href="#codigo">Cómo funciona <span className="g-arrow-down"><UiIcon name="arrow" size={16} /></span></a>
          </div>
        </div>
        <div className="g-hero-mark">
          <AsciiMark paused={paused} />
        </div>
      </div>
      <button className="g-hero-pause" type="button" aria-pressed={paused} aria-label={paused ? 'Reanudar animación' : 'Pausar animación'} onClick={() => setPaused(!paused)}>
        <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">{paused ? <path d="M3 1.5v11l9-5.5z" fill="currentColor" /> : <path d="M3 1.5h3v11H3zM8 1.5h3v11H8z" fill="currentColor" />}</svg>
      </button>
    </section>
    <nav className="g-signal-band" aria-label="Flujo de Gotchu">
      {verbs.map(verb => <a key={verb.label} href={verb.href}>{verb.label}<span className="g-arrow-up"><UiIcon name="arrow" size={22} /></span></a>)}
    </nav>
  </>;
}
