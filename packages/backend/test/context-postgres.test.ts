import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from '../../database/test/support.js';
import { createBackend } from '../src/index.js';
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
  it('isolates organizations and applications and rejects viewer writes and archived applications', async () => {
    const environment = await backend.context.createEnvironment(identity(), { ...scope(), name: 'production', kind: 'production' });
    expect(environment?.name).toBe('production');
    await expect(backend.context.list({ userId: f.b.userId }, scope())).rejects.toMatchObject({ code: 'forbidden' });
    const viewer = `viewer:${crypto.randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [f.a.organizationId, viewer]);
    await expect(backend.context.createEnvironment({ userId: viewer }, { ...scope(), name: 'staging', kind: 'staging' })).rejects.toMatchObject({ code: 'forbidden' });
    const otherApp = { organizationId: f.a.organizationId, applicationId: f.b.applicationId };
    await expect(backend.context.createEnvironment(identity(), { ...otherApp, name: 'staging', kind: 'staging' })).rejects.toMatchObject({ code: 'not_found' });
    await f.admin.query('UPDATE gotchu.applications SET archived=true WHERE organization_id=$1 AND id=$2', [f.a.organizationId, f.a.applicationId]);
    await expect(backend.context.createEnvironment(identity(), { ...scope(), name: 'staging', kind: 'staging' })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('enforces bounds, revokes repository access and keeps commit comparison conservative', async () => {
    for (let index = 0; index < 10; index += 1) await backend.context.createEnvironment(identity(), { ...scope(), name: `env-${index}`, kind: 'other' });
    await expect(backend.context.createEnvironment(identity(), { ...scope(), name: 'eleven', kind: 'other' })).rejects.toMatchObject({ code: 'context_environment_limit' });
    const environment = (await backend.context.list(identity(), scope())).environments[0];
    if (!environment) throw new Error('Environment fixture was not created');
    const service = await backend.context.createService(identity(), { ...scope(), environmentId: environment.id, name: 'web', kind: 'web' });
    if (!service) throw new Error('Service fixture was not created');
    const link = await backend.context.createRepositoryLink(identity(), { ...scope(), repositoryKey: 'fixture-repo', subdirectory: 'apps/web', defaultBranch: 'main' });
    if (!link) throw new Error('Repository fixture was not created');
    const revoked = await backend.context.revokeRepositoryLink(identity(), { ...scope(), repositoryLinkId: link.id });
    expect(revoked).toMatchObject({ revoked: true, readAccess: 'revoked', writeAccess: 'not_granted' });
    const deployment = await backend.context.createDeployment(identity(), { ...scope(), environmentId: environment.id, serviceId: service.id, releaseId: 'release-1', commitSha: 'a'.repeat(40), deployedAt: new Date().toISOString(), state: 'verified' });
    expect(deployment).toBeDefined();
    const inventory = await backend.context.list(identity(), scope());
    expect(inventory.deployments).toHaveLength(1);
    const { compareAnalyzedToDeployed } = await import('@gotchu/contracts');
    expect(compareAnalyzedToDeployed({ commitSha: 'b'.repeat(40) }, inventory.deployments[0]!)).toBe('differs');
    expect(compareAnalyzedToDeployed({}, inventory.deployments[0]!)).toBe('unknown');
  });
});
