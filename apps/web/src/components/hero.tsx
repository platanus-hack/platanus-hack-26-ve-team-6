import { useState } from 'react';
import { UiIcon } from './ui';
import { AsciiMark } from './ascii-mark';
import './hero.css';

const scope = [
  { icon: 'code', label: 'Código fuente' },
  { icon: 'globe', label: 'Orígenes HTTPS' },
  { icon: 'shield', label: 'Solo observación' },
  { icon: 'report', label: 'Informes JSON' },
] as const;
const verbs = [
  { label: 'Subir', href: '#codigo' },
  { label: 'Autorizar', href: '#https' },
  { label: 'Evaluar', href: '#perspectivas' },
  { label: 'Exportar', href: '#evidencia' },
];

/** First viewport: the claim on the left, the mark in a framed blueprint on the right, the flow in a band below. */
export function Hero() {
  const [paused, setPaused] = useState(false);
  return <>
    <section className="g-hero g-wrap" aria-labelledby="hero-title">
      <div className="g-hero-copy">
        <p className="g-mono g-hero-scope"><span className="g-square" aria-hidden="true" />Código fuente / HTTPS autorizado</p>
        <h1 id="hero-title">Tu código y tu web. <span>Bajo la misma lupa.</span></h1>
        <p className="g-hero-lead">Sube una versión de tu código o autoriza tu dominio por DNS. Gotchu te devuelve hallazgos con su evidencia y lo que no se pudo comprobar.</p>
        <div className="g-hero-actions">
          <a className="g-button g-button-paper" href="/dashboard" data-catch>Revisar mi aplicación <UiIcon name="arrow" /></a>
          <a className="g-text-link" href="#codigo">Cómo funciona <span aria-hidden="true">↓</span></a>
        </div>
        <p className="g-mono g-hero-note"><UiIcon name="shield" size={14} />Sin ejecutar tu código. Con evidencia. Con límites por escrito.</p>
      </div>
      <div className={`g-hero-art g-ticks${paused ? ' is-paused' : ''}`}>
        <div className="g-art-top g-mono" aria-hidden="true"><span><span className="g-square" />Gotchu / modo observación</span><span>[◆] 01</span></div>
        <p className="g-art-index g-mono" aria-hidden="true">Código<br />HTTPS<br />Evidencia</p>
        <span className="g-art-axis g-mono" aria-hidden="true">Instantánea → informe</span>
        <svg className="g-art-blueprint" viewBox="0 0 600 490" aria-hidden="true" preserveAspectRatio="xMidYMid slice">
          <defs><pattern id="g-art-grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#c7bfbd" strokeOpacity=".1" strokeWidth=".6" /></pattern></defs>
          <rect x="40" y="40" width="520" height="410" fill="url(#g-art-grid)" />
          <g fill="none" stroke="#c7bfbd" strokeOpacity=".26" strokeWidth=".8"><rect x="132" y="77" width="336" height="336" /><rect x="112" y="57" width="376" height="376" strokeDasharray="2 9" /><path d="M75 245h450M300 38v414" /><path d="M98 86h32V62M470 62v24h32M98 402h32v25M470 427v-25h32" /></g>
          <g fill="none" stroke="#e7147d" strokeWidth="1.2"><path d="M128 245h20M452 245h20M300 73v20M300 397v20" /><path d="M180 122h-35v-28M420 365h34v28" /></g>
        </svg>
        <span className="g-art-scan" aria-hidden="true" />
        <div className="g-hero-ascii"><AsciiMark paused={paused} /></div>
        <div className="g-art-status">
          <div><p className="g-mono"><span className="g-square" aria-hidden="true" />Alcance autorizado</p><p>De la instantánea al informe.</p></div>
          <button className="g-art-pause" type="button" aria-pressed={paused} aria-label={paused ? 'Reanudar animación' : 'Pausar animación'} onClick={() => setPaused(!paused)}><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">{paused ? <path d="M3 1.5v11l9-5.5z" fill="currentColor" /> : <path d="M3 1.5h3v11H3zM8 1.5h3v11H8z" fill="currentColor" />}</svg></button>
        </div>
      </div>
      <div className="g-hero-bottom g-mono">
        <span>Seguridad para tu código y tu web.</span>
        <ul>{scope.map(item => <li key={item.label}><UiIcon name={item.icon} size={14} />{item.label}</li>)}</ul>
      </div>
    </section>
    <nav className="g-signal-band" aria-label="Flujo de Gotchu">
      {verbs.map(verb => <a key={verb.label} href={verb.href}>{verb.label}<span aria-hidden="true">↗</span></a>)}
    </nav>
  </>;
}
