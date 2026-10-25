import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, GitBranchIcon, GlobeIcon, LockIcon } from 'lucide-react';
import { REPO_SCANS, REPO_STEPS, WEB_STEPS, type FlowStep } from './copy';

const LAST = 3;
/** The four steps plus a short hold on the finished report. */
const SPAN = 4.6;

type FlowProps = { label: string; steps: readonly FlowStep[]; nodes: readonly ReactNode[]; motion: boolean; action: ReactNode };
type Props = { motion: boolean; action: ReactNode };

/** Where the diagram's top sits when the run starts and how far it travels until the run ends. */
function runWindow(height: number) {
  const start = innerHeight * 0.92;
  return { start, length: innerHeight * 0.12 + height };
}

/**
 * An audit as four nodes joined by wires, in the normal page flow. As it scrolls through the viewport each
 * node rises into place and lights, the wire into it draws with a packet at its tip, and the section's
 * headline lines drift apart and back. Scroll writes `--gl-at` (0 → 4.6, step i active from i) and `--gl-q`
 * (-1 → 1, the section's distance from the viewport centre) on the section, never React state; only the
 * active step re-renders. Without motion every step shows its finished state.
 */
function AuditFlow({ label, steps, nodes, motion, action }: FlowProps) {
  const root = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState(LAST);

  useEffect(() => {
    const element = root.current;
    const section = element?.closest('section');
    if (!element || !section || !motion) { setStage(LAST); return; }
    section.dataset.parallax = '';
    let frame = 0;
    const update = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const { start, length } = runWindow(box.height);
      const progress = Math.min(1, Math.max(0, (start - box.top) / length));
      const around = section.getBoundingClientRect();
      const distance = (around.top + around.height / 2 - innerHeight / 2) / innerHeight;
      section.style.setProperty('--gl-at', (progress * SPAN).toFixed(3));
      section.style.setProperty('--gl-q', Math.min(1, Math.max(-1, distance)).toFixed(3));
      setStage(Math.min(LAST, Math.floor(progress * SPAN)));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule);
    return () => {
      removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
      delete section.dataset.parallax;
      section.style.removeProperty('--gl-at');
      section.style.removeProperty('--gl-q');
    };
  }, [motion]);

  /** Scrolls to the point where `index` is the active step. */
  const show = (index: number) => {
    const element = root.current;
    if (!element || !motion) return;
    const box = element.getBoundingClientRect();
    const { start, length } = runWindow(box.height);
    scrollTo({ top: scrollY + box.top - (start - length * (index + 0.4) / SPAN), behavior: 'smooth' });
  };

  const shown = motion ? stage : LAST;
  return <div ref={root} className="gl-flow" role="group" aria-label={label}>
    <ol>
      {steps.map((step, index) => <li key={step.title} data-state={index < shown ? 'done' : index === shown ? 'active' : 'idle'} style={{ '--gl-i': index }}>
        {index > 0 && <span className="gl-flow-wire" aria-hidden="true"><span className="gl-flow-packet" /></span>}
        <div className="gl-flow-node" aria-hidden="true">{nodes[index]}</div>
        <button type="button" className="gl-flow-step" aria-current={index === shown ? 'step' : undefined} onClick={() => show(index)}>
          <span className="gl-flow-number">0{index + 1}</span>
          <strong>{step.title}</strong>
          <span className="gl-flow-text">{step.text}</span>
        </button>
      </li>)}
    </ol>
    <div className="gl-flow-foot">{action}</div>
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
