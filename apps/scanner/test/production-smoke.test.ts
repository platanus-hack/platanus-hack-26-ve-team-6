import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CustomerRunInput } from '@gotchu/contracts';
import { sourceDigest } from '@gotchu/customer-assessment';
import { createScannerClient } from '../src/client.js';

const smokeEnabled = process.env.GOTCHU_SCANNER_PRODUCTION_SMOKE === '1';
const productionSmoke = smokeEnabled ? describe : describe.skip;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', () => resolve()).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('production_smoke_port_unavailable');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function readReadiness(origin: string, ca: Buffer, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(new URL('/readyz', origin), {
      method: 'GET', agent: false, ca, rejectUnauthorized: true, signal: AbortSignal.timeout(timeoutMs), maxHeaderSize: 8192,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) {
          response.destroy();
          reject(new Error('production_smoke_readiness_limit'));
        } else chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: response.statusCode ?? 0, body });
        }
        catch { reject(new Error('production_smoke_readiness_invalid')); }
      });
      response.on('error', () => reject(new Error('production_smoke_readiness_unavailable')));
    });
    request.on('error', cause => reject(new Error('production_smoke_transport_unavailable', { cause })));
    request.end();
  });
}

function processFailure(child: ChildProcess): Error | undefined {
  if (child.exitCode !== null || child.signalCode !== null) return new Error('production_smoke_process_exited_before_ready');
  return undefined;
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error) || error.message !== 'production_smoke_transport_unavailable') return false;
  const cause: unknown = error.cause;
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ECONNREFUSED';
}

async function readReadinessWhenAvailable(child: ChildProcess, origin: string, ca: Buffer, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let rejectOnProcessFailure: (error: Error) => void = () => undefined;
  const onError = (error: Error) => rejectOnProcessFailure(new Error('production_smoke_process_error', { cause: error }));
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    rejectOnProcessFailure(new Error(`production_smoke_process_exited_before_ready:${code ?? signal ?? 'unknown'}`));
  };
  const processFailurePromise = new Promise<never>((_resolve, reject) => { rejectOnProcessFailure = reject; });
  child.on('error', onError);
  child.on('exit', onExit);
  try {
    while (Date.now() < deadline) {
      const failed = processFailure(child);
      if (failed) throw failed;
      const remainingMs = deadline - Date.now();
      try {
        return await Promise.race([
          readReadiness(origin, ca, remainingMs),
          processFailurePromise,
        ]);
      } catch (error) {
        const exited = processFailure(child);
        if (exited) throw exited;
        if (!isConnectionRefused(error)) throw error;
        const pauseMs = Math.min(200, deadline - Date.now());
        if (pauseMs <= 0) break;
        await new Promise(resolve => setTimeout(resolve, pauseMs));
      }
    }
    const failed = processFailure(child);
    if (failed) throw failed;
    throw new Error('production_smoke_startup_timeout');
  } finally {
    child.off('error', onError);
    child.off('exit', onExit);
  }
}

const readinessSchema = z.object({
  ready: z.boolean(),
  tools: z.array(z.object({ name: z.string(), available: z.boolean() })),
});

const profileProvenanceSchema = z.object({
  image: z.string().regex(/^[^@]+@sha256:[a-f0-9]{64}$/),
  profileChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  redacted: z.literal(true),
  matched: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
});

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', () => resolve()));
}

