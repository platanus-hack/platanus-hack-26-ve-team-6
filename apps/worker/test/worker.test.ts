import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT, importSPKI } from 'jose';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerHttpServer } from '../src/http.js';
import { createInvestigationWorkerService, WorkerServiceError } from '../src/worker.js';
import type { WorkerConfig } from '../src/config.js';
import type { InvestigationWorkerService } from '../src/worker.js';

const scope = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  applicationId: '22222222-2222-4222-8222-222222222222',
  runId: '33333333-3333-4333-8333-333333333333',
};
const evidenceId = '44444444-4444-4444-8444-444444444444';
const pair = generateKeyPairSync('ed25519');
const nowSeconds = Math.floor(Date.now() / 1000);
const privateKey = pair.privateKey;
const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const publicKeyPromise = importSPKI(publicPem, 'EdDSA');

async function signedCapability(): Promise<string> {
  return new SignJWT({
    ...scope,
    allowedReadTools: ['evidence.read', 'auth.events.read'],
    evidenceIds: [evidenceId],
    jti: randomUUID(),
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer('gotchu-run-capability-issuer')
    .setAudience('gotchu-investigation-worker')
    .setSubject(scope.runId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 300)
    .sign(privateKey);
}

const runInput = {
  scope,
  requiredChecks: {
    inputIntegrity: { result: 'passed', evidenceIds: [evidenceId] },
    tenantScope: { result: 'passed', evidenceIds: [evidenceId] },
    evidenceProvenance: { result: 'passed', evidenceIds: [evidenceId] },
    deterministicDetection: { result: 'candidate', evidenceIds: [evidenceId] },
  },
};

const modelResponse = {
  output: {
    assessment: 'candidate_issue',
    summary: 'One bounded evidence item supports further review.',
    citedEvidenceIds: [evidenceId],
    requestedReads: [],
  },
  usage: { inputTokens: 22, outputTokens: 14, totalTokens: 36, spendMicroUsd: 20 },
};

function evidence() {
  return {
    evidenceId,
    ...scope,
    source: 'unit-test',
    collectedAt: '2026-01-01T00:00:00.000Z',
    excerpt: 'Short bounded evidence excerpt.',
    truncated: true,
  };
}

function fakeConfig(capabilityPublicKey: Awaited<typeof publicKeyPromise>, gatewayBaseUrl?: URL): WorkerConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    nodeEnv: 'test',
    capabilityPublicKey,
    ...(gatewayBaseUrl ? { gatewayBaseUrl } : {}),
  };
}

async function withServer(service: InvestigationWorkerService, config: WorkerConfig, run: (origin: string) => Promise<void>): Promise<void> {
  const server = createWorkerHttpServer({ config, service });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('worker test server did not bind a TCP address');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('investigation worker adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires a signed capability and ignores x-user-id headers', async () => {
    const token = await signedCapability();
    const service: InvestigationWorkerService = {
      ready: true,
      async investigate(value) {
        if (value !== token) throw new Error('wrong token');
        return {
          status: 'inconclusive', assessment: 'inconclusive', summary: '', citedEvidenceIds: [], reasonCode: 'completed',
          counters: { modelCalls: 0, additionalReadToolCalls: 0, tokensUsed: 0, spendMicroUsd: 0, activeMs: 1 },
          independentVerification: 'not_verified',
        };
      },
    };
    const config = fakeConfig(await publicKeyPromise, new URL('https://gateway.example'));
    await withServer(service, config, async (origin) => {
      const unauthenticated = await fetch(`${origin}/v1/investigations`, { method: 'POST', headers: { 'x-user-id': 'attacker' } });
      expect(unauthenticated.status).toBe(401);

      const bodyRequest = await fetch(`${origin}/v1/investigations`, {
        method: 'POST',
        headers: { authorization: `RunCapability ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ runId: scope.runId }),
      });
      expect(bodyRequest.status).toBe(400);

      const authorized = await fetch(`${origin}/v1/investigations`, {
        method: 'POST',
        headers: { authorization: `RunCapability ${token}` },
      });
      expect(authorized.status).toBe(200);
    });
  });

  it('returns explicit disabled state when the gateway is not configured', async () => {
    const service = createInvestigationWorkerService({ capabilityPublicKey: await publicKeyPromise });

    expect(service.ready).toBe(false);
    await expect(service.investigate(await signedCapability())).rejects.toMatchObject({ code: 'integration_disabled', status: 503 });
    await withServer(service, fakeConfig(await publicKeyPromise), async (origin) => {
      const readiness = await fetch(`${origin}/health/ready`);
      expect(readiness.status).toBe(503);
      await expect(fetch(`${origin}/v1/investigations`, {
        method: 'POST',
        headers: { authorization: `RunCapability ${await signedCapability()}` },
      })).resolves.toMatchObject({ status: 503 });
    });
  });

  it('uses only the configured gateway origin and forwards the scoped capability and stable call IDs', async () => {
    const token = await signedCapability();
    const observed: Array<{ url: URL; method: string; headers: Headers; body: unknown }> = [];
    let checkpointVersion = 0;
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      observed.push({ url, method, headers, body });
      if (url.pathname.endsWith('/input')) return Response.json(runInput);
      if (url.pathname.endsWith('/reads')) return Response.json(evidence());
      if (url.pathname.endsWith('/model-calls')) return Response.json(modelResponse);
      if (url.pathname.endsWith('/checkpoint') && method === 'GET') return Response.json({ version: checkpointVersion, checkpoint: null });
      if (url.pathname.endsWith('/checkpoint') && method === 'PUT') {
        const payload = z.object({ expectedVersion: z.number().int(), checkpoint: z.unknown() }).parse(body);
        expect(payload.expectedVersion).toBe(checkpointVersion);
        checkpointVersion += 1;
        return Response.json({ version: checkpointVersion });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    };
    const gatewayUrl = new URL('https://fixed-gateway.example');
    const service = createInvestigationWorkerService({
      capabilityPublicKey: await publicKeyPromise,
      gatewayBaseUrl: gatewayUrl,
      fetchImpl: fetchMock,
    });

    const result = await service.investigate(token);

    expect(result).toMatchObject({ status: 'investigated', assessment: 'candidate_issue', independentVerification: 'not_verified' });
    expect(observed.length).toBeGreaterThanOrEqual(5);
    expect(observed.every((call) => call.url.origin === gatewayUrl.origin)).toBe(true);
    expect(observed.every((call) => call.headers.get('authorization') === `RunCapability ${token}`)).toBe(true);
    const modelCall = observed.find((call) => call.url.pathname.endsWith('/model-calls'));
    expect(modelCall?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    const checkpoints = observed.filter((call) => call.url.pathname.endsWith('/checkpoint') && call.method === 'PUT');
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(JSON.stringify(checkpoints)).not.toContain('Short bounded evidence excerpt.');
    expect(JSON.stringify(checkpoints)).not.toContain(token);
  });

  it('rejects forged capability before making any gateway request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createInvestigationWorkerService({
      capabilityPublicKey: await publicKeyPromise,
      gatewayBaseUrl: new URL('https://fixed-gateway.example'),
      fetchImpl: fetchMock,
    });

    await expect(service.investigate('forged-token')).rejects.toBeInstanceOf(WorkerServiceError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
