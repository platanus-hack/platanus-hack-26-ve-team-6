import { createServer, type IncomingMessage } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createActionVerifier, actionPolicyVersion, createBackend, readPinnedRootfsDigest } from '@gotchu/backend';
import { createDatabase } from '@gotchu/database';
import { createGitHubAppAdapter } from '@gotchu/git-adapters';
import { loadMonitoringRepositoryCatalog } from '@gotchu/monitoring';
import { z } from 'zod';
import { createBackendActionExecutionLedger } from './action-backend-ledger.js';
import { createGitHubActionProvider, createGitHubSingleAppWriterAdapter } from './github-provider.js';
import { loadGitHubSingleAppCredentials, loadGitHubWriterAppCredentials } from './github-credentials.js';
import { createGitHubBroker } from './github-broker.js';
import { createSingleAppGitHubResolver, writerInstallationIdFor } from './single-app-resolver.js';
import { createExecutionJobProcessor } from './execution-job.js';

function report(event: string, error?: unknown) {
  const reason = error instanceof Error && /^[a-z][a-z0-9_]{0,80}$/.test(error.message) ? error.message : undefined;
  const code = typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : undefined;
  console.error(JSON.stringify({ event, type: error instanceof Error ? error.name : 'unknown', ...(reason ? { reason } : {}), ...(code ? { code } : {}) }));
}

function verifyInternalBearer(supplied: string, expectedValue: string | undefined): boolean {
  const expected = Buffer.from(expectedValue ?? '', 'utf8');
  const received = Buffer.from(supplied, 'utf8');
  return expected.length > 0 && received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJsonBody(request: IncomingMessage, limit: number, timeoutMs: number): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new Error('request_content_type');
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new Error('request_too_large');
  let timeout: NodeJS.Timeout | undefined;
  const reading = (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw new Error('request_too_large');
      chunks.push(bytes);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
    catch { throw new Error('request_json_invalid'); }
  })();
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => { request.destroy(); reject(new Error('request_timeout')); }, timeoutMs);
    timeout.unref();
  });
  try { return await Promise.race([reading, deadline]); }
  finally { if (timeout) clearTimeout(timeout); }
}

