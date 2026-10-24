import { motion, useMotionValue, useReducedMotion, useScroll, useSpring, useTransform } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { AsciiMark } from '../../components/ascii-mark';
import { CodeWorld, WebWorld } from './textures';

/** Pinned layout: wide screens that allow motion. Everything else renders the static stack. */
const PINNED = '(min-width: 760px) and (prefers-reduced-motion: no-preference)';
const SLIDE_START = 0.04;
const SLIDE_END = 0.66;
const MERGED_AT = 0.68;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const slide = (progress: number) => clamp01((progress - SLIDE_START) / (SLIDE_END - SLIDE_START));

/**
 * The two grounds slide apart while the brackets close on the finding, then the statement arrives.
 * Scroll always moves the page: the frame is only sticky, never captured.
 */
export function MergeSection() {
  const section = useRef<HTMLElement>(null);
  const markBox = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [pulses, setPulses] = useState(0);
  const pinnedLayout = useMotionValue(0);

  const { scrollYProgress: pinnedProgress } = useScroll({ target: section, offset: ['start start', 'end end'] });
  // Without the pinned frame the mark simply closes as it scrolls through the viewport.
  const { scrollYProgress: flowProgress } = useScroll({ target: markBox, offset: ['start 90%', 'center 45%'] });
  // Read both sources every time so the computed value tracks either one when the layout changes.
  const raw = useTransform(() => {
    const pinned = pinnedProgress.get();
    const flowing = flowProgress.get();
    return pinnedLayout.get() ? pinned : flowing;
  });
  const progress = useSpring(raw, { duration: 0.3, bounce: 0 });

  const open = useTransform(() => 1 - (pinnedLayout.get() ? slide(progress.get()) : clamp01(progress.get())));
  const leftX = useTransform(() => `${-slide(progress.get()) * 100}%`);
  const rightX = useTransform(() => `${slide(progress.get()) * 100}%`);
  // The mark starts on the seam wherever the visitor dragged it, then settles at the centre.
  const markX = useTransform(() => `calc((var(--va-split) - 50) * ${1 - slide(progress.get())} * 1cqw)`);
  const statementOpacity = useTransform(progress, [0.66, 0.88], [0, 1]);
  const statementY = useTransform(progress, [0.66, 0.88], [24, 0]);

  useEffect(() => {
    const query = matchMedia(PINNED);
    const sync = () => pinnedLayout.set(query.matches ? 1 : 0);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [pinnedLayout]);

  // Pulse once each time the halves finish merging on the way down.
  useEffect(() => {
    let merged = false;
    return progress.on('change', value => {
      const now = pinnedLayout.get() === 1 && value >= MERGED_AT;
      if (now && !merged) setPulses(count => count + 1);
      merged = now;
    });
  }, [pinnedLayout, progress]);

  return <section ref={section} className="va-merge" aria-labelledby="va-merge-title">
    <div className="va-merge-frame">
      <div className="va-field" aria-hidden="true" />
      <motion.div className="va-pane is-l va-merge-pane" style={{ x: leftX }} aria-hidden="true"><CodeWorld /></motion.div>
      <motion.div className="va-pane is-r va-merge-pane" style={{ x: rightX }} aria-hidden="true"><WebWorld /></motion.div>
      <div className="va-merge-stack">
        <motion.div ref={markBox} className="va-merge-mark" style={{ x: markX }} aria-hidden="true">
          <AsciiMark {...(reduced ? {} : { open })} rest={0} />
          {pulses > 0 && <div key={pulses} className="va-rings"><i /><i /></div>}
        </motion.div>
        <motion.div className="va-statement" style={{ opacity: statementOpacity, y: statementY }}>
          <h2 id="va-merge-title"><span>Cada hallazgo.</span> <span>Su evidencia.</span></h2>
          <p>Cada hallazgo indica gravedad y confianza, con evidencia; el reporte aclara qué se revisó, qué quedó fuera y sus límites.</p>
        </motion.div>
      </div>
    </div>
  </section>;
}
