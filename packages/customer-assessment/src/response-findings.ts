import type { AssessmentFinding } from '@gotchu/contracts';

export type HttpResponseFinding = Omit<AssessmentFinding, 'id' | 'origin' | 'exploitability'>;

export interface HttpResponseFindingInput {
  location: string;
  status: number;
  headers: Readonly<Record<string, string>>;
  tlsVerified: boolean;
  incomplete: string | null;
  evidenceId: string;
}

/** Derive only response-local observations from a complete, verified HTTP response. */
export function deriveHttpResponseFindings(input: HttpResponseFindingInput): HttpResponseFinding[] {
  if (!input.tlsVerified || input.incomplete !== null || input.status < 100) return [];

  const findings: HttpResponseFinding[] = [];
  for (const header of ['content-security-policy', 'strict-transport-security', 'x-content-type-options']) {
    if (input.headers[header]) continue;
    findings.push({
      ruleId: `https.missing-${header}`,
      correlationKey: `http:${header}`,
      title: `Response omits ${header}`,
      location: input.location,
      description: `The observed HTTP ${input.status} response at this path did not include ${header}.`,
      severity: 'low',
      confidence: 'observed',
      impact: 'Browser hardening may be reduced for this response.',
      recommendation: 'Review the appropriate response policy and apply it where relevant.',
      limitations: ['This finding applies only to this response; broader route coverage and policy effectiveness remain unknown, and no exploit was attempted.'],
      evidenceIds: [input.evidenceId],
    });
  }

  if (input.headers.server || input.headers['x-powered-by']) {
    findings.push({
      ruleId: 'https.technology-banner',
      correlationKey: 'http:technology-banner',
      title: 'Response advertises a technology banner',
      location: input.location,
      description: 'The server supplied a banner. Its software identity and version are unverified.',
      severity: 'informational',
      confidence: 'inferred',
      impact: 'The response exposes an unverified technology indication.',
      recommendation: 'Review whether the banner is necessary.',
      limitations: ['Do not treat a banner as inventory, a package advisory match, or proof of exploitation.'],
      evidenceIds: [input.evidenceId],
    });
  }

  return findings;
}
