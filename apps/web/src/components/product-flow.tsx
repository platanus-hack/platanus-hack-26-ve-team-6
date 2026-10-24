import { useEffect, useRef, useState } from 'react';
import { UiIcon } from './ui';
import { useTilt } from './spatial-objects';
import './product-flow.css';

const sheetPose = (x: number, y: number) => `rotateX(${(3 - y * 7).toFixed(2)}deg) rotateY(${(-6 + x * 9).toFixed(2)}deg)`;

/** Product structure only: no invented customer records, findings or verification results. */
export function ProductFlow({ step, className = '' }: { step: number; className?: string }) {
  const { root, body } = useTilt(sheetPose);
  return <div ref={root} className={`g-product-flow ${className}`} data-step={step}>
    <div ref={body} className="g-flow-body" style={{ transform: sheetPose(0, 0) }}>
      <div className="g-flow-depth" aria-hidden="true" />
      {step === 0 ? <div className="g-flow-sheet" key="source">
        <header><UiIcon name="code" size={24} /><h3>Instantánea de código</h3></header>
        <div className="g-file-formats" aria-label="Formatos admitidos"><code>JS / TS</code><code>JSON</code><code>YAML</code><code>TOML</code></div>
        <dl className="g-flow-fields"><div><dt>Revisión</dt><dd>La versión que compartes</dd></div><div><dt>Huella SHA-256</dt><dd>Identifica los archivos analizados</dd></div></dl>
        <div className="g-source-checks"><span>Código</span><span>Secretos</span><span>Dependencias</span></div>
        <footer><UiIcon name="shield" />Sin ejecutar código ni instalar paquetes</footer>
      </div> : step === 1 ? <div className="g-flow-sheet" key="target">
        <header><UiIcon name="globe" size={24} /><h3>Origen HTTPS</h3></header>
        <div className="g-dns-record"><span>Registro TXT</span><code>{'_gotchu.<dominio>'}</code></div>
        <ol className="g-dns-steps"><li>Confirmas la autorización</li><li>Publicas el registro DNS</li><li>Gotchu comprueba el dominio</li></ol>
        <footer><UiIcon name="shield" />Autorización con vigencia y revocación</footer>
      </div> : <div className="g-flow-sheet" key="report">
        <header><UiIcon name="report" size={24} /><h3>Informe de evaluación</h3></header>
        <dl className="g-flow-fields g-report-fields"><div><dt>Hallazgos</dt><dd>Severidad y confianza</dd></div><div><dt>Evidencia</dt><dd>Extracto, herramienta y checksum</dd></div><div><dt>Cobertura</dt><dd>Qué se inspeccionó y qué quedó fuera</dd></div><div><dt>Contraste</dt><dd>Observaciones internas y externas</dd></div></dl>
        <footer><UiIcon name="report" /><span>Informe completo exportable</span><code>JSON</code></footer>
      </div>}
    </div>
  </div>;
}

/** Reports which `[data-chapter]` article sits in the reading band of the viewport. */
export function useChapterTracking() {
  const container = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (!container.current) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.target instanceof HTMLElement) setActive(Number(entry.target.dataset.chapter));
      }
    }, { rootMargin: '-25% 0px -35% 0px', threshold: 0 });
    container.current.querySelectorAll('[data-chapter]').forEach(chapter => observer.observe(chapter));
    return () => observer.disconnect();
  }, []);
  return { container, active };
}
