import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createScannerClient, readScannerCaFile } from '@gotchu/scanner';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { createBackend } from '@gotchu/backend';
import { DEMO_ASSESSMENT_SCOPE } from '@gotchu/backend';
import { createControlledAssessmentRunner } from '@gotchu/assessment';
import { startDemoTargetServer } from '@gotchu/demo-target';
import { createDatabase } from '@gotchu/database';
import { dispatchOutbox } from './jobs.js';
import { createHttpInvestigator } from './investigator.js';
import { reconcileDurableDeliveries } from './delivery.js';
import { createCoordinatorTransport } from './transport.js';
import { runMonitoringWork } from './monitoring.js';
import { createConfiguredMonitoringAdapters } from './monitoring-adapters.js';

function report(event: string, error?: unknown) {
  console.error(JSON.stringify({ event, type: error instanceof Error ? error.name : 'unknown', ...(error instanceof z.ZodError ? { fields: error.issues.map((issue) => issue.path.join('.')) } : {}) }));
}

async function main() {
  const config = z.object({
    databaseUrl: z.url(), redisUrl: z.url(),
    organizationIds: z.array(z.uuid().transform((id) => id.toLowerCase())).max(5),
    port: z.coerce.number().int().min(1).max(65535),
    nodeEnv: z.enum(['production', 'development', 'test']),
  }).parse({
    databaseUrl: process.env.GOTCHU_COORDINATOR_DATABASE_URL,
    redisUrl: process.env.GOTCHU_REDIS_URL,
    organizationIds: process.env.GOTCHU_ORGANIZATION_IDS?.split(',').filter(Boolean) ?? [],
    port: process.env.PORT ?? 3003,
    nodeEnv: process.env.NODE_ENV ?? 'production',
  });
  if (!['redis:', 'rediss:'].includes(new URL(config.redisUrl).protocol)) throw new Error('Invalid Redis connection protocol');
  const database = createDatabase({ connectionString: config.databaseUrl, role: 'gotchu_coordinator', max: 5 });
  const backend = createBackend({ database });
  const workerUrl = process.env.GOTCHU_WORKER_URL;
  const privateKeyPem = process.env.GOTCHU_RUN_CAPABILITY_PRIVATE_KEY;
  if (Boolean(workerUrl) !== Boolean(privateKeyPem)) throw new Error('Worker URL and capability signing key must be configured together');
  const investigator = workerUrl && privateKeyPem ? await createHttpInvestigator({ workerUrl, privateKeyPem, allowLoopbackHttp: config.nodeEnv !== 'production' }) : undefined;
  const allowedOrganizations = new Set(config.organizationIds);
  const customerDiscovery = process.env.GOTCHU_CUSTOMER_DISCOVERY === 'true';
  let discoveryHealthy = !customerDiscovery;
  const scannerOrigin = process.env.GOTCHU_SCANNER_ORIGIN;
  const scannerSecretFile = process.env.GOTCHU_SCANNER_SECRET_FILE;
  const scannerCaFile = process.env.GOTCHU_SCANNER_CA_FILE;
  if ((scannerOrigin === undefined) !== (scannerSecretFile === undefined)) throw new Error('Scanner origin and secret file must be configured together');
  if (scannerCaFile !== undefined && scannerOrigin === undefined) throw new Error('Scanner CA file requires a scanner origin');
  const scannerUrl = scannerOrigin === undefined ? undefined : new URL(scannerOrigin);
  if (scannerCaFile !== undefined && scannerUrl?.protocol !== 'https:') throw new Error('Scanner CA file requires an HTTPS scanner origin');
  const scannerCa = scannerCaFile === undefined ? undefined : await readScannerCaFile(scannerCaFile);
  const customerAssessmentRunner = scannerOrigin !== undefined && scannerSecretFile !== undefined ? createScannerClient({
    origin: scannerOrigin, secret: await readFile(scannerSecretFile), allowDevelopmentHttp: config.nodeEnv !== 'production',
    ...(scannerCa ? { ca: scannerCa } : {}),
  }) : undefined;
  const demoEnabled = process.env.GOTCHU_DEMO_ENABLED === 'true';
  if (demoEnabled && !allowedOrganizations.has(DEMO_ASSESSMENT_SCOPE.organizationId)) throw new Error('Assign the controlled demo organization before enabling its runner');
  const controlledTarget = demoEnabled && !process.env.GOTCHU_DEMO_TARGET_ORIGIN ? await startDemoTargetServer({ host: '127.0.0.1', port: 4100 }) : undefined;
  const origin = process.env.GOTCHU_DEMO_TARGET_ORIGIN ?? controlledTarget?.origin;
  const assessmentRunner = demoEnabled ? createControlledAssessmentRunner(origin ? { origin } : {}) : undefined;
  const dependencies = { database, backend, ...(investigator ? { investigator } : {}), ...(assessmentRunner ? { assessmentRunner } : {}), ...(customerAssessmentRunner ? { customerAssessmentRunner } : {}) };
  const transport = createCoordinatorTransport({ redisUrl: config.redisUrl, organizationIds: config.organizationIds, dependencies, report });
  const stop = new AbortController();
  const monitoringEnabled = process.env.GOTCHU_MONITORING_ENABLED === 'true';
  const monitoringAdapters = createConfiguredMonitoringAdapters({ ...(process.env.GOTCHU_MONITORING_CONFIG_FILE ? { configFile: process.env.GOTCHU_MONITORING_CONFIG_FILE } : {}), advisories: process.env.GOTCHU_MONITORING_OSV === 'true' });
  let monitoringTask: Promise<void> | undefined;
  const loop = (async () => {
    let lastReconciliation = 0;
    while (!stop.signal.aborted) {
      try {
        if (monitoringEnabled && !monitoringTask) {
          const due = await backend.operations.claimDue({ limit: 1 });
          const work = due[0];
          if (work) monitoringTask = runMonitoringWork({ database, backend, adapters: monitoringAdapters }, work, stop.signal)
            .catch(error => { if (!stop.signal.aborted) report('monitoring_run_degraded', error); })
            .finally(() => { monitoringTask = undefined; });
        }
        if (customerDiscovery) {
          const pending = await backend.customers.pendingOrganizations({ limit: 100 });
          const current = [...new Set([...config.organizationIds, ...pending])];
          transport.setOrganizationIds(current);
          allowedOrganizations.clear();
          for (const id of current) allowedOrganizations.add(id);
          discoveryHealthy = true;
        }
        for (const organizationId of allowedOrganizations) await dispatchOutbox(backend, organizationId, transport.publish);
        if (Date.now() - lastReconciliation >= 10_000) {
          for (const organizationId of allowedOrganizations) await reconcileDurableDeliveries(database, organizationId, transport.publish);
          lastReconciliation = Date.now();
        }
      } catch (error) { discoveryHealthy = !customerDiscovery; report('coordinator_dispatch_delayed', error); }
      try { await delay(500, undefined, { signal: stop.signal }); }
      catch (error) { if (!stop.signal.aborted) throw error; }
    }
  })();
  const server = createServer((request, response) => {
    if (request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"alive"}'); return;
    }
    if (request.url !== '/health/ready') { response.writeHead(404); response.end(); return; }
    void Promise.all([database.checkHealth(), transport.checkHealth()]).then(() => {
      const ready = discoveryHealthy && (allowedOrganizations.size > 0 || customerDiscovery);
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: ready ? 'ready' : 'unassigned', assignedOrganizations: allowedOrganizations.size, investigatorConfigured: Boolean(investigator), customerDiscovery, customerScannerConfigured: Boolean(customerAssessmentRunner), scheduledMonitoring: monitoringEnabled }));
    }).catch((error: unknown) => {
      report('coordinator_not_ready', error); response.writeHead(503); response.end('{"status":"unavailable"}');
    });
  });
  server.listen(config.port, process.env.GOTCHU_COORDINATOR_HOST ?? '127.0.0.1');
  const shutdown = async () => {
    stop.abort();
    await loop;
    await monitoringTask;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    try { await transport.close(); }
    finally { await Promise.all([database.close(), controlledTarget?.close()]); }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown().catch((error: unknown) => { report('coordinator_shutdown_failed', error); process.exitCode = 1; }); });
  loop.catch((error: unknown) => { report('coordinator_loop_failed', error); process.exitCode = 1; });
  console.log(JSON.stringify({ event: 'coordinator_started', port: config.port, assignedOrganizations: allowedOrganizations.size }));
}

main().catch((error: unknown) => { report('coordinator_start_failed', error); process.exitCode = 1; });
