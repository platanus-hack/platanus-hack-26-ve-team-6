import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

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

const OPTIONS: { value: ThemePreference; label: string; icon: string }[] = [
  { value: 'light', label: 'Tema claro', icon: 'M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4M8 5.25a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 0 0 0-5.5Z' },
  { value: 'dark', label: 'Tema oscuro', icon: 'M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z' },
  { value: 'system', label: 'Tema del sistema', icon: 'M2 3h12v8H2zM6 14h4M8 11v3' },
];

/** Three-way theme control: a radio group of icon buttons with arrow-key navigation. */
export function ThemeSwitch({ className = '' }: { className?: string }) {
  const [preference, choose] = useThemePreference();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (index + delta + OPTIONS.length) % OPTIONS.length;
    const option = OPTIONS[next];
    if (!option) return;
    choose(option.value);
    buttons.current[next]?.focus();
  }
  return <div className={`gl-theme ${className}`} role="radiogroup" aria-label="Tema">
    {OPTIONS.map((option, index) => <button
      key={option.value}
      ref={element => { buttons.current[index] = element; }}
      type="button"
      role="radio"
      aria-checked={preference === option.value}
      aria-label={option.label}
      title={option.label}
      tabIndex={preference === option.value ? 0 : -1}
      onClick={() => choose(option.value)}
      onKeyDown={event => onKey(event, index)}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={option.icon} /></svg>
    </button>)}
  </div>;
}
