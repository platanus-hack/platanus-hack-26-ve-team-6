import { createRequire } from 'node:module';
import { DEMO_ASSESSMENT_SCOPE, DEMO_ASSESSMENT_TARGET_KEY } from '@gotchu/backend';
import { migrate } from '@gotchu/database';

// Use the database package's existing driver; this operator script has no runtime server role.
const require = createRequire(import.meta.resolve('@gotchu/database'));
const { Client } = require('pg');
const connectionString = process.env.GOTCHU_MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('GOTCHU_MIGRATION_DATABASE_URL is required for operator-only demo setup');

await migrate({ connectionString });
const client = new Client({ connectionString });
await client.connect();
try {
  const { organizationId, applicationId, userId } = DEMO_ASSESSMENT_SCOPE;
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(612481954)');
  // RLS must not hide conflicting customer state from the operator checks below.
  await client.query('SET LOCAL row_security = off');
  await client.query("INSERT INTO gotchu.organizations(id,name) VALUES ($1,'Controlled Assessment Demo') ON CONFLICT DO NOTHING", [organizationId]);
  await client.query("INSERT INTO gotchu.applications(organization_id,id,name) VALUES ($1,$2,'Controlled Demo Store') ON CONFLICT DO NOTHING", [organizationId, applicationId]);
  await client.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES ($1,$2,'operator') ON CONFLICT DO NOTHING", [organizationId, userId]);
  await client.query(`INSERT INTO gotchu.assessment_targets(organization_id,application_id,target_key,enabled)
    VALUES ($1,$2,$3,true) ON CONFLICT DO NOTHING`, [organizationId, applicationId, DEMO_ASSESSMENT_TARGET_KEY]);
  const unsafe = await client.query(`SELECT
    EXISTS(SELECT 1 FROM gotchu.organizations WHERE id=$1 AND (name<>'Controlled Assessment Demo' OR model_opt_in))
    OR EXISTS(SELECT 1 FROM gotchu.applications WHERE organization_id=$1 AND (id<>$2 OR name<>'Controlled Demo Store'))
    OR EXISTS(SELECT 1 FROM gotchu.memberships WHERE (organization_id=$1 AND (user_id<>$3 OR role<>'operator')) OR (user_id=$3 AND organization_id<>$1))
    OR EXISTS(SELECT 1 FROM gotchu.assessment_targets WHERE organization_id=$1 AND (application_id<>$2 OR target_key<>$4 OR NOT enabled))
    OR EXISTS(SELECT 1 FROM gotchu.integrations WHERE organization_id=$1) AS unsafe`,
  [organizationId, applicationId, userId, DEMO_ASSESSMENT_TARGET_KEY]);
  if (unsafe.rows[0]?.unsafe !== false) throw new Error('Fixed demo scope contains conflicting configuration; operator review is required');
  await client.query('COMMIT');
  console.log(JSON.stringify({ event: 'controlled_assessment_demo_seeded', ...DEMO_ASSESSMENT_SCOPE, targetKey: DEMO_ASSESSMENT_TARGET_KEY }));
} catch (error) {
  await client.query('ROLLBACK');
  // Do not print driver errors that can contain operator connection details.
  console.error(JSON.stringify({ event: 'controlled_assessment_demo_seed_failed', type: error instanceof Error ? error.name : 'unknown' }));
  process.exitCode = 1;
} finally {
  await client.end();
}
