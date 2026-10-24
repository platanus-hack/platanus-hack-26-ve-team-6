import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BackendError } from '@gotchu/backend';
import { createCustomerApi, type CustomerServices } from '../src/server/customer-api.js';
import { contextClient } from '../src/components/context-client.js';
import type { AuthService } from '../src/server/auth.js';
import type { LocalAccounts } from '../src/server/local-accounts.js';
import { decisionRecordPageSchema, operationPlanSchema } from '@gotchu/contracts';
import type { LicensePolicy } from '@gotchu/contracts';
import type { WorkspaceRetentionPolicy } from '@gotchu/contracts';
import { customerAssessmentReportSchema } from '@gotchu/contracts';
import { buildCycloneDx } from '@gotchu/customer-assessment';
const origin = 'http://localhost:3000';
const organizationId = randomUUID();
const applicationId = randomUUID();
const userId = `credentials:${randomUUID()}`;
function ports() {
  const unused = async (): Promise<never> => { throw new Error('Unexpected service invocation'); };
  const services: CustomerServices = { listWorkspaces: unused, createWorkspace: unused, updateWorkspace: unused, listApplications: unused, createApplication: unused, updateApplication: unused, listTargets: unused, enrollTarget: unused, verifyTarget: unused, revokeTarget: unused, listSources: unused, uploadSource: unused, deleteSource: unused, listContainerImages: unused, uploadContainerImage: unused, deleteContainerImage: unused, listReports: unused, getReport: unused, recordReportDownload: unused, queue: unused, job: unused };
  const auth: AuthService = { enabled: true, handle: async () => new Response(), identity: async () => ({ userId, cookies: ['authjs.session-token=refreshed; Path=/; HttpOnly'] }), accountEmail: async () => null };
  return { services, auth };
}
function request(path: string, payload?: unknown, headers: HeadersInit = {}) {
  return new Request(`${origin}/api/customer/${path}`, payload === undefined ? {} : { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
}
function operationPorts() {
  const result = ports();
  const unused = async (): Promise<never> => { throw new Error('Unexpected operation service invocation'); };
  const operations: NonNullable<CustomerServices['operations']> = { getConfig: unused, configure: unused, claimDue: unused, getWatch: unused, heartbeatRun: unused, materialize: unused, finishRun: unused, recordObservation: unused, listAlerts: unused, updateAlert: unused, getCoverage: unused, createPlan: unused, listPlans: unused, requestPreparation: unused, attestStep: unused, checkReadiness: unused, requestExecution: unused };
  result.services.operations = operations;
  return { ...result, operations };
}
describe('authenticated customer HTTP adapter (injected services)', () => {
  it('downloads CycloneDX only through the authenticated report scope', async () => {
    const { services, auth } = ports();
    const reportId = randomUUID();
    const timestamp = new Date().toISOString();
    const targetId = randomUUID();
    const report = customerAssessmentReportSchema.parse({ version: 2, id: reportId, organizationId, applicationId, jobId: randomUUID(), applicationName: 'App', mode: 'external', startedAt: timestamp, finishedAt: timestamp, internal: null, external: { origin: 'external', status: 'completed', startedAt: timestamp, finishedAt: timestamp, snapshotRef: 'target:snapshot:1', tool: { name: 'synthetic-test', version: '1' }, findings: [], evidence: [], coverage: [], limitations: [] }, comparison: [], limitations: [], responseMode: 'observation', actionsPerformed: [], subject: { sourceSnapshotId: null, sourceDigest: null, targetId, targetVersion: 1, origin: 'https://app.example.com' } });
    const bom = buildCycloneDx(report);
    const exportSbom = vi.fn(async () => bom);
    services.exportSbom = exportSbom;
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const path = `workspaces/${organizationId}/applications/${applicationId}/reports/${reportId}/sbom.cyclonedx.json`;
    const response = await handle(new Request(`${origin}/api/customer/${path}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.cyclonedx+json');
    expect(response.headers.get('content-disposition')).toContain(`${reportId}.cdx.json`);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(bom);
    expect(exportSbom).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, reportId });
    auth.identity = async () => null;
    expect((await handle(new Request(`${origin}/api/customer/${path}`))).status).toBe(401);
    expect(exportSbom).toHaveBeenCalledTimes(1);
  });

  it('reads and updates workspace license policy through the authenticated path scope', async () => {
    const { services, auth } = ports();
    const policy: LicensePolicy = { allow: ['MIT'], deny: [], review: ['UNKNOWN'] };
    const getPolicy = vi.fn(async () => ({ organizationId, policy, updatedAt: null, configured: false }));
    const updatePolicy = vi.fn(async (_identity: { userId: string }, input: { organizationId: string; policy: LicensePolicy }) => ({ organizationId: input.organizationId, policy: input.policy, updatedAt: new Date().toISOString(), configured: true }));
    services.getLicensePolicy = getPolicy;
    services.updateLicensePolicy = updatePolicy;
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const path = `/api/customer/workspaces/${organizationId}/license-policy`;
    const fetched = await handle(new Request(`${origin}${path}`));
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ organizationId, policy, configured: false });
    expect(getPolicy).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId });

    const invalid = await handle(new Request(`${origin}${path}`, { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ allow: ['MIT'], deny: ['MIT'], review: [] }) }));
    expect(invalid.status).toBe(400);
    expect(updatePolicy).not.toHaveBeenCalled();
    const updated = await handle(new Request(`${origin}${path}`, { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(policy) }));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ organizationId, policy, configured: true });
    expect(updatePolicy).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, policy });
  });

  it('renames a workspace using the authenticated path scope', async () => {
    const { services, auth } = ports();
    const workspace = { id: organizationId, name: 'Renamed', role: 'owner' as const };
    services.updateWorkspace = vi.fn(async (identity, input) => {
      expect(identity).toEqual({ userId });
      expect(input).toEqual({ organizationId, name: 'Renamed' });
      return workspace;
    });
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const response = await handle(new Request(`${origin}/api/customer/workspaces/${organizationId}`, { method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(workspace);
    expect(services.updateWorkspace).toHaveBeenCalledTimes(1);
  });

  it('does not let an authenticated identity create the first self-host Owner outside /setup', async () => {
    const { services, auth } = ports();
    const bootstrapComplete = vi.fn(async () => false);
    const localAccounts: LocalAccounts = {
      register: async () => ({ id: 'account-id' }),
      bootstrap: async () => ({ id: 'account-id' }),
      authenticate: async () => null,
      emailExists: async () => false,
      bootstrapComplete,
      accountEmail: async () => null,
      reauthenticate: async () => null,
      epoch: async () => null,
    };
    const createWorkspace = vi.fn(async () => ({ id: organizationId, name: 'Unapproved', role: 'owner' as const }));
    services.createWorkspace = createWorkspace;
    const handle = createCustomerApi({ auth, origin, services, localAccounts, selfHostSetup: true, registrationEnabled: false, providers: [] });
    const response = await handle(request('workspaces', { name: 'Unapproved' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'self_host_setup_required' } });
    expect(bootstrapComplete).toHaveBeenCalledExactlyOnceWith();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it('reads and updates workspace retention through the authenticated workspace path', async () => {
    const { services, auth } = ports();
    const policy: WorkspaceRetentionPolicy = { organizationId, sourceSnapshotDays: 90, containerImageDays: 30, reportDays: 365,
      observationDays: 30, runDays: 30, notificationDeliveryDays: 90, protectionEventDays: 30, updatedAt: new Date().toISOString() };
    const getPolicy = vi.fn(async () => policy);
    const updatePolicy = vi.fn(async (_identity: { userId: string }, input: { organizationId: string; sourceSnapshotDays: number; containerImageDays: number; reportDays: number; observationDays: number; runDays: number; notificationDeliveryDays: number; protectionEventDays: number }) => ({ ...input, updatedAt: new Date().toISOString() }));
    services.retention = { getPolicy, updatePolicy, claimDue: async () => [], purge: async () => ({ sourceSnapshots: 0, containerImages: 0, reports: 0, observations: 0, runs: 0, notificationDeliveries: 0, protectionEvents: 0, proposalsInvalidated: 0, runsTrimmed: 0, observationsTrimmed: 0, plansTrimmed: 0 }) };
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const path = `/api/customer/workspaces/${organizationId}/retention`;
    const fetched = await handle(new Request(`${origin}${path}`));
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject(policy);
    expect(getPolicy).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId });
    const invalid = await handle(new Request(`${origin}${path}`, { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...policy, sourceSnapshotDays: 0 }) }));
    expect(invalid.status).toBe(400);
    expect(updatePolicy).not.toHaveBeenCalled();
    const updated = await handle(new Request(`${origin}${path}`, { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ ...policy, updatedAt: undefined, organizationId: undefined }) }));
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ ...policy, updatedAt: expect.any(String) });
    expect(updatePolicy).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, sourceSnapshotDays: 90, containerImageDays: 30, reportDays: 365, observationDays: 30, runDays: 30, notificationDeliveryDays: 90, protectionEventDays: 30 });
  });

  it('fails closed when step-up routes are unavailable', async () => {
    const { services, auth } = ports();
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const response = await handle(request('step-up/challenges', { organizationId, actionHash: 'a'.repeat(64) }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'step_up_not_configured' } });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('dispatches step-up routes only for the session identity and returns no-store responses', async () => {
    const { services, auth } = ports();
    services.stepUp = {
      verifier: { verify: async () => { throw new Error('Unexpected verifier call'); } },
      invalidateSession: vi.fn(async () => undefined),
      list: vi.fn(async () => []), beginEnrollment: vi.fn(async () => ({ challengeId: randomUUID(), expiresAt: new Date(), options: { challenge: 'random-challenge', rp: { name: 'Gotchu' }, user: { id: 'user', name: 'user', displayName: 'user' }, pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }] } })),
      beginRecoveryEnrollment: vi.fn(async () => ({ challengeId: randomUUID(), expiresAt: new Date(), options: { challenge: 'random-challenge', rp: { name: 'Gotchu' }, user: { id: 'user', name: 'user', displayName: 'user' }, pubKeyCredParams: [{ type: 'public-key' as const, alg: -7 }] } })),
      finishEnrollment: vi.fn(async () => ({ factor: { id: randomUUID(), credentialId: 'credential', label: 'Llave', createdAt: new Date().toISOString(), lastUsedAt: null }, recoveryCodes: [] })),
      beginChallenge: vi.fn(async () => ({ challengeId: randomUUID(), expiresAt: new Date(), options: { challenge: 'random-challenge', rpId: 'localhost', userVerification: 'required' as const } })),
      finishAssertion: vi.fn(async () => ({ proof: 'x'.repeat(32), expiresAt: new Date() })),
      rename: vi.fn(async () => undefined), revoke: vi.fn(async () => undefined), revokeWithRecovery: vi.fn(async () => undefined),
    };
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const response = await handle(request('step-up/challenges', { organizationId, actionHash: 'a'.repeat(64) }));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.getSetCookie()).toContain('authjs.session-token=refreshed; Path=/; HttpOnly');
    expect(services.stepUp?.beginChallenge).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, actionHash: 'a'.repeat(64) });
    auth.identity = async () => null;
    expect((await handle(request('step-up/challenges', { organizationId, actionHash: 'a'.repeat(64) }))).status).toBe(401);
  });
  it('prepares only an exact finding/digest selection using authenticated path scope', async () => {
    const { services, auth } = ports();
    const reportId = randomUUID(); const findingId = randomUUID();
    const selection = { recipeId: 'tls-certificate-verification', findingId, expectedSourceDigest: 'a'.repeat(64) };
    const result = { sourceId: randomUUID(), jobId: randomUUID(), changes: [{ path: 'src/tls.ts', description: 'Enable certificate verification.' }], patchHash: 'b'.repeat(64) };
    const prepare = vi.fn(async () => result);
    services.corrections = { prepare, prepareDependencyFix: async () => { throw new Error('Unexpected dependency fix preparation'); }, recommendations: async () => { throw new Error('Unexpected recommendations read'); } };
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const path = `workspaces/${organizationId}/applications/${applicationId}/reports/${reportId}/corrections`;
    for (const extra of [{ verified: true }, { command: 'arbitrary command' }, { organizationId: randomUUID() }, { source: { files: [] } }]) {
      expect((await handle(request(path, { ...selection, ...extra }))).status).toBe(400);
    }
    expect(prepare).not.toHaveBeenCalled();
    const response = await handle(request(path, selection));
    expect(response.status).toBe(201); expect(await response.json()).toEqual(result);
    expect(prepare).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, reportId, ...selection });
  });
  it('exposes validation status by candidate and versioned suite setup to authenticated workspace members', async () => {
    const { services, auth } = ports();
    const candidateSourceId = randomUUID(); const repositoryLinkId = randomUUID();
    const validationStatus = vi.fn(async () => null);
    services.corrections = { recommendations: async () => { throw new Error('Unexpected recommendations read'); }, prepare: async () => { throw new Error('Unexpected correction preparation'); }, prepareDependencyFix: async () => { throw new Error('Unexpected dependency fix preparation'); }, validationStatus };
    const suite = { id: randomUUID(), organizationId, applicationId, repositoryLinkId, version: 1, profile: 'node24-npm-test' as const, scriptName: 'test', suiteName: 'API tests', requiredCount: 4, regressionTestPath: null, createdAt: new Date().toISOString() };
    const configureSuite = vi.fn(async () => suite);
    services.validations = { configureSuite, getStatus: async () => null, getValidationFacts: async () => null };
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const statusRequest = new Request(`${origin}/api/customer/workspaces/${organizationId}/applications/${applicationId}/corrections/${candidateSourceId}`);
    expect(await (await handle(statusRequest)).json()).toBeNull();
    expect(validationStatus).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, candidateSourceId });
    const configured = await handle(request(`workspaces/${organizationId}/applications/${applicationId}/validation-suites`, { repositoryLinkId, scriptName: 'test', suiteName: 'API tests', requiredCount: 4, regressionTestPath: null }));
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual(suite);
    expect(configureSuite).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, repositoryLinkId, scriptName: 'test', suiteName: 'API tests', requiredCount: 4, regressionTestPath: null });
  });
  it('dispatches versioned action references with strict request fields and refreshed session cookies', async () => {
    const { services, auth } = ports();
    const proposalId = randomUUID();
    const propose = vi.fn(async (_identity: { userId: string }, _input: { organizationId: string; applicationId: string; kind: string; sourceRef: unknown }) => ({ proposalId, actionHash: 'a'.repeat(64) }));
    const projection = { id: proposalId, actionHash: 'a'.repeat(64), kind: 'source_patch_pull_request' as const, state: 'ineligible' as const, effect: 'Abrir una solicitud de cambio', scope: 'Aplicación', target: { kind: 'repository' as const, repositoryLinkId: randomUUID(), repositoryKey: 'catalog:key', branch: 'main' }, cost: { state: 'unknown' as const, amount: null }, diff: null, validations: [], limits: [], blockingReasons: [], createdAt: new Date().toISOString() };
    services.actions = {
      list: async () => [], get: async () => projection, propose, getEligibility: async () => ({ status: 'ineligible' as const, blockingReasons: ['sin adaptador de escritura'] }),
      approve: async () => ({ approvalId: randomUUID(), expiresAt: new Date() }), cancel: async () => undefined,
    };
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const prefix = `workspaces/${organizationId}/applications/${applicationId}/actions`;
    const ref = { kind: 'source_patch_pull_request', sourceRef: { type: 'correction_candidate', candidateId: randomUUID() } };
    expect((await handle(request(prefix, { ...ref, payload: { target: 'attacker/repo' } }))).status).toBe(400);
    const response = await handle(request(prefix, ref));
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toContain('authjs.session-token=refreshed; Path=/; HttpOnly');
    expect(await response.json()).toEqual({ proposalId, actionHash: 'a'.repeat(64) });
    expect(propose).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, ...ref });
  });
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
  it('validates workspace decision-history queries and forwards only the authenticated identity', async () => {
    const { services, auth } = ports();
    const page = decisionRecordPageSchema.parse({ records: [], nextCursor: null });
    const list = vi.fn(async () => page);
    services.decisionRecords = { list };
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const path = `${origin}/api/customer/workspaces/${organizationId.toUpperCase()}/decision-records`;
    const response = await handle(new Request(`${path}?limit=10&subjectType=alert&subjectId=${applicationId}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual(page);
    expect(list).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, limit: 10, subjectType: 'alert', subjectId: applicationId });

    list.mockRejectedValueOnce(new BackendError('forbidden', 'No tienes acceso a este espacio.', 403));
    expect((await handle(new Request(`${path}`))).status).toBe(403);

    expect((await handle(new Request(`${path}?limit=51`))).status).toBe(400);
    expect((await handle(new Request(`${path}?unknown=value`))).status).toBe(400);
    expect(list).toHaveBeenCalledTimes(2);
    auth.identity = async () => null;
    expect((await handle(new Request(`${path}`))).status).toBe(401);
    expect(list).toHaveBeenCalledTimes(2);
  });
  it('records report downloads only after the authenticated workspace service accepts them', async () => {
    const { services, auth } = ports();
    const reportId = randomUUID();
    const record = vi.fn(async () => undefined);
    services.recordReportDownload = record;
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const path = `workspaces/${organizationId}/applications/${applicationId}/reports/${reportId}/download`;
    expect((await handle(request(path, {}))).status).toBe(204);
    expect(record).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, reportId });
    record.mockRejectedValueOnce(new BackendError('forbidden', 'No tienes acceso.', 403));
    expect((await handle(request(path, {}))).status).toBe(403);
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
  it('accepts a bounded raw image archive only through the authenticated, authorized upload route', async () => {
    const { services, auth } = ports();
    const imageId = randomUUID();
    const createdAt = new Date().toISOString();
    const archive = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const upload = vi.fn(async (
      _identity: Parameters<CustomerServices['uploadContainerImage']>[0],
      input: Parameters<CustomerServices['uploadContainerImage']>[1],
      bytes: Parameters<CustomerServices['uploadContainerImage']>[2],
    ) => ({
      organizationId: input.organizationId, applicationId: input.applicationId, id: imageId,
      digest: 'a'.repeat(64), label: input.label, size: bytes.byteLength, createdAt,
    }));
    services.uploadContainerImage = upload;
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const path = `workspaces/${organizationId}/applications/${applicationId}/container-images?label=customer.tar&authorized=true`;
    const response = await handle(new Request(`${origin}/api/customer/${path}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/x-tar' }, body: archive,
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      organizationId, applicationId, id: imageId, digest: 'a'.repeat(64), label: 'customer.tar', size: archive.byteLength, createdAt,
    });
    expect(upload).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, label: 'customer.tar', authorized: true }, Buffer.from(archive));

    const invalidType = await handle(new Request(`${origin}/api/customer/${path}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
    }));
    expect(invalidType.status).toBe(415);
    expect(upload).toHaveBeenCalledTimes(1);
  });
  it('reports invalid backend output as a server error rather than a successful empty result', async () => {
    const { services, auth } = ports(); services.job = async () => ({ id: randomUUID(), secret: 'must not be exposed' });
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const result = await handle(request(`workspaces/${organizationId}/jobs/${randomUUID()}`));
    expect(result.status).toBe(500); expect(await result.text()).not.toContain('must not be exposed');
  });

  it('protects member routes with CSRF, no-store, refreshed cookies, and body-only invitation tokens', async () => {
    const { services, auth } = ports();
    const accept = vi.fn(async (_identity, _email, _input) => ({ organizationId, role: 'viewer' as const }));
    const members = {
      list: vi.fn(async () => [{ userId, email: 'member@example.test', role: 'owner' as const, joinedAt: '2026-10-24T00:00:00.000Z' }]),
      listInvitations: vi.fn(async () => []), invite: vi.fn(async () => { throw new Error('unused'); }),
      revokeInvitation: vi.fn(async () => undefined), accept, changeRole: vi.fn(async () => undefined), remove: vi.fn(async () => undefined), leave: vi.fn(async () => undefined),
    };
    services.members = members;
    auth.identity = async () => ({ userId, cookies: ['session=refreshed; HttpOnly'] });
    auth.accountEmail = vi.fn(async () => 'MEMBER@example.test');
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const read = await handle(new Request(`${origin}/api/customer/workspaces/${organizationId}/members`));
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('private, no-store');
    expect(await read.json()).toMatchObject([{ email: 'member@example.test', role: 'owner' }]);
    expect(read.headers.getSetCookie()).toEqual(['session=refreshed; HttpOnly']);

    const token = 'a'.repeat(43);
    const queryOnly = await handle(new Request(`${origin}/api/customer/invitations/accept?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' }));
    expect(queryOnly.status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
    const csrf = await handle(new Request(`${origin}/api/customer/invitations/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }));
    expect(csrf.status).toBe(403);
    expect(accept).not.toHaveBeenCalled();
    const accepted = await handle(new Request(`${origin}/api/customer/invitations/accept`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) }));
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('cache-control')).toBe('private, no-store');
    expect(await accepted.json()).toEqual({ organizationId, role: 'viewer' });
    expect(accept).toHaveBeenCalledExactlyOnceWith({ userId }, 'MEMBER@example.test', { token });
    expect(auth.accountEmail).toHaveBeenCalledTimes(2);
    expect(auth.accountEmail).toHaveBeenNthCalledWith(1, userId);
    expect(auth.accountEmail).toHaveBeenNthCalledWith(2, userId);
  });

  it('deletes with no request body and returns an empty private 204 with refreshed session cookies', async () => {
    const { services, auth } = ports();
    const sourceSnapshotId = randomUUID();
    services.deleteSource = vi.fn(async () => undefined);
    auth.identity = async () => ({ userId, cookies: ['authjs.session-token=refreshed; HttpOnly; SameSite=Lax'] });
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const response = await handle(new Request(`${origin}/api/customer/workspaces/${organizationId.toUpperCase()}/applications/${applicationId.toUpperCase()}/sources/${sourceSnapshotId.toUpperCase()}`, { method: 'DELETE', headers: { origin } }));
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
    expect(response.headers.has('content-type')).toBe(false);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.getSetCookie()).toEqual(['authjs.session-token=refreshed; HttpOnly; SameSite=Lax']);
    expect(services.deleteSource).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, sourceSnapshotId });
  });

  it('requires a session, same-origin mutation and valid scope before deleting', async () => {
    const { services, auth } = ports();
    services.deleteSource = vi.fn(async () => undefined);
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const path = `${origin}/api/customer/workspaces/${organizationId}/applications/${applicationId}/sources/${randomUUID()}`;
    for (const headers of [{}, { origin: 'https://attacker.invalid' }]) {
      expect((await handle(new Request(path, { method: 'DELETE', headers }))).status).toBe(403);
    }
    for (const invalid of [path.replace(organizationId, 'invalid'), path.replace(applicationId, 'invalid'), `${path.slice(0, path.lastIndexOf('/'))}/invalid`]) {
      expect((await handle(new Request(invalid, { method: 'DELETE', headers: { origin } }))).status).toBe(400);
    }
    auth.identity = async () => null;
    expect((await handle(new Request(path, { method: 'DELETE', headers: { origin, 'x-user-id': userId } }))).status).toBe(401);
    expect(services.deleteSource).not.toHaveBeenCalled();
  });

  it('preserves backend membership, scoped not-found and in-use deletion errors', async () => {
    const { services, auth } = ports();
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    for (const [status, code] of [[403, 'forbidden'], [404, 'not_found'], [409, 'source_in_use']] as const) {
      services.deleteSource = async () => { throw new BackendError(code, 'Deletion denied', status); };
      const response = await handle(new Request(`${origin}/api/customer/workspaces/${organizationId}/applications/${applicationId}/sources/${randomUUID()}`, { method: 'DELETE', headers: { origin } }));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code, message: 'Deletion denied' } });
    }
  });

  it('retains the existing POST deletion action for compatible callers', async () => {
    const { services, auth } = ports();
    const sourceSnapshotId = randomUUID();
    services.deleteSource = vi.fn(async () => undefined);
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const response = await handle(request(`workspaces/${organizationId}/applications/${applicationId}/sources/${sourceSnapshotId}/delete`, {}));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(services.deleteSource).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, sourceSnapshotId });
  });

  it('binds monitoring writes to the session/path and never exposes trusted observation ingestion', async () => {
    const { services, auth, operations } = operationPorts();
    const targetId = randomUUID();
    operations.configure = vi.fn(async (_identity, input) => ({ ...input, sourceSnapshotId: input.sourceSnapshotId ?? null, targetId: input.targetId ?? null, repositoryKey: input.repositoryKey ?? null, providers: input.providers ?? [], revision: 1, nextDueAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const prefix = `workspaces/${organizationId}/applications/${applicationId}`;
    const value = { enabled: true, intervalSeconds: 21600, targetId };
    const put = (body: unknown) => new Request(`${origin}/api/customer/${prefix}/monitoring`, { method: 'PUT', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await handle(put({ ...value, organizationId: randomUUID(), verified: true }))).status).toBe(400);
    expect((await handle(put(value))).status).toBe(200);
    expect(operations.configure).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, enabled: true, intervalSeconds: 21600, sourceSnapshotId: null, targetId, repositoryKey: null, providers: [] });
    expect((await handle(request(`${prefix}/observations`, { kind: 'upstream_outage', verified: true }))).status).toBe(404);
  });

  it('requires the exact stored plan binding and propagates disabled execution instead of reporting success', async () => {
    const { services, auth, operations } = operationPorts(); const planId = randomUUID(); const actionHash = 'a'.repeat(64);
    const plan = operationPlanSchema.parse({ organizationId, applicationId, id: planId, kind: 'review_improvement', revision: 2, actionHash, state: 'preparation_requested', observationIds: [randomUUID()], steps: [], limitations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), execution: 'disabled' });
    operations.requestPreparation = vi.fn(async () => plan);
    operations.requestExecution = async () => { throw new BackendError('operation_execution_unavailable', 'Independent execution requirements are unavailable', 503); };
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const prefix = `workspaces/${organizationId}/applications/${applicationId}/plans/${planId}`;
    expect((await handle(request(`${prefix}/prepare`, { revision: 1, actionHash, approved: true }))).status).toBe(400);
    expect((await handle(request(`${prefix}/prepare`, { revision: 1, actionHash }))).status).toBe(200);
    expect(operations.requestPreparation).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, planId, revision: 1, actionHash });
    const unavailable = await handle(request(`${prefix}/execute`, { revision: 2, actionHash }));
    expect(unavailable.status).toBe(503); expect(await unavailable.json()).toMatchObject({ error: { code: 'operation_execution_unavailable' } });
  });
});

