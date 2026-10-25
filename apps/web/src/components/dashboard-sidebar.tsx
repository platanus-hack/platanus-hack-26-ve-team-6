import { useState, type ReactNode } from 'react';
import { CheckIcon, ChevronDownIcon, PencilIcon, PlusIcon } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuGroupLabel, DropdownMenuItem,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuRadioItemIndicator, DropdownMenuSeparator, DropdownMenuTrigger,
} from './ui/dropdown-menu';

export interface ScopeOption { id: string; label: string; meta?: string }
export interface ScopeAction { id: string; label: string; icon: 'plus' | 'rename' }

/**
 * Workspace or project picker: the current scope as a compact button, its siblings and the scope's
 * own actions (create, rename) in one menu instead of forms crowding the sidebar.
 */
export function ScopeSwitcher({ kind, title, subtitle, options, currentId, onSelect, actions, onAction, compact = false }: {
  kind: string;
  title: string;
  subtitle?: string;
  options: readonly ScopeOption[];
  currentId: string | null;
  onSelect: (id: string) => void;
  actions: readonly ScopeAction[];
  onAction: (id: string) => void;
  compact?: boolean;
}) {
  return <DropdownMenu>
    <DropdownMenuTrigger className={`customer-switcher${compact ? ' is-compact' : ''}`} aria-label={`Cambiar ${kind}: ${title}`}>
      {!compact && <span className="customer-switcher-mark" aria-hidden="true">{title.trim()[0]?.toUpperCase() ?? '·'}</span>}
      <span className="customer-switcher-text"><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
      <ChevronDownIcon aria-hidden="true" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="customer-switcher-menu">
      <DropdownMenuGroup>
        <DropdownMenuGroupLabel>{kind}</DropdownMenuGroupLabel>
        <DropdownMenuRadioGroup value={currentId ?? ''} onValueChange={value => { if (typeof value === 'string' && value !== currentId) onSelect(value); }}>
          {options.map(option => <DropdownMenuRadioItem key={option.id} value={option.id}>
            <span className="customer-switcher-option"><span>{option.label}</span>{option.meta && <small>{option.meta}</small>}</span>
            <DropdownMenuRadioItemIndicator><CheckIcon /></DropdownMenuRadioItemIndicator>
          </DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      {actions.length > 0 && <DropdownMenuSeparator />}
      {actions.map(action => <DropdownMenuItem key={action.id} onClick={() => onAction(action.id)}>
        {action.icon === 'plus' ? <PlusIcon /> : <PencilIcon />}{action.label}
      </DropdownMenuItem>)}
    </DropdownMenuContent>
  </DropdownMenu>;
}

/** One-field inline form the switchers open in place (new workspace, rename, new project). */
export function SidebarNameForm({ id, label, initial = '', submitLabel, onSubmit, onCancel }: {
  id: string;
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return <form className="customer-sidebar-form" onSubmit={event => {
    event.preventDefault();
    setBusy(true); setError(null);
    onSubmit(name.trim()).catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'No se pudo guardar.')).finally(() => setBusy(false));
  }}>
    <label htmlFor={id}>{label}</label>
    <input id={id} value={name} onChange={event => setName(event.target.value)} maxLength={200} required autoFocus disabled={busy} />
    <div className="customer-sidebar-form-actions">
      <button className="customer-button customer-button-primary customer-button-small" disabled={busy || !name.trim() || name.trim() === initial}>{busy ? 'Guardando…' : submitLabel}</button>
      <button type="button" className="customer-link-button" onClick={onCancel}>Cancelar</button>
    </div>
    {error && <p className="customer-form-error" role="alert">{error}</p>}
  </form>;
}

/** Title, one line of context and the page's actions, the same at the top of every page. */
export function PageHeader({ title, description, actions, status }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; status?: ReactNode }) {
  return <header className="customer-page-header">
    <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
    {(actions || status) && <div className="customer-page-actions">{status}{actions}</div>}
  </header>;
}
