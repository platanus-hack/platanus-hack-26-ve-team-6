import { useEffect, useState } from 'react';
import { MenuIcon } from 'lucide-react';
import { GotchuMark } from '../components/gotchu-mark';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
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
        <Button size="sm" className="max-[899px]:hidden" nativeButton={false} render={<a href="/dashboard" />}>Abrir Gotchu</Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger render={<Button variant="outline" size="sm" className="min-[900px]:hidden" />}>
            <MenuIcon aria-hidden="true" />Menú
          </SheetTrigger>
          <SheetContent side="top" className="gl gl-sheet">
            <SheetTitle className="gl-sr">Menú</SheetTitle>
            <nav aria-label="Navegación principal" className="gl-sheet-nav">
              {LINKS.map(link => <SheetClose key={link.href} nativeButton={false} render={<a href={link.href} />}>{link.label}</SheetClose>)}
            </nav>
            <Separator />
            <div className="gl-sheet-foot">
              <ThemeSwitch />
              <Button nativeButton={false} render={<a href="/dashboard" />}>Abrir Gotchu</Button>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  </header>;
}
