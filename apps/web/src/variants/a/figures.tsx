import { useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

const BLOCKS = '░▒▓█';
/** The settled strip is only a visual rhythm, not a real digest. */
const FINGERPRINT = '▓░▒█░▓▒░█▒▓░░▒▓█▒░▓▒█░▒▓░';
const RECORD = '_gotchu.<dominio>  TXT';

/** Scrambles block glyphs for ~900ms, settling left to right on the final strip. */
function useScramble(final: string, active: boolean, duration = 900) {
  const reduced = useReducedMotion();
  const [text, setText] = useState(final);
  useEffect(() => {
    if (!active || reduced) return;
    const started = performance.now();
    const id = setInterval(() => {
      const progress = Math.min(1, (performance.now() - started) / duration);
      const settled = Math.floor(progress * final.length);
      const noise = Array.from({ length: final.length - settled }, () => BLOCKS[Math.floor(Math.random() * BLOCKS.length)]).join('');
      setText(final.slice(0, settled) + noise);
      if (progress >= 1) { clearInterval(id); setText(final); }
    }, 60);
    return () => clearInterval(id);
  }, [active, reduced, final, duration]);
  return text;
}

/** Types the text one character at a time (~40ms each) once active. */
function useTyped(full: string, active: boolean, speed = 40) {
  const reduced = useReducedMotion();
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (reduced) { setCount(full.length); return; }
    if (!active) return;
    let typed = 0;
    const id = setInterval(() => {
      typed += 1;
      setCount(typed);
      if (typed >= full.length) clearInterval(id);
    }, speed);
    return () => clearInterval(id);
  }, [active, reduced, full, speed]);
  const done = count >= full.length;
  return { text: full.slice(0, count), phase: done ? 'done' : active ? 'typing' : 'idle' } as const;
}

/** Folder outline, a version tag the user writes, and a SHA-256 fingerprint strip. */
export function SnapshotFigure() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.5 });
  const fingerprint = useScramble(FINGERPRINT, inView);
  return <div ref={ref} className="va-snap" data-in={inView || undefined} aria-hidden="true">
    <svg className="va-folder" width="148" height="104" viewBox="0 0 148 104" fill="none" shapeRendering="crispEdges">
      <path className="va-draw" pathLength={1} d="M3 14H52L62 26H145V101H3Z" stroke="#c7bfbd" strokeWidth="2" />
      <path d="M22 48h44M34 62h72M34 76h30M22 90h58" stroke="#646174" strokeWidth="2" />
      <path d="M70 48h2v2h-2zM110 62h2v2h-2zM68 76h2v2h-2z" fill="#e7147d" />
    </svg>
    <span className="va-link" />
    <span className="va-chip"><span className="va-chip-tag">v&lt;versión&gt;</span><i className="va-chip-caret" /></span>
    <span className="va-link" />
    <span className="va-fp"><span className="va-fp-label">SHA-256</span><span className="va-fp-bar">{fingerprint}</span></span>
  </div>;
}

/** `_gotchu.<dominio>  TXT` typed in, a caret that blinks three times, then the check draws. */
export function DnsFigure() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const { text, phase } = useTyped(RECORD, inView);
  return <div ref={ref} className="va-dns" data-phase={phase}>
    <span className="va-sr">Registro DNS TXT en _gotchu.&lt;dominio&gt;</span>
    <div className="va-dns-row" aria-hidden="true">
      <code className="va-dns-line"><span>{text}</span><i className="va-caret" /></code>
      <svg className="va-check" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#ff8fbe" strokeWidth="2.4" strokeLinecap="square"><path pathLength={1} d="M3 12.5 9 18.5 21 5.5" /></svg>
    </div>
    <p className="va-dns-ok" aria-hidden="true">Propiedad verificada</p>
  </div>;
}