describe('authenticated context inventory HTTP adapter', () => {
  it('does not dispatch unrelated paths that merely contain the context prefix', async () => {
    const { services, auth } = ports();
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const response = await handle(new Request(`${origin}/api/customer/workspaces/${organizationId}/applications/${applicationId}/contexts`));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('uses the session identity, validates response contracts, and restricts repositories to the operator catalog', async () => {
    const { services, auth } = ports();
    const inventory = { environments: [], services: [], repositoryLinks: [], deployments: [], dependencies: [], origins: [] };
    const createRepositoryLink = vi.fn(async () => undefined);
    services.context = {
      list: async () => inventory,
      createEnvironment: async () => undefined,
      updateEnvironment: async () => undefined,
      archiveEnvironment: async () => undefined,
      createService: async () => undefined,
      updateService: async () => undefined,
      createRepositoryLink,
      revokeRepositoryLink: async () => undefined,
      createDeployment: async () => undefined,
      createDependency: async () => undefined,
      createOriginCandidate: async () => undefined,
    };
    services.repositoryCatalog = vi.fn(async () => [{ key: 'repo-main', label: 'Repositorio principal' }]);
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const prefix = `workspaces/${organizationId}/applications/${applicationId}/context`;
    const response = await handle(new Request(`${origin}/api/customer/${prefix}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(inventory);
    const repoRequest = (repositoryKey: string) => new Request(`${origin}/api/customer/${prefix}/repositories`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ repositoryKey, defaultBranch: 'main' }) });
    const outsideCatalog = await handle(repoRequest('outside-catalog'));
    expect(outsideCatalog.status).toBe(404);
    expect(await outsideCatalog.json()).toMatchObject({ error: { code: 'repository_not_in_catalog' } });
    expect(createRepositoryLink).not.toHaveBeenCalled();
    expect((await handle(repoRequest('repo-main'))).status).toBe(500);
    expect(services.repositoryCatalog).toHaveBeenCalledWith({ userId }, { organizationId, applicationId });
    const deployment = new Request(`${origin}/api/customer/${prefix}/deployments`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ environmentId: randomUUID(), serviceId: randomUUID(), releaseId: 'release-1', deployedAt: new Date().toISOString(), state: 'verified' }) });
    expect((await handle(deployment)).status).toBe(400);
    const originCandidate = new Request(`${origin}/api/customer/${prefix}/origins`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ environmentId: randomUUID(), origin: 'https://example.com', discoverySource: 'customer_inventory', ownership: 'verified' }) });
    expect((await handle(originCandidate)).status).toBe(400);
    const trustRequests = [
      new Request(`${origin}/api/customer/${prefix}/environments`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'production', kind: 'production', state: 'verified' }) }),
      new Request(`${origin}/api/customer/${prefix}/environments`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'staging', kind: 'staging', source: 'signed_telemetry' }) }),
      repoRequest('repo-main').clone(),
    ];
    const repoWithTrust = new Request(`${origin}/api/customer/${prefix}/repositories`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ repositoryKey: 'repo-main', defaultBranch: 'main', readAccess: 'granted' }) });
    trustRequests[2] = repoWithTrust;
    for (const invalid of trustRequests) expect((await handle(invalid)).status).toBe(400);
  });

  it('accepts the client environment PATCH path and only the exact archive suffix', async () => {
    const { services, auth } = ports();
    const environmentId = randomUUID();
    const environment = { id: environmentId, applicationId, name: 'staging', kind: 'staging' as const, archived: false,
      state: 'declared' as const, source: 'customer_declared' as const, observedAt: null, createdAt: new Date().toISOString() };
    const updateEnvironment = vi.fn(async () => environment);
    const archiveEnvironment = vi.fn(async () => ({ ...environment, archived: true }));
    services.context = {
      list: async () => ({ environments: [], services: [], repositoryLinks: [], deployments: [], dependencies: [], origins: [] }),
      createEnvironment: async () => undefined, updateEnvironment, archiveEnvironment,
      createService: async () => undefined, updateService: async () => undefined,
      createRepositoryLink: async () => undefined, revokeRepositoryLink: async () => undefined,
      createDeployment: async () => undefined, createDependency: async () => undefined, createOriginCandidate: async () => undefined,
    };
    const handle = createCustomerApi({ auth, origin, services, registrationEnabled: false, providers: [] });
    const prefix = `workspaces/${organizationId}/applications/${applicationId}/context/environments/${environmentId}`;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('origin', origin);
      return handle(new Request(new URL(String(input), origin), { ...init, headers }));
    });
    const patch = (suffix = '') => new Request(`${origin}/api/customer/${prefix}${suffix}`, {
      method: 'PATCH', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'staging' }),
    });
    try {
      const updated = await contextClient.updateEnvironment({ organizationId, applicationId, environmentId, name: 'staging' });
      expect(updated).toEqual(environment);
      expect(fetchMock).toHaveBeenCalledWith(`/api/customer/${prefix}`, expect.objectContaining({ method: 'PATCH' }));
      expect(updateEnvironment).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, environmentId, name: 'staging' });
      expect((await handle(patch('/extra'))).status).toBe(404);
      expect((await handle(patch('/archive'))).status).toBe(404);
      expect(updateEnvironment).toHaveBeenCalledTimes(1);

      const archived = await contextClient.archiveEnvironment({ organizationId, applicationId, environmentId });
      expect(archived).toMatchObject({ id: environmentId, archived: true });
      expect(archiveEnvironment).toHaveBeenCalledExactlyOnceWith({ userId }, { organizationId, applicationId, environmentId, archived: true });
      expect((await handle(new Request(`${origin}/api/customer/${prefix}/archive/extra`, {
        method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
      }))).status).toBe(404);
      expect(archiveEnvironment).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
