import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, type Database, type RuntimeRole, runtimeRoleSchema } from '../src/index.js';
import { migrate, provisionRuntimeLogin } from '../src/migrate.js';

export const liveUrl = process.env.GOTCHU_TEST_DATABASE_URL;
export async function fixture() {
  if (!liveUrl) throw new Error('GOTCHU_TEST_DATABASE_URL is required');
  const parsed = new URL(liveUrl);
  if (!/^gotchu_test_[a-zA-Z0-9_]+$/.test(parsed.pathname.slice(1))) throw new Error('Live tests require a dedicated database named gotchu_test_*');
  await migrate({ connectionString: liveUrl });
  await migrate({ connectionString: liveUrl }); // Idempotency and migration checksum checks.
  const admin = new pg.Client({ connectionString: liveUrl });
  await admin.connect();
  const suffix = randomBytes(6).toString('hex');
  const databases = {} as Record<RuntimeRole, Database>;
  const usernames: string[] = [];
  for (const role of runtimeRoleSchema.options) {
    const username = `${role}_${suffix}`;
    usernames.push(username);
    const password = randomBytes(32).toString('hex');
    await provisionRuntimeLogin({ connectionString: liveUrl, username, password, role });
    const url = new URL(liveUrl);
    url.username = username;
    url.password = password;
    databases[role] = createDatabase({ connectionString: url.toString(), role, max: 1 });
  }
  const tenants = [0, 1].map(() => ({ organizationId: randomUUID(), applicationId: randomUUID(), integrationId: randomUUID(), userId: `github:${randomUUID()}` }));
  for (const t of tenants) {
    await admin.query("INSERT INTO gotchu.organizations(id, name, model_opt_in, model_budget_micros) VALUES ($1, 'Test', true, 1000)", [t.organizationId]);
    await admin.query("INSERT INTO gotchu.memberships(organization_id, user_id, role) VALUES ($1, $2, 'owner')", [t.organizationId, t.userId]);
    await admin.query("INSERT INTO gotchu.applications(organization_id, id, name) VALUES ($1, $2, 'Test')", [t.organizationId, t.applicationId]);
    await admin.query("INSERT INTO gotchu.integrations(organization_id, application_id, id, kind) VALUES ($1, $2, $3, 'signed_events')", [t.organizationId, t.applicationId, t.integrationId]);
    await admin.query('INSERT INTO gotchu.integration_credentials(organization_id, integration_id, credential_ref) VALUES ($1, $2, $3)', [t.organizationId, t.integrationId, `test:${t.integrationId}`]);
  }
  return { admin, databases, a: tenants[0]!, b: tenants[1]!, close: async () => {
    await Promise.all(Object.values(databases).map((db) => db.close()));
    for (const username of usernames) await admin.query(`DROP ROLE ${username}`);
    await admin.end();
  } };
}
