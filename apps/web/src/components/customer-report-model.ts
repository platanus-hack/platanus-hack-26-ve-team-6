import type { AssessmentAnalysis, AssessmentComparison } from '@gotchu/contracts';

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
