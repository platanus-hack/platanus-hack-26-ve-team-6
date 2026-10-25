import { apiCheckEvidenceSchema, apiScenarioIdSchema, apiScenarioLabels, type AssessmentAnalysis } from '@gotchu/contracts';
import { Badge } from './ui/badge';

export function ApiScenarioEvidence({ analysis }: { analysis: AssessmentAnalysis }) {
  const checks = analysis.evidence.flatMap(item => {
    try {
      const payload: unknown = JSON.parse(item.excerpt);
      const parsed = apiCheckEvidenceSchema.safeParse(payload);
      return parsed.success ? [parsed.data] : [];
    } catch { return []; }
  });
  if (checks.length === 0) return null;
  const operations = checks.flatMap(item => item.signals.operations ?? []).filter((item, index, all) =>
    all.findIndex(other => other.path === item.path && other.method === item.method) === index);
  return <section className="customer-report-section" aria-label="Escenarios de API ejecutados">
    <div className="customer-section-heading"><h3>Pruebas de web y API</h3><Badge variant="outline">Catálogo {checks[0]?.catalogVersion}</Badge></div>
    <p>Solicitudes reales y acotadas. Una respuesta completa no confirma que la ruta sea segura.</p>
    <div className="customer-http-evidence-list">{apiScenarioIdSchema.options.map(id => {
      const items = checks.filter(item => item.scenarioId === id);
      const complete = items.filter(item => item.status !== null && item.incomplete === null).length;
      const coverage = analysis.coverage.find(item => item.capability === `api_${id}`);
      return <details className="customer-evidence" key={id}>
        <summary>{apiScenarioLabels[id]} · {complete}/{items.length} respuestas completas <Badge variant="outline">{coverage?.state === 'inspected' ? 'Observado' : 'Cobertura parcial o desconocida'}</Badge></summary>
        <ul>{items.map((item, i) => <li key={`${item.method}:${item.path}:${i}`}><code>{item.method} {item.path}</code> · {item.status === null ? 'Sin respuesta' : `HTTP ${item.status}`}{item.incomplete && ` · ${item.incomplete}`}</li>)}</ul>
        {id === 'auth_boundary' && <p>HEAD sin credenciales describe sólo esta respuesta; no demuestra acceso mediante GET ni un bypass.</p>}
        {id === 'cors_preflight' && <p>Origen de prueba fijo: https://gotchu.invalid. No se comprobó lectura autenticada desde un navegador.</p>}
      </details>;
    })}</div>
    {operations.length > 0 && <details className="customer-evidence"><summary>Rutas declaradas por OpenAPI ({operations.length})</summary>
      <ul>{operations.map(item => <li key={`${item.method}:${item.path}`}><code>{item.method} {item.path}</code> · {item.authentication === 'declared' ? 'autenticación declarada' : item.authentication === 'not_declared' ? 'sin autenticación declarada' : 'autenticación desconocida'} · {item.probeEligible ? 'candidata a HEAD/OPTIONS' : 'sin prueba de ruta'}</li>)}</ul>
      <p>El documento es una declaración. No demuestra qué API está desplegada.</p>
    </details>}
  </section>;
}
