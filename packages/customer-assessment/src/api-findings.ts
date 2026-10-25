import type { ApiCheckEvidence, AssessmentAnalysis } from '@gotchu/contracts';
import { finding } from './common.js';

export function addApiFindings(analysis: AssessmentAnalysis, item: ApiCheckEvidence, evidenceId: string, location: string, peers: Array<{ item: ApiCheckEvidence; id: string }>) {
  if (!item.tlsVerified || item.incomplete !== null || item.status === null) return;
  const base = {
    location, evidenceIds: [evidenceId], confidence: 'inferred' as const,
    limitations: ['This bounded unauthenticated protocol check does not establish exploitation, access to sensitive data, or behavior under authenticated GET requests.'],
  };
  const preflight = peers.find(peer => peer.item.scenarioId === 'cors_preflight' && peer.item.path === item.path && peer.item.method === 'OPTIONS');
  const acceptsProbe = (value: ApiCheckEvidence) => value.status !== null && value.status >= 200 && value.status < 300
    && value.tlsVerified && value.incomplete === null && value.signals.originAllowed === 'probe_origin' && value.signals.credentialsAllowed;
  if (item.scenarioId === 'cors_preflight' && item.method === 'HEAD' && acceptsProbe(item) && preflight && acceptsProbe(preflight.item)
    && preflight.item.signals.allowedMethods?.includes('GET') && preflight.item.signals.authorizationAllowed) {
    finding(analysis, { ...base, evidenceIds: [evidenceId, preflight.id], ruleId: 'api.credentialed-probe-origin', correlationKey: `api:cors:${item.path}`,
      title: 'CORS policy accepts the unrelated probe origin with credentials', severity: 'medium',
      description: 'The HEAD response and GET preflight accepted the fixed unrelated origin https://gotchu.invalid and declared credentials support. Acceptance of other origins and authenticated readability were not tested.',
      impact: 'If this policy also applies to sensitive authenticated responses, an unrelated origin might receive browser access.',
      recommendation: 'Review the intended origin allowlist and test authenticated browser access in a controlled environment.',
    });
  }
  if (item.scenarioId === 'error_handling' && item.status >= 400 && item.signals.errorSignature) {
    finding(analysis, { ...base, ruleId: 'api.error-detail', correlationKey: `api:error-detail:${item.path}`,
      title: 'Probe response contains an error-detail signature', severity: 'low',
      description: `The fixed marker path returned HTTP ${item.status} with a ${item.signals.errorSignature} pattern. No response text was retained.`,
      impact: 'Error responses may disclose implementation details.',
      recommendation: 'Review server-side error handling and return a generic public error response.',
    });
  }
}
