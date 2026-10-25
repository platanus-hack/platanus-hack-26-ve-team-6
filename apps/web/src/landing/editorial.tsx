import { Fragment, useEffect, useRef, type ReactNode } from 'react';

// Lets inline styles pass the `--gl-*` custom properties the stylesheet reads.
declare module 'react' {
  interface CSSProperties {
    [key: `--gl-${string}`]: string | number | undefined;
  }
}

/**
 * Marks the element `data-on="true"` once, when it is `margin` inside the viewport (or already scrolled past).
 * The stylesheet owns what "on" looks like, so React never re-renders for it.
 */
export function useReveal<T extends HTMLElement>(margin = '0px 0px -40% 0px') {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const passed = entry.boundingClientRect.bottom < (entry.rootBounds?.top ?? 0);
        if (!entry.isIntersecting && !passed) continue;
        entry.target.setAttribute('data-on', 'true');
        observer.disconnect();
      }
    }, { rootMargin: margin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [margin]);
  return ref;
}

/**
 * Writes `--gl-q` on the element while motion is on: its distance from the viewport centre, -1 (above) to 1
 * (below). The stylesheet turns it into parallax under `[data-parallax]`; React never re-renders for it.
 */
export function useParallax<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    element.dataset.parallax = '';
    let frame = 0;
    const update = () => {
      frame = 0;
      const box = element.getBoundingClientRect();
      const distance = (box.top + box.height / 2 - innerHeight / 2) / innerHeight;
      element.style.setProperty('--gl-q', Math.min(1, Math.max(-1, distance)).toFixed(3));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule);
    return () => {
      removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
      delete element.dataset.parallax;
      element.style.removeProperty('--gl-q');
    };
  }, [enabled]);
  return ref;
}

type MarkProps = {
  children: ReactNode;
  /** `body`: graphite on pink band. `big`: porcelain on magenta band, large type only. */
  size?: 'body' | 'big';
  /** Stagger between phrases of the same block, in ms. */
  delay?: number;
  /** Sweep on page load instead of on scroll (hero). */
  load?: boolean;
  /** Sweep only while the parent `.gl-sweep-host` is hovered or focused. */
  hover?: boolean;
};

/** A highlighter stroke that sweeps across a phrase, and keeps working across line breaks. */
export function Mark({ children, size = 'body', delay = 0, load = false, hover = false }: MarkProps) {
  const ref = useReveal<HTMLSpanElement>();
  const className = `gl-mark gl-mark--${size}${load ? ' gl-mark--load' : ''}${hover ? ' gl-mark--hover' : ''}`;
  return <span ref={load ? undefined : ref} className={className} style={{ '--gl-delay': `${delay}ms` }}>{size === 'big' ? <span className="gl-mark-ink">{children}</span> : children}</span>;
}

type DisplayProps = {
  as?: 'h1' | 'h2' | 'h3';
  lines: ReactNode[];
  id?: string;
  className?: string;
  /** Reveal on load rather than on scroll. */
  eager?: boolean;
};

/** Display headline whose lines unmask one after another. */
export function Display({ as: Tag = 'h2', lines, id, className = '', eager = false }: DisplayProps) {
  const ref = useReveal<HTMLHeadingElement>('0px 0px -12% 0px');
  return <Tag ref={eager ? undefined : ref} id={id} className={`gl-display${eager ? ' gl-display--load' : ''} ${className}`}>
    {lines.map((line, index) => <Fragment key={index}>
      <span className="gl-line"><span className="gl-line-in" style={{ '--gl-i': index }}>{line}</span></span>{' '}
    </Fragment>)}
  </Tag>;
}
