import { useEffect, useRef, useState } from 'react';
import { GotchuMark } from '../../components/gotchu-mark';
import { UiIcon } from '../../components/ui';
import { NAV } from './copy';

/** Fixed header: transparent over the field, graphite once scrolled; hides while scrolling down. */
export function Header() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [view, setView] = useState({ hidden: false, solid: false });
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let lastY = window.scrollY;
    let hidden = false;
    const onScroll = () => {
      const y = window.scrollY;
      if (Math.abs(y - lastY) > 8) {
        hidden = y > lastY && y > 96;
        lastY = y;
      }
      if (y <= 96) hidden = false;
      const solid = y > 24;
      setView(current => (current.hidden === hidden && current.solid === solid ? current : { hidden, solid }));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      toggle.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const hidden = view.hidden && !menuOpen;
  return <header className="vb-header" data-hidden={hidden || undefined} data-solid={view.solid || menuOpen || undefined}>
    <a className="vb-brand" href="#contenido" aria-label="Gotchu, inicio"><GotchuMark size={26} /><span>GOTCHU</span></a>
    <nav id="vb-nav" className="vb-nav" aria-label="Principal" data-open={menuOpen || undefined}>
      {NAV.map(item => <a key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>{item.label}</a>)}
    </nav>
    <a className="vb-header-cta" href="/dashboard">Abrir Gotchu <UiIcon name="arrow" size={16} /></a>
    <button ref={toggle} type="button" className="vb-menu" aria-expanded={menuOpen} aria-controls="vb-nav" aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'} onClick={() => setMenuOpen(open => !open)}>
      <UiIcon name={menuOpen ? 'close' : 'grid'} size={20} />
    </button>
  </header>;
}
