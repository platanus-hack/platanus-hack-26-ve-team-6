import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './ui.css';

const paths = {
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3ZM8 12l3 3 5-6',
  home: 'm3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  report: 'M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  close: 'm6 6 12 12M6 18 18 6',
  plus: 'M12 4v16M4 12h16',
  signOut: 'M9 3H4v18h5m5-14 5 5-5 5M8 12h12',
  chevron: 'm9 5 7 7-7 7',
} as const;
export type IconName = keyof typeof paths;

export function UiIcon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}

export function Brand() {
  return <a className="ds-brand" href="/dashboard" aria-label="Gotchu, inicio"><UiIcon name="shield" size={28} /><span>gotchu<span className="ds-brand-dot">.</span></span></a>;
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  busy?: boolean;
};
export function Button({ variant = 'secondary', busy = false, className = '', disabled, children, type = 'button', ...props }: ButtonProps) {
  return <button {...props} type={type} className={`ds-button ds-button-${variant} ${className}`} disabled={disabled || busy} aria-busy={busy || undefined}>{busy && <span className="ds-spinner" aria-hidden="true" />}{children}</button>;
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'unknown';
export function Status({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`ds-status ds-status-${tone}`}>{children}</span>;
}

export function LoadingState({ label }: { label: string }) {
  return <div className="ds-loading" role="status"><span className="ds-spinner" aria-hidden="true" />{label}</div>;
}

export function Notice({ tone = 'info', title, children }: { tone?: Exclude<Tone, 'neutral'>; title: string; children: ReactNode }) {
  return <div className={`ds-notice ds-status-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}><strong>{title}</strong><div>{children}</div></div>;
}
