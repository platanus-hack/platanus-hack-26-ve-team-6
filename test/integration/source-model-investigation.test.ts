import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { exportPKCS8, generateKeyPair } from 'jose';
import { z } from 'zod';
import { createBackend, type ModelSecretStore } from '@gotchu/backend';
import { customerAssessmentReportSchema, defaultLicensePolicy, type CustomerRunInput, type JobEnvelope } from '@gotchu/contracts';
import { createDatabase, provisionRuntimeLogin, type Database } from '@gotchu/database';
import { createHttpInvestigator, dispatchOutbox, ensureQueueDelivery, processDurableJob } from '@gotchu/coordinator';
import { createGatewayService, startGatewayServer } from '@gotchu/gateway';
import { migrateGateway } from '@gotchu/gateway/migrate';
import { createInvestigationWorkerService, createWorkerHttpServer, listenWorkerServer } from '@gotchu/worker';
import { createSubscriptionCliPorts } from '../../apps/gateway/src/subscription-cli.js';
import { fixture, liveUrl, present } from '../../packages/database/test/support.js';

const redisUrl = process.env.GOTCHU_TEST_REDIS_URL;
const live = liveUrl && redisUrl ? describe : describe.skip;

live('automatic source investigation through real LangGraph, HTTP, PostgreSQL and Redis', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

  it('persists scoped Codex-adapter suggestions and settles accounting without repeating a delivered job', async () => {
    const f = await fixture({ max: 6 }); cleanup.push(() => f.close());
    await migrateGateway({ connectionString: present(liveUrl) });
    const directory = await mkdtemp(join(tmpdir(), 'gotchu-source-model-pipeline-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const binary = join(directory, 'codex-fixture.cjs'); const record = join(directory, 'calls.jsonl');
    // Only the provider responses and scan observations are fixtures. The production Codex
    // subprocess adapter, LangGraph, capability gateway, durable worker and databases run unchanged.
    await writeFile(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
const context = JSON.parse(fs.readFileSync(0, 'utf8'));
const args = process.argv.slice(2);
assert.equal(args[0], 'exec');
assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
assert(args.includes('--ignore-user-config'));
assert.deepEqual(fs.readdirSync(process.cwd()), []);
assert.equal(fs.statSync(process.env.CODEX_HOME + '/auth.json').mode & 511, 384);
const tools = context.evidence.map(item => item.tool);
const evidenceId = context.subject.evidenceIds[0];
const loaded = tools.includes('finding.details.read') && tools.includes('source.excerpt.read');
if (loaded) {
  const source = context.evidence.find(item => item.tool === 'source.excerpt.read').record.excerpt;
  assert(source.includes('[REDACTED]'));
  assert(!source.includes('pipeline-fixture-password'));
  assert(!source.includes('unrelated-file-marker'));
}
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({tools, loaded}) + '\\n', { mode: 384 });
const output = {
  assessment: loaded ? 'candidate_issue' : 'inconclusive',
  summary: loaded ? 'Synthetic source candidate requires human review.' : 'Read the scoped finding and source.',
  citedEvidenceIds: [evidenceId], hypotheses: [],
  candidateSuggestion: loaded ? { kind: 'source_change', summary: 'Use a runtime secret reference.',
    path: 'src/index.ts', evidenceIds: [evidenceId], validationRequired: 'D05',
    implications: ['Deployment must supply the secret.'], risks: ['Missing configuration may prevent startup.'],
    validationPlan: ['Validate missing and configured secret behavior.'] } : null,
  requestedReads: loaded ? [] : ['finding.details.read', 'source.excerpt.read'].map(name => ({name, evidenceId}))
};
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:120,output_tokens:80}}));
`, { mode: 0o700 });
    const stored = new Map<string, Uint8Array>();
    const secrets: ModelSecretStore = {
      get: async reference => present(stored.get(reference)),
      put: async (reference, secret) => { stored.set(reference, secret); },
      replace: async (reference, secret) => { stored.set(reference, secret); },
      delete: async reference => { stored.delete(reference); },
    };
    const api = createBackend({ database: f.databases.gotchu_api, modelSecrets: secrets });
    const coordinator = createBackend({ database: f.databases.gotchu_coordinator });
    const identity = { userId: f.a.userId }; const scope = { organizationId: f.a.organizationId, applicationId: f.a.applicationId };
    await api.investigationModels.configure(identity, { organizationId: scope.organizationId, providerPresetId: 'codex', modelId: 'gpt-6-luna',
      apiKey: JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'synthetic', access_token: 'synthetic', refresh_token: 'synthetic' } }),
      consentToExternalProcessing: true, automaticSourceInvestigations: true, dataScopes: ['finding_details', 'source_excerpts'],
      inputPriceMicroUsdPerMillionTokens: 0, outputPriceMicroUsdPerMillionTokens: 0,
      organizationBudgetCents: 100, organizationTokenBudget: 100_000 });
    const source = await api.customers.uploadSource(identity, { ...scope, authorized: true, snapshot: { revision: 'synthetic-fixture', files: [
      { path: 'src/index.ts', content: 'export const password = "pipeline-fixture-password";\n' },
      { path: 'src/unrelated.ts', content: 'export const marker = "unrelated-file-marker";\n' },
    ] } });
    const queued = await api.customers.queue(identity, { ...scope, mode: 'internal', sourceSnapshotId: source.id, targetId: null, idempotencyKey: randomUUID() });
    const claim = present(await coordinator.jobs.claim({ organizationId: scope.organizationId, jobId: queued.jobId, leaseMs: 120_000 }));
    const input = await coordinator.customers.getRequest({ ...scope, jobId: queued.jobId, leaseToken: claim.leaseToken });
    const report = syntheticReport(input);
    await coordinator.customers.recordResult({ input, leaseToken: claim.leaseToken, report });
    const investigation = present((await api.investigations.list(identity, scope))[0]);
    expect(investigation).toMatchObject({ state: 'queued', subject: { kind: 'finding', reportId: report.id } });
    await expect(api.investigations.list({ userId: f.b.userId }, scope)).rejects.toMatchObject({ code: 'forbidden' });

    const keys = await generateKeyPair('EdDSA', { extractable: true });
    const username = `source_model_${randomBytes(6).toString('hex')}`;
    const password = randomBytes(32).toString('hex');
    await provisionRuntimeLogin({ connectionString: present(liveUrl), username, password, role: 'gotchu_coordinator' });
    cleanup.push(() => f.admin.query(`DROP ROLE ${username}`));
    const url = new URL(present(liveUrl)); url.username = username; url.password = password;
    const gatewayDatabase: Database = createDatabase({ connectionString: url.href, role: 'gotchu_coordinator', max: 4 });
    cleanup.push(() => gatewayDatabase.close());
    const gateway = await startGatewayServer({ host: '127.0.0.1', port: 0, transport: { mode: 'loopback-http', nodeEnv: 'test' },
      service: createGatewayService({ database: gatewayDatabase, capabilityPublicKey: keys.publicKey, modelSecrets: secrets,
        modelPort: createSubscriptionCliPorts({ codexBinary: binary }).codex }) });
    cleanup.push(() => gateway.close());
    const config = { host: '127.0.0.1', port: 0, nodeEnv: 'test' as const, capabilityPublicKey: keys.publicKey, gatewayBaseUrl: new URL(`http://127.0.0.1:${gateway.port}`) };
    const workerServer: Server = createWorkerHttpServer({ config, service: createInvestigationWorkerService(config) });
    await listenWorkerServer(workerServer, config);
    cleanup.push(() => new Promise<void>((resolve, reject) => workerServer.close(error => error ? reject(error) : resolve())));
    const address = workerServer.address(); if (!address || typeof address === 'string') throw new Error('Worker did not bind');
    const investigator = await createHttpInvestigator({ workerUrl: `http://127.0.0.1:${address.port}`, privateKeyPem: await exportPKCS8(keys.privateKey), allowLoopbackHttp: true });
    const dependencies = { database: f.databases.gotchu_coordinator, backend: coordinator, investigator };
    const connection = new Redis(present(redisUrl), { maxRetriesPerRequest: null });
    cleanup.push(() => connection.quit());
    const queue = new Queue<JobEnvelope>(`gotchu-source-model-${randomUUID()}`, { connection });
    cleanup.push(async () => { await queue.obliterate({ force: true }); await queue.close(); });
    const consumerConnection = new Redis(present(redisUrl), { maxRetriesPerRequest: null });
    cleanup.push(() => consumerConnection.quit());
    const worker = new Worker(queue.name, job => processDurableJob(dependencies, job.data), { connection: consumerConnection });
    cleanup.push(() => worker.close()); await worker.waitUntilReady();
    await dispatchOutbox(coordinator, scope.organizationId, envelope => ensureQueueDelivery(queue, envelope));
    let result = investigation;
    for (let attempt = 0; attempt < 240 && result.state !== 'succeeded' && result.state !== 'failed'; attempt++) {
      await delay(50); result = present((await api.investigations.list(identity, scope))[0]);
    }
    expect(result).toMatchObject({ state: 'succeeded', status: 'investigated', assessment: 'candidate_issue', tokensSpent: 400,
      reservedTokens: 0, reservedCostMicroUsd: 0, costMicroUsd: 0,
      candidateSuggestion: { path: 'src/index.ts', validationRequired: 'D05', implications: ['Deployment must supply the secret.'],
        risks: ['Missing configuration may prevent startup.'], validationPlan: ['Validate missing and configured secret behavior.'] } });
    const ledger = present((await f.admin.query<{ model_calls: number; tool_calls: number; checkpoint: unknown; result: unknown; delivered: boolean }>(`SELECT r.model_calls,r.tool_calls,r.checkpoint,j.result,o.delivered_at IS NOT NULL AS delivered
      FROM gotchu.agent_runs r JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.id=r.job_id
      JOIN gotchu.outbox o ON o.organization_id=j.organization_id AND o.job_id=j.id WHERE j.organization_id=$1 AND j.id=$2`, [scope.organizationId, result.jobId])).rows[0]);
    expect(ledger).toMatchObject({ model_calls: 2, tool_calls: 2, delivered: true, result: { independentVerification: 'not_verified' } });
    expect(ledger.checkpoint).not.toBeNull();
    const calls = z.array(z.object({ tools: z.array(z.string()), loaded: z.boolean() })).parse((await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)));
    expect(calls).toHaveLength(2); expect(calls[1]?.tools).toEqual(['evidence.read', 'finding.details.read', 'source.excerpt.read']);
    // Re-delivery must not run LangGraph or spend the model budget again.
    await processDurableJob(dependencies, { ...scope, version: 1, kind: 'investigation', id: result.jobId });
    expect((await readFile(record, 'utf8')).trim().split('\n')).toHaveLength(2);
  });
});

