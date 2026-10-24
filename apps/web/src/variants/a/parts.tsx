import { motion } from 'motion/react';
import { useEffect, useState, type ReactNode, type RefObject } from 'react';

export type Side = 'l' | 'r' | 'c';

const ease = [0.23, 1, 0.32, 1] as const;
const tags = { div: motion.div, li: motion.li, p: motion.p, h2: motion.h2, span: motion.span } as const;

type RevealProps = {
  side?: Side;
  /** Position in a staggered group; each step adds 70ms. */
  index?: number;
  as?: keyof typeof tags;
  className?: string;
  children: ReactNode;
};

/**
 * Enters from its own side of the seam. Reduced motion is handled in CSS (`.va-reveal`),
 * so server and client render the same markup.
 */
export function Reveal({ side = 'c', index = 0, as = 'div', className = '', children }: RevealProps) {
  const Tag = tags[as];
  const x = side === 'l' ? -28 : side === 'r' ? 28 : 0;
  return <Tag
    className={`va-reveal ${className}`}
    initial={{ opacity: 0, x, y: side === 'c' ? 20 : 0 }}
    whileInView={{ opacity: 1, x: 0, y: 0 }}
    viewport={{ once: true, margin: '0px 0px -8% 0px' }}
    transition={{ duration: 0.7, ease, delay: index * 0.07 }}
  >{children}</Tag>;
}

/** True while the element is on screen and the tab is visible; continuous loops key off this. */
export function useLive(ref: RefObject<Element | null>) {
  const [visible, setVisible] = useState(true);
  const [awake, setAwake] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    observer.observe(element);
    const sync = () => setAwake(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', sync); };
  }, [ref]);
  return visible && awake;
}

export function Arrow() {
  return <svg className="va-arrow" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true" focusable="false"><path d="M4 12h16m-6-6 6 6-6 6" /></svg>;
}
