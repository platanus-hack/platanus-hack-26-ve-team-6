import type { ReactNode } from 'react';

export function ProjectOverview({ snapshotCount, verifiedDomainCount, reportCount, onAddSource, onViewReports, assessmentForm, recentReports, activeJobBanner }: {
  snapshotCount: number;
  verifiedDomainCount: number;
  reportCount: number;
  onAddSource: () => void;
  onViewReports: () => void;
  assessmentForm: ReactNode;
  recentReports: ReactNode;
  activeJobBanner?: ReactNode;
}) {
  return <>
    {activeJobBanner}
    <div className="customer-overview-grid">
      <section className="customer-welcome-card">
        <h2>Fuentes e informes</h2>
        <div className="customer-overview-stats">
          <div><strong>{snapshotCount}</strong><span>Instantáneas</span></div>
          <div><strong>{verifiedDomainCount}</strong><span>Dominios</span></div>
          <div><strong>{reportCount}</strong><span>Informes</span></div>
        </div>
        <button className="customer-button customer-button-secondary" onClick={onAddSource}>Añadir código, dominio o imagen</button>
      </section>
      {assessmentForm}
    </div>
    <section className="customer-card customer-recent-card">
      <div className="customer-card-heading"><div><h2>Informes recientes</h2></div><button className="customer-link-button" onClick={onViewReports}>Ver todos los informes</button></div>
      {recentReports}
    </section>
  </>;
}
