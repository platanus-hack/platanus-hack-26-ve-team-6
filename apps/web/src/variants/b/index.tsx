import '../../styles/tokens.css';
import './b.css';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useReducedMotion } from 'motion/react';
import { SCOPES } from './copy';
import { Header } from './header';
import { BothSection, ClosingSection, CodeSection, DomainSection, FaqSection, Footer, Hero, ReportSection, ScopeSection, TeamSection } from './sections';
import { useField } from './use-field';

/** Marks `[data-reveal]` blocks as hidden until they scroll into view. Without JS or with reduced motion everything stays visible. */
function useReveals(root: RefObject<HTMLDivElement | null>, reduced: boolean) {
  useEffect(() => {
    const page = root.current;
    if (!page || reduced) return;
    page.dataset.armed = '';
    const observer = new IntersectionObserver((entries, self) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute('data-in', '');
        self.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -10% 0px' });
    page.querySelectorAll('[data-reveal]').forEach(element => observer.observe(element));
    return () => {
      observer.disconnect();
      delete page.dataset.armed;
    };
  }, [root, reduced]);
}

function PauseIcon({ paused }: { paused: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
    {paused ? <path d="M4 2.5v11l9-5.5z" /> : <path d="M3.5 2h3v12h-3zM9.5 2h3v12h-3z" />}
  </svg>;
}

/** Landing variant B, "Campo vivo": one particle field behind the page re-forms for each section. */
export function VariantB() {
  const page = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion() === true;
  const [paused, setPaused] = useState(false);
  const [scopeIndex, setScopeIndex] = useState(0);
  const scope = SCOPES[scopeIndex] ?? SCOPES[0];

  useField(canvas, { paused, reduced, scope: scope.formation });
  useReveals(page, reduced);

  return <div ref={page} className="g-page v-b">
    <a className="vb-skip" href="#contenido">Saltar al contenido</a>
    <canvas ref={canvas} className="vb-field" aria-hidden="true" />
    <Header />
    <main id="contenido" tabIndex={-1} className="vb-main">
      <Hero />
      <CodeSection />
      <DomainSection />
      <BothSection />
      <ScopeSection index={scopeIndex} onChange={setScopeIndex} />
      <ReportSection />
      <TeamSection />
      <FaqSection />
      <ClosingSection />
    </main>
    <Footer />
    {!reduced && <button type="button" className="vb-pause" aria-pressed={paused} aria-label={paused ? 'Reanudar animación' : 'Pausar animación'} onClick={() => setPaused(value => !value)}>
      <PauseIcon paused={paused} />
    </button>}
  </div>;
}
