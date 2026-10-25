// Frontend-only preview of the report pages with fixture data. Not part of the app.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/styles/tokens.css';
import '../src/styles/landing-ui.css';
import '../src/components/customer-shell.css';
import '../src/components/customer-report.css';
import '../src/components/customer-operations.css';
import { ReportRows } from '../src/components/project-overview';
import { FindingList, ReportCoverage, ReportHeading, ReportSummary, ReportTabPanel, ReportTabs } from '../src/components/project-reports';
import { ExternalHttpsEvidence } from '../src/components/customer-report-components';
import { reportInputLabel, type ReportTab } from '../src/components/customer-report-model';
import { PageHeader } from '../src/components/dashboard-sidebar';

window.fetch = async () => new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });

const t = '2026-10-25T08:54:00.000Z';
const sum = 'b'.repeat(64);
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const headers = { 'content-type': 'text/html; charset=utf-8', server: 'nginx', 'x-powered-by': 'Express' };
function finding(title: string, severity: string, location: string, extra: Partial<Record<string, unknown>> = {}) {
  const evidenceId = id();
  return {
    evidence: { id: evidenceId, origin: 'external', kind: 'http_response', locator: `https://www.yummysuperapp.com${location}`, collectedAt: t, snapshotRef: 'target:public_surface', tool: { name: 'gotchu-https', version: '1.4.0' }, checksum: sum,
      excerpt: JSON.stringify({ status: 200, tlsVerified: true, headers, incomplete: null, path: location, profile: 'public_surface', method: 'GET', bodyPolicy: 'bounded_body' }) },
    finding: { id: id(), ruleId: title, correlationKey: title, origin: 'external', title, location: `https://www.yummysuperapp.com${location}`, severity, confidence: 'observed', exploitability: 'not_demonstrated',
      description: 'La respuesta no incluye esta cabecera de seguridad, así que el navegador aplica su comportamiento por defecto.',
      impact: 'Un atacante que consiga inyectar contenido tendría menos barreras para ejecutarlo en el navegador de tus usuarios.',
      recommendation: 'Añade la cabecera en el servidor o en el proxy (por ejemplo, en la configuración de nginx) y vuelve a evaluar.',
      limitations: ['Solo se observó la ruta indicada; otras rutas pueden comportarse distinto.'], evidenceIds: [evidenceId], ...extra },
  };
}
const items = [
  finding('Falta Content-Security-Policy', 'medium', '/'),
  finding('CORS permite cualquier origen', 'medium', '/api/products'),
  finding('Falta Strict-Transport-Security', 'low', '/'),
  finding('Falta X-Content-Type-Options: nosniff', 'low', '/login'),
  finding('La cabecera X-Powered-By revela la tecnología', 'low', '/'),
  finding('Cookies sin atributo SameSite', 'low', '/login'),
  finding('La cabecera Server revela el servidor', 'informational', '/'),
  finding('robots.txt enumera rutas internas', 'informational', '/robots.txt'),
  finding('Versión de framework sin confirmar', 'unknown', '/', { confidence: 'uncertain', exploitability: 'unknown' }),
];
const report = {
  id: 'r1', jobId: id(), organizationId: id(), applicationId: id(), applicationName: 'Yummy', mode: 'external', startedAt: t, finishedAt: t,
  subject: { sourceSnapshotId: null, sourceDigest: null, targetId: 't1', targetVersion: 3, origin: 'https://www.yummysuperapp.com', containerImageId: null, containerImageDigest: null, containerImageReference: null },
  internal: null,
  external: { origin: 'external', status: 'partial', startedAt: t, finishedAt: t, snapshotRef: 'target:public_surface', tool: { name: 'gotchu-https', version: '1.4.0' },
    findings: items.map(item => item.finding), evidence: items.map(item => item.evidence),
    coverage: [
      { capability: 'tls_https', state: 'inspected', detail: 'Certificado válido y TLS 1.3 negociado.' },
      { capability: 'root_headers', state: 'inspected', detail: 'Cabeceras de la página principal leídas completas.' },
      { capability: 'public_surface_known_paths', state: 'inspected', detail: '7 rutas públicas conocidas consultadas.' },
      { capability: 'same_origin_link_discovery', state: 'inspected', detail: 'Enlaces del mismo origen descubiertos en HTML y sitemap.' },
      { capability: 'authenticated_routes', state: 'unsupported', detail: 'Este perfil no inicia sesión.' },
      { capability: 'subdomains_and_non_https_services', state: 'unsupported', detail: 'Este perfil no inspecciona subdominios.' },
    ],
    limitations: ['No se ejecuta JavaScript.', 'Máximo 10 solicitudes GET.'] },
  comparison: items.map(item => ({ key: item.finding.ruleId, classification: 'external_only', internalFindingIds: [], externalFindingIds: [item.finding.id], explanation: 'Sin grupo equivalente observado en código porque no se evaluó el código.' })),
  limitations: ['La cobertura parcial no confirma que el sitio sea seguro.'],
};
const rows = [
  { id: 'r1', title: 'HTTPS externo', detail: '25 oct 2026, 8:54 · www.yummysuperapp.com', findingCount: 9, delta: 1, severities: ['medium', 'medium', 'low', 'low', 'low', 'low', 'informational', 'informational', 'unknown'] },
  { id: 'r2', title: 'HTTPS externo', detail: '25 oct 2026, 8:51 · www.yummysuperapp.com', findingCount: 8, delta: 6, severities: ['medium', 'medium', 'low', 'low', 'low', 'informational', 'informational', 'unknown'] },
  { id: 'r3', title: 'Código fuente', detail: '25 oct 2026, 8:50 · 6cd2895', findingCount: 2, delta: -14, severities: ['high', 'unknown'] },
  { id: 'r4', title: 'HTTPS externo', detail: '25 oct 2026, 8:47 · www.yummysuperapp.com', findingCount: 16, delta: null, severities: Array(16).fill('medium') },
] as const;