productionSmoke('production scanner process with real Docker profiles', () => {
  it('starts with TLS, reports real readiness, and accepts a signed assessment of application source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gotchu-production-scanner-'));
    let child: ChildProcess | undefined;
    try {
      const certPath = join(directory, 'cert.pem');
      const keyPath = join(directory, 'key.pem');
      const secretPath = join(directory, 'secret.bin');
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
        '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE',
        '-addext', 'keyUsage=critical,digitalSignature,keyCertSign,keyEncipherment', '-addext', 'subjectAltName=IP:127.0.0.1',
      ], { stdio: 'ignore', timeout: 10_000 });
      const secret = randomBytes(32);
      await writeFile(secretPath, secret, { mode: 0o600 });
      const ca = await readFile(certPath);
      const port = await availablePort();
      const sourcePath = join(repositoryRoot, 'apps/web/src/server/customer-api.ts');
      const sourceText = await readFile(sourcePath, 'utf8');
      const snapshot = { revision: 'gotchu-application-source', files: [{ path: 'customer-api.ts', content: sourceText }] };
      const request: CustomerRunInput = {
        version: 2, organizationId: randomUUID(), applicationId: randomUUID(), jobId: randomUUID(),
        applicationName: 'Gotchu application source smoke', mode: 'internal',
        source: { ...snapshot, id: randomUUID(), digest: sourceDigest(snapshot) }, target: null,
      };
      child = spawn(process.execPath, [join(repositoryRoot, 'apps/scanner/dist/main.js')], {
        cwd: repositoryRoot,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          TMPDIR: process.env.TMPDIR ?? '/tmp',
          NODE_ENV: 'production',
          GOTCHU_SCANNER_HOST: '127.0.0.1',
          GOTCHU_SCANNER_PORT: String(port),
          GOTCHU_SCANNER_SECRET_FILE: secretPath,
          GOTCHU_SCANNER_TLS_CERT_FILE: certPath,
          GOTCHU_SCANNER_TLS_KEY_FILE: keyPath,
          GOTCHU_SCANNER_OSV: '1',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      const origin = `https://127.0.0.1:${port}`;
      const readinessResponse = await readReadinessWhenAvailable(child, origin, ca);
      const readiness = readinessSchema.parse(readinessResponse.body);
      expect(readiness.tools).toEqual(expect.arrayContaining([
        { name: 'semgrep', available: true },
        { name: 'gitleaks', available: true },
        { name: 'trivy', available: true },
      ]));
      expect(readiness.ready).toBe(true);
      expect(readinessResponse.status).toBe(200);
      const report = await createScannerClient({ origin, secret, ca, timeoutMs: 65_000 }).run(request);
      expect(report.subject.sourceDigest).toBe(request.source?.digest);
      if (!report.internal) throw new Error('production_smoke_internal_analysis_missing');
      const coverage = new Map(report.internal.coverage.map(item => [item.capability, item]));
      expect(coverage.get('semgrep')?.state).toBe('inspected');
      expect(coverage.get('gitleaks')?.state).toBe('inspected');
      expect(coverage.get('trivy')).toMatchObject({
        state: 'unsupported',
        detail: 'The pinned Kubernetes profile recognized no supported configuration in this snapshot.',
      });

      const expectedProfiles = {
        semgrep: { version: '1.182.0', image: 'semgrep/semgrep@sha256:4a34048c04fef049f71665047f074cffb00cc3d89482f965a5cd151d589237af' },
        gitleaks: { version: '8.28.0', image: 'zricethezav/gitleaks@sha256:cdbb7c955abce02001a9f6c9f602fb195b7fadc1e812065883f695d1eeaba854' },
        trivy: { version: '0.67.2', image: 'aquasec/trivy@sha256:e2b22eac59c02003d8749f5b8d9bd073b62e30fefaef5b7c8371204e0a4b0c08' },
      } as const;
      for (const [name, expected] of Object.entries(expectedProfiles)) {
        const evidence = report.internal.evidence.find(item => item.locator === `scanner-profile:${name}`);
        if (!evidence) throw new Error(`production_smoke_${name}_profile_evidence_missing`);
        expect(evidence.tool).toEqual({ name, version: expected.version });
        const rawProvenance: unknown = JSON.parse(evidence.excerpt);
        const provenance = profileProvenanceSchema.parse(rawProvenance);
        expect(provenance).toMatchObject({ image: expected.image, sourceDigest: request.source?.digest });
        expect(evidence.checksum).toBe(createHash('sha256').update(evidence.excerpt).digest('hex'));
      }
    } finally {
      if (child) {
        child.kill('SIGTERM');
        const exited = waitForExit(child);
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000); })]);
        if (timer) clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
