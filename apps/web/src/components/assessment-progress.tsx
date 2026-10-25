import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { AssessmentMode, CustomerAssessmentReport } from '@gotchu/contracts';
import type { CustomerJob } from './customer-client';
import {
  PHASES, applyStep, coverageCount, frontier, idlePhaseStates, isSettled, jobPhaseStates, jobPhaseTimes, phaseEdges, phaseSteps,
  reportPhaseStates, reportPhaseTimes, visiblePhases, type Phase, type PhaseState, type PhaseStates, type PhaseStep, type PhaseTimes,
} from './assessment-progress-model';
import './assessment-progress.css';

const STEP_MS = 350;
const SETTLED_HOLD_MS = 900;
const LABELS: Record<Phase, string> = { queue: 'Cola', validation: 'Validación', internal: 'Interno', external: 'Externo', correlation: 'Correlación', report: 'Informe' };
const inactive = (state: PhaseState) => state === 'skipped' || state === 'not_requested';
const stateKey = (states: PhaseStates) => PHASES.map(phase => states[phase]).join();

function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
const duration = (ms: number) => `${Math.max(0.1, ms / 1000).toFixed(1)} s`;

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/**
 * Shows the latest server state one step at a time. Polls can skip several phases (validation and
 * correlation take milliseconds), so every missed transition is replayed in order. The first known
 * state is shown directly: reopening the page mid-run does not replay history.
 */
function useSequencedPhases(target: PhaseStates, known: boolean) {
  const [shown, setShown] = useState(target);
  const queued = useRef<PhaseStep[]>([]);
  const latest = useRef(target);
  const baseline = useRef(known);
  const timer = useRef<number | null>(null);
  const key = stateKey(target);
  useEffect(() => {
    if (!known) return;
    if (!baseline.current) {
      baseline.current = true; latest.current = target; setShown(target);
      return;
    }
    queued.current.push(...phaseSteps(latest.current, target));
    latest.current = target;
    if (timer.current !== null || queued.current.length === 0) return;
    const next = () => {
      const step = queued.current.shift();
      if (!step) { timer.current = null; return; }
      setShown(current => applyStep(current, step));
      timer.current = window.setTimeout(next, STEP_MS);
    };
    next();
  }, [key, known]); // `key` changes exactly when `target` does.
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; }, []);
  return { shown, settled: stateKey(shown) === key && isSettled(shown) };
}

type Edge = { from: Phase; to: Phase; d: string; length: number };

