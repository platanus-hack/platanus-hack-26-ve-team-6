import { useEffect, useState } from 'react';
import { MenuIcon, XIcon } from 'lucide-react';
import { GotchuMark } from '../components/gotchu-mark';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Sheet, SheetClose, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ThemeSwitch } from './theme';

const LINKS = [
  { href: '#gl-codigo', label: 'Cómo funciona' },
  { href: '#gl-alcance', label: 'Alcance' },
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
        <a href="/dashboard" data-catch="" className={cn(buttonVariants({ size: 'sm' }), 'max-[899px]:hidden')}>Abrir Gotchu</a>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger render={<Button variant="outline" size="sm" className="min-[900px]:hidden" />}>
            <MenuIcon aria-hidden="true" />Menú
          </SheetTrigger>
          <SheetContent
            side="top"
            overlayClassName="gl-sheet-backdrop !fixed !inset-x-0 !top-12 min-[760px]:!top-[52px] !bottom-0 !z-[49] !bg-black/40 !backdrop-blur-none !duration-[180ms]"
            className="gl gl-sheet !fixed !inset-x-0 !top-0 !z-[51] !h-auto !max-h-svh !w-full !max-w-none !translate-y-0 !gap-0 !rounded-none !border-0 !bg-transparent !p-0 !shadow-none !opacity-100 !transition-[clip-path] !duration-240 !ease-[cubic-bezier(.23,1,.32,1)]"
            showCloseButton={false}
          >
            <div className="gl-sheet-header">
              <div className="gl-header-in">
                <div className="gl-brand" aria-hidden="true"><GotchuMark size={26} /><span>Gotchu</span></div>
                <SheetClose render={<Button variant="outline" size="sm" aria-expanded={open} />}>
                  <XIcon aria-hidden="true" />Cerrar
                </SheetClose>
              </div>
            </div>
            <SheetTitle className="gl-sr">Menú</SheetTitle>
            <div className="gl-sheet-panel">
              <nav aria-label="Navegación principal" className="gl-sheet-nav">
                {LINKS.map(link => <a key={link.href} href={link.href} onClick={() => setOpen(false)}>{link.label}</a>)}
              </nav>
              <div className="gl-sheet-foot">
                <ThemeSwitch />
                <a href="/dashboard" data-catch="" className={buttonVariants()}>Abrir Gotchu</a>
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  </header>;
}
