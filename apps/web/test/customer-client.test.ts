import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerApiError, customerApi } from '../src/components/customer-client.js';

const organizationId = '8b8123ef-a1ca-43ac-91a5-9bf4b792d729';
const applicationId = '13e37f6a-784c-4f46-97dd-41bd81c6d00d';
const sourceId = '2c5f01dc-e145-4e6e-80b4-9a2b202445b5';
const targetId = '4a02d840-a230-4e4c-88a5-f59a080c99ae';

const fetchMock = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('customer API client', () => {
  it('submits only the selected assessment scope and verifies the queued response', async () => {
    fetchMock.mockResolvedValueOnce(json({ jobId: sourceId }, 202));

    await customerApi.queue({
      organizationId,
      applicationId,
      mode: 'external',
      sourceSnapshotId: null,
      targetId,
    });

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/assessments`);
    expect(init?.credentials).toBe('same-origin');
    expect(init?.cache).toBe('no-store');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
    expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(JSON.parse(String(init?.body))).toEqual({ mode: 'external', sourceSnapshotId: null, targetId });
  });

  it('rejects a mode whose source and target do not match before making a request', async () => {
    expect(() => customerApi.queue({
      organizationId,
      applicationId,
      mode: 'external',
      sourceSnapshotId: sourceId,
      targetId,
    })).toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads only the authorized source snapshot body to its tenant-scoped path', async () => {
    fetchMock.mockResolvedValueOnce(json({
      organizationId,
      applicationId,
      id: sourceId,
      digest: 'a'.repeat(64),
      revision: 'main',
      fileCount: 1,
      createdAt: '2026-10-24T00:00:00.000Z',
    }));

    await customerApi.uploadSource({
      organizationId,
      applicationId,
      snapshot: { revision: 'main', files: [{ path: 'src/app.ts', content: 'export const ready = true;' }] },
      authorized: true,
    });

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/sources`);
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(JSON.parse(String(init?.body))).toEqual({
      snapshot: { revision: 'main', files: [{ path: 'src/app.ts', content: 'export const ready = true;' }] },
      authorized: true,
    });
  });

  it('sends the explicitly selected public-surface profile with fresh target consent', async () => {
    fetchMock.mockResolvedValueOnce(json({
      target: {
        organizationId,
        applicationId,
        id: targetId,
        origin: 'https://app.customer.net',
        version: 1,
        status: 'pending',
        consentActor: 'user:owner',
        consentAt: '2026-10-24T08:00:00.000Z',
        challengeExpiresAt: '2026-10-24T08:30:00.000Z',
        verifiedAt: null,
        expiresAt: null,
        scanProfile: 'public_surface',
      },
      challenge: { name: '_gotchu.app.customer.net', value: 'gotchu-verification=challenge', expiresAt: '2026-10-24T08:30:00.000Z' },
    }, 201));

    const enrolled = await customerApi.enrollTarget({ organizationId, applicationId, origin: 'https://app.customer.net', authorized: true, scanProfile: 'public_surface' });

    expect(enrolled.target.scanProfile).toBe('public_surface');
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/targets`);
    expect(JSON.parse(String(init?.body))).toEqual({ origin: 'https://app.customer.net', authorized: true, scanProfile: 'public_surface' });
  });

  it('rejects unsupported source paths before upload', () => {
    expect(() => customerApi.uploadSource({
      organizationId,
      applicationId,
      snapshot: { revision: 'main', files: [{ path: '../.env', content: 'not sent' }] },
      authorized: true,
    })).toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses Auth.js CSRF and Credentials callback before trusting the returned session', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ csrfToken: 'csrf-value' }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(json({ user: { id: 'credentials:account-id' }, providers: [], localAuthEnabled: true, registrationEnabled: false }));

    const session = await customerApi.signIn('person@example.test', 'a-long-password');

    expect(session.user?.id).toBe('credentials:account-id');
    const [path, init] = fetchMock.mock.calls[1] ?? [];
    expect(path).toBe('/api/auth/callback/credentials');
    expect(init?.credentials).toBe('same-origin');
    expect(new Headers(init?.headers).get('X-Auth-Return-Redirect')).toBe('1');
    expect(String(init?.body)).toContain('csrfToken=csrf-value');
    expect(String(init?.body)).toContain('email=person%40example.test');
  });

  it('does not report sign-out success while the authenticated session remains active', async () => {
    fetchMock.mockResolvedValueOnce(json({ csrfToken: 'csrf-value' }))
      .mockResolvedValueOnce(json({ url: '/api/auth/error' }))
      .mockResolvedValueOnce(json({ user: { id: 'credentials:account-id' }, providers: [], localAuthEnabled: true, registrationEnabled: false }));
    await expect(customerApi.signOut()).rejects.toMatchObject({ code: 'signout_rejected' });
  });

  it('rejects report data that fails the shared customer report schema', async () => {
    fetchMock.mockResolvedValueOnce(json({ id: sourceId }));
    const result = customerApi.report(organizationId, applicationId, sourceId);

    await expect(result).rejects.toBeInstanceOf(CustomerApiError);
    await expect(result).rejects.toMatchObject({ status: 200, code: 'invalid_response' });
  });

  it('deletes a source snapshot with the tenant-scoped DELETE endpoint', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(customerApi.deleteSource(organizationId, applicationId, sourceId)).resolves.toBeUndefined();

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/sources/${sourceId}`);
    expect(init?.method).toBe('DELETE');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.body).toBeUndefined();
  });
});
