import { GotchuMark } from './gotchu-mark';
import { ThemeSwitch } from './theme-switch';

/** Lockup and theme switch shared by the signed-out pages (privacy, terms, first-run setup). */
export function PublicTop() {
  return <div className="pub-top">
    <a className="pub-brand" href="/" aria-label="Gotchu, inicio"><GotchuMark size={26} /><span>Gotchu</span></a>
    <ThemeSwitch />
  </div>;
}