function PhaseGraph({ states, times, notes, hints, now }: {
  states: PhaseStates;
  times: PhaseTimes;
  notes?: Partial<Record<Phase, string>>;
  hints: Partial<Record<Phase, string>>;
  now: number;
}) {
  const wrapper = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [instant, setInstant] = useState(true);
  const reduced = useReducedMotion();

  const drawn = visiblePhases(states);
  const shape = drawn.join();
  // Anchors move only when the width or the drawn phases change: node heights do not depend on their state.
  useLayoutEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    let width = -1;
    let frame = 0;
    const layout = () => {
      const box = element.getBoundingClientRect();
      const rect = (phase: Phase) => element.querySelector(`[data-phase="${phase}"]`)?.getBoundingClientRect();
      const next: Edge[] = [];
      for (const [from, to] of phaseEdges(states)) {
        const a = rect(from), b = rect(to);
        if (!a || !b) continue;
        const horizontal = b.left >= a.right - 1;
        const [x1, y1, x2, y2] = horizontal
          ? [a.right - box.left, a.top + a.height / 2 - box.top, b.left - box.left, b.top + b.height / 2 - box.top]
          : [a.left + a.width / 2 - box.left, a.bottom - box.top, b.left + b.width / 2 - box.left, b.top - box.top];
        const d = horizontal
          ? `M${x1} ${y1} C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}`
          : `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
        // The control polygon bounds the curve, so this dash length always hides an unlit edge.
        next.push({ from, to, d, length: Math.abs(x2 - x1) + Math.abs(y2 - y1) + 2 });
      }
      // Redrawn edges appear in their current state instead of animating again.
      setInstant(true);
      setEdges(next);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setInstant(false)); });
    };
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.round(entry?.contentRect.width ?? 0);
      if (nextWidth !== width) { width = nextWidth; layout(); }
    });
    observer.observe(element);
    document.fonts?.ready.then(layout).catch(() => undefined);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
    // Edges depend only on which phases are drawn (`shape`), not on their states.
  }, [shape]);

  const meta = (phase: Phase) => {
    const state = states[phase], span = times[phase];
    if (notes?.[phase] && state !== 'running') return notes[phase];
    switch (state) {
      case 'pending': return 'Pendiente';
      case 'not_requested': return 'No solicitado';
      case 'skipped': return 'No se ejecutó';
      case 'failed': return 'No finalizó';
      case 'running': return span ? elapsed(now - span.start) : 'En curso';
      case 'done': return span?.end != null ? duration(span.end - span.start) : 'Completado';
    }
  };

  const single = !drawn.includes('correlation');
  return <div ref={wrapper} className={`customer-progress-graph${single ? ' is-single' : ''}${instant ? ' is-instant' : ''}`}>
    <svg aria-hidden="true">
      {edges.map(edge => {
        const lit = states[edge.from] === 'done' && !inactive(states[edge.to]);
        const off = inactive(states[edge.from]) || inactive(states[edge.to]);
        return <g key={`${edge.from}-${edge.to}`}>
          <path className={`customer-progress-edge${off ? ' is-off' : ''}`} d={edge.d} />
          <path className="customer-progress-edge is-lit" d={edge.d} style={{ strokeDasharray: edge.length, strokeDashoffset: lit ? 0 : edge.length }} />
          {lit && states[edge.to] === 'running' && !reduced && <circle className="customer-progress-dot" r={3}><animateMotion dur="1.4s" repeatCount="indefinite" path={edge.d} /></circle>}
        </g>;
      })}
    </svg>
    <ol className="customer-progress-nodes">
      {drawn.map(phase => <li key={phase} data-phase={phase} className={`customer-progress-node is-${states[phase]}`} aria-current={states[phase] === 'running' ? 'step' : undefined}>
        <span className="customer-progress-label"><PhaseIcon state={states[phase]} /><span>{LABELS[phase]}{hints[phase] && <em> · {hints[phase]}</em>}</span></span>
        <span className="customer-progress-meta">{meta(phase)}</span>
      </li>)}
    </ol>
  </div>;
}

const RING = [0, 1, 2, 5, 8, 7, 6, 3]; // clockwise order of the outer cells of the 3x3 grid
function PhaseIcon({ state }: { state: PhaseState }) {
  if (state === 'running') return <span className="customer-progress-icon" aria-hidden="true"><span className="customer-progress-pixels">
    {Array.from({ length: 9 }, (_, cell) => <i key={cell} style={{ '--i': RING.indexOf(cell) } as CSSProperties} />)}
  </span></span>;
  return <span className="customer-progress-icon" aria-hidden="true">
    {state === 'done' && <svg viewBox="0 0 10 10"><path d="M2 5.2l2 2L8 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    {state === 'failed' && <svg viewBox="0 0 10 10"><path d="M3 3l4 4M7 3L3 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>}
  </span>;
}

const laneHints = (inputKind: CustomerJob['inputKind'] | 'container_image' | undefined): Partial<Record<Phase, string>> =>
  ({ internal: inputKind === 'container_image' ? 'imagen' : 'código', external: 'HTTPS' });

/** What the panel shows before a job exists. */
export type ProgressWaiting = 'idle' | 'submitting' | 'loading';
const WAITING: Record<ProgressWaiting, { title: string; detail: string }> = {
  idle: { title: 'Lista para empezar', detail: 'El análisis empieza cuando lo pidas.' },
  submitting: { title: 'Registrando solicitud', detail: 'Guardando el alcance y la solicitud.' },
  loading: { title: 'Consultando estado', detail: 'Leyendo el último análisis de este proyecto.' },
};

function heading(states: PhaseStates, purpose: 'assessment' | 'correction', internalHint: string | undefined) {
  const current = frontier(states);
  const failed = PHASES.some(phase => states[phase] === 'failed');
  const correction = purpose === 'correction';
  if (failed) return { title: correction ? 'Análisis independiente no finalizado' : 'Evaluación no finalizada', detail: 'Los informes anteriores siguen disponibles.' };
  if (current === null) return { title: correction ? 'Análisis independiente finalizado' : 'Evaluación finalizada', detail: 'Abriendo el informe…' };
  if (current === 'queue') return { title: correction ? 'Análisis independiente en cola' : 'Evaluación en cola', detail: 'Esperando a un worker disponible.' };
  const title = correction ? 'Analizando instantánea privada' : 'Evaluación en curso';
  if (current === 'validation') return { title, detail: 'Comprobando la autorización y la instantánea.' };
  if (current === 'internal' || current === 'external') {
    const lanes = (['internal', 'external'] as const).filter(phase => states[phase] === 'running');
    const detail = lanes.length === 2 ? 'Análisis interno y externo en paralelo.'
      : lanes[0] === 'external' ? 'Probando el origen HTTPS autorizado.'
      : internalHint === 'imagen' ? 'Revisando la imagen de contenedor.' : 'Revisando el código fuente.';
    return { title, detail };
  }
  if (current === 'correlation') return { title, detail: 'Cruzando hallazgos internos y externos.' };
  return { title, detail: 'Guardando el informe con sus evidencias.' };
}

/**
 * Live phase graph for one job. Before the job exists, `mode` draws its branches and `waiting` says why
 * nothing has started. It reports `settled` once its last transition has been shown.
 */
export function AssessmentProgress({ purpose, job, mode, waiting = 'loading', failure, error, retry, onSettled, onDismiss }: {
  purpose: 'assessment' | 'correction';
  job: CustomerJob | undefined;
  mode?: AssessmentMode;
  waiting?: ProgressWaiting;
  /** Why the job failed, shown once the graph has reached the failed phase. */
  failure: string | null;
  error: string | null;
  retry: () => void;
  onSettled?: (job: CustomerJob) => void;
  onDismiss?: () => void;
}) {
  const layout = job?.mode ?? mode;
  const target = job ? jobPhaseStates(job) : idlePhaseStates(layout ?? 'both');
  const { shown, settled } = useSequencedPhases(target, job !== undefined);
  const times = job ? jobPhaseTimes(job) : {};
  const [now, setNow] = useState(() => Date.now());
  const live = job !== undefined && !settled;
  useEffect(() => {
    if (!live) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [live]);
  // Hold the completed graph briefly so the last phase is seen before the report opens.
  const reported = useRef(false);
  useEffect(() => {
    if (!settled || !job || !onSettled || reported.current) return;
    const timeout = window.setTimeout(() => { reported.current = true; onSettled(job); }, SETTLED_HOLD_MS);
    return () => window.clearTimeout(timeout);
  }, [settled, job, onSettled]);

  const hints = laneHints(job?.inputKind);
  const failedShown = PHASES.some(phase => shown[phase] === 'failed');
  // Without a job, a failed status read must not look like progress or like a stopped analysis.
  const { title, detail } = job ? heading(shown, purpose, hints.internal)
    : error ? { title: 'Estado sin confirmar', detail: 'No se pudo consultar el estado. Esto no confirma que el análisis se haya detenido.' }
    : WAITING[waiting];
  const notes: Partial<Record<Phase, string>> = job?.state === 'succeeded' && !job.reportId ? { report: 'Sin informe guardado' } : {};
  const started = job ? Date.parse(job.createdAt) : null;
  const ended = job?.completedAt ? Date.parse(job.completedAt) : null;
  const busy = job ? job.state === 'queued' || job.state === 'running' : !error && waiting !== 'idle';
  return <section id="customer-active-job" className="customer-card customer-progress" aria-label="Progreso de la evaluación" aria-busy={busy}>
    <div className="customer-progress-head">
      <div><strong>{title}</strong><p>{job && error ? 'No se pudo actualizar el estado. El trabajo puede continuar en segundo plano.' : failedShown && failure ? failure : detail}</p></div>
      {started !== null && <span className="customer-progress-clock">{elapsed((ended ?? now) - started)}</span>}
    </div>
    <p className="sr-only" role="status" aria-live="polite">{title}</p>
    {/* The branches depend on the job's mode, so the graph waits for it unless the caller already knows it. */}
    {layout && <PhaseGraph states={shown} times={times} notes={notes} hints={hints} now={now} />}
    {error && <button className="customer-link-button" type="button" onClick={retry}>Actualizar estado del análisis</button>}
    {failedShown && settled && onDismiss && <button className="customer-link-button" type="button" onClick={onDismiss}>Descartar</button>}
  </section>;
}

/** How a finished report was produced, from the report's own timings and coverage. */
export function ReportProgress({ report, job }: { report: CustomerAssessmentReport; job: CustomerJob | undefined }) {
  const notes: Partial<Record<Phase, string>> = {};
  for (const phase of ['internal', 'external'] as const) {
    const analysis = report[phase], count = coverageCount(analysis), span = reportPhaseTimes(report)[phase];
    if (!analysis || !count || span?.end == null) continue;
    if (analysis.status === 'unavailable') { notes[phase] = 'No disponible'; continue; }
    const coverage = count.total > 0 ? `${count.inspected}/${count.total} capacidades · ` : '';
    notes[phase] = `${coverage}${analysis.status === 'partial' ? 'parcial · ' : ''}${duration(span.end - span.start)}`;
  }
  const hints = laneHints(report.subject.containerImageDigest ? 'container_image' : 'source_snapshot');
  return <section className="customer-report-progress" aria-label="Cómo se obtuvo el informe">
    <h3>Cómo se obtuvo</h3>
    <PhaseGraph states={reportPhaseStates(report)} times={reportPhaseTimes(report, job)} notes={notes} hints={hints} now={Date.parse(report.finishedAt)} />
  </section>;
}
