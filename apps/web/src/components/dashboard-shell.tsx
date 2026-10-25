import type { ReactNode } from 'react';
import { MenuIcon, XIcon } from 'lucide-react';

export function DashboardShell({ brand, menuOpen, onToggleMenu, onCloseMenu, sidebar, children }: {
  brand: ReactNode;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  return <div className="gl customer-app-shell">
    <aside className="customer-sidebar">
      <div className="customer-sidebar-head">
        {brand}
        <button type="button" className="customer-menu-button" aria-label={menuOpen ? 'Cerrar menú' : 'Abrir menú'} aria-expanded={menuOpen} aria-controls="customer-sidebar-body" onClick={onToggleMenu}>
          {menuOpen ? <XIcon aria-hidden="true" /> : <MenuIcon aria-hidden="true" />}
        </button>
      </div>
      <div className="customer-sidebar-body" id="customer-sidebar-body" data-open={menuOpen || undefined}>{sidebar}</div>
    </aside>
    {menuOpen && <button type="button" className="customer-menu-backdrop" tabIndex={-1} aria-label="Cerrar menú" onClick={onCloseMenu} />}
    <div className="customer-main-column">
      <main className="customer-main">{children}</main>
    </div>
  </div>;
}
