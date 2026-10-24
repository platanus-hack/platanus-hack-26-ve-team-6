import { describe, expect, it } from 'vitest';
import { serviceContextSchema } from '../src/inputs.js';

describe('triage context identifiers', () => {
  it('accepts release IDs and dependency components up to their customer context limit', () => {
    const context = serviceContextSchema.parse({
      deployments: [{ service: 'checkout', releaseId: 'r'.repeat(200), commit: null, deployedAt: '2026-10-24T12:00:00.000Z', state: 'declared' }],
      dependencies: [{ service: 'checkout', provider: 'cloudflare', component: 'c'.repeat(200), region: null, state: 'declared' }],
    });

    expect(context.deployments[0]?.releaseId).toHaveLength(200);
    expect(context.dependencies[0]?.component).toHaveLength(200);
  });
});
