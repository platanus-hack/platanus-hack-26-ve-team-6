import type { AssessmentAnalysis, AssessmentComparison, CustomerAssessmentReport } from '@gotchu/contracts';

const coverageLabels: Record<string, string> = {
  semgrep: 'Semgrep · SAST (JavaScript/TypeScript, Python, Go y Java)',
  gitleaks: 'Gitleaks · detección de secretos',
  trivy: 'Trivy · configuración de Kubernetes, Terraform y Dockerfile',
  trivy_kubernetes: 'Trivy · Kubernetes',
  trivy_terraform: 'Trivy · Terraform',
  trivy_dockerfile: 'Trivy · Dockerfile',
  container_image_trivy_profile: 'Perfil Trivy · vulnerabilidades de imagen',
  container_image_os_cves: 'Trivy · CVE de paquetes del sistema operativo',
  container_image_language_cves: 'Trivy · CVE de paquetes de lenguaje',
  container_image_java_cves: 'Trivy · CVE de paquetes Java (cobertura desconocida)',
  container_image_vulnerability_database: 'Base de datos CVE de Trivy',
  container_image_finding_limit: 'Límite de observaciones de imagen',
};

export function reportInputLabel(report: Pick<CustomerAssessmentReport, 'mode' | 'subject'>) {
  if (report.subject.containerImageDigest) return 'Imagen de contenedor';
  switch (report.mode) {
    case 'internal': return 'Código fuente';
    case 'external': return 'HTTPS externo';
    case 'both': return 'Código + HTTPS';
  }
}

export function coverageCapabilityLabel(capability: string) {
  return coverageLabels[capability] ?? capability;
}

export function comparisonPresence(item: AssessmentComparison) {
  const hasInternal = item.internalFindingIds.length > 0;
  const hasExternal = item.externalFindingIds.length > 0;
  if (hasInternal && hasExternal) return 'Código + HTTPS';
  if (hasInternal) return 'Código';
  if (hasExternal) return 'HTTPS';
  return 'Sin observaciones enlazadas';
}

export function comparisonVerification(classification: AssessmentComparison['classification']) {
  switch (classification) {
    case 'both': return 'Agrupadas por regla';
    case 'internal_only': return 'Sin grupo equivalente observado en HTTPS';
    case 'external_only': return 'Sin grupo equivalente observado en código';
    case 'unverified': return 'Sin contraste verificado';
  }
}

export function comparisonCounts(comparisons: readonly AssessmentComparison[]) {
  return {
    internal: comparisons.reduce((count, item) => count + item.internalFindingIds.length, 0),
    external: comparisons.reduce((count, item) => count + item.externalFindingIds.length, 0),
    matched: comparisons.filter(item => item.internalFindingIds.length > 0 && item.externalFindingIds.length > 0).length,
  };
}

export function perspectiveStatus(analysis: AssessmentAnalysis | null) {
  if (!analysis) return 'No solicitada';
  switch (analysis.status) {
    case 'completed': return 'Evaluada';
    case 'partial': return 'Parcial';
    case 'unavailable': return 'No disponible';
  }
}

export function exploitabilityLabel(exploitability: AssessmentAnalysis['findings'][number]['exploitability']) {
  switch (exploitability) {
    case 'unknown': return 'Desconocida';
    case 'not_demonstrated': return 'No demostrada';
    case 'demonstrated_in_fixture': return 'Demostrada en fixture de prueba autorizada';
  }
}
