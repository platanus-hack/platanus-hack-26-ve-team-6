import { createFileRoute } from '@tanstack/react-router';
import '../styles/tokens.css';

const options = [
  { href: '/', label: 'Actual' },
  { href: '/variantes/anterior', label: 'Anterior' },
  { href: '/variantes/a', label: 'Variante A' },
  { href: '/variantes/b', label: 'Variante B' },
  { href: '/variantes/c', label: 'Variante C' },
];

/** Internal comparison index for landing directions; not linked from the public page. */
function Variants() {
  return <div className="g-page" style={{ minHeight: '100svh', padding: 48, background: 'var(--gc-canvas)', color: 'var(--gc-paper)', fontFamily: 'var(--gc-font-body)' }}>
    <h1 style={{ fontFamily: 'var(--gc-font-display)', textTransform: 'uppercase' }}>Direcciones de la landing</h1>
    <ul style={{ display: 'grid', gap: 12, padding: 0, listStyle: 'none', marginTop: 32 }}>{options.map(option => <li key={option.href}><a href={option.href} style={{ color: 'var(--gc-accent-ink)' }}>{option.label}</a></li>)}</ul>
  </div>;
}

export const Route = createFileRoute('/variantes/')({
  head: () => ({ meta: [{ title: 'Gotchu · Direcciones' }, { name: 'robots', content: 'noindex' }] }),
  component: Variants,
});
