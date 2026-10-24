import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createDatabase, type Database, type RuntimeRole } from '../src/index.js';
import { migrate, provisionRuntimeLogin } from '../src/migrate.js';

export const liveUrl = process.env.GOTCHU_TEST_DATABASE_URL;
export async function fixture(options: { max?: number } = {}) {
  if (!liveUrl) throw new Error('GOTCHU_TEST_DATABASE_URL is required');
  const connectionString = liveUrl;
  const parsed = new URL(connectionString);
  if (!/^gotchu_test_[a-zA-Z0-9_]+$/.test(parsed.pathname.slice(1))) throw new Error('Live tests require a dedicated database named gotchu_test_*');
  await migrate({ connectionString });
  await migrate({ connectionString }); // Idempotency and migration checksum checks.
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  const suffix = randomBytes(6).toString('hex');
  const usernames: string[] = [];
  const runtimeUrls = new Map<RuntimeRole, string>();
  async function database(role: RuntimeRole) {
    const username = `${role}_${suffix}`;
    usernames.push(username);
    const password = randomBytes(32).toString('hex');
    await provisionRuntimeLogin({ connectionString, username, password, role });
    const url = new URL(connectionString);
    url.username = username;
    url.password = password;
    runtimeUrls.set(role, url.toString());
    return createDatabase({ connectionString: url.toString(), role, max: options.max ?? 1 });
  }
  const databases: Record<RuntimeRole, Database> = {
    gotchu_api: await database('gotchu_api'), gotchu_ingest: await database('gotchu_ingest'),
    gotchu_coordinator: await database('gotchu_coordinator'), gotchu_executor: await database('gotchu_executor'),
    gotchu_validator: await database('gotchu_validator'),
  };
  const tenant = () => ({ organizationId: randomUUID(), applicationId: randomUUID(), integrationId: randomUUID(), userId: `github:${randomUUID()}` });
  const a = tenant(); const b = tenant(); const tenants = [a, b];
  for (const t of tenants) {
    await admin.query("INSERT INTO gotchu.organizations(id, name, model_opt_in, model_budget_micros) VALUES ($1, 'Test', true, 1000)", [t.organizationId]);
    await admin.query("INSERT INTO gotchu.memberships(organization_id, user_id, role) VALUES ($1, $2, 'owner')", [t.organizationId, t.userId]);
    await admin.query("INSERT INTO gotchu.applications(organization_id, id, name) VALUES ($1, $2, 'Test')", [t.organizationId, t.applicationId]);
    await admin.query("INSERT INTO gotchu.integrations(organization_id, application_id, id, kind) VALUES ($1, $2, $3, 'signed_events')", [t.organizationId, t.applicationId, t.integrationId]);
    await admin.query('INSERT INTO gotchu.integration_credentials(organization_id, integration_id, credential_ref) VALUES ($1, $2, $3)', [t.organizationId, t.integrationId, `test:${t.integrationId}`]);
  }
  return { admin, databases, a, b, runtimeConnectionString: (role: RuntimeRole) => present(runtimeUrls.get(role)), close: async () => {
    await Promise.all(Object.values(databases).map((db) => db.close()));
    for (const username of usernames) await admin.query(`DROP ROLE ${username}`);
    await admin.end();
    runtimeUrls.clear();
  } };
}

export function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Required test fixture is missing');
  return value;
}
