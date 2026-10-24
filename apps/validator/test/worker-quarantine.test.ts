import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createCustomerAssessmentRunner } from '@gotchu/customer-assessment';
import type { Database, Transaction } from '@gotchu/database';
import type { RunnerResult } from '@gotchu/runner';
import { createValidationWorker } from '../src/validator.js';

function makeWorkerRunRow(organizationId: string, applicationId: string) {
  const snapshot = {
    revision: 'test-revision',
    files: [
      { path: 'package.json', content: '{"name":"test","scripts":{"test":"node test/run.js"}}' },
      { path: 'package-lock.json', content: '{"name":"test","lockfileVersion":3,"packages":{"":{"name":"test"}}}' },
      { path: 'test/run.js', content: 'process.exit(0)' },
    ],
  };
  const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const baseSourceId = randomUUID();
  const candidateSourceId = randomUUID();
  const repositoryLinkId = randomUUID();
  const suiteDefinitionId = randomUUID();
  return {
    row: {
      id: randomUUID(), organization_id: organizationId, application_id: applicationId,
      action_ref: randomUUID(), target_finding_id: randomUUID(), candidate_source_id: candidateSourceId, base_source_id: baseSourceId,
      base_snapshot_digest: digest, candidate_tree_digest: digest, patch_digest: 'c'.repeat(64),
      suite_repository_link_id: repositoryLinkId, suite_definition_id: suiteDefinitionId, suite_version: 1,
      runner_profile: 'node24-npm-test', sandbox_kind: 'bwrap+systemd-scope',
      limits: { vcpu: 1, memMiB: 1024, pids: 128, wallMs: 10_000, outputBytes: 16_384, diskMiB: 2048 },
      state: 'running', reason: null, queued_at: new Date().toISOString(), started_at: null,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      candidate_body: snapshot, candidate_source_digest: digest, base_body: snapshot, base_source_digest: digest,
      repository_link_id: repositoryLinkId, profile: 'node24-npm-test', script_name: 'test', suite_name: 'smoke',
      required_count: 1, regression_test_path: null,
    },
  };
}

function testRunnerResult(status: 'completed' | 'cleanup_uncertain'): RunnerResult {
  const output = { text: '', sha256: createHash('sha256').update('').digest('hex'), truncated: false, bytes: 0 };
  const isolation = {
    sandbox: { kind: 'bwrap+systemd-scope' as const, memoryMaxMiB: 1536, tasksMax: 144, cpuQuotaPercent: 100 },
    runnerVersion: '0.1.0', firecrackerVersion: 'unavailable', kernelDigest: '0'.repeat(64), rootfsDigest: '0'.repeat(64),
    profile: 'node24-npm-test' as const, networkPolicy: { mode: 'deny' as const },
    lockfileSha256: '0'.repeat(64), tarballSetSha256: '0'.repeat(64), cleanupVerified: status === 'completed',
  };
  return status === 'completed'
    ? { status, exitCode: 0, durationMs: 1, isolation, stdout: output, stderr: output, artifacts: [] }
    : { status, reason: 'cleanup could not be confirmed', durationMs: 1, isolation };
}

function makeWorkerDatabase(runRow: Record<string, unknown>, leaseToken: string, onQuarantine: () => void) {
  let state = 'running';
  const query = async <R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>> => {
    let rows: Record<string, unknown>[] = [];
    if (text.includes('FROM gotchu.validation_runs v')) {
      rows = [runRow];
    } else if (text.includes("SET state='quarantined'")) {
      expect(text).toContain("state IN ('running','quarantined')");
      expect(text).toContain('lease_token=$4');
      expect(values?.[3]).toBe(leaseToken);
      state = 'quarantined';
      onQuarantine();
      rows = [{ state, lease_token: leaseToken }];
    } else if (text.includes('SELECT state,lease_token')) {
      rows = [{ state, lease_token: state === 'quarantined' ? leaseToken : null }];
    } else if (text.includes('SET lease_until=')) {
      rows = [];
    } else {
      throw new Error(`Unexpected validation-worker query: ${text}`);
    }
    return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows: rows as unknown as R[] };
  };
  const transaction: Transaction = { query };
  const database: Database = {
    role: 'gotchu_validator',
    tenant: async <T>(_organizationId: string, work: (tx: Transaction) => Promise<T>) => work(transaction),
    integration: async <T>(_integrationId: string, work: (tx: Transaction) => Promise<T>) => work(transaction),
    checkHealth: async () => undefined,
    close: async () => undefined,
  };
  return database;
}

describe('validation worker cleanup quarantine', () => {
  it('stops at first uncertain cleanup and stages input through the configured resolver (injected runner; no live VM)', async () => {
    const pair = generateKeyPairSync('ed25519');
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyId = createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

    for (const uncertainStage of [1, 2, 3]) {
      const organizationId = randomUUID();
      const applicationId = randomUUID();
      const leaseToken = randomUUID();
      const { row } = makeWorkerRunRow(organizationId, applicationId);
      const shutdown = new AbortController();
      const database = makeWorkerDatabase(row, leaseToken, () => shutdown.abort());
      const scanner = createCustomerAssessmentRunner();
      const scan = vi.spyOn(scanner, 'run');
      let gateChecks = 0;
      let runnerCalls = 0;
      const worker = createValidationWorker({
        database,
        key: { keyId, publicKey, privateKey: pair.privateKey },
        scanner,
        concurrency: 2,
        shutdownSignal: shutdown.signal,
        runnerGate: async () => { gateChecks += 1; return { status: 'open' }; },
        runnerJobAdapter: async (job, _options, resolveInput) => {
          const staged = await resolveInput(job.input, { organizationId: job.organizationId, jobId: job.jobId });
          expect(staged.byteLength).toBe(job.input.sizeBytes);
          expect(createHash('sha256').update(staged).digest('hex')).toBe(job.input.sha256);
          runnerCalls += 1;
          return testRunnerResult(runnerCalls === uncertainStage ? 'cleanup_uncertain' : 'completed');
        },
      });

      await worker.processClaim({ organizationId, applicationId, runId: String(row.id), leaseToken });

      expect(runnerCalls).toBe(uncertainStage);
      expect(gateChecks).toBe(1);
      expect(scan).not.toHaveBeenCalled();
    }
  });
});