async function main() {
  const config = z.object({
    databaseUrl: z.url(), redisUrl: z.url(), port: z.coerce.number().int().min(1).max(65535),
    publicAppUrl: z.url(),
    connectionMode: z.enum(['legacy_two_app', 'single_app']).default('legacy_two_app'),
    internalToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    writerAppFile: z.string().min(1).optional(), writerInstallationId: z.string().regex(/^[0-9]{1,20}$/).optional(),
    monitoringConfigFile: z.string().min(1).optional(),
    singleAppFile: z.string().min(1).optional(), publicAppFile: z.string().min(1).optional(),
    writesEnabled: z.enum(['true', 'false']).optional(),
  }).strict().parse({
    databaseUrl: process.env.GOTCHU_EXECUTOR_DATABASE_URL, redisUrl: process.env.GOTCHU_REDIS_URL,
    publicAppUrl: process.env.PUBLIC_APP_URL,
    connectionMode: process.env.GOTCHU_GITHUB_CONNECTION_MODE || undefined,
    internalToken: process.env.GOTCHU_EXECUTOR_INTERNAL_TOKEN || undefined,
    port: process.env.PORT ?? 3004, writerAppFile: process.env.GOTCHU_GITHUB_WRITER_APP_FILE || undefined,
    writerInstallationId: process.env.GOTCHU_GITHUB_WRITER_INSTALLATION_ID || undefined,
    monitoringConfigFile: process.env.GOTCHU_MONITORING_CONFIG_FILE || undefined,
    singleAppFile: process.env.GOTCHU_GITHUB_SINGLE_APP_FILE || undefined,
    publicAppFile: process.env.GOTCHU_GITHUB_PUBLIC_APP_FILE || undefined,
    writesEnabled: process.env.GOTCHU_EXECUTOR_WRITES_ENABLED || undefined,
  });
  if (!['redis:','rediss:'].includes(new URL(config.redisUrl).protocol)) throw new Error('Invalid Redis connection protocol');
  const legacyProviderConfigured = Boolean(config.writerAppFile && config.writerInstallationId && config.monitoringConfigFile);
  const legacyConfigPresent = Boolean(config.writerAppFile || config.writerInstallationId || config.monitoringConfigFile);
  if (config.connectionMode === 'legacy_two_app' && legacyConfigPresent && !legacyProviderConfigured) throw new Error('Executor writer configuration must be complete');
  if (config.connectionMode === 'single_app' && (!config.singleAppFile || !config.publicAppFile || !config.internalToken)) {
    throw new Error('Single App broker configuration must include public/private App files and internal authentication');
  }
  if (legacyProviderConfigured && !config.internalToken) throw new Error('Executor internal authentication is required with the Writer App');
  const writesEnabled = config.writesEnabled === 'true'
    || config.writesEnabled === undefined && config.connectionMode === 'legacy_two_app' && legacyProviderConfigured;
  if (writesEnabled && config.connectionMode === 'legacy_two_app' && !legacyProviderConfigured) throw new Error('Executor writes require a complete legacy provider configuration');
  if (config.connectionMode === 'legacy_two_app' && writesEnabled && config.monitoringConfigFile) await loadMonitoringRepositoryCatalog(config.monitoringConfigFile);

  const singleAppFiles = config.connectionMode === 'single_app'
    ? await loadGitHubSingleAppCredentials({ privateFile: config.singleAppFile!, publicFile: config.publicAppFile! })
    : undefined;
  const legacyWriter = config.connectionMode === 'legacy_two_app' && writesEnabled && config.writerAppFile
    ? await loadGitHubWriterAppCredentials(config.writerAppFile) : undefined;
  const writer = singleAppFiles ? { appId: singleAppFiles.app.id, privateKeyPem: singleAppFiles.app.privateKeyPem } : legacyWriter;

  const database = createDatabase({ connectionString: config.databaseUrl, role: 'gotchu_executor', max: 5 });
  const baseBackend = createBackend({ database });
  const singleResolver = singleAppFiles ? createSingleAppGitHubResolver({ database, app: singleAppFiles.app }) : undefined;
  const broker = singleAppFiles ? createGitHubBroker({ database, app: singleAppFiles.app, publicAppUrl: config.publicAppUrl }) : undefined;
  const adapterFor = async (scope: { organizationId: string; applicationId: string; repositoryKey: string; repositoryLinkId?: string }) => {
    if (singleAppFiles && singleResolver) {
      if (!scope.repositoryLinkId) throw new Error('repository_link_required');
      const binding = await singleResolver.resolveRepository({ ...scope, repositoryLinkId: scope.repositoryLinkId });
      // Verification establishes the first write grant; execution independently requires that grant.
      const installationId = binding.installationId;
      if (!await singleResolver.isActiveInstallation(scope.organizationId, scope.applicationId, installationId)) throw new Error('writer_provider_unavailable');
      const adapter = await singleResolver.withRepositoryMetadata(binding, repository => {
        const [owner, name] = repository.fullName.split('/');
        if (!owner || !name) throw new Error('github_repository_metadata_invalid');
        return createGitHubSingleAppWriterAdapter({ app: singleAppFiles.app, installationId,
          repositoryId: binding.repositoryId, owner, repository: name });
      });
      return { adapter, installationId };
    }
    if (config.connectionMode === 'single_app') throw new Error('single_app_writer_unavailable');
    if (!writer || !config.writerInstallationId || !config.monitoringConfigFile) throw new Error('writer_provider_unavailable');
    const catalog = await loadMonitoringRepositoryCatalog(config.monitoringConfigFile);
    const entry = catalog.resolve(scope, scope.repositoryKey);
    if (entry.provider !== 'github') throw new Error('repository_provider_not_supported');
    return { adapter: createGitHubAppAdapter({ appId: writer.appId, privateKeyPem: writer.privateKeyPem,
      installationId: config.writerInstallationId, owner: entry.owner, repository: entry.repository }), installationId: config.writerInstallationId };
  };
  const actionVerifier = writesEnabled && writer && (singleAppFiles || config.writerInstallationId && config.monitoringConfigFile)
    ? createActionVerifier({
      database, pinnedRootfsDigest: readPinnedRootfsDigest(),
      validationFacts: { getFacts: input => baseBackend.validations.getValidationFacts(input) },
      repository: {
        ...(singleAppFiles ? {
          writerInstallationIdFor: scope => writerInstallationIdFor(database, singleAppFiles.app.id, scope),
          async readHead(scope) {
            if (!singleResolver) throw new Error('single_app_reader_unavailable');
            return singleResolver.readHead(scope, scope.branch);
          },
          async readTree(scope) {
            if (!singleResolver) throw new Error('single_app_reader_unavailable');
            return singleResolver.readTree(scope, scope.commitSha);
          },
          async inspectAutomation(scope) {
            if (!singleResolver) throw new Error('single_app_reader_unavailable');
            return singleResolver.inspectAutomation(scope, scope.baseCommit);
          },
        } : {
          ...(config.writerInstallationId ? { writerInstallationId: config.writerInstallationId } : {}),
          async readHead(scope) { return (await adapterFor(scope)).adapter.readHead(scope.branch); },
          async readTree(scope) { return (await adapterFor(scope)).adapter.readTree(scope.commitSha); },
          async inspectAutomation(scope) { return (await adapterFor(scope)).adapter.inspectAutomation(scope.baseCommit); },
        }),
        async isPolicyCurrent(input) {
          const version = actionPolicyVersion(input.capabilityId);
          if (!version || version !== input.policyVersion) return false;
          const rows = await database.tenant(input.organizationId, tx => tx.query<{ active_version: string }>(
            'SELECT active_version FROM gotchu.action_policy_registry WHERE capability_id=$1', [input.capabilityId],
          ));
          return rows.rows[0]?.active_version === version;
        },
      },
    }) : undefined;
  const backend = createBackend({ database, ...(actionVerifier ? { actionVerifier } : {}) });

  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  redis.on('error', error => report('executor_redis_error', error));
  let worker: Worker | undefined;
  const executorInstanceId = randomUUID();
  let availabilityHeartbeat: NodeJS.Timeout | undefined;
  if (writesEnabled && writer && actionVerifier && (singleAppFiles || config.monitoringConfigFile && config.writerInstallationId)) {
    const provider = createGitHubActionProvider({
      database, writer, publicAppUrl: config.publicAppUrl,
      ...(singleAppFiles ? {
        singleApp: singleAppFiles.app,
        writerInstallationIdFor: scope => writerInstallationIdFor(database, singleAppFiles.app.id, scope),
      } : {
        ...(config.writerInstallationId ? { installationId: config.writerInstallationId } : {}),
        ...(config.monitoringConfigFile ? { monitoringConfigFile: config.monitoringConfigFile } : {}),
      }),
    });
    const processor = createExecutionJobProcessor({ database,backend,provider,ledger:createBackendActionExecutionLedger(backend.executions) });
    worker = new Worker('gotchu-executions-v1', processor, { connection:redis,concurrency:1,lockDuration:300_000 });
    worker.on('error', error => report('executor_worker_error', error));
    worker.on('failed', (_job, error) => report('executor_job_failed', error));
    await worker.waitUntilReady();
    const heartbeat = () => database.system(tx => tx.query(`INSERT INTO gotchu.action_executor_instances(instance_id,capability_id,heartbeat_at)
      VALUES($1,'repository.source_patch_pr',clock_timestamp()),($1,'repository.dependency_pr',clock_timestamp()) ON CONFLICT(instance_id,capability_id)
      DO UPDATE SET heartbeat_at=EXCLUDED.heartbeat_at`, [executorInstanceId]).then(() => undefined));
    await heartbeat();
    availabilityHeartbeat = setInterval(() => { void heartbeat().catch(error => report('executor_availability_heartbeat_failed', error)); }, 20_000);
    availabilityHeartbeat.unref();
  }

  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/internal/github/broker') {
      void (async () => {
        const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
        if (!verifyInternalBearer(supplied, config.internalToken)) {
          response.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end('{"error":"unauthorized"}'); return;
        }
        if (!broker) {
          response.writeHead(404); response.end(); return;
        }
        try {
          const input = await readJsonBody(request, 16 * 1024, 15_000);
          const result = await broker.dispatch(input);
          const body = JSON.stringify(result);
          if (Buffer.byteLength(body) > 4_194_304 + 128_000) {
            response.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            response.end('{"error":"response_too_large"}'); return;
          }
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          response.end(body);
        } catch (error) {
          report('executor_github_broker_failed', error);
          const errorName = error instanceof Error ? error.message : '';
          const status = errorName === 'request_too_large' ? 413
            : errorName === 'request_content_type' ? 415
              : errorName === 'request_timeout' ? 408
                : errorName === 'request_json_invalid' || error instanceof z.ZodError ? 400
                  : typeof error === 'object' && error !== null && 'status' in error
                    && typeof error.status === 'number' && error.status >= 400 && error.status <= 599 ? error.status : 503;
          if (!response.headersSent && !response.destroyed) response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          if (!response.destroyed) response.end(JSON.stringify({ error: status < 500 ? 'github_broker_request_rejected' : 'github_broker_unavailable' }));
        }
      })();
      return;
    }
    if (request.method === 'POST' && request.url === '/internal/repositories/verify-write-access') {
      void (async () => {
        const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
        if (!verifyInternalBearer(supplied, config.internalToken)) {
          response.writeHead(401); response.end('{"error":"unauthorized"}'); return;
        }
        if (!writesEnabled) { response.writeHead(503); response.end('{"error":"writer_disabled"}'); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          if (size > 4096) { response.writeHead(413); response.end('{"error":"request_too_large"}'); return; }
          chunks.push(data);
        }
        const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const input = z.object({ organizationId:z.uuid(), applicationId:z.uuid(), repositoryLinkId:z.uuid(), repositoryKey:z.string().min(1).max(200), branch:z.string().min(1).max(200) }).strict().parse(payload);
        const link = await database.tenant(input.organizationId, async tx => {
          const result = await tx.query<{ repository_key:string; default_branch:string; state:string; revoked:boolean; read_access:string; installation_id:string|null }>(
            `SELECT repository_key,default_branch,state,revoked,read_access,installation_id FROM gotchu.application_repository_links
              WHERE organization_id=$1 AND application_id=$2 AND id=$3`,
            [input.organizationId,input.applicationId,input.repositoryLinkId],
          );
          return result.rows[0];
        });
        if (!link || link.repository_key !== input.repositoryKey || link.default_branch !== input.branch
          || link.state !== 'verified' || link.revoked || link.read_access !== 'granted' || !link.installation_id) {
          response.writeHead(409); response.end('{"error":"repository_link_unavailable"}'); return;
        }
        const adapter = await adapterFor({ ...input, repositoryKey:link.repository_key });
        const baseCommit = await adapter.adapter.readHead(link.default_branch);
        response.writeHead(200, { 'content-type':'application/json' });
        response.end(JSON.stringify({ installationId:adapter.installationId,baseCommit }));
      })().catch(error => {
        report('executor_write_access_verification_failed', error);
        if (!response.headersSent) response.writeHead(503);
        response.end('{"error":"writer_verification_unavailable"}');
      });
      return;
    }
    if (request.method !== 'GET' || (request.url !== '/health/live' && request.url !== '/health/ready')) { response.writeHead(404); response.end(); return; }
    if (request.url === '/health/live') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"alive"}'); return; }
    void Promise.all([database.checkHealth(), redis.ping()]).then(() => {
      const ready = Boolean(broker || worker);
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: ready ? 'ready' : 'disabled', brokerConfigured: Boolean(broker), writesConfigured: Boolean(worker), customerCodeExecution: false }));
    }).catch(error => { report('executor_not_ready', error); response.writeHead(503); response.end('{"status":"unavailable"}'); });
  });
  server.listen(config.port, '127.0.0.1');
  const shutdown = () => closing ??= (async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (availabilityHeartbeat) clearInterval(availabilityHeartbeat);
    try { await worker?.close(); }
    finally {
      try { await database.system(tx => tx.query('DELETE FROM gotchu.action_executor_instances WHERE instance_id=$1', [executorInstanceId]).then(() => undefined)); }
      finally { await Promise.all([redis.quit(), database.close()]); }
    }
  })();
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => {
    void shutdown().catch(error => { report('executor_shutdown_failed', error); process.exitCode = 1; });
  });
  console.log(JSON.stringify({ event: 'executor_started', port: config.port, brokerConfigured: Boolean(broker), writesConfigured: Boolean(worker), concurrency: 1 }));
}

main().catch(error => { report('executor_start_failed', error); process.exitCode = 1; });
