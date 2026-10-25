import { useEffect, useState } from 'react';
import { MenuIcon, XIcon } from 'lucide-react';
import { Dialog } from '@base-ui/react/dialog';
import { GotchuMark } from '../components/gotchu-mark';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ThemeSwitch } from '../components/theme-switch';

const LINKS = [
  { href: '#gl-auditoria', label: 'Auditoría' },
  { href: '#gl-evidencia', label: 'Evidencia' },
  { href: '#gl-preguntas', label: 'Preguntas' },
] as const;

/** Tucks the header away while scrolling down and returns it on any scroll up. */
function useHeaderTucking() {
  const [tucked, setTucked] = useState(false);
  useEffect(() => {
    let last = scrollY, pending = 0;
    const update = () => {
      pending = 0;
      const delta = scrollY - last;
      if (Math.abs(delta) < 8) return;
      setTucked(delta > 0 && scrollY > 160);
      last = scrollY;
    };
    const onScroll = () => { if (!pending) pending = requestAnimationFrame(update); };
    addEventListener('scroll', onScroll, { passive: true });
    return () => { removeEventListener('scroll', onScroll); cancelAnimationFrame(pending); };
  }, []);
  return tucked;
}

export function Header() {
  const tucked = useHeaderTucking();
  const [open, setOpen] = useState(false);
  return <header className={`gl-header${tucked && !open ? ' is-tucked' : ''}`}>
    <div className="gl-header-in">
      <a className="gl-brand" href="#gl-mirada" aria-label="Gotchu, inicio"><GotchuMark size={26} /><span>Gotchu</span></a>
      <nav className="gl-nav" aria-label="Navegación principal">
        {LINKS.map(link => <a key={link.href} href={link.href}>{link.label}</a>)}
      </nav>
      <div className="gl-header-tools">
        <ThemeSwitch className="max-[519px]:hidden" />
        <a href="/dashboard" data-catch="" className={cn(buttonVariants({ size: 'sm' }), 'max-[899px]:hidden')}>Entrar</a>
        <MobileMenu open={open} onOpenChange={setOpen} />
      </div>
    </div>
  </header>;
}

function MobileMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Trigger render={<Button variant="outline" size="icon" aria-label={open ? 'Cerrar menú' : 'Abrir menú'} aria-expanded={open} className="min-[900px]:hidden" />}>
      {open ? <XIcon aria-hidden="true" /> : <MenuIcon aria-hidden="true" />}
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Backdrop className="gl gl-mobile-menu-backdrop" />
      <Dialog.Popup className="gl gl-mobile-menu">
        <div className="gl-mobile-menu-header">
          <div className="gl-header-in">
            <div className="gl-brand" aria-hidden="true"><GotchuMark size={26} /><span>Gotchu</span></div>
            <Dialog.Close render={<Button variant="outline" size="icon" aria-label="Cerrar menú" aria-expanded={open} />}>
              <XIcon aria-hidden="true" />
            </Dialog.Close>
          </div>
        </div>
        <Dialog.Title className="gl-sr">Menú</Dialog.Title>
        <div className="gl-mobile-menu-panel">
          <nav aria-label="Navegación principal" className="gl-mobile-menu-nav">
            {LINKS.map(link => <a key={link.href} href={link.href} onClick={() => onOpenChange(false)}>{link.label}</a>)}
          </nav>
          <div className="gl-mobile-menu-foot">
            <ThemeSwitch />
            <a href="/dashboard" data-catch="" className={buttonVariants()}>Entrar</a>
          </div>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