function syntheticReport(input: CustomerRunInput) {
  const timestamp = new Date().toISOString(); const evidenceId = randomUUID(); const findingId = randomUUID();
  return customerAssessmentReportSchema.parse({ version: 2, id: randomUUID(), organizationId: input.organizationId, applicationId: input.applicationId, jobId: input.jobId,
    applicationName: input.applicationName, mode: input.mode, startedAt: timestamp, finishedAt: timestamp,
    internal: { origin: 'internal', status: 'completed', startedAt: timestamp, finishedAt: timestamp, snapshotRef: 'synthetic', tool: { name: 'synthetic', version: '1' },
      findings: [{ id: findingId, origin: 'internal', ruleId: 'synthetic.secret', correlationKey: 'synthetic.secret', title: 'Synthetic source finding', location: 'src/index.ts:1',
        description: 'Synthetic source observation for pipeline regression.', severity: 'high', confidence: 'observed', exploitability: 'unknown', impact: 'Unknown', recommendation: 'Review', limitations: ['Synthetic evidence'], evidenceIds: [evidenceId] }],
      evidence: [{ id: evidenceId, origin: 'internal', kind: 'configuration', locator: 'src/index.ts:1', collectedAt: timestamp, snapshotRef: 'synthetic', tool: { name: 'synthetic', version: '1' }, checksum: 'a'.repeat(64), excerpt: '[redacted]' }], coverage: [], limitations: ['Synthetic evidence'],
      dependencyInventory: { components: [], lockfiles: [], policy: input.licensePolicy ?? defaultLicensePolicy, complete: false, graphComplete: false, unknownCount: 0 } },
    external: null, comparison: [{ key: 'synthetic.secret', classification: 'unverified', internalFindingIds: [findingId], externalFindingIds: [], explanation: 'Synthetic comparison' }], limitations: ['Synthetic report'], responseMode: 'observation', actionsPerformed: [],
    subject: { sourceSnapshotId: input.source?.id, sourceDigest: input.source?.digest, targetId: null, targetVersion: null, origin: null, containerImageId: null, containerImageDigest: null, containerImageReference: null } });
}
