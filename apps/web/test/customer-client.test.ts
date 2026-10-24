import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerApiError, customerApi } from '../src/components/customer-client.js';
import { membersApi } from '../src/components/members-client.js';

const organizationId = '8b8123ef-a1ca-43ac-91a5-9bf4b792d729';
const applicationId = '13e37f6a-784c-4f46-97dd-41bd81c6d00d';
const sourceId = '2c5f01dc-e145-4e6e-80b4-9a2b202445b5';
const targetId = '4a02d840-a230-4e4c-88a5-f59a080c99ae';
const reportId = 'f2c8ac51-f151-4eac-8abf-4e4af9ba9613';
const findingId = '680a27e0-b2c2-43a4-88d4-3e210e6a9d22';
const sourceDigest = 'a'.repeat(64);
const reportScope = {
  organizationId,
  applicationId,
  applicationName: 'Aplicación de prueba',
  jobId: '1b4be687-a1d5-4ded-91ae-79c7c1bc0eb0',
  reportId,
  mode: 'internal',
  sourceSnapshotId: sourceId,
  sourceDigest,
  targetId: null,
  targetVersion: null,
  targetOrigin: null,
};
const recommendationsResponse = {
  catalogVersion: 1,
  scope: reportScope,
  repositoryContext: {
    dependencyKeys: [], dependencyKeysTruncated: false, manifestState: 'observed',
    configurationPaths: [], configurationPathsTruncated: false, configurationState: 'identified',
    frameworks: ['tanstack-start'], infrastructureAreas: [],
  },
  coverage: [],
  recommendations: [{
    recipeId: 'tls-certificate-verification', recipeVersion: '1.0.0', title: 'Habilitar verificación TLS',
    risk: { severity: 'high', confidence: 'observed', exploitability: 'unknown', summary: 'La configuración puede omitir la verificación del certificado.' },
    options: [{ id: 'verify-peer', title: 'Verificar el certificado', detail: 'Confirma la política de confianza.' }],
    requirements: ['Revisa el cliente asociado al hallazgo.'], evidenceFindingIds: [findingId],
    availability: 'candidate_patch', availabilityReason: 'La instantánea vigente permite preparar una propuesta privada.',
    scope: reportScope, architectureHints: { frameworks: ['tanstack-start'], relevantConfigurationPaths: [] },
  }],
};

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

  it('loads recommendations from the selected tenant report and validates the response scope', async () => {
    fetchMock.mockResolvedValueOnce(json(recommendationsResponse));

    const result = await customerApi.reportRecommendations(organizationId, applicationId, reportId);

    expect(result.recommendations[0]?.recipeId).toBe('tls-certificate-verification');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/reports/${reportId}/recommendations`);
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe('no-store');
  });

  it('rejects recommendations returned for a different application', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...recommendationsResponse, scope: { ...reportScope, applicationId: targetId } }));

    await expect(customerApi.reportRecommendations(organizationId, applicationId, reportId)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('keeps invitation tokens in request bodies and uses no-store workspace routes', async () => {
    const token = 'a'.repeat(43);
    fetchMock.mockResolvedValueOnce(json({ organizationId, role: 'viewer' }));
    await expect(membersApi.accept(token)).resolves.toEqual({ organizationId, role: 'viewer' });
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe('/api/customer/invitations/accept');
    expect(String(path)).not.toContain(token);
    expect(init?.cache).toBe('no-store');
    expect(JSON.parse(String(init?.body))).toEqual({ token });
    fetchMock.mockResolvedValueOnce(json({ invitation: {
      id: '2f85d710-2a4d-4fcb-8d5a-1f1c7b9fb9be', email: 'invitee@example.test', role: 'viewer', invitedBy: 'owner',
      createdAt: '2026-10-24T00:00:00.000Z', expiresAt: '2026-10-31T00:00:00.000Z',
    }, token, invitationUrl: `http://localhost:3000/dashboard#invitation=${token}` }, 201));
    const invitation = await membersApi.invite(organizationId, 'INVITEE@example.test', 'viewer');
    expect(invitation.invitation.email).toBe('invitee@example.test');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/customer/workspaces/${organizationId}/invitations`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ email: 'invitee@example.test', role: 'viewer' });
  });

  it('prepares only the validated finding and source digest on the report-scoped correction route', async () => {
    fetchMock.mockResolvedValueOnce(json({
      sourceId,
      jobId: 'f51f998d-dd37-414e-b5a3-6cc86d263c6d',
      changes: [{ path: 'src/client.ts', description: 'Se habilitó la verificación TLS.' }],
      patchHash: 'b'.repeat(64),
    }, 201));

    const result = await customerApi.prepareCorrection({
      organizationId, applicationId, reportId,
      request: { recipeId: 'tls-certificate-verification', findingId, expectedSourceDigest: sourceDigest },
    });

    expect(result.changes).toEqual([{ path: 'src/client.ts', description: 'Se habilitó la verificación TLS.' }]);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/reports/${reportId}/corrections`);
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    expect(JSON.parse(String(init?.body))).toEqual({ recipeId: 'tls-certificate-verification', findingId, expectedSourceDigest: sourceDigest });
  });

  it('requires the correction endpoint to return 201 and surfaces an unavailable source response', async () => {
    fetchMock.mockResolvedValueOnce(json({
      sourceId, jobId: 'f51f998d-dd37-414e-b5a3-6cc86d263c6d',
      changes: [{ path: 'src/client.ts', description: 'Se habilitó la verificación TLS.' }], patchHash: 'b'.repeat(64),
    }));
    await expect(customerApi.prepareCorrection({
      organizationId, applicationId, reportId,
      request: { recipeId: 'tls-certificate-verification', findingId, expectedSourceDigest: sourceDigest },
    })).rejects.toMatchObject({ code: 'unexpected_status' });

    fetchMock.mockResolvedValueOnce(json({ error: { code: 'source_unavailable', message: 'La instantánea ya no está disponible.' } }, 409));
    await expect(customerApi.prepareCorrection({
      organizationId, applicationId, reportId,
      request: { recipeId: 'tls-certificate-verification', findingId, expectedSourceDigest: sourceDigest },
    })).rejects.toMatchObject({ status: 409, code: 'source_unavailable', message: 'La instantánea ya no está disponible.' });
  });

  it('sends only the private candidate reference when preparing a v2 correction proposal', async () => {
    const proposalId = '45fc7599-c67c-4a64-939b-437e0279f85e';
    fetchMock.mockResolvedValueOnce(json({ proposalId, actionHash: 'c'.repeat(64) }, 201));
    await expect(customerApi.proposeCorrectionAction({ organizationId, applicationId, candidateId: sourceId })).resolves.toEqual({ proposalId, actionHash: 'c'.repeat(64) });
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/actions`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ kind: 'source_patch_pull_request', sourceRef: { type: 'correction_candidate', candidateId: sourceId } });
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
