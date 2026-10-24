import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { importSPKI } from 'jose';
import { describe, expect, it } from 'vitest';
import { issueModelProbeToken } from '@gotchu/backend';
import type { Database, Transaction } from '@gotchu/database';
import { createGatewayService } from '../src/service.js';
import type { ModelPort } from '../src/model-provider.js';

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
    let savedProbeState: string | null = null;
    let savedResult: unknown = null;
    let reserveValues: unknown[] = [];
    let settlementValues: unknown[] = [];
    let calls = 0;
    const query = async <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> => {
      let rows: Record<string, unknown>[] = [];
      if (text.includes('FROM gotchu.investigation_model_probes') && text.includes('FOR UPDATE')) {
        rows = savedProbeState ? [{ state: savedProbeState, result: savedResult }] : [];
      } else if (text.includes('o.model_budget_micros')) {
        rows = [{ ...modelSettings, ...organizationLimits }];
      } else if (text.includes('FROM gotchu.investigation_model_settings')) {
        rows = [modelSettings];
      } else if (text.includes('INSERT INTO gotchu.investigation_model_probes')) {
        savedProbeState = 'in_flight';
        rows = [{ request_id: requestId }];
      } else if (text.includes('model_reserved_micros=model_reserved_micros+$2')) {
        reserveValues = values ?? [];
      } else if (text.includes("SET state='settled'")) {
        savedProbeState = 'settled';
        settlementValues = values ?? [];
        savedResult = JSON.parse(String(values?.[5]));
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
      modelSecrets: { get: async () => Buffer.from(providerKey), put: async () => undefined, delete: async () => undefined } });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = issueModelProbeToken(secret, { version: 1, organizationId, requestId, issuedAt, expiresAt: issuedAt + 30 });

    const result = await gateway.probe(token, { organizationId, requestId });

    expect(result).toEqual({ status: 'succeeded', reason: null, inputTokens: 11, outputTokens: 3 });
    expect(calls).toBe(1);
    expect(reserveValues).toEqual([organizationId, 2, 64]);
    expect(settlementValues.slice(0, 5)).toEqual([organizationId, requestId, 11, 3, 1]);
    expect(savedProbeState).toBe('settled');
    expect(JSON.stringify(savedResult)).not.toContain(providerKey);
    expect(await gateway.probe(token, { organizationId, requestId })).toEqual(result);
    expect(calls).toBe(1);
  });
});
