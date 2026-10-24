import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackend } from '@gotchu/backend';
import { triageRevisionSchema } from '@gotchu/triage';
import { fixture, liveUrl } from '../../../packages/database/test/support.js';
import { evaluateTriage } from '../src/triage.js';

const live = liveUrl ? describe : describe.skip;

live('bounded triage context on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: ReturnType<typeof createBackend>;

  beforeAll(async () => {
    f = await fixture();
    api = createBackend({ database: f.databases.gotchu_api });
  });
  afterAll(async () => { await f?.close(); });

  it('projects only the newest 100 deployments and accepts customer context identifiers up to 200 characters', async () => {
    const identity = { userId: `triage-context:${randomUUID()}` };
    const workspace = await api.customers.createWorkspace(identity, { name: 'Triage context bounds' });
    const application = await api.customers.createApplication(identity, { organizationId: workspace.id, name: 'Application' });
    const scope = { organizationId: workspace.id, applicationId: application.applicationId };
    const environment = await api.context.createEnvironment(identity, { ...scope, name: 'production', kind: 'production' });
    if (!environment) throw new Error('Environment fixture was not created');
    const service = await api.context.createService(identity, { ...scope, environmentId: environment.id, name: 'checkout', kind: 'web' });
    if (!service) throw new Error('Service fixture was not created');

    const longReleaseId = 'r'.repeat(200);
    const deployment = await api.context.createDeployment(identity, { ...scope, environmentId: environment.id, serviceId: service.id,
      releaseId: longReleaseId, deployedAt: new Date().toISOString() });
    if (!deployment) throw new Error('Deployment fixture was not created');
    expect(deployment).toMatchObject({ releaseId: longReleaseId, state: 'declared', source: 'customer_declared' });
    const longComponent = 'c'.repeat(200);
    const dependency = await api.context.createDependency(identity, { ...scope, environmentId: environment.id, serviceId: service.id,
      kind: 'provider_component', provider: 'cloudflare', component: longComponent, region: null });
    if (!dependency) throw new Error('Dependency fixture was not created');
    expect(dependency).toMatchObject({ component: longComponent, state: 'declared', source: 'customer_declared' });

    await f.admin.query(`INSERT INTO gotchu.application_deployments(organization_id,application_id,environment_id,service_id,id,release_id,deployed_at,state,source)
      SELECT $1,$2,$3,$4,gen_random_uuid(),'older-'||n,$5::timestamptz-(n*interval '1 second'),'declared','customer_declared'
      FROM generate_series(1,100) n`, [scope.organizationId, scope.applicationId, environment.id, service.id, deployment.deployedAt]);
    const observedAt = new Date().toISOString();
    await f.admin.query(`INSERT INTO gotchu.triage_inputs(organization_id,application_id,id,kind,observed_at,payload)
      VALUES($1,$2,$3,'provider_status',$4,$5::jsonb)`, [scope.organizationId, scope.applicationId, randomUUID(), observedAt,
      JSON.stringify({ provider: 'cloudflare', component: null, region: null, state: 'operational', observedAt, scope: 'global', fixture: false })]);

    await f.databases.gotchu_coordinator.tenant(scope.organizationId, tx => evaluateTriage(tx, scope, new Date(observedAt)));
    const latest = await f.admin.query<{ body: unknown }>(`SELECT body FROM gotchu.triage_revisions
      WHERE organization_id=$1 AND application_id=$2 ORDER BY created_at DESC LIMIT 1`, [scope.organizationId, scope.applicationId]);
    const revision = triageRevisionSchema.parse(latest.rows[0]?.body);
    expect(revision.impact.observed).toBe('unknown');
    expect(revision.unknownInvestigable.some(anomaly => anomaly.includes('Deployment context is incomplete'))).toBe(true);
  }, 30_000);
});
