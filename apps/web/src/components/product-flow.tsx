import { useEffect, useRef, useState } from 'react';
import { DotMatrix, type PictogramName } from './dot-matrix';
import './product-flow.css';

const sheets: { key: string; title: string; pictogram: PictogramName }[] = [
  { key: 'source', title: 'Instantánea de código', pictogram: 'code' },
  { key: 'target', title: 'Origen HTTPS', pictogram: 'globe' },
  { key: 'report', title: 'Informe de evaluación', pictogram: 'json' },
];

/** Product structure only: no invented customer records, findings or verification results. */
export function ProductFlow({ step, className = '' }: { step: number; className?: string }) {
  const sheet = sheets[step] ?? sheets[0]!;
  return <div className={`g-product-flow ${className}`} data-step={step}>
    <div className="g-flow-sheet" key={sheet.key}>
      <DotMatrix name={sheet.pictogram} className="g-flow-dots" />
      <h3>{sheet.title}</h3>
      {step === 0 ? <>
        <div className="g-file-formats" aria-label="Formatos admitidos"><code>JS / TS</code><code>JSON</code><code>YAML</code><code>TOML</code></div>
        <dl className="g-flow-fields"><div><dt>Versión</dt><dd>La que tú etiquetas</dd></div><div><dt>Huella SHA-256</dt><dd>Prueba exacta de lo revisado</dd></div></dl>
      </> : step === 1 ? <>
        <div className="g-dns-record"><span>Registro TXT</span><code>{'_gotchu.<dominio>'}</code></div>
        <ol className="g-dns-steps"><li>Confirmas que es tuyo</li><li>Publicas el registro</li><li>Gotchu lo comprueba</li></ol>
      </> : <>
        <dl className="g-flow-fields"><div><dt>Cobertura</dt><dd>Lo revisado y lo que quedó fuera</dd></div><div><dt>Contraste</dt><dd>Lo que coincide entre código y web</dd></div><div><dt>Límites</dt><dd>Lo que no se pudo comprobar</dd></div></dl>
        <footer>Descarga el informe completo <code>JSON</code></footer>
      </>}
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
