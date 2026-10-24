import { describe, expect, it, vi } from 'vitest';
import { createApi, type ApiServices } from '../src/server/api.js';

const org = '8b8123ef-a1ca-43ac-91a5-9bf4b792d729';
const app = '13e37f6a-784c-4f46-97dd-41bd81c6d00d';
const origin = 'http://localhost:3000';
function services(authenticated = true): ApiServices {
  return {
    origin,
    auth: { enabled: true, handle: async () => new Response(), identity: async () => authenticated ? { userId: 'github:42', cookies: [] } : null },
    ingest: vi.fn(async () => ({ accepted: 1, duplicates: 0 })),
    execute: vi.fn(async () => ({ jobId: app })),
  };
}

describe('thin public HTTP adapter', () => {
  it('does not convert client identity headers into a session', async () => {
    const dependencies = services(false);
    const response = await createApi(dependencies)(new Request(`${origin}/api/v1/organizations/${org}/applications`, { headers: { 'x-user-id': 'owner', 'x-organization-id': org } }));
    expect(response.status).toBe(401);
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it('passes the verified actor and validated resource selector to backend authorization', async () => {
    const dependencies = services();
    const response = await createApi(dependencies)(new Request(`${origin}/api/v1/organizations/${org}/applications`, { headers: { 'x-user-id': 'attacker' } }));
    expect(response.status).toBe(200);
    expect(dependencies.execute).toHaveBeenCalledWith({ userId: 'github:42' }, { kind: 'applications.list', organizationId: org });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('keeps the retired unscoped audit entry point closed after checking CSRF', async () => {
    const dependencies = services();
    const api = createApi(dependencies);
    const path = `${origin}/api/v1/organizations/${org}/applications/${app}/audits`;
    expect((await api(new Request(path, { method: 'POST', headers: { origin: 'https://attacker.example', 'idempotency-key': 'request-1' } }))).status).toBe(403);
    expect((await api(new Request(path, { method: 'POST', headers: { origin } }))).status).toBe(410);
    expect(dependencies.execute).not.toHaveBeenCalled();
    expect((await api(new Request(path, { method: 'POST', headers: { origin, 'idempotency-key': 'request-1' } }))).status).toBe(410);
  });

  it('rejects client timestamps masquerading as a fresh authentication proof', async () => {
    const dependencies = services();
    const response = await createApi(dependencies)(new Request(`${origin}/api/v1/organizations/${org}/proposals/${app}/approvals`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ actionHash: 'a'.repeat(64), authenticatedAt: new Date().toISOString() }),
    }));
    expect(response.status).toBe(400);
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it('requires event signatures and preserves exact bytes without accepting user-session identity', async () => {
    const dependencies = services(false);
    const raw = '{ "applicationId" : "signed-by-the-client" }\n';
    const headers = { 'content-type': 'application/json', 'x-gotchu-integration': org, 'x-gotchu-timestamp': '1792800000', 'x-gotchu-signature': 'a'.repeat(64) };
    const response = await createApi(dependencies)(new Request(`${origin}/api/v1/events`, { method: 'POST', headers, body: raw }));
    expect(response.status).toBe(202);
    expect(dependencies.ingest).toHaveBeenCalledWith({ integrationId: org, timestamp: headers['x-gotchu-timestamp'], signature: headers['x-gotchu-signature'], rawBody: Buffer.from(raw) });
    expect(dependencies.execute).not.toHaveBeenCalled();
  });
});
