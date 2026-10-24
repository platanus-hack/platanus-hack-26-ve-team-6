import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { GotchuMark } from '../../components/gotchu-mark';
import { UiIcon } from '../../components/ui';
import { FAQ, REPORT_TERMS, SCOPES, TEAM } from './copy';

/* ---------- small pieces ---------- */

type TitleProps = {
  lines: readonly string[];
  as?: 'h1' | 'h2' | 'h3';
  /** First line index drawn in magenta. */
  accentFrom?: number;
  /** Plays on load with CSS only (hero); other titles reveal once when scrolled into view. */
  intro?: boolean;
  className?: string;
};

/** Giant headline set line by line; each line is revealed through a mask. */
export function Title({ lines, as: Tag = 'h2', accentFrom, intro = false, className = '' }: TitleProps) {
  return <Tag className={`vb-title ${className}`} data-reveal={intro ? undefined : ''}>
    {lines.map((line, index) => {
      const delay = intro ? { animationDelay: `${120 + index * 90}ms` } : { transitionDelay: `${index * 90}ms` };
      const accent = accentFrom !== undefined && index >= accentFrom;
      return <span key={line}>
        {index > 0 && ' '}
        <span className={`vb-line${accent ? ' vb-accent' : ''}${intro ? ' vb-intro' : ''}`} style={delay}><span style={delay}>{line}</span></span>
      </span>;
    })}
  </Tag>;
}

const rise = (index: number) => ({ transitionDelay: `${index * 80}ms` });

function Section({ id, formation, className = '', children }: { id?: string; formation: string; className?: string; children: ReactNode }) {
  return <section id={id} data-formation={formation} className={`vb-sec ${className}`}>{children}</section>;
}

function Button({ href, children, ...rest }: { href: string; children: ReactNode; 'data-catch'?: '' }) {
  return <a className="vb-btn" href={href} {...rest}>{children}<span className="vb-arrow"><UiIcon name="arrow" size={18} /></span></a>;
}

/* ---------- sections ---------- */

export function Hero() {
  return <Section formation="mark" className="vb-hero">
    <div className="vb-col">
      <Title as="h1" intro lines={['Mira de', 'cerca.', 'Decide con', 'pruebas.']} accentFrom={2} className="vb-title-hero" />
      <p className="vb-lead vb-fade" style={{ animationDelay: '600ms' }}>Revisa el código de tu app, tu web o ambos, con evidencia para entender cada hallazgo y saber por dónde seguir.</p>
      <div className="vb-actions vb-fade" style={{ animationDelay: '760ms' }}>
        <Button href="/dashboard" data-catch="">Revisar mi aplicación</Button>
        <a className="vb-link" href="#vb-codigo">Cómo funciona <span className="vb-arrow vb-arrow-down"><UiIcon name="arrow" size={16} /></span></a>
      </div>
    </div>
  </Section>;
}

const CODE_FACTS = ['Sin ejecutarlo', 'Sin instalar paquetes', 'Huella SHA-256'] as const;
const CODE_LOOKS = ['Patrones de código riesgosos', 'Posibles secretos expuestos', 'Avisos de dependencias, si los hay'] as const;

export function CodeSection() {
  return <Section id="vb-codigo" formation="code">
    <div className="vb-col">
      <Title lines={['Sube una', 'copia de tu', 'código.']} />
      <p className="vb-text vb-rise" data-reveal="">Para revisar código, sube una copia de la carpeta de tu app, etiqueta la versión y guárdala con su huella SHA-256.</p>
      <ul className="vb-facts vb-facts-row" data-reveal="">{CODE_FACTS.map((fact, index) => <li key={fact} className="vb-rise" style={rise(index)}>{fact}</li>)}</ul>
      <p className="vb-label">Qué busca</p>
      <ul className="vb-plain" data-reveal="">{CODE_LOOKS.map((item, index) => <li key={item} className="vb-rise" style={rise(index)}>{item}</li>)}</ul>
    </div>
  </Section>;
}

const DOMAIN_FACTS = ['Propiedad verificada por DNS', 'Sin cookies', 'Sin seguir redirecciones', 'Sin compartir el código fuente'] as const;

export function DomainSection() {
  return <Section formation="globe">
    <div className="vb-col">
      <Title lines={['Confirma que', 'el dominio', 'es tuyo.']} />
      <p className="vb-text vb-rise" data-reveal="">Para revisar la web, publica el TXT en <code>{'_gotchu.<dominio>'}</code>, verifica la propiedad y autoriza la revisión.</p>
      <div className="vb-record" data-reveal="">
        <span className="vb-tag vb-rise">TXT</span>
        <code className="vb-rise" style={rise(1)}>{'_gotchu.<dominio>'}</code>
      </div>
      <ul className="vb-facts" data-reveal="">{DOMAIN_FACTS.map((fact, index) => <li key={fact} className="vb-rise" style={rise(index)}>{fact}</li>)}</ul>
    </div>
  </Section>;
}

export function BothSection() {
  return <Section id="vb-alcance" formation="both" className="vb-both">
    <div className="vb-col">
      <Title lines={['Dos miradas.', 'Más contexto.']} />
      <p className="vb-text vb-rise" data-reveal="">Revisa el código y la web juntos para distinguir qué coincide y qué aparece en una sola revisión.</p>
    </div>
    <div className="vb-zones" data-reveal="">
      <span className="vb-zone vb-zone-code vb-rise">Solo en el código</span>
      <span className="vb-zone vb-zone-both vb-rise" style={rise(1)}>En ambas</span>
      <span className="vb-zone vb-zone-web vb-rise" style={rise(2)}>Solo en la web</span>
    </div>
  </Section>;
}

