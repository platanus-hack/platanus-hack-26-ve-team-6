import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerApiError } from '../src/components/customer-client.js';
import { operationsApi } from '../src/components/operations-client.js';

const organizationId = '8b8123ef-a1ca-43ac-91a5-9bf4b792d729';
const applicationId = '13e37f6a-784c-4f46-97dd-41bd81c6d00d';
const planId = '2c5f01dc-e145-4e6e-80b4-9a2b202445b5';
const observationId = '4a02d840-a230-4e4c-88a5-f59a080c99ae';
const now = '2026-10-24T08:00:00.000Z';

const fetchMock = vi.fn<typeof fetch>();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

const scope = { organizationId, applicationId };
const plan = {
  ...scope,
  id: planId,
  kind: 'review_improvement' as const,
  revision: 2,
  actionHash: 'a'.repeat(64),
  state: 'draft' as const,
  observationIds: [observationId],
  steps: [{ key: 'inventory' as const, instruction: 'Revisa el hallazgo.', state: 'todo' as const, attestation: null }],
  limitations: ['Preparación consultiva.'],
  createdAt: now,
  updatedAt: now,
  execution: 'disabled' as const,
};

describe('operations API client', () => {
  it('saves a single selected monitoring source and validates the returned config', async () => {
    fetchMock.mockResolvedValueOnce(json({
      ...scope,
      enabled: true,
      intervalSeconds: 21_600,
      sourceSnapshotId: observationId,
      targetId: null,
      repositoryKey: null,
      providers: ['cloudflare'],
      revision: 1,
      nextDueAt: now,
      updatedAt: now,
    }));

    const saved = await operationsApi.configure(scope, {
      enabled: true,
      intervalSeconds: 21_600,
      sourceSnapshotId: observationId,
      targetId: null,
      repositoryKey: null,
      providers: ['cloudflare'],
    });

    expect(saved.revision).toBe(1);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/monitoring`);
    expect(init?.method).toBe('PUT');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.cache).toBe('no-store');
    expect(JSON.parse(String(init?.body))).toEqual({
      enabled: true,
      intervalSeconds: 21_600,
      sourceSnapshotId: observationId,
      targetId: null,
      repositoryKey: null,
      providers: ['cloudflare'],
    });
  });

  it('binds plan preparation to the exact revision and action hash', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...plan, revision: 3, actionHash: 'b'.repeat(64) }));

    const updated = await operationsApi.preparePlan(scope, plan);

    expect(updated.revision).toBe(3);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/plans/${planId}/prepare`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ revision: 2, actionHash: 'a'.repeat(64) });
  });

  it('records checklist declarations as a revision-bound, user-supplied attestation', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...plan, revision: 3, actionHash: 'b'.repeat(64), steps: [{ ...plan.steps[0], state: 'self_reported', attestation: 'Revisé dependencias y responsables.' }] }));

    await operationsApi.attestStep(scope, plan, 'inventory', 'Revisé dependencias y responsables.');

    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/plans/${planId}/steps/inventory`);
    expect(JSON.parse(String(init?.body))).toEqual({ revision: 2, actionHash: 'a'.repeat(64), attestation: 'Revisé dependencias y responsables.' });
  });

  it('validates telemetry setup and accepts an empty 204 disable response', async () => {
    fetchMock.mockResolvedValueOnce(json({ integration: { ...scope, id: planId, status: 'active', lastEventAt: null }, signingKey: `${'A'.repeat(43)}=` }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const connection = await operationsApi.connectTelemetry(scope);
    await expect(operationsApi.disableTelemetry(scope, planId)).resolves.toBeUndefined();

    expect(connection.integration.id).toBe(planId);
    expect(connection.signingKey).toBe(`${'A'.repeat(43)}=`);
    const [connectPath, connectInit] = fetchMock.mock.calls[0] ?? [];
    expect(connectPath).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/telemetry`);
    expect(connectInit?.method).toBe('POST');
    expect(JSON.parse(String(connectInit?.body))).toEqual({});
    const [disablePath, disableInit] = fetchMock.mock.calls[1] ?? [];
    expect(disablePath).toBe(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/telemetry/${planId}`);
    expect(disableInit?.method).toBe('DELETE');
  });

  it('rejects invalid contract data before sending a request', () => {
    expect(() => operationsApi.configure(scope, {
      enabled: true,
      intervalSeconds: 60,
      sourceSnapshotId: null,
      targetId: null,
      repositoryKey: null,
      providers: [],
    })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a telemetry response with a malformed one-time signing key', async () => {
    fetchMock.mockResolvedValueOnce(json({ integration: { ...scope, id: planId, status: 'active', lastEventAt: null }, signingKey: 'not-a-key' }));

    await expect(operationsApi.connectTelemetry(scope)).rejects.toMatchObject({ status: 200, code: 'invalid_response' });
  });
});
