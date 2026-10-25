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
  dependencyFixes: [],
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
});