function Preview() {
  const params = new URLSearchParams(location.search);
  const [open, setOpen] = useState(params.has('informe'));
  const [tab, setTab] = useState<ReportTab>((params.get('tab') as ReportTab) ?? 'findings');
  return <div className="gl customer-app-shell" style={{ display: 'block' }}><div className="customer-main-column"><main className="customer-main">
    <PageHeader title="Informes" description={<>Última evaluación <strong>hace 1 minuto</strong> · https externo <strong>www.yummysuperapp.com</strong></>} />
    {!open ? <section className="customer-report-index">
      <div className="customer-section-head"><div><h2>4 informes</h2><p>Abre uno para ver sus observaciones, cómo corregirlas y qué se evaluó.</p></div></div>
      <ReportRows reports={rows} onOpenReport={() => setOpen(true)} />
    </section> : <div className="customer-report-detail">
      <ReportHeading title={`${reportInputLabel(report as never)} · www.yummysuperapp.com`} detail="25 oct 2026, 8:54" onBack={() => setOpen(false)} actions={<button className="customer-button" type="button">Descargar JSON</button>} />
      <ReportSummary report={report as never} onOpenCoverage={() => setTab('coverage')} />
      <ReportTabs active={tab} counts={{ findings: report.comparison.length }} onChange={setTab} />
      {tab === 'findings' && <ReportTabPanel tab="findings"><FindingList report={report as never} organizationId="o" applicationId="a" canManage /></ReportTabPanel>}
      {tab === 'fixes' && <ReportTabPanel tab="fixes"><p className="customer-empty-inline">(Recomendaciones, investigaciones y propuestas: cargan desde la API real.)</p></ReportTabPanel>}
      {tab === 'dependencies' && <ReportTabPanel tab="dependencies"><p className="customer-empty-inline">(Inventario de dependencias del código.)</p></ReportTabPanel>}
      {tab === 'coverage' && <ReportTabPanel tab="coverage"><ReportCoverage report={report as never}><ExternalHttpsEvidence analysis={report.external as never} /></ReportCoverage></ReportTabPanel>}
    </div>}
  </main></div></div>;
}

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Preview /></QueryClientProvider>);
