import { z } from 'zod';
import type { AssessmentAnalysis, AssessmentComparison, AssessmentEvidence } from '@gotchu/contracts';
import { comparisonPresence, comparisonVerification, perspectiveStatus } from './customer-report-model';

const httpResponseExcerptSchema = z.object({
  status: z.number().int().min(100).max(599),
  tlsVerified: z.boolean(),
  headers: z.record(z.string(), z.string()),
  incomplete: z.string().nullable().optional(),
  path: z.string().min(1).optional(),
  profile: z.literal('public_surface').optional(),
});

function parseHttpResponseExcerpt(excerpt: string) {
  try {
    const payload: unknown = JSON.parse(excerpt);
    const parsed = httpResponseExcerptSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

const displayedHeaders = [
  'content-type', 'content-security-policy', 'strict-transport-security',
  'x-content-type-options', 'x-frame-options', 'server', 'x-powered-by',
] as const;

function HttpEvidence({ item }: { item: AssessmentEvidence }) {
  const response = parseHttpResponseExcerpt(item.excerpt);
  return <details className="customer-evidence customer-http-evidence">
    <summary>{item.locator}{response?.path ? ` · ${response.path}` : ''}</summary>
    {response ? <>
      <p>HTTP {response.status} · {response.tlsVerified ? 'TLS verificado' : 'TLS no verificado'}{response.profile === 'public_surface' ? ' · Superficie pública limitada' : ''}</p>
      {response.path && <p>Ruta: <code>{response.path}</code></p>}
      {response.incomplete === undefined
        ? <p>Integridad de respuesta no indicada.</p>
        : response.incomplete === null
          ? <p>Respuesta completa.</p>
          : <p>Respuesta incompleta: {response.incomplete}</p>}
      <ul className="customer-http-headers">
        {displayedHeaders.filter(name => response.headers[name] !== undefined).map(name => <li key={name}><strong>{name}</strong><span>{response.headers[name]}</span></li>)}
      </ul>
      {displayedHeaders.every(name => response.headers[name] === undefined) && <p>No se registraron cabeceras seleccionadas.</p>}
    </> : <p>No fue posible interpretar el resumen de esta respuesta. Los campos no se muestran.</p>}
    <p>{item.tool.name} · v{item.tool.version} · {formatDate(item.collectedAt)}</p>
    <p className="customer-evidence-meta">SHA-256: {item.checksum}</p>
    <p className="customer-evidence-meta">Snapshot: {item.snapshotRef}</p>
  </details>;
}

export function ExternalHttpsEvidence({ analysis }: { analysis: AssessmentAnalysis | null }) {
  if (!analysis) return null;
  const responses = analysis.evidence.filter(item => item.kind === 'http_response');
  return <section className="customer-report-section">
    <div className="customer-section-heading"><div><span className="customer-eyebrow">EVIDENCIA HTTPS</span><h3>Recursos observados</h3></div></div>
    {responses.length === 0
      ? <div className="customer-empty-inline">Sin respuestas HTTPS registradas.</div>
      : <div className="customer-http-evidence-list">{responses.map(item => <HttpEvidence item={item} key={item.id} />)}</div>}
  </section>;
}

export function ComparisonSummary({ comparisons, internal, external }: {
  comparisons: readonly AssessmentComparison[];
  internal: AssessmentAnalysis | null;
  external: AssessmentAnalysis | null;
}) {
  if (comparisons.length === 0) return null;
  return <div className="customer-comparison-summary">
    <p>Código: {perspectiveStatus(internal).toLocaleLowerCase('es')} · HTTPS: {perspectiveStatus(external).toLocaleLowerCase('es')}. Una perspectiva no descarta la otra.</p>
  </div>;
}

export function ComparisonPresence({ item }: { item: AssessmentComparison }) {
  return <span className="customer-status customer-status-muted">{comparisonPresence(item)}</span>;
}

export function ComparisonVerification({ item }: { item: AssessmentComparison }) {
  return <span className="customer-status customer-status-muted">{comparisonVerification(item.classification)}</span>;
}
