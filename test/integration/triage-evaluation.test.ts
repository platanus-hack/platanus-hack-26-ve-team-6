import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:https';
import type { RequestListener, Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveUrl } from '../../packages/database/test/support.js';
import { createLiveTriageStack } from '../evaluation/live-stack.js';
import { loadTriageMatrix } from '../evaluation/triage-matrix.js';
import { runTriageCase } from '../evaluation/run-triage-case.js';
import { buildEvaluationReport, writeEvaluationArtifacts } from '../evaluation/triage-report.js';

const live = liveUrl && process.env.GOTCHU_TEST_REDIS_URL ? describe : describe.skip;

live('real-app triage evaluation on disposable PostgreSQL, Redis, web intake and coordinator', () => {
  let stack: Awaited<ReturnType<typeof createLiveTriageStack>>;
  let directory = '';
  let certificate = '';
  let tlsServer: Server | undefined;
  let tlsPort = 0;
  let activeHandler: RequestListener | null = null;

  beforeAll(async () => {
    stack = await createLiveTriageStack();
    directory = await mkdtemp(join(tmpdir(), 'gotchu-triage-evaluation-'));
    const keyPath = join(directory, 'key.pem');
    const certificatePath = join(directory, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
      '-out', certificatePath, '-days', '1', '-subj', '/CN=customer.org', '-addext', 'subjectAltName=DNS:customer.org'],
    { stdio: 'ignore', timeout: 10_000 });
    certificate = await readFile(certificatePath, 'utf8');
    const key = await readFile(keyPath, 'utf8');
    tlsServer = createTlsServer({ cert: certificate, key }, (request, response) => {
      if (activeHandler) activeHandler(request, response);
      else response.writeHead(503).end();
    });
    await new Promise<void>((resolve, reject) => {
      tlsServer?.once('error', reject);
      tlsServer?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = tlsServer.address();
    if (!address || typeof address === 'string') throw new Error('evaluation_probe_listener_missing');
    tlsPort = address.port;
  }, 30_000);

  afterAll(async () => {
    tlsServer?.closeAllConnections();
    if (tlsServer?.listening) await new Promise<void>((resolve, reject) => tlsServer?.close(error => error ? reject(error) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
    await stack?.close();
  });

  it('runs the prelabelled matrix through real signed ingestion and durable triage', async () => {
    const { matrix, matrixSha256 } = await loadTriageMatrix();
    const requested = process.env.GOTCHU_TRIAGE_EVAL_SPLIT;
    if (requested && requested !== 'tuning' && requested !== 'holdout') throw new Error('invalid_GOTCHU_TRIAGE_EVAL_SPLIT');
    const splits = requested ? [requested] : ['tuning', 'holdout'] as const;
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const trials = [];
    for (const split of splits) {
      const cases = matrix.cases.filter(item => item.split === split);
      for (const scenario of cases) {
        for (let repetition = 1; repetition <= matrix.repetitions; repetition++) {
          trials.push(await runTriageCase({ stack, scenario, repetition, setProbeHandler: handler => { activeHandler = handler; },
            probeCertificate: certificate, probePort: tlsPort }));
        }
      }
    }
    const finishedAt = new Date().toISOString();
    const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const worktreeDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0;
    const report = buildEvaluationReport({ matrixVersion: matrix.version, matrixSha256, rulesVersion: matrix.rulesVersion,
      gitSha, worktreeDirty, startedAt, finishedAt, durationMs: Date.now() - startTime,
      repetitions: matrix.repetitions, acceptanceTargets: matrix.acceptanceTargets, trials,
      permissionChecks: trials.flatMap(trial => trial.permissionCheck ? [trial.permissionCheck] : []),
    });
    const paths = await writeEvaluationArtifacts(report, requested !== undefined);
    process.stdout.write(`Triage evaluation ${requested ?? 'tuning+holdout'}: ${trials.length} app/windows, ${report.failures.length} labelled mismatches. Results: ${paths.jsonPath}\n`);

    const attackTrials = trials.filter(trial => trial.expected.alertRules.some(rule => rule.startsWith('runtime.attack.')));
    expect(attackTrials.every(trial => trial.actual.attackResponses.length === 1 && trial.actual.attackResponses[0] === 403
      && trial.actual.sinkExecutions.sql === 0 && trial.actual.sinkExecutions.filesystem === 0)).toBe(true);
    const negativeControls = trials.filter(trial => trial.scenario === 'healthy-traffic-spike');
    expect(negativeControls.every(trial => !trial.actual.alertRules.some(rule => rule.startsWith('runtime.attack.')))).toBe(true);
    const telemetryCases = trials.filter(trial => trial.scenario === 'stale-telemetry' || trial.scenario === 'missing-telemetry');
    expect(telemetryCases.every(trial => trial.actual.impact === 'unknown' && trial.actual.unknownCoverageVisible && trial.correctness.abstained)).toBe(true);
    if (trials.some(trial => trial.split === 'tuning')) {
      expect(report.decisionDimensions.alertSeverityAndConfidence.separateFieldsPresent).toBe(true);
      expect(report.decisionDimensions.providerExecutionPermission).toBe('disabled');
    }
  }, 900_000);
});
