import { UiIcon } from './ui';
import { AsciiMark } from './ascii-mark';
import { GotchuMark } from './gotchu-mark';
import { WordmarkRows } from './wordmark-rows';
import './hero.css';

/** First viewport: the headline on a magenta field, the mark in 3D, and the way in. */
export function Hero() {
  return <section className="g-hero" aria-labelledby="hero-title">
    <div className="g-card g-card-magenta g-hero-type">
      <WordmarkRows rows={7} />
      <p className="g-tag g-hero-tag">[ Solo observación ]</p>
      <h1 id="hero-title"><span>Tu código.</span> <span>Tu web.</span> <span className="g-hero-accent">Bajo la misma lupa.</span></h1>
    </div>
    <div className="g-card g-card-ink g-hero-object">
      <AsciiMark />
      <p className="g-tag g-hero-object-left">[ Código ]</p>
      <p className="g-tag g-hero-object-right">[ HTTPS ]</p>
    </div>
    <div className="g-card g-card-silver g-hero-pitch">
      <p className="g-lockup"><GotchuMark size={34} />Revisa lo que importa</p>
      <p className="g-hero-lead">Sube una versión de tu código o autoriza tu dominio por DNS. Recibe hallazgos con su evidencia y lo que no se pudo comprobar.</p>
      <div className="g-hero-actions">
        <a className="g-button g-button-ink" href="/dashboard" data-catch>Revisar mi aplicación <UiIcon name="arrow" /></a>
        <a className="g-secondary-link" href="#codigo">Cómo funciona <UiIcon name="chevron" /></a>
      </div>
    </div>
  </section>;
}
