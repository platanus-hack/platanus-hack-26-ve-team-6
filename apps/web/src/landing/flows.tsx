import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, GitBranchIcon, GlobeIcon, LockIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';
import { REPO_SCANS, REPO_STEPS, WEB_STEPS, type FlowStep } from './copy';

const STEP_MS = 2000;
const HOLD_MS = 3000;
const LAST = 3;

type FlowProps = { label: string; steps: readonly FlowStep[]; nodes: readonly ReactNode[]; motion: boolean; paused: boolean; action: ReactNode };
type Props = { motion: boolean; paused: boolean; action: ReactNode };

/**
 * An audit as four nodes joined by wires. While it is on screen the nodes light in turn and a packet
 * travels each wire, then the whole run repeats. Choosing a step or pausing holds it; without motion
 * every step shows its finished state.
 */
function AuditFlow({ label, steps, nodes, motion, paused, action }: FlowProps) {
  const root = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState(LAST);
  const [visible, setVisible] = useState(false);
  const [held, setHeld] = useState(false);
  const running = motion && visible && !paused && !held;

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let started = false;
    const observer = new IntersectionObserver(([entry]) => {
      const inView = entry?.isIntersecting ?? false;
      // The first time it comes into view the run starts from the first step.
      if (inView && !started) { started = true; setStage(0); }
      setVisible(inView);
    }, { rootMargin: '0px 0px -25% 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => setStage(current => current === LAST ? 0 : current + 1), stage === LAST ? HOLD_MS : STEP_MS);
    return () => clearTimeout(timer);
  }, [running, stage]);

  const shown = motion ? stage : LAST;
  // The active step's bar fills over the time it stays on screen; `data-running` turns the fill on.
  return <div ref={root} className="gl-flow" role="group" aria-label={label} data-running={running || undefined} style={{ '--gl-step': `${STEP_MS}ms`, '--gl-hold': `${HOLD_MS}ms` }}>
    <ol>
      {steps.map((step, index) => <li key={step.title} data-state={index < shown ? 'done' : index === shown ? 'active' : 'idle'}>
        {index > 0 && <span className="gl-flow-wire" aria-hidden="true"><span className="gl-flow-packet" /></span>}
        <div className="gl-flow-node" aria-hidden="true">{nodes[index]}</div>
        <button type="button" className="gl-flow-step" aria-pressed={index === shown} onClick={() => { setHeld(true); setStage(index); }}>
          <span className="gl-flow-number">0{index + 1}</span>
          <strong>{step.title}</strong>
          <span className="gl-flow-text">{step.text}</span>
        </button>
      </li>)}
    </ol>
    <div className="gl-flow-foot">
      {action}
      {motion && <Toggle variant="outline" pressed={held} onPressedChange={setHeld} aria-label={held ? 'Reanudar animación' : 'Pausar animación'}>
        {held ? <PlayIcon aria-hidden="true" className="size-3" /> : <PauseIcon aria-hidden="true" className="size-3" />}
      </Toggle>}
    </div>
  </div>;
}

/** An abstract fingerprint: a fixed pattern of pixels, not a real digest. */
const PRINT = [1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1];

function Report() {
  return <span className="gl-sheet">{[0, 1, 2, 3].map(row => <i key={row} data-finding={row === 1 || undefined} style={{ '--gl-i': row }} />)}</span>;
}

const REPO_NODES = [
  <><GitBranchIcon /><span>tu-org/app</span></>,
  <><span className="gl-print">{PRINT.map((on, index) => <i key={index} data-on={on || undefined} style={{ '--gl-i': index }} />)}</span><span>SHA-256</span></>,
  <ul className="gl-lanes">{REPO_SCANS.map((scan, index) => <li key={scan} style={{ '--gl-i': index }}><span>{scan}</span><i /></li>)}</ul>,
  <Report />,
];

const WEB_NODES = [
  <><span className="gl-record-name">_gotchu.<br />tudominio.com</span><span className="gl-record-type">TXT</span></>,
  <span className="gl-dns"><GlobeIcon /><CheckIcon className="gl-dns-check" /></span>,
  <><LockIcon /><span className="gl-request" style={{ '--gl-i': 0 }}>GET /</span><span className="gl-request" style={{ '--gl-i': 1 }}>TLS verificado</span></>,
  <Report />,
];

export function RepoFlow(props: Props) {
  return <AuditFlow label="Auditoría de un repositorio de GitHub" steps={REPO_STEPS} nodes={REPO_NODES} {...props} />;
}

export function WebFlow(props: Props) {
  return <AuditFlow label="Auditoría externa de una web" steps={WEB_STEPS} nodes={WEB_NODES} {...props} />;
}
