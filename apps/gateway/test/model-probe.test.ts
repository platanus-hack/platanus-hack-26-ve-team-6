import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { importPKCS8, importSPKI, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { issueModelProbeToken } from '@gotchu/backend';
import type { Database, Transaction } from '@gotchu/database';
import { createGatewayService } from '../src/service.js';
import { ModelProviderError, type ModelPort } from '../src/model-provider.js';

async function modelRequestFixture(remainingTokens: number) {
  const organizationId = randomUUID();
  const applicationId = randomUUID();
  const runId = randomUUID();
  const reservationId = randomUUID();
  const evidenceId = randomUUID();
  const now = new Date();
  const modelSettings = {
    provider: 'openai_compatible', provider_preset_id: 'openai', endpoint: 'https://api.openai.com/v1', model_id: 'gpt-5.4',
    secret_ref: 'fixture-secret', consent_to_external_processing: true, data_scopes: ['finding_details'],
    input_price_micro_usd_per_million_tokens: '10000', output_price_micro_usd_per_million_tokens: '20000',
  };
  const organizationLimits = {
    model_opt_in: true, model_budget_micros: '100000', model_spent_micros: '0', model_reserved_micros: '0',
    model_token_budget: '100000', model_tokens_spent: '0', model_tokens_reserved: '0',
  };
  const state = { reserveCount: 0, requestMaxOutputTokens: 0 };
  const query = async <R extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<R>> => {
    let rows: Record<string, unknown>[] = [];
    if (text.includes('FROM gotchu.agent_runs r JOIN gotchu.jobs')) {
      rows = [{ applicationId, state: 'running', deadline: new Date(now.getTime() + 60_000), cancelRequested: false,
        payload: { version: 2, subject: { kind: 'incident', subjectId: randomUUID() }, evidenceIds: [evidenceId] },
        jobState: 'running', jobLeaseUntil: new Date(now.getTime() + 60_000) }];
    } else if (text.includes('SELECT clock_timestamp() AS now')) rows = [{ now }];
    else if (text.includes('FROM gotchu.gateway_revoked_capabilities')) rows = [];
    else if (text.includes('FROM gotchu.investigation_model_settings s JOIN gotchu.organizations')) rows = [modelSettings];
    else if (text.includes('FROM gotchu.gateway_read_calls')) rows = [];
    else if (text.includes('SELECT model_opt_in,model_budget_micros')) rows = [organizationLimits];
    else if (text.includes('FROM gotchu.investigation_model_settings WHERE')) rows = [modelSettings];
    else if (text.includes('SELECT run_id,amount_micros,reserved_tokens,')) rows = [{ run_id: runId, amount_micros: '10000', reserved_tokens: String(remainingTokens), token_limit_enforced: true, charged_micros: null, charged_tokens: null, input_tokens: null, output_tokens: null }];
    else if (text.includes('FROM gotchu.model_reservations')) rows = [];
    else if (text.includes('SELECT model_calls,reserved_micros')) rows = [{ model_calls: 0, reserved_micros: '0', spent_micros: '0', tokens_reserved: '0', tokens_spent: '0' }];
    else if (text.includes('INSERT INTO gotchu.model_reservations')) state.reserveCount++;
    return { command: 'SELECT', rowCount: rows.length || (text.startsWith('UPDATE') ? 1 : 0), oid: 0, fields: [], rows: rows as R[] };
  };
  const transaction: Transaction = { query };
  const database: Database = {
    role: 'gotchu_coordinator', tenant: async <T>(_id: string, work: (tx: Transaction) => Promise<T>) => work(transaction),
    integration: async <T>(_id: string, work: (tx: Transaction) => Promise<T>) => work(transaction),
    system: async <T>(work: (tx: Transaction) => Promise<T>) => work(transaction),
    checkHealth: async () => undefined, close: async () => undefined,
  };
  const pair = generateKeyPairSync('ed25519');
  const publicKey = await importSPKI(pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'EdDSA');
  const privateKey = await importPKCS8(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'EdDSA');
  const issuedAt = Math.floor(Date.now() / 1_000);
  const token = await new SignJWT({ organizationId, applicationId, runId, allowedReadTools: ['evidence.read'], evidenceIds: [evidenceId] })
    .setProtectedHeader({ alg: 'EdDSA' }).setIssuer('gotchu-run-capability-issuer').setAudience('gotchu-investigation-worker')
    .setSubject(runId).setJti(randomUUID()).setIssuedAt(issuedAt).setExpirationTime(issuedAt + 300).sign(privateKey);
  const modelPort: ModelPort = { complete: async request => {
    state.requestMaxOutputTokens = request.maxOutputTokens ?? 0;
    return { output: { ok: true }, inputTokens: 1, outputTokens: 1 };
  } };
  const gateway = createGatewayService({ database, capabilityPublicKey: publicKey, modelPort,
    modelSecrets: { get: async () => Buffer.from('fixture-provider-key'), put: async () => undefined,
      replace: async () => undefined, delete: async () => undefined } });
  const request = () => gateway.request({ token, runId, operation: 'model', idempotencyKey: reservationId, body: {
    organizationId, applicationId, reservationId, systemInstruction: '', userContext: 'x'.repeat(600),
    maxOutputTokens: 2_048, remainingTokens, remainingSpendMicroUsd: 10_000,
  } });
  return { request, state };
}

describe('gateway model-call token reservation', () => {
  it('reduces output allowance to fit the prompt estimate', async () => {
    const fixture = await modelRequestFixture(2_000);
    await fixture.request();
    expect(fixture.state.requestMaxOutputTokens).toBeGreaterThanOrEqual(64);
    expect(fixture.state.requestMaxOutputTokens).toBeLessThan(2_000);
    expect(fixture.state.reserveCount).toBe(1);
  });

  it('rejects a reservation with fewer than 64 output tokens before reserving', async () => {
    const fixture = await modelRequestFixture(64);
    await expect(fixture.request()).rejects.toMatchObject({ code: 'model_budget_exhausted' });
    expect(fixture.state.reserveCount).toBe(0);
    expect(fixture.state.requestMaxOutputTokens).toBe(0);
  });
});

/** Answers the gateway's probe queries from fixed settings and records reservation and settlement writes. */
function probeDatabase(requestId: string, modelSettings: Record<string, unknown>, organizationLimits: Record<string, unknown>) {
  const probe: { savedProbeState: string | null; savedResult: unknown; reserveValues: unknown[]; settlementValues: unknown[]; releaseValues: unknown[] } = {
    savedProbeState: null, savedResult: null, reserveValues: [], settlementValues: [], releaseValues: [],
  };
  const query = async <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> => {
    let rows: Record<string, unknown>[] = [];
    if (text.includes('FROM gotchu.investigation_model_probes') && text.includes('FOR UPDATE')) {
      rows = probe.savedProbeState ? [{ state: probe.savedProbeState, result: probe.savedResult }] : [];
    } else if (text.includes('o.model_budget_micros')) {
      rows = [{ ...modelSettings, ...organizationLimits }];
    } else if (text.includes('FROM gotchu.investigation_model_settings')) {
      rows = [modelSettings];
    } else if (text.includes('INSERT INTO gotchu.investigation_model_probes')) {
      probe.savedProbeState = 'in_flight';
      rows = [{ request_id: requestId }];
    } else if (text.includes('model_reserved_micros=model_reserved_micros+$2')) {
      probe.reserveValues = values ?? [];
    } else if (text.includes("SET state='settled'")) {
      probe.savedProbeState = 'settled';
      probe.settlementValues = values ?? [];
      probe.savedResult = JSON.parse(String(values?.at(-1)));
    } else if (text.includes('model_reserved_micros=model_reserved_micros-$2') && !text.includes('model_spent_micros')) {
      probe.releaseValues = values ?? [];
    }
    return { command: 'SELECT', rowCount: rows.length || (text.startsWith('UPDATE') ? 1 : 0), oid: 0, fields: [], rows: rows as R[] };
  };
  const transaction: Transaction = { query };
  const database: Database = {
    role: 'gotchu_coordinator', tenant: async <T>(_id: string, work: (tx: Transaction) => Promise<T>) => work(transaction),
    integration: async <T>(_id: string, work: (tx: Transaction) => Promise<T>) => work(transaction),
    system: async <T>(work: (tx: Transaction) => Promise<T>) => work(transaction),
    checkHealth: async () => undefined, close: async () => undefined,
  };
  return { database, probe };
}

describe('gateway model connection probe (injected provider and database fixtures; not live)', () => {
  it('reserves the tiny budget and settles actual token usage returned by the adapter', async () => {
    const organizationId = randomUUID();
    const requestId = randomUUID();
    const secret = randomBytes(32);
    const providerKey = 'fixture-provider-key';
    const modelSettings = {
      provider: 'openai_compatible', provider_preset_id: 'openai', endpoint: 'https://api.openai.com/v1',
      model_id: 'gpt-5.4', secret_ref: 'fixture-secret', consent_to_external_processing: true,
      data_scopes: ['finding_details'], input_price_micro_usd_per_million_tokens: '10000',
      output_price_micro_usd_per_million_tokens: '20000',
    };
    const organizationLimits = {
      model_budget_micros: '100000', model_spent_micros: '0', model_reserved_micros: '0',
      model_token_budget: '10000', model_tokens_spent: '0', model_tokens_reserved: '0',
    };
    let calls = 0;
    const { database, probe: state } = probeDatabase(requestId, modelSettings, organizationLimits);
    const modelPort: ModelPort = { complete: async request => {
      calls++;
      expect(request.apiKey).toBe(providerKey);
      expect(request.maxOutputTokens).toBe(16);
      expect(request.userContext).toBe('Connection test. Return the requested JSON.');
      return { output: { ok: true }, inputTokens: 11, outputTokens: 3 };
    } };
    const keyPair = generateKeyPairSync('ed25519');
    const publicKey = await importSPKI(keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'EdDSA');
    const gateway = createGatewayService({ database, capabilityPublicKey: publicKey, modelProbeSecret: secret, modelPort,
      modelSecrets: { get: async () => Buffer.from(providerKey), put: async () => undefined, replace: async () => undefined, delete: async () => undefined } });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = issueModelProbeToken(secret, { version: 1, organizationId, requestId, issuedAt, expiresAt: issuedAt + 30 });

    const result = await gateway.probe(token, { organizationId, requestId });

    expect(result).toEqual({ status: 'succeeded', reason: null, inputTokens: 11, outputTokens: 3 });
    expect(calls).toBe(1);
    expect(state.reserveValues).toEqual([organizationId, 2, 64]);
    expect(state.settlementValues.slice(0, 5)).toEqual([organizationId, requestId, 11, 3, 1]);
    expect(state.savedProbeState).toBe('settled');
    expect(JSON.stringify(state.savedResult)).not.toContain(providerKey);
    expect(await gateway.probe(token, { organizationId, requestId })).toEqual(result);
    expect(calls).toBe(1);
  });

  it('gives Codex its larger allowance, charges nothing, and writes the rotated login back', async () => {
    const organizationId = randomUUID();
    const requestId = randomUUID();
    const secret = randomBytes(32);
    const storedLogin = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"r1"}}';
    const modelSettings = {
      provider: 'codex_cli', provider_preset_id: 'codex', endpoint: 'https://chatgpt.com/backend-api/codex',
      model_id: 'gpt-6-luna', secret_ref: 'fixture-secret', consent_to_external_processing: true,
      data_scopes: ['finding_details'], input_price_micro_usd_per_million_tokens: '0', output_price_micro_usd_per_million_tokens: '0',
    };
    const organizationLimits = {
      model_budget_micros: '10000', model_spent_micros: '0', model_reserved_micros: '0',
      model_token_budget: '100000', model_tokens_spent: '0', model_tokens_reserved: '0',
    };
    const { database, probe: state } = probeDatabase(requestId, modelSettings, organizationLimits);
    const replaced: string[] = [];
    const modelPort: ModelPort = { complete: async request => {
      expect(request.apiKey).toBe(storedLogin);
      await request.persistCredential?.('{"auth_mode":"chatgpt","tokens":{"refresh_token":"r2"}}');
      return { output: { ok: true }, inputTokens: 5_095, outputTokens: 8 };
    } };
    const keyPair = generateKeyPairSync('ed25519');
    const publicKey = await importSPKI(keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'EdDSA');
    const gateway = createGatewayService({ database, capabilityPublicKey: publicKey, modelProbeSecret: secret, modelPort,
      modelSecrets: { get: async () => Buffer.from(storedLogin), put: async () => undefined, delete: async () => undefined,
        replace: async (reference, value) => { expect(reference).toBe('fixture-secret'); replaced.push(Buffer.from(value).toString('utf8')); } } });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = issueModelProbeToken(secret, { version: 1, organizationId, requestId, issuedAt, expiresAt: issuedAt + 30 });

    expect(await gateway.probe(token, { organizationId, requestId })).toEqual({ status: 'succeeded', reason: null, inputTokens: 5_095, outputTokens: 8 });
    expect(state.reserveValues).toEqual([organizationId, 1, 20_000]);
    expect(state.settlementValues.slice(0, 5)).toEqual([organizationId, requestId, 5_095, 8, 0]);
    expect(replaced).toEqual(['{"auth_mode":"chatgpt","tokens":{"refresh_token":"r2"}}']);
  });

  it('releases the reservation when the subscription rejects the login before generating anything', async () => {
    const organizationId = randomUUID();
    const requestId = randomUUID();
    const secret = randomBytes(32);
    const modelSettings = {
      provider: 'codex_cli', provider_preset_id: 'codex', endpoint: 'https://chatgpt.com/backend-api/codex',
      model_id: 'gpt-6-luna', secret_ref: 'fixture-secret', consent_to_external_processing: true,
      data_scopes: ['finding_details'], input_price_micro_usd_per_million_tokens: '0', output_price_micro_usd_per_million_tokens: '0',
    };
    const organizationLimits = {
      model_budget_micros: '10000', model_spent_micros: '0', model_reserved_micros: '0',
      model_token_budget: '100000', model_tokens_spent: '0', model_tokens_reserved: '0',
    };
    const { database, probe: state } = probeDatabase(requestId, modelSettings, organizationLimits);
    const modelPort: ModelPort = { complete: async () => { throw new ModelProviderError('request_failed', 401); } };
    const keyPair = generateKeyPairSync('ed25519');
    const publicKey = await importSPKI(keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'EdDSA');
    const gateway = createGatewayService({ database, capabilityPublicKey: publicKey, modelProbeSecret: secret, modelPort,
      modelSecrets: { get: async () => Buffer.from('{}'), put: async () => undefined, replace: async () => undefined, delete: async () => undefined } });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = issueModelProbeToken(secret, { version: 1, organizationId, requestId, issuedAt, expiresAt: issuedAt + 30 });

    expect(await gateway.probe(token, { organizationId, requestId })).toEqual({ status: 'failed', reason: 'invalid_api_key', inputTokens: null, outputTokens: null });
    expect(state.savedProbeState).toBe('settled');
    expect(state.releaseValues).toEqual([organizationId, 1, 20_000]);
  });

  it('deletes a rotated login instead of restoring it when the Owner replaced it during the call', async () => {
    const organizationId = randomUUID();
    const requestId = randomUUID();
    const secret = randomBytes(32);
    const modelSettings = {
      provider: 'codex_cli', provider_preset_id: 'codex', endpoint: 'https://chatgpt.com/backend-api/codex',
      model_id: 'gpt-6-luna', secret_ref: 'fixture-secret', consent_to_external_processing: true,
      data_scopes: ['finding_details'], input_price_micro_usd_per_million_tokens: '0', output_price_micro_usd_per_million_tokens: '0',
    };
    const organizationLimits = {
      model_budget_micros: '10000', model_spent_micros: '0', model_reserved_micros: '0',
      model_token_budget: '100000', model_tokens_spent: '0', model_tokens_reserved: '0',
    };
    const { database } = probeDatabase(requestId, modelSettings, organizationLimits);
    const deleted: string[] = [];
    const modelPort: ModelPort = { complete: async request => {
      modelSettings.secret_ref = 'owner-pasted-a-new-login';
      await request.persistCredential?.('{"auth_mode":"chatgpt","tokens":{"refresh_token":"r2"}}');
      return { output: { ok: true }, inputTokens: 5_000, outputTokens: 8 };
    } };
    const keyPair = generateKeyPairSync('ed25519');
    const publicKey = await importSPKI(keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'EdDSA');
    const gateway = createGatewayService({ database, capabilityPublicKey: publicKey, modelProbeSecret: secret, modelPort,
      modelSecrets: { get: async () => Buffer.from('{}'), put: async () => undefined, replace: async () => undefined,
        delete: async reference => { deleted.push(reference); } } });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = issueModelProbeToken(secret, { version: 1, organizationId, requestId, issuedAt, expiresAt: issuedAt + 30 });

    await gateway.probe(token, { organizationId, requestId });
    expect(deleted).toEqual(['fixture-secret']);
  });
});
