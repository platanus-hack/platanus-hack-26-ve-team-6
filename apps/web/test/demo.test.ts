import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DEMO_ASSESSMENT_SCOPE, DEMO_ASSESSMENT_TARGET_KEY } from '@gotchu/backend';
import { createDemoAssessmentApi, type DemoAssessmentServices } from '../src/server/demo.js';

const origin = 'http://127.0.0.1:3000';
function fixture() {
  const jobId = randomUUID();
  const services: DemoAssessmentServices = {
    target: vi.fn(async () => ({ targetKey: DEMO_ASSESSMENT_TARGET_KEY })),
    reports: vi.fn(async () => []),
    queue: vi.fn(async () => ({ jobId })),
    report: vi.fn(async () => { throw new Error('No report fixture'); }),
    job: vi.fn(async () => ({ id: jobId, applicationId: DEMO_ASSESSMENT_SCOPE.applicationId, kind: 'audit', state: 'running', attempts: 1, createdAt: new Date(), completedAt: null, outcome: null, reasonCode: null, reportId: null })),
  };
  return { services, api: createDemoAssessmentApi({ enabled: true, origin, services }) };
}
function post(body: unknown, id = randomUUID(), requestOrigin = origin) {
  return new Request(`${origin}/api/demo/assessments`, { method: 'POST', headers: { origin: requestOrigin, 'Content-Type': 'application/json', 'Idempotency-Key': id }, body: JSON.stringify(body) });
}

describe('fixed-scope controlled demo HTTP boundary (service fixtures)', () => {
  it('fails closed unless explicitly enabled and configured', async () => {
    const { services } = fixture();
    const disabled = createDemoAssessmentApi({ enabled: false, origin, services });
    expect((await disabled(post({ mode: 'both', revision: 'vulnerable' }))).status).toBe(503);
    expect(services.queue).not.toHaveBeenCalled();
    expect((await createDemoAssessmentApi({ enabled: true, origin, services: null })(new Request(`${origin}/api/demo/workspace`))).status).toBe(503);
  });
  it('rejects foreign origins and caller URLs, tenants, paths and action permissions', async () => {
    const { api, services } = fixture();
    expect((await api(post({ mode: 'both', revision: 'vulnerable' }, randomUUID(), 'https://foreign.example'))).status).toBe(403);
    for (const extra of [{ url: 'http://169.254.169.254' }, { organizationId: randomUUID() }, { path: '/etc/passwd' }, { responseMode: 'automatic_limited' }]) {
      expect((await api(post({ mode: 'both', revision: 'vulnerable', ...extra }))).status).toBe(400);
    }
    expect(services.queue).not.toHaveBeenCalled();
  });
  it('passes only validated mode/revision and exact request identity to its fixed service', async () => {
    const { api, services } = fixture(); const key = randomUUID();
    expect((await api(post({ mode: 'external', revision: 'corrected' }, key))).status).toBe(202);
    expect(services.queue).toHaveBeenCalledWith({ mode: 'external', revision: 'corrected' }, key);
    expect((await api(post({ mode: 'both', revision: 'vulnerable' }, key))).status).toBe(409);
  });
  it('bounds concurrent admissions and preserves exact retries without another unique slot', async () => {
    const { api, services } = fixture(); const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 11 }, (_, index) => api(post({ mode: 'both', revision: 'vulnerable' }, index === 0 ? key : randomUUID()))));
    expect(responses.filter((response) => response.status === 202)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
    expect((await api(post({ mode: 'both', revision: 'vulnerable' }, key))).status).toBe(202);
    expect(services.queue).toHaveBeenCalledTimes(11);
  });
  it('does not expose a different application job even when a service returns it', async () => {
    const { api, services } = fixture();
    services.job = vi.fn(async () => ({ id: randomUUID(), applicationId: randomUUID(), kind: 'audit', state: 'running', attempts: 1, createdAt: new Date(), completedAt: null, outcome: null, reasonCode: null, reportId: null }));
    expect((await api(new Request(`${origin}/api/demo/jobs/${randomUUID()}`))).status).toBe(404);
  });
  it('bounds JSON before attempting any queued work', async () => {
    const { api, services } = fixture();
    expect((await api(post({ mode: 'both', revision: 'vulnerable', padding: 'x'.repeat(2000) }))).status).toBe(413);
    expect(services.queue).not.toHaveBeenCalled();
  });
});