/** Three-option radio group: its choice swaps the copy below and morphs the field. */
export function ScopeSection({ index, onChange }: { index: number; onChange: (next: number) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const scope = SCOPES[index] ?? SCOPES[0];
  const select = (next: number) => {
    const wrapped = (next + SCOPES.length) % SCOPES.length;
    onChange(wrapped);
    buttons.current[wrapped]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const keys: Record<string, number | undefined> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: SCOPES.length - 1 };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  };
  return <Section formation="scope" className="vb-scope">
    <div className="vb-col">
      <Title lines={['Tú eliges', 'dónde mirar.']} />
      <div className="vb-seg" role="radiogroup" aria-label="Dónde mirar" onKeyDown={onKeyDown}>
        <span className="vb-seg-indicator" style={{ transform: `translateX(${index * 100}%)` }} aria-hidden="true" />
        {SCOPES.map((option, optionIndex) => <button
          key={option.label}
          ref={element => { buttons.current[optionIndex] = element; }}
          type="button" role="radio" aria-checked={optionIndex === index}
          tabIndex={optionIndex === index ? 0 : -1}
          className="vb-seg-option"
          onClick={() => onChange(optionIndex)}
        >{option.label}</button>)}
      </div>
      <div className="vb-swap" key={scope.label} aria-live="polite">
        <h3 className="vb-subtitle">{scope.title}</h3>
        <p className="vb-text">{scope.text}</p>
        <ul className="vb-facts">{scope.facts.map(fact => <li key={fact}>{fact}</li>)}</ul>
      </div>
    </div>
  </Section>;
}

export function ReportSection() {
  return <Section formation="report">
    <div className="vb-col">
      <Title lines={['Cada hallazgo.', 'Su evidencia.']} />
      <p className="vb-text vb-rise" data-reveal="">Cada hallazgo indica gravedad y confianza, con evidencia; el reporte aclara qué se revisó, qué quedó fuera y sus límites.</p>
      <dl className="vb-terms" data-reveal="">
        {REPORT_TERMS.map(({ term, text }, index) => <div key={term} className="vb-term vb-rise" style={rise(index)}>
          <dt>{term}</dt>
          <dd>{text}</dd>
        </div>)}
      </dl>
    </div>
  </Section>;
}

export function TeamSection() {
  return <Section formation="mark">
    <div className="vb-col">
      <Title lines={['Que el equipo', 'tenga contexto.']} />
      <ol className="vb-team" data-reveal="">
        {TEAM.map(({ title, text }, index) => <li key={title} className="vb-rise" style={rise(index)}>
          <span className="vb-num">{String(index + 1).padStart(2, '0')}</span>
          <div><h3>{title}</h3><p>{text}</p></div>
        </li>)}
      </ol>
      <pre className="vb-json vb-rise" data-reveal="" tabIndex={0} aria-label="Forma del reporte en JSON"><code>
        <span>{'{'}</span>{'\n'}
        {'  '}<i>"internal"</i>{': { '}<i>"findings"</i>{': […], '}<i>"coverage"</i>{': […] },'}{'\n'}
        {'  '}<i>"external"</i>{': { '}<i>"findings"</i>{': […], '}<i>"coverage"</i>{': […] },'}{'\n'}
        {'  '}<i>"comparison"</i>{': […],'}{'\n'}
        {'  '}<i>"limitations"</i>{': […],'}{'\n'}
        {'  '}<i>"responseMode"</i>{': '}<b>"observation"</b>{','}{'\n'}
        {'  '}<i>"actionsPerformed"</i>{': []'}{'\n'}
        <span>{'}'}</span>
      </code></pre>
    </div>
  </Section>;
}

export function FaqSection() {
  return <Section id="vb-preguntas" formation="none" className="vb-faq-sec">
    <div className="vb-col vb-col-faq">
      <Title lines={['Antes de dar', 'el paso.']} />
      <div className="vb-faq" data-reveal="">
        {FAQ.map(({ q, a }, index) => <details key={q} className="vb-rise" style={rise(index)}>
          <summary><span>{q}</span><span className="vb-faq-icon"><UiIcon name="plus" size={20} /></span></summary>
          <p>{a}</p>
        </details>)}
      </div>
    </div>
  </Section>;
}

export function ClosingSection() {
  return <Section formation="wordmark" className="vb-closing">
    <div className="vb-closing-body">
      <Title lines={['Dale otra mirada.', 'Da el paso.']} accentFrom={1} className="vb-title-close" />
      <div className="vb-actions" data-reveal="">
        <span className="vb-rise"><Button href="/dashboard" data-catch="">Empezar mi revisión</Button></span>
      </div>
    </div>
  </Section>;
}

export function Footer() {
  return <footer className="vb-footer">
    <a className="vb-brand" href="#contenido" aria-label="Gotchu, volver al inicio de la página"><GotchuMark size={26} /><span>GOTCHU</span></a>
    <p>Tu app merece otra mirada.</p>
    <a className="vb-link" href="/dashboard">Abrir Gotchu</a>
  </footer>;
}
