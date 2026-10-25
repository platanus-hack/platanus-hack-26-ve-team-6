import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { importSPKI } from 'jose';
import { describe, expect, it } from 'vitest';
import { issueModelProbeToken } from '@gotchu/backend';
import type { Database, Transaction } from '@gotchu/database';
import { createGatewayService } from '../src/service.js';
import type { ModelPort } from '../src/model-provider.js';

/** Answers the gateway's probe queries from fixed settings and records reservation and settlement writes. */
function probeDatabase(requestId: string, modelSettings: Record<string, unknown>, organizationLimits: Record<string, unknown>) {
  const probe: { savedProbeState: string | null; savedResult: unknown; reserveValues: unknown[]; settlementValues: unknown[] } = {
    savedProbeState: null, savedResult: null, reserveValues: [], settlementValues: [],
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
      probe.savedResult = JSON.parse(String(values?.[5]));
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
});
