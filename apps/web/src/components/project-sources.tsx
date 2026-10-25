import type { ReactNode } from 'react';
import type { CustomerApplication } from '@gotchu/contracts';
import { AppWindowIcon } from 'lucide-react';

export function ProjectSources({ workspaceName, projects, selectedProjectId, createControl, dateLabel, onSelect, children }: {
  workspaceName?: string;
  projects: CustomerApplication[];
  selectedProjectId: string;
  createControl?: ReactNode;
  dateLabel: (value: string) => string;
  onSelect: (projectId: string) => void;
  children: ReactNode;
}) {
  return <>
    <section className="customer-card customer-applications-card">
      <div className="customer-card-heading"><div><h2>Proyectos{workspaceName ? ` de ${workspaceName}` : ''}</h2></div>{createControl}</div>
      <div className="customer-application-grid">{projects.map(project => <button className={project.applicationId === selectedProjectId ? 'customer-application-card is-selected' : 'customer-application-card'} key={project.applicationId} onClick={() => onSelect(project.applicationId)}>
        <span className="customer-app-icon" aria-hidden="true"><AppWindowIcon /></span>
        <span><strong>{project.name}</strong><small>{project.archived ? 'Archivado' : 'Activo'} · Añadido {dateLabel(project.createdAt)}</small></span>
        <span className="customer-app-role">{project.applicationId === selectedProjectId ? 'Proyecto actual' : 'Seleccionar'}</span>
      </button>)}</div>
    </section>
    {children}
  </>;
}
