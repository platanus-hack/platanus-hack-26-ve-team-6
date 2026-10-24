import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCustomerApi, type CustomerServices } from '../src/server/customer-api.js';
import type { AuthService } from '../src/server/auth.js';
const origin = 'http://localhost:3000';
const organizationId = randomUUID();
const applicationId = randomUUID();
const userId = `credentials:${randomUUID()}`;
function ports() {
  const unused = async (): Promise<never> => { throw new Error('Unexpected service invocation'); };
  const services: CustomerServices = { listWorkspaces: unused, createWorkspace: unused, listApplications: unused, createApplication: unused, updateApplication: unused, listTargets: unused, enrollTarget: unused, verifyTarget: unused, revokeTarget: unused, listSources: unused, uploadSource: unused, deleteSource: unused, listReports: unused, getReport: unused, queue: unused, job: unused };
  const auth: AuthService = { enabled: true, handle: async () => new Response(), identity: async () => ({ userId, cookies: [] }) };
  return { services, auth };
}
function request(path: string, payload?: unknown, headers: HeadersInit = {}) {
  return new Request(`${origin}/api/customer/${path}`, payload === undefined ? {} : { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
}
describe('authenticated customer HTTP adapter (injected services)', () => {
  it('exposes no customer data to anonymous sessions or identity headers', async () => {
    const { services, auth } = ports(); auth.identity = async () => null;
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    expect((await handle(new Request(`${origin}/api/customer/workspaces`, { headers: { 'x-user-id': userId } }))).status).toBe(401);
    expect(await (await handle(request('session'))).json()).toMatchObject({ user: null, registrationEnabled: false });
  });
  it('binds the session identity and path scope and rejects caller identity overrides', async () => {
    const { services, auth } = ports();
    services.createApplication = vi.fn(async (_identity, value) => ({ organizationId: value.organizationId, applicationId, name: value.name, archived: false, createdAt: new Date().toISOString() }));
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    expect((await handle(request(`workspaces/${organizationId}/applications`, { name: 'Actual app', organizationId: randomUUID(), userId: 'attacker' }))).status).toBe(400);
    expect((await handle(request(`workspaces/${organizationId}/applications`, { name: 'Actual app' }))).status).toBe(201);
    expect(services.createApplication).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, name: 'Actual app' });
  });
  it('rejects cross-origin mutations before calling any backend service', async () => {
    const { services, auth } = ports();
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    expect((await handle(request('workspaces', { name: 'Unexpected' }, { origin: 'https://attacker.invalid' }))).status).toBe(403);
  });
  it('does not accept caller verification facts, source paths or automatic response authority', async () => {
    const { services, auth } = ports();
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const prefix = `workspaces/${organizationId}/applications/${applicationId}`;
    expect((await handle(request(`${prefix}/targets`, { origin: 'https://example.com', authorized: true, verified: true }))).status).toBe(400);
    expect((await handle(request(`${prefix}/sources`, { snapshot: { revision: 'commit', files: [{ path: '../../secret.ts', content: 'secret' }] }, authorized: true }))).status).toBe(400);
    expect((await handle(request(`${prefix}/assessments`, { mode: 'external', sourceSnapshotId: null, targetId: randomUUID(), responseMode: 'automatic_limited' }, { 'idempotency-key': randomUUID() }))).status).toBe(400);
  });
  it('caps source bodies and keeps registration disabled without the explicit development gate', async () => {
    const { services, auth } = ports();
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    expect((await handle(request('register', { email: 'person@example.com', password: 'a long passphrase for fixture' }))).status).toBe(403);
    const oversized = new Request(`${origin}/api/customer/workspaces/${organizationId}/applications/${applicationId}/sources`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'content-length': '99999999' }, body: '{}' });
    expect((await handle(oversized)).status).toBe(413);
  });
  it('reports invalid backend output as a server error rather than a successful empty result', async () => {
    const { services, auth } = ports(); services.job = async () => ({ id: randomUUID(), secret: 'must not be exposed' });
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const result = await handle(request(`workspaces/${organizationId}/jobs/${randomUUID()}`));
    expect(result.status).toBe(500); expect(await result.text()).not.toContain('must not be exposed');
  });
});
