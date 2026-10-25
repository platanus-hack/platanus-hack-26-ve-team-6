import { describe, expect, it } from 'vitest';
import type { AssessmentFinding } from '@gotchu/contracts';
import { findingPrompt } from '../src/components/finding-prompt';

const finding = (overrides: Partial<AssessmentFinding> = {}): AssessmentFinding => ({
  id: '6f1b9f0e-6d0c-4a59-9f43-2e1c6c4c2a10', ruleId: 'generic-api-key', correlationKey: 'gitleaks:generic-api-key:src/index.js', origin: 'internal',
  title: 'Possible secret', location: 'src/index.js:1', description: 'A credential pattern matched.', severity: 'high', confidence: 'inferred',
  exploitability: 'unknown', impact: 'Potential credential exposure.', recommendation: 'Revoke and rotate if real.', limitations: ['Static rule match only.'],
  evidenceIds: ['9d5c7f43-1b56-4f0a-8a35-6c2b47e1d8a2'], ...overrides,
});
const evidence = (excerpt: string) => ({ locator: 'src/index.js:1', excerpt });

describe('finding prompt for coding assistants', () => {
  it('carries the finding, its redacted evidence and verification steps', () => {
    const prompt = findingPrompt({ applicationName: 'Shop', origin: null, finding: finding(), evidence: [evidence('const key = [REDACTED];\n'.repeat(60))] });
    expect(prompt).toContain('«Shop»');
    expect(prompt).toContain('Ubicación: src/index.js:1');
    expect(prompt).toContain('[REDACTED]');
    expect(prompt).toContain('revocarla y rotarla');
    expect(prompt).toContain('Añade o ajusta una prueba');
    // Long evidence is cut so the prompt stays readable.
    expect(prompt.length).toBeLessThan(2_400);
  });

  it('asks for a deployed-response check on HTTPS findings and a lockfile update on dependencies', () => {
    expect(findingPrompt({ applicationName: 'Shop', origin: 'https://shop.example', finding: finding({ origin: 'external' }), evidence: [] })).toContain('de https://shop.example');
    const dependency = findingPrompt({ applicationName: 'Shop', origin: null, evidence: [], finding: finding({ dependencyAssessment: { name: 'lodash', version: '4.17.20', purl: 'pkg:npm/lodash@4.17.20', reachability: { state: 'unknown', symbolCoverage: 'unknown', symbols: [], importEvidence: [], symbolEvidence: [], dependencyPath: null, limitation: [] }, artifactStatus: 'not_requested' } }) });
    expect(dependency).toContain('lodash@4.17.20');
    expect(dependency).toContain('regenera el lockfile');
  });
});
