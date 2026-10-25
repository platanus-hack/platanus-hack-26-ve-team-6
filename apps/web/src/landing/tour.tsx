import { useEffect, useRef, useState } from 'react';
import { DotPlate } from '../components/dot-field/dot-plate';
import { CHAPTERS } from './copy';
import { Display } from './editorial';

/**
 * The product walkthrough: chapters scroll past a pinned dot field that morphs into each feature.
 * The chapter covering a band just below the middle of the viewport is the active one.
 */
export function Tour({ paused }: { paused: boolean }) {
  const [active, setActive] = useState(0);
  const chapters = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    // A thin band at 60% height: below the pinned field on phones, inside the centred chapter on desktop.
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const index = chapters.current.indexOf(entry.target instanceof HTMLLIElement ? entry.target : null);
        if (entry.isIntersecting && index >= 0) setActive(index);
      }
    }, { rootMargin: '-60% 0px -38% 0px' });
    for (const chapter of chapters.current) if (chapter) observer.observe(chapter);
    return () => observer.disconnect();
  }, []);

  const formation = CHAPTERS[active]?.formation ?? 'both';
  return <section id="gl-funciona" className="gl-section gl-tour" aria-labelledby="gl-funciona-titulo">
    <Display id="gl-funciona-titulo" className="gl-section-title" lines={['Cómo funciona.']} />
    <div className="gl-tour-body">
      <div className="gl-tour-stage">
        <DotPlate formation={formation} paused={paused} />
        <nav className="gl-tour-progress" aria-label="Recorrido">
          {CHAPTERS.map((chapter, index) => <a key={chapter.id} href={`#${chapter.id}`} aria-label={chapter.title} aria-current={index === active ? 'step' : undefined} />)}
        </nav>
      </div>
      <ol className="gl-tour-chapters">
        {CHAPTERS.map((chapter, index) => <li key={chapter.id} id={chapter.id} ref={element => { chapters.current[index] = element; }} data-active={index === active || undefined}>
          <span className="gl-tour-number" aria-hidden="true">0{index + 1}</span>
          <h3>{chapter.title}</h3>
          <p>{chapter.text}</p>
          {chapter.tags && <ul className="gl-tour-tags">{chapter.tags.map(tag => <li key={tag}>{tag}</li>)}</ul>}
        </li>)}
      </ol>
    </div>
  </section>;
}
