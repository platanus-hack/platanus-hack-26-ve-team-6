import { useEffect, useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from 'lucide-react';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

export type ThemePreference = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'gotchu-theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Runs in <head> before first paint: applies the stored preference (or the system one) to <html> so
 * the page never flashes the wrong theme. Kept dependency-free because it is inlined as a string.
 */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem('${STORAGE_KEY}');if(p!=='light'&&p!=='dark')p='system';var d=p==='dark'||(p==='system'&&matchMedia('${DARK_QUERY}').matches);var r=document.documentElement;r.dataset.themePref=p;r.dataset.theme=d?'dark':'light';}catch(e){}})();`;

const isPreference = (value: string | null | undefined): value is ThemePreference => value === 'light' || value === 'dark' || value === 'system';

function apply(preference: ThemePreference) {
  const root = document.documentElement;
  const dark = preference === 'dark' || (preference === 'system' && matchMedia(DARK_QUERY).matches);
  root.dataset.themePref = preference;
  root.dataset.theme = dark ? 'dark' : 'light';
}

/** Current preference plus a setter that persists it; follows the system while set to "system". */
export function useThemePreference() {
  // null until the stored choice is read, so mounting never overrides what THEME_SCRIPT applied.
  const [preference, setPreference] = useState<ThemePreference | null>(null);
  useEffect(() => {
    const stored = document.documentElement.dataset.themePref;
    setPreference(isPreference(stored) ? stored : 'system');
  }, []);
  useEffect(() => {
    if (!preference) return;
    apply(preference);
    if (preference !== 'system') return;
    const query = matchMedia(DARK_QUERY);
    const follow = () => apply('system');
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, [preference]);
  const choose = (next: ThemePreference) => {
    setPreference(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Storage can be unavailable; the choice still applies for this visit. */ }
  };
  return [preference ?? 'system', choose] as const;
}

const OPTIONS = [
  { value: 'light', label: 'Tema claro', Icon: SunIcon },
  { value: 'dark', label: 'Tema oscuro', Icon: MoonIcon },
  { value: 'system', label: 'Tema del sistema', Icon: MonitorIcon },
] as const satisfies readonly { value: ThemePreference; label: string; Icon: LucideIcon }[];

/** Three-way theme control. The group owns roving focus and arrow keys; one option is always pressed. */
export function ThemeSwitch({ className }: { className?: string }) {
  const [preference, choose] = useThemePreference();
  return <ToggleGroup
    aria-label="Tema"
    spacing={1}
    className={cn('gl-theme rounded-lg shadow-[inset_0_0_0_1px_var(--border)]', className)}
    value={[preference]}
    onValueChange={([next]) => { if (isPreference(next)) choose(next); }}>
    {OPTIONS.map(({ value, label, Icon }) => <ToggleGroupItem key={value} value={value} aria-label={label} title={label} className="size-[34px] px-0">
      <Icon aria-hidden="true" className="size-3.5" />
    </ToggleGroupItem>)}
  </ToggleGroup>;
}
