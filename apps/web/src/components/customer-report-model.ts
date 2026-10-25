import type { AssessmentAnalysis, AssessmentComparison, CustomerAssessmentReport } from '@gotchu/contracts';

const coverageLabels: Record<string, string> = {
  api_schema_discovery: 'Descubrimiento de API',
  api_cors_preflight: 'Política CORS y preflight',
  api_method_policy: 'Métodos HTTP',
  api_error_handling: 'Manejo de rutas de control',
  api_auth_boundary: 'Respuesta HEAD sin autenticación',
  api_endpoint_mapping: 'Rutas declaradas y muestreo',
  api_probe_budget: 'Límites de solicitudes API',
  api_exploitation: 'Explotación de vulnerabilidades API',
  semgrep: 'Semgrep · SAST (JavaScript/TypeScript, Python, Go y Java)',
  gitleaks: 'Gitleaks · detección de secretos',
  trivy_kubernetes: 'Kubernetes',
  trivy_terraform: 'Terraform',
  trivy_dockerfile: 'Dockerfile',
  trivy: 'Configuración',
  container_image_trivy_profile: 'Perfil Trivy · vulnerabilidades de imagen',
  container_image_os_cves: 'Trivy · CVE de paquetes del sistema operativo',
  container_image_language_cves: 'Trivy · CVE de paquetes de lenguaje',
  container_image_java_cves: 'Trivy · CVE de paquetes Java (cobertura desconocida)',
  container_image_vulnerability_database: 'Base de datos CVE de Trivy',
  container_image_finding_limit: 'Límite de observaciones de imagen',
  application_versions_and_exploitability: 'Versiones y explotabilidad',
  authenticated_routes: 'Rutas autenticadas',
  'customer-code-execution': 'Ejecución del código del cliente',
  dependency_inventory: 'Inventario de dependencias',
  dependency_reachability: 'Alcance de dependencias',
  dependency_advisories: 'Avisos de dependencias',
  dependency_artifact_analysis: 'Análisis de artefactos de dependencias',
  'external-exploitation': 'Explotación externa',
  'general-static-scanners': 'Escáneres estáticos generales',
  'http.catalog-headers': 'Cabeceras de recursos conocidos',
  'http.response': 'Respuesta HTTP',
  javascript_and_query_routes: 'Rutas JavaScript y con parámetros',
  license_metadata: 'Metadatos de licencias',
  public_https_root: 'Origen HTTPS público',
  public_surface_known_paths: 'Rutas públicas conocidas',
  public_surface_origin: 'Origen público',
  public_surface_response_headers: 'Cabeceras de respuestas públicas',
  root_headers: 'Cabeceras de la página principal',
  same_origin_link_discovery: 'Enlaces del mismo origen',
  subdomains_and_non_https_services: 'Subdominios y servicios sin HTTPS',
  tls_https: 'Conexión TLS por HTTPS',
};

export function groupCoverage(coverage: AssessmentAnalysis['coverage']) {
  const groups = new Map<string, { capabilities: string[]; state: AssessmentAnalysis['coverage'][number]['state']; detail: string }>();
  for (const item of coverage) {
    const isTrivyNoCandidate = item.state === 'unsupported'
      && ['trivy', 'trivy_kubernetes', 'trivy_terraform', 'trivy_dockerfile'].includes(item.capability)
      && item.detail.startsWith('No se encontraron candidatos');
    const detail = isTrivyNoCandidate ? 'No se encontraron candidatos en la configuración evaluada.' : item.detail;
    const key = `${item.state}\0${detail}`;
    const group = groups.get(key);
    if (group) group.capabilities.push(item.capability);
    else groups.set(key, { capabilities: [item.capability], state: item.state, detail });
  }
  return [...groups.values()];
}

export function reportInputLabel(report: Pick<CustomerAssessmentReport, 'mode' | 'subject'>) {
  if (report.subject.containerImageDigest) return 'Imagen de contenedor';
  switch (report.mode) {
    case 'internal': return 'Código fuente';
    case 'external': return 'HTTPS externo';
    case 'both': return 'Código + HTTPS';
  }
}

export function coverageCapabilityLabel(capability: string) {
  return coverageLabels[capability] ?? capability.replace(/[._-]+/g, ' ').replace(/^\w/, letter => letter.toLocaleUpperCase('es'));
}

export function coverageCapabilitiesLabel(capabilities: readonly string[]) {
  const labels = capabilities.map(coverageCapabilityLabel);
  const trivyCapabilities = new Set(['trivy', 'trivy_kubernetes', 'trivy_terraform', 'trivy_dockerfile']);
  if (capabilities.length > 0 && capabilities.every(capability => trivyCapabilities.has(capability))) {
    const scopes = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} y ${labels.at(-1)}` : labels[0];
    return `Trivy · ${scopes}`;
  }
  return labels.join(' · ');
}

export function comparisonPresence(item: AssessmentComparison) {
  const hasInternal = item.internalFindingIds.length > 0;
  const hasExternal = item.externalFindingIds.length > 0;
  if (hasInternal && hasExternal) return 'Código + HTTPS';
  if (hasInternal) return 'Código';
  if (hasExternal) return 'HTTPS';
  return 'Sin observaciones enlazadas';
}

export function exploitabilityLabel(exploitability: AssessmentAnalysis['findings'][number]['exploitability']) {
  switch (exploitability) {
    case 'unknown': return 'Desconocida';
    case 'not_demonstrated': return 'No demostrada';
    case 'demonstrated_in_fixture': return 'Demostrada en prueba controlada';
  }
}

/** Report tabs, each with the `pestana` search value that links to it; findings is the default and has none. */
export const reportTabSlugs = ['correcciones', 'dependencias', 'cobertura'] as const;
export type ReportTabSlug = (typeof reportTabSlugs)[number];
export const reportTabs = [
  { id: 'findings', slug: undefined, label: 'Observaciones' },
  { id: 'fixes', slug: 'correcciones', label: 'Correcciones' },
  { id: 'dependencies', slug: 'dependencias', label: 'Dependencias' },
  { id: 'coverage', slug: 'cobertura', label: 'Qué se evaluó' },
] as const satisfies readonly { id: string; slug: ReportTabSlug | undefined; label: string }[];
export type ReportTab = (typeof reportTabs)[number]['id'];

export function reportTabFromSlug(slug: string | null | undefined): ReportTab {
  return reportTabs.find(tab => tab.slug !== undefined && tab.slug === slug)?.id ?? 'findings';
}

export function reportTabSlug(tab: ReportTab): ReportTabSlug | undefined {
  return reportTabs.find(item => item.id === tab)?.slug;
}

const severityOrder = ['critical', 'high', 'medium', 'low', 'informational', 'unknown'] as const satisfies readonly AssessmentAnalysis['findings'][number]['severity'][];

/** Lower is more severe; used to put the worst observations first. */
export function severityRank(severity: AssessmentAnalysis['findings'][number]['severity']) {
  return severityOrder.indexOf(severity);
}

/** A report's checks split by whether they were actually inspected; not-requested checks are left out. */
export function coverageTally(report: Pick<CustomerAssessmentReport, 'internal' | 'external'>) {
  const items = [report.internal, report.external].flatMap(analysis => analysis?.coverage ?? []).filter(item => item.state !== 'not_requested');
  const inspected = items.filter(item => item.state === 'inspected').length;
  const stopped = [report.internal, report.external].some(analysis => analysis !== null && analysis.status !== 'completed');
  return { inspected, total: items.length, complete: !stopped && inspected === items.length };
}
