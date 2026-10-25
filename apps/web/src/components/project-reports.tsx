import type { ReactNode } from 'react';

export function ProjectReports({ title, reportCount, reportList, detail }: {
  title: string;
  reportCount: string;
  reportList: ReactNode;
  detail: ReactNode;
}) {
  return <div className="customer-report-layout">
    <section className="customer-card customer-report-history">
      <div className="customer-card-heading"><div><h2>{reportCount}</h2></div></div>
      {reportList}
    </section>
    <section className="customer-card customer-report-card" aria-label={title}>{detail}</section>
  </div>;
}
