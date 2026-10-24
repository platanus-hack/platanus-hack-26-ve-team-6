import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';
import { compareAnalyzedToDeployed } from '@gotchu/contracts';

const live = liveUrl ? describe : describe.skip;
live('tenant application context on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let backend: ReturnType<typeof createBackend>;
  beforeAll(async () => { f = await fixture(); backend = createBackend({ database: f.databases.gotchu_api }); });
  beforeEach(async () => {
    await f.admin.query('UPDATE gotchu.applications SET archived=false WHERE organization_id=$1 AND id=$2', [f.a.organizationId, f.a.applicationId]);
    for (const table of ['application_origin_candidates', 'application_dependencies', 'application_deployments', 'application_repository_links', 'application_services', 'application_environments'] as const) {
      await f.admin.query(`DELETE FROM gotchu.${table} WHERE organization_id=$1 AND application_id=$2`, [f.a.organizationId, f.a.applicationId]);
    }
  });
  afterAll(async () => { await f?.close(); });
  const identity = () => ({ userId: f.a.userId });
  const scope = () => ({ organizationId: f.a.organizationId, applicationId: f.a.applicationId });
  async function base() {
    const environment = await backend.context.createEnvironment(identity(), { ...scope(), name: 'production', kind: 'production' });
    if (!environment) throw new Error('Environment fixture was not created');
    const service = await backend.context.createService(identity(), { ...scope(), environmentId: environment.id, name: 'web', kind: 'web' });
    if (!service) throw new Error('Service fixture was not created');
    return { environment, service };
  }
  it('rejects cross-tenant access, lets viewers read, and denies viewers every mutation', async () => {
    const { environment, service } = await base();
    const link = await backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'fixture-repo', defaultBranch: 'main' });
    if (!link) throw new Error('Repository fixture was not created');
    const viewer = `viewer:${crypto.randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [f.a.organizationId, viewer]);
    await expect(backend.context.list({ userId: viewer }, scope())).resolves.toMatchObject({ environments: [{ id: environment.id }] });
    const attempts = [
      () => backend.context.createEnvironment({ userId: viewer }, { ...scope(), name: 'staging', kind: 'staging' }),
      () => backend.context.updateEnvironment({ userId: viewer }, { ...scope(), environmentId: environment.id, name: 'stage' }),
      () => backend.context.archiveEnvironment({ userId: viewer }, { ...scope(), environmentId: environment.id, archived: true }),
      () => backend.context.createService({ userId: viewer }, { ...scope(), environmentId: environment.id, name: 'worker', kind: 'worker' }),
      () => backend.context.updateService({ userId: viewer }, { ...scope(), serviceId: service.id, name: 'renamed' }),
      () => backend.context.createRepositoryLink({ userId: viewer }, { ...scope(), repositoryKey: 'viewer-repo', defaultBranch: 'main' }),
      () => backend.context.revokeRepositoryLink({ userId: viewer }, { ...scope(), repositoryLinkId: link.id }),
      () => backend.context.createDeployment({ userId: viewer }, { ...scope(), environmentId: environment.id, serviceId: service.id, releaseId: 'r1', deployedAt: new Date().toISOString() }),
      () => backend.context.createDependency({ userId: viewer }, { ...scope(), environmentId: environment.id, serviceId: service.id, kind: 'package', provider: 'other', component: 'lib', region: null }),
      () => backend.context.createOriginCandidate({ userId: viewer }, { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory' }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    await expect(backend.context.list({ userId: f.b.userId }, scope())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(backend.context.updateEnvironment({ userId: f.b.userId }, { organizationId: f.b.organizationId, applicationId: f.a.applicationId, environmentId: environment.id, name: 'stolen' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.context.revokeRepositoryLink({ userId: f.b.userId }, { organizationId: f.b.organizationId, applicationId: f.a.applicationId, repositoryLinkId: link.id })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('rejects every mutation after application archive and rejects writes to archived environments', async () => {
    const { environment, service } = await base();
    const link = await backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'fixture-repo', defaultBranch: 'main' });
    if (!link) throw new Error('Repository fixture was not created');
    await f.admin.query('UPDATE gotchu.applications SET archived=true WHERE organization_id=$1 AND id=$2', [f.a.organizationId, f.a.applicationId]);
    const attempts = [
      () => backend.context.createEnvironment(identity(), { ...scope(), name: 'staging', kind: 'staging' }),
      () => backend.context.updateEnvironment(identity(), { ...scope(), environmentId: environment.id, name: 'stage' }),
      () => backend.context.archiveEnvironment(identity(), { ...scope(), environmentId: environment.id, archived: true }),
      () => backend.context.createService(identity(), { ...scope(), environmentId: environment.id, name: 'worker', kind: 'worker' }),
      () => backend.context.updateService(identity(), { ...scope(), serviceId: service.id, name: 'renamed' }),
      () => backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'another-repo', defaultBranch: 'main' }),
      () => backend.context.revokeRepositoryLink(identity(), { ...scope(), repositoryLinkId: link.id }),
      () => backend.context.createDeployment(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, releaseId: 'r1', deployedAt: new Date().toISOString() }),
      () => backend.context.createDependency(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, kind: 'package', provider: 'other', component: 'lib', region: null }),
      () => backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory' }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await f.admin.query('UPDATE gotchu.applications SET archived=false WHERE organization_id=$1 AND id=$2', [f.a.organizationId, f.a.applicationId]);
    await f.admin.query('UPDATE gotchu.application_environments SET archived=true WHERE organization_id=$1 AND application_id=$2 AND id=$3', [f.a.organizationId, f.a.applicationId, environment.id]);
    await expect(backend.context.createService(identity(), { ...scope(), environmentId: environment.id, name: 'worker', kind: 'worker' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.context.updateService(identity(), { ...scope(), serviceId: service.id, name: 'renamed' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.context.createDeployment(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, releaseId: 'r1', deployedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'not_found' });
    await expect(backend.context.createDependency(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, kind: 'package', provider: 'other', component: 'lib', region: null })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('rejects client trust assertions at the service and SQL boundaries', async () => {
    const { environment, service } = await base();
    await expect(backend.context.createEnvironment(identity(), { ...scope(), name: 'stage', kind: 'staging', state: 'verified' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(backend.context.createService(identity(), { ...scope(), environmentId: environment.id, name: 'worker', kind: 'worker', source: 'operator' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'repo', defaultBranch: 'main', readAccess: 'granted' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(backend.context.createDeployment(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, releaseId: 'r', deployedAt: new Date().toISOString(), state: 'verified' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory', ownership: 'verified' })).rejects.toMatchObject({ code: 'invalid_input' });
    const db = f.databases.gotchu_api;
    await expect(db.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.context_create_environment($1,$2,$3,$4,$5,$6,$7,$8)', [f.a.organizationId,f.a.applicationId,f.a.userId,crypto.randomUUID(),'stage','staging','signed_telemetry',null]))).rejects.toThrow('context_self_assertion');
    await expect(db.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.context_create_repository($1,$2,$3,$4,$5,$6,$7,$8)', [f.a.organizationId,f.a.applicationId,f.a.userId,crypto.randomUUID(),'repo','src','main','revoked']))).rejects.toThrow('context_self_assertion');
    await expect(db.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.context_create_deployment($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)', [f.a.organizationId,f.a.applicationId,f.a.userId,environment.id,service.id,crypto.randomUUID(),'r',null,null,null,new Date(),'verified','operator']))).rejects.toThrow('context_self_assertion');
    await expect(db.tenant(f.a.organizationId, tx => tx.query('SELECT gotchu.context_create_origin($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [f.a.organizationId,f.a.applicationId,f.a.userId,environment.id,crypto.randomUUID(),'https://example.com','customer_inventory','verified',null,'declared','customer_declared',null]))).rejects.toThrow('context_self_assertion');
  });
  it('enforces environment, repository and target relationships and derives current ownership', async () => {
    const { environment, service } = await base();
    const otherEnvironment = await backend.context.createEnvironment(identity(), { ...scope(), name: 'staging', kind: 'staging' });
    if (!otherEnvironment) throw new Error('Second environment fixture was not created');
    await expect(backend.context.createDeployment(identity(), { ...scope(), environmentId: otherEnvironment.id, serviceId: service.id, releaseId: 'wrong-env', deployedAt: new Date().toISOString() })).rejects.toMatchObject({ code: 'not_found' });
    const targetId = crypto.randomUUID();
    await f.admin.query("INSERT INTO gotchu.customer_targets(organization_id,application_id,id,origin,version,status,consent_actor,challenge_hash,challenge_expires_at,verified_at,expires_at) VALUES($1,$2,$3,'https://example.com',1,'verified',$4,$5,now()+interval '30 minutes',now(),now()+interval '1 hour')", [f.a.organizationId,f.a.applicationId,targetId,f.a.userId,'c'.repeat(64)]);
    await expect(backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory', authorizationTargetId: crypto.randomUUID() })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://other.example', discoverySource: 'customer_inventory', authorizationTargetId: targetId })).rejects.toMatchObject({ code: 'invalid_input' });
    const foreignAppId = crypto.randomUUID(); const foreignTargetId = crypto.randomUUID();
    await f.admin.query("INSERT INTO gotchu.applications(organization_id,id,name) VALUES($1,$2,'Other application')", [f.a.organizationId,foreignAppId]);
    await f.admin.query("INSERT INTO gotchu.customer_targets(organization_id,application_id,id,origin,version,status,consent_actor,challenge_hash,challenge_expires_at) VALUES($1,$2,$3,'https://example.com',1,'pending',$4,$5,now()+interval '30 minutes')", [f.a.organizationId,foreignAppId,foreignTargetId,f.a.userId,'d'.repeat(64)]);
    await expect(backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory', authorizationTargetId: foreignTargetId })).rejects.toMatchObject({ code: 'invalid_input' });
    const origin = await backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: environment.id, origin: 'https://example.com', discoverySource: 'customer_inventory', ownership: 'claimed', authorizationTargetId: targetId });
    expect(origin?.ownership).toBe('verified');
    await f.admin.query("UPDATE gotchu.customer_targets SET verified_at=now()-interval '1 hour',expires_at=now()-interval '1 second' WHERE organization_id=$1 AND application_id=$2 AND id=$3", [f.a.organizationId,f.a.applicationId,targetId]);
    expect((await backend.context.list(identity(), scope())).origins[0]?.ownership).toBe('claimed');
    await f.admin.query("UPDATE gotchu.customer_targets SET status='revoked',expires_at=NULL WHERE organization_id=$1 AND application_id=$2 AND id=$3", [f.a.organizationId,f.a.applicationId,targetId]);
    expect((await backend.context.list(identity(), scope())).origins[0]?.ownership).toBe('claimed');
    expect(await backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'catalog-backed', defaultBranch: 'main' })).toMatchObject({ readAccess: 'granted', writeAccess: 'not_granted' });
    await expect(f.admin.query("INSERT INTO gotchu.application_deployments(organization_id,application_id,environment_id,service_id,id,release_id,deployed_at,state,source) VALUES($1,$2,$3,$4,$5,'bad-fk',now(),'declared','customer_declared')", [f.a.organizationId,f.a.applicationId,otherEnvironment.id,service.id,crypto.randomUUID()])).rejects.toMatchObject({ code: '23503' });
  });
  it('maps bounds and environment name collisions to stable errors', async () => {
    await base();
    for (let i = 0; i < 9; i++) await backend.context.createEnvironment(identity(), { ...scope(), name: `env-${i}`, kind: 'other' });
    await expect(backend.context.createEnvironment(identity(), { ...scope(), name: 'eleven', kind: 'other' })).rejects.toMatchObject({ code: 'context_environment_limit', status: 429 });
    await expect(backend.context.updateEnvironment(identity(), { ...scope(), environmentId: (await backend.context.list(identity(), scope())).environments[0]!.id, name: 'env-0' })).rejects.toMatchObject({ code: 'context_conflict', status: 409 });
    const inventory = await backend.context.list(identity(), scope());
    const env = inventory.environments[0]!;
    for (let i = 0; i < 20; i++) await backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: `repo-${i}`, defaultBranch: 'main' });
    await expect(backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'repo-overflow', defaultBranch: 'main' })).rejects.toMatchObject({ code: 'context_repository_limit', status: 429 });
    for (let i = 0; i < 49; i++) await backend.context.createService(identity(), { ...scope(), environmentId: env.id, name: `service-${i}`, kind: 'web' });
    await expect(backend.context.createService(identity(), { ...scope(), environmentId: env.id, name: 'service-overflow', kind: 'web' })).rejects.toMatchObject({ code: 'context_service_limit', status: 429 });
    const service = (await backend.context.list(identity(), scope())).services[0]!;
    for (let i = 0; i < 100; i++) await backend.context.createDependency(identity(), { ...scope(), environmentId: env.id, serviceId: service.id, kind: 'package', provider: 'other', component: `dep-${i}`, region: null });
    await expect(backend.context.createDependency(identity(), { ...scope(), environmentId: env.id, serviceId: service.id, kind: 'package', provider: 'other', component: 'dep-overflow', region: null })).rejects.toMatchObject({ code: 'context_dependency_limit', status: 429 });
    for (let i = 0; i < 200; i++) await backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: env.id, origin: `https://host-${i}.example.com`, discoverySource: 'customer_inventory' });
    await expect(backend.context.createOriginCandidate(identity(), { ...scope(), environmentId: env.id, origin: 'https://overflow.example.com', discoverySource: 'customer_inventory' })).rejects.toMatchObject({ code: 'context_origin_limit', status: 429 });
  }, 60_000);
  it('retains the 500 newest deployments per service and compares only verified identity', async () => {
    const { environment, service } = await base();
    for (let i = 0; i < 501; i++) await backend.context.createDeployment(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, releaseId: `r-${i}`, deployedAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(), commitSha: `${i.toString(16).padStart(40, '0')}` });
    const rows = (await backend.context.list(identity(), scope())).deployments;
    expect(rows).toHaveLength(500);
    expect(rows.some(row => row.releaseId === 'r-0')).toBe(false);
    expect(rows[0]?.releaseId).toBe('r-500');
    expect(compareAnalyzedToDeployed({ commitSha: 'a'.repeat(40) }, { state: 'verified', commitSha: 'a'.repeat(40), sourceSnapshotDigest: null })).toBe('matches');
    expect(compareAnalyzedToDeployed({ commitSha: 'b'.repeat(40) }, { state: 'verified', commitSha: 'a'.repeat(40), sourceSnapshotDigest: null })).toBe('differs');
    expect(compareAnalyzedToDeployed({}, { state: 'declared', commitSha: 'a'.repeat(40), sourceSnapshotDigest: null })).toBe('unknown');
  }, 60_000);
});
