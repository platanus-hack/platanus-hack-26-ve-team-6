import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBackend } from '@gotchu/backend';
import { createCoordinatorTransport, dispatchOutbox, runMonitoringWork, type MonitoringAdapters } from '@gotchu/coordinator';
import { createCustomerAssessmentRunner, profiles, type ScannerAdapter } from '@gotchu/customer-assessment';
import { createMonitoringRepositoryCatalog, createLocalGitRepositoryReader, createOsvDependencyAdapter, createCloudflareStatusAdapter, createRailwayStatusAdapter } from '@gotchu/monitoring';
import type { MonitorWork } from '@gotchu/contracts';
import { fixture, liveUrl, present } from '../../packages/database/test/support.js';

const live = liveUrl && process.env.GOTCHU_TEST_REDIS_URL ? describe : describe.skip;
live('scheduled customer monitoring with real Git, PostgreSQL and BullMQ', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>; let coordinator: ReturnType<typeof createBackend>;
  let directory: string;
  const unavailableScanners: ScannerAdapter = {
    async readiness() { return { ready: false, tools: [] }; },
    async run() { throw new Error('unavailable_scanner_fixture'); },
  };
  beforeAll(async () => {
    f = await fixture({ max: 8 });
    api = createBackend({ database: f.databases.gotchu_api });
    coordinator = createBackend({ database: f.databases.gotchu_coordinator });
    directory = await mkdtemp(join(tmpdir(), 'gotchu-scheduled-'));
  });
  afterAll(async () => { await f?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  const scope = () => ({ organizationId: f.a.organizationId, applicationId: f.a.applicationId });
  const identity = () => ({ userId: f.a.userId });
  async function next(): Promise<MonitorWork> {
    // Operator-controlled clock advancement; the customer cannot make a monitor due through HTTP.
    await f.admin.query('UPDATE gotchu.operation_monitors SET next_due_at=clock_timestamp()-interval \'1 second\' WHERE organization_id=$1 AND application_id=$2', [f.a.organizationId, f.a.applicationId]);
    return present((await coordinator.operations.claimDue({ limit: 1 }))[0]);
  }
  async function execute(work: MonitorWork, adapters: MonitoringAdapters) {
    const database = f.databases.gotchu_coordinator;
    const transport = createCoordinatorTransport({ redisUrl: present(process.env.GOTCHU_TEST_REDIS_URL), organizationIds: [work.organizationId],
      dependencies: { database, backend: coordinator, customerAssessmentRunner: createCustomerAssessmentRunner({ scanners: unavailableScanners }) },
      prefix: `scheduled-${randomUUID()}`, report: () => {},
    });
    await transport.waitUntilReady();
    let done = false;
    const running = runMonitoringWork({ database, backend: coordinator, adapters }, work).finally(() => { done = true; });
    // Observe early failure while the dispatcher is running, then propagate it below.
    const observed = running.catch(() => {});
    try {
      for (let i = 0; !done && i < 300; i++) { await dispatchOutbox(coordinator, work.organizationId, transport.publish); await delay(25); }
      if (!done) throw new Error('scheduled_monitor_timeout');
      await running;
      // Deliver the report's durable notification after the audit has settled.
      await dispatchOutbox(coordinator, work.organizationId, transport.publish);
      await expect.poll(async () => (await transport.queues.notification.getJobCounts('active', 'waiting')).active ?? 0).toBe(0);
    } finally { await observed; await transport.close(); }
  }
  it('rechecks unchanged dependency versions and changed commits through canonical assessments', async () => {
    const managed = join(directory, 'managed'); const bare = join(managed, 'app.git'); const working = join(directory, 'working');
    await mkdir(managed);
    function git(args: string[], cwd?: string) { execFileSync('git', args, { ...(cwd ? { cwd } : {}), stdio: 'ignore', timeout: 5000 }); }
    git(['init', '--bare', '--initial-branch=main', bare]); git(['init', '--initial-branch=main', working]);
    await writeFile(join(working, 'app.ts'), 'export const value = 1;\n');
    await writeFile(join(working, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/example': { version: '1.0.0' }, 'node_modules/nested/node_modules/example': { version: '2.0.0' } } }));
    async function commit(message: string) {
      git(['add', '.'], working); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message], working);
      git(['push', bare, 'HEAD:refs/heads/main'], working);
    }
    await commit('baseline');
    const catalog = createMonitoringRepositoryCatalog({ repositoryRoot: managed, repositories: [{ ...scope(), repositoryKey: 'company-app', displayName: 'Company app', provider: 'local_git', path: 'app.git', ref: 'refs/heads/main' }] });
    const reader = createLocalGitRepositoryReader(catalog);
    let advisory = false; let queries = 0;
    // Deterministic OSV response fixture, exercising the actual metadata adapter; no live availability claim.
    const osv = createOsvDependencyAdapter({ fetchImplementation: async (request, init) => {
      if (String(request).endsWith('/querybatch')) {
        queries++;
        const body = z.object({ queries: z.array(z.unknown()) }).parse(JSON.parse(z.string().parse(init?.body)));
        return Response.json({ results: body.queries.map(() => ({ vulns: advisory ? [{ id: 'GHSA-fixture-1234' }] : [] })) });
      }
      return Response.json({ id: 'GHSA-fixture-1234', summary: 'Fixture package advisory', database_specific: { severity: 'HIGH' } });
    } });
    const adapters: MonitoringAdapters = {
      repository: input => reader.read(input),
      dependencies: (repository, signal) => osv.read({ repositoryKey: repository.repositoryKey, commitSha: repository.commit.sha, repositoryReference: present(repository.evidence[0]).reference, snapshot: repository.snapshot, signal }),
      async provider() { throw new Error('provider_not_selected'); },
      async httpsHealth() { throw new Error('https_not_selected'); },
    };
    await api.operations.configure(identity(), { ...scope(), enabled: true, intervalSeconds: 21600, sourceSnapshotId: null, targetId: null, repositoryKey: 'company-app', providers: [] });
    await execute(await next(), adapters);
    const firstReports = await api.customers.listReports(identity(), scope());
    expect(firstReports).toHaveLength(1);
    expect((await api.operations.listAlerts(identity(), scope())).some(a => a.observation.kind === 'dependency_advisory')).toBe(false);
    advisory = true;
    await execute(await next(), adapters);
    expect(queries).toBe(2);
    expect(await api.customers.listSources(identity(), scope())).toHaveLength(1);
    const dependency = (await api.operations.listAlerts(identity(), scope())).find(a => a.observation.kind === 'dependency_advisory');
    expect(dependency?.observation.evidence.some(e => e.source === 'advisory_database')).toBe(true);
    const advisories = (await api.operations.listAlerts(identity(), scope())).filter(a => a.observation.kind === 'dependency_advisory');
    expect(advisories).toHaveLength(2);
    expect(advisories.some(a => a.observation.summary.includes('example@1.0.0'))).toBe(true);
    expect(advisories.some(a => a.observation.summary.includes('example@2.0.0'))).toBe(true);
    await writeFile(join(working, 'app.ts'), 'export const value = 2;\n'); await commit('actual change');
    await execute(await next(), adapters);
    expect(await api.customers.listReports(identity(), scope())).toHaveLength(3);
    expect(await api.customers.listSources(identity(), scope())).toHaveLength(2);
    expect((await api.operations.listAlerts(identity(), scope())).some(a => a.observation.kind === 'repository_change')).toBe(true);
    expect((await api.operations.getCoverage(identity(), scope())).status).toBe('degraded'); // Scanner fixtures remain honestly unavailable.
    await expect(reader.read({ ...scope(), applicationId: randomUUID(), repositoryKey: 'company-app' })).rejects.toThrow('repository_not_configured');
  }, 30_000);
  it('records healthy status without an alert and treats a provider outage as unverified customer impact', async () => {
    await api.operations.configure(identity(), { ...scope(), enabled: true, intervalSeconds: 21600, sourceSnapshotId: null, targetId: null, repositoryKey: null, providers: ['cloudflare'] });
    expect(await api.operations.getCoverage(identity(), scope())).toMatchObject({ status: 'pending', lastRun: null });
    let outage = false;
    const provider = createCloudflareStatusAdapter({ fetchImplementation: async () => Response.json({
      page: { updated_at: new Date().toISOString() }, status: { indicator: outage ? 'major' : 'none', description: outage ? 'Fixture outage' : 'Operational' },
      components: [{ name: 'Fixture edge', status: outage ? 'major_outage' : 'operational' }], incidents: [],
    }) });
    const adapters: MonitoringAdapters = { async repository() { throw new Error('not_selected'); }, async dependencies() { throw new Error('not_selected'); }, provider: (_name, signal) => provider.read(signal), async httpsHealth() { throw new Error('https_not_selected'); } };
    const before = await api.operations.listAlerts(identity(), scope());
    await execute(await next(), adapters);
    expect(await api.operations.listAlerts(identity(), scope())).toHaveLength(before.length);
    expect((await api.operations.getCoverage(identity(), scope())).status).toBe('active');
    outage = true; await execute(await next(), adapters);
    const alert = present((await api.operations.listAlerts(identity(), scope())).find(a => a.observation.kind === 'upstream_outage'));
    expect(alert.observation.upstreamImpact).toBe('unverified');
    const plan = await api.operations.createPlan(identity(), { ...scope(), kind: 'migration_readiness', observationIds: [alert.observation.id] });
    expect(plan.execution).toBe('disabled'); expect(plan.steps.some(s => s.key === 'data')).toBe(true);
    await api.operations.configure(identity(), { ...scope(), enabled: true, intervalSeconds: 21600, sourceSnapshotId: null, targetId: null, repositoryKey: null, providers: ['railway'] });
    const railway = createRailwayStatusAdapter({ fetchImplementation: async () => Response.json({ generatedAt: new Date().toISOString(),
      entries: [{ type: 'component', data: { id: 'fixture-component', name: 'Unknown component', months: [] } }],
      activeIncidents: [{ id: 'fixture-incident', title: 'Known upstream issue', status: 'INVESTIGATING' }], maintenances: [],
    }) });
    await execute(await next(), { ...adapters, provider: (_name, signal) => railway.read(signal) });
    const mixed = (await api.operations.listAlerts(identity(), scope())).filter(a => a.observation.evidence.some(e => e.reference === 'https://status.railway.com/api/status'));
    expect(mixed.map(a => a.observation.kind).sort()).toEqual(['coverage_gap', 'upstream_outage']);
    expect((await api.operations.getCoverage(identity(), scope())).status).toBe('degraded');
  });
  it('refuses a disabled or no-longer-authorized run before any adapter read', async () => {
    const work = await next();
    // Configuration cannot revoke an active read lease. It may change once the lease expires.
    await expect(api.operations.configure(identity(), { ...scope(), enabled: false, intervalSeconds: 21600, sourceSnapshotId: null, targetId: null, repositoryKey: null, providers: ['cloudflare'] })).rejects.toMatchObject({ code: 'monitor_work_in_progress' });
    await f.admin.query('UPDATE gotchu.operation_runs SET lease_until=clock_timestamp()-interval \'1 second\' WHERE organization_id=$1 AND id=$2', [work.organizationId, work.runId]);
    await api.operations.configure(identity(), { ...scope(), enabled: false, intervalSeconds: 21600, sourceSnapshotId: null, targetId: null, repositoryKey: null, providers: ['cloudflare'] });
    let reads = 0;
    const adapters: MonitoringAdapters = { async repository() { reads++; throw new Error('unexpected_read'); }, async dependencies() { reads++; throw new Error('unexpected_read'); }, async provider() { reads++; throw new Error('unexpected_read'); }, async httpsHealth() { reads++; throw new Error('unexpected_read'); } };
    await expect(runMonitoringWork({ database: f.databases.gotchu_coordinator, backend: coordinator, adapters }, work)).rejects.toThrow();
    expect(reads).toBe(0); expect(await coordinator.operations.claimDue()).toEqual([]);
  });
  it('keeps recovered adapter outcomes unknown even when a saved audit completed', async () => {
    const source = await api.customers.uploadSource(identity(), { ...scope(), authorized: true, snapshot: { revision: 'recovery-fixture', files: [{ path: 'index.ts', content: 'export const fixture = 1;' }, { path: 'package-lock.json', content: '{"lockfileVersion":3,"packages":{}}' }] } });
    await api.operations.configure(identity(), { ...scope(), enabled: true, intervalSeconds: 21600, sourceSnapshotId: source.id, targetId: null, repositoryKey: null, providers: ['cloudflare'] });
    const work = await next();
    const binding = { ...scope(), runId: work.runId, leaseToken: work.leaseToken };
    const queued = await coordinator.operations.materialize(binding);
    const claim = present(await coordinator.jobs.claim({ organizationId: work.organizationId, jobId: present(queued.jobId) }));
    const input = await coordinator.customers.getRequest({ ...scope(), jobId: present(queued.jobId), leaseToken: claim.leaseToken });
    // Synthetic scanner completion isolates crash recovery from scanner availability; not live scanner evidence.
    const scanners: ScannerAdapter = { async readiness() { return { ready: true, tools: [] }; }, async run(name) {
      return { image: 'synthetic-recovery-fixture', version: profiles[name].version, profileChecksum: '0'.repeat(64), output:
        name === 'semgrep' ? { version: profiles.semgrep.version, results: [], errors: [], paths: { scanned: ['/source/index.ts'] } } : name === 'gitleaks' ? [] : { SchemaVersion: 2, Results: [{ Target: 'package-lock.json' }] } };
    } };
    const report = await createCustomerAssessmentRunner({ scanners, advisory: { async query() { return []; } } }).run(input);
    expect(report.internal?.status).toBe('completed');
    await coordinator.customers.recordResult({ input, leaseToken: claim.leaseToken, report });
    await f.admin.query('UPDATE gotchu.operation_runs SET lease_until=clock_timestamp()-interval \'1 second\' WHERE organization_id=$1 AND id=$2', [work.organizationId, work.runId]);
    const recovered = present((await coordinator.operations.claimDue({ limit: 1 }))[0]);
    expect(recovered.runId).toBe(work.runId);
    let reads = 0;
    const adapters: MonitoringAdapters = { async repository() { reads++; throw new Error('unexpected_read'); }, async dependencies() { reads++; throw new Error('unexpected_read'); }, async provider() { reads++; throw new Error('unexpected_read'); }, async httpsHealth() { reads++; throw new Error('unexpected_read'); } };
    await runMonitoringWork({ database: f.databases.gotchu_coordinator, backend: coordinator, adapters }, recovered);
    expect(reads).toBe(0);
    expect(await api.operations.getCoverage(identity(), scope())).toMatchObject({ status: 'degraded', lastRun: { runId: recovered.runId, status: 'degraded', reason: expect.stringContaining('unknown adapter completion') } });
  });
});
