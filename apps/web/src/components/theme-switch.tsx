import { useSyncExternalStore } from 'react';
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuRadioItemIndicator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
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

const subscribers = new Set<() => void>();
let systemMediaQuery: MediaQueryList | null = null;

function getPreference(): ThemePreference {
  if (typeof document === 'undefined') return 'system';
  const stored = document.documentElement.dataset.themePref;
  return isPreference(stored) ? stored : 'system';
}

function notifySubscribers() {
  subscribers.forEach(subscriber => subscriber());
}

function apply(preference: ThemePreference) {
  const root = document.documentElement;
  const dark = preference === 'dark' || (preference === 'system' && matchMedia(DARK_QUERY).matches);
  root.dataset.themePref = preference;
  root.dataset.theme = dark ? 'dark' : 'light';
}

function onSystemChange() {
  if (getPreference() !== 'system') return;
  apply('system');
  notifySubscribers();
}

function syncSystemListener() {
  if (subscribers.size > 0 && getPreference() === 'system') {
    if (!systemMediaQuery) {
      systemMediaQuery = matchMedia(DARK_QUERY);
      systemMediaQuery.addEventListener('change', onSystemChange);
    }
    return;
  }
  if (systemMediaQuery) {
    systemMediaQuery.removeEventListener('change', onSystemChange);
    systemMediaQuery = null;
  }
}

function subscribe(subscriber: () => void) {
  subscribers.add(subscriber);
  syncSystemListener();
  return () => {
    subscribers.delete(subscriber);
    syncSystemListener();
  };
}

function chooseTheme(preference: ThemePreference) {
  try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* Storage can be unavailable; the choice still applies for this visit. */ }
  apply(preference);
  syncSystemListener();
  notifySubscribers();
}

/** All switches share the document preference and a single listener for system changes. */
export function useThemePreference() {
  const preference = useSyncExternalStore(subscribe, getPreference, () => 'system');
  return [preference, chooseTheme] as const;
}

const OPTIONS = [
  { value: 'light', label: 'Claro', Icon: SunIcon },
  { value: 'dark', label: 'Oscuro', Icon: MoonIcon },
  { value: 'system', label: 'Sistema', Icon: MonitorIcon },
] as const satisfies readonly { value: ThemePreference; label: string; Icon: LucideIcon }[];

/** Theme control: one icon button showing the current preference that opens a Claro / Oscuro / Sistema menu. */
export function ThemeSwitch({ className }: { className?: string }) {
  const [preference, choose] = useThemePreference();
  const current = OPTIONS.find(option => option.value === preference) ?? OPTIONS[2];
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="Tema" title="Tema" className={cn('gl-theme size-[34px]', className)} />}>
      <current.Icon aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent>
      <DropdownMenuRadioGroup value={preference} onValueChange={next => { if (isPreference(next)) choose(next); }}>
        {OPTIONS.map(({ value, label, Icon }) => <DropdownMenuRadioItem key={value} value={value}>
          <Icon aria-hidden="true" />{label}
          <DropdownMenuRadioItemIndicator><CheckIcon aria-hidden="true" /></DropdownMenuRadioItemIndicator>
        </DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
