import { Fragment, useEffect, useRef, type ReactNode } from 'react';

// Lets inline styles pass the `--vc-*` custom properties the stylesheet reads.
declare module 'react' {
  interface CSSProperties {
    [key: `--vc-${string}`]: string | number | undefined;
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

type MarkProps = {
  children: ReactNode;
  /** `body`: graphite on pink band. `big`: porcelain on magenta band, large type only. */
  size?: 'body' | 'big';
  /** Stagger between phrases of the same block, in ms. */
  delay?: number;
  /** Sweep on page load instead of on scroll (hero). */
  load?: boolean;
  /** Sweep only while the parent `.vc-sweep-host` is hovered or focused. */
  hover?: boolean;
};

/** A highlighter stroke that sweeps across a phrase, and keeps working across line breaks. */
export function Mark({ children, size = 'body', delay = 0, load = false, hover = false }: MarkProps) {
  const ref = useReveal<HTMLSpanElement>();
  const className = `vc-mark vc-mark--${size}${load ? ' vc-mark--load' : ''}${hover ? ' vc-mark--hover' : ''}`;
  return <span ref={load ? undefined : ref} className={className} style={{ '--vc-delay': `${delay}ms` }}>{children}</span>;
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
  return <Tag ref={eager ? undefined : ref} id={id} className={`vc-display${eager ? ' vc-display--load' : ''} ${className}`}>
    {lines.map((line, index) => <Fragment key={index}>
      <span className="vc-line"><span className="vc-line-in" style={{ '--vc-i': index }}>{line}</span></span>{' '}
    </Fragment>)}
  </Tag>;
}

/** Margin note: a fact that belongs to the paragraph it sits beside; slides in with it. */
export function Note({ n, children }: { n: number; children: ReactNode }) {
  const ref = useReveal<HTMLElement>('0px 0px -14% 0px');
  return <aside ref={ref} className="vc-note"><sup className="vc-ref">{n}</sup> {children}</aside>;
}

/** Superscript pointer in running text to the note with the same number. */
export function Ref({ n }: { n: number }) {
  return <sup className="vc-ref" aria-hidden="true">{n}</sup>;
}
