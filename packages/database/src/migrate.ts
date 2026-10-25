import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { z } from 'zod';

const roles = ['gotchu_owner', 'gotchu_api', 'gotchu_ingest', 'gotchu_coordinator', 'gotchu_executor', 'gotchu_validator'] as const;
// Retain old checksums so a renamed migration is not replayed on an existing local database.
const legacyMigrationNames = new Map([
  ['055_automatic_source_investigations.sql', '052_automatic_source_investigations.sql'],
  ['046_self_host_bootstrap_status.sql', '038_self_host_bootstrap_status.sql'],
  ['047_monitoring_quota_retention.sql', '041_monitoring_quota_retention.sql'],
  ['048_investigation_provider_presets.sql', '043_investigation_provider_presets.sql'],
  ['049_investigation_model_probes.sql', '044_investigation_model_probes.sql'],
]);
const ident = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";

export async function migrate(options: { connectionString: string }): Promise<void> {
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(612481953)');
    for (const role of roles) {
      const found = await client.query<Record<string, boolean>>('SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = $1', [role]);
      const existingRole = found.rows[0];
      if (!existingRole) await client.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
      else if (Object.values(existingRole).some(Boolean)) throw new Error(`Refusing unsafe pre-existing role ${role}`);
    }
    await client.query('CREATE SCHEMA IF NOT EXISTS gotchu AUTHORIZATION gotchu_owner');
    const owner = await client.query<{ owner: string }>("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'gotchu'");
    if (owner.rows[0]?.owner !== 'gotchu_owner') throw new Error('Unexpected gotchu schema owner');
    await client.query('SET LOCAL ROLE gotchu_owner');
    await client.query('REVOKE ALL ON SCHEMA gotchu FROM PUBLIC');
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA gotchu REVOKE ALL ON TABLES FROM PUBLIC');
    await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA gotchu REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC');
    await client.query('CREATE TABLE IF NOT EXISTS gotchu.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>('SELECT checksum FROM gotchu.schema_migrations WHERE name = $1', [name]);
      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      const legacyName = legacyMigrationNames.get(name);
      if (legacyName) {
        const legacy = await client.query<{ checksum: string }>('SELECT checksum FROM gotchu.schema_migrations WHERE name = $1', [legacyName]);
        if (legacy.rowCount) {
          if (legacy.rows[0]?.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${legacyName}`);
          continue;
        }
      }
      await client.query(sql);
      await client.query('INSERT INTO gotchu.schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { await client.end(); }
}

/** Operator-only bootstrap. Password must be generated externally; never persist it in source. */
export async function provisionRuntimeLogin(options: { connectionString: string; username: string; password: string; role: 'gotchu_api' | 'gotchu_ingest' | 'gotchu_coordinator' | 'gotchu_executor' | 'gotchu_validator' }): Promise<void> {
  const username = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/).parse(options.username);
  const password = z.string().min(24).max(1024).refine((x) => !x.includes('\0')).parse(options.password);
  const role = z.enum(['gotchu_api', 'gotchu_ingest', 'gotchu_coordinator', 'gotchu_executor', 'gotchu_validator']).parse(options.role);
  if (roles.some(roleName => roleName === username)) throw new Error('Runtime login cannot use a group-role name');
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(612481953)');
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [username]);
    // Do not mutate unknown roles or rotate credentials as an implicit side effect.
    if (existing.rowCount) throw new Error('Runtime login already exists; rotate or inspect it through the operator workflow');
    await client.query("SELECT set_config('standard_conforming_strings', 'on', true)");
    await client.query(`CREATE ROLE ${ident(username)} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password)}`);
    await client.query(`GRANT ${role} TO ${ident(username)}`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { await client.end(); }
}

/** Run using operator credentials immediately after a restore, before starting executors. */
export async function setRecoveryState(options: { connectionString: string; mode: 'freeze' | 'reconciled'; reconciliationReference?: string }): Promise<{ epoch: string; frozen: boolean }> {
  const client = new pg.Client({ connectionString: options.connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE gotchu_owner');
    const mode = z.enum(['freeze', 'reconciled']).parse(options.mode);
    const result = mode === 'freeze'
      ? await client.query<{ recovery_epoch: string; writes_frozen: boolean }>('UPDATE gotchu.platform_state SET recovery_epoch = recovery_epoch + 1, writes_frozen = true, reconciliation_reference = NULL, updated_at = now() RETURNING recovery_epoch, writes_frozen')
      : await client.query<{ recovery_epoch: string; writes_frozen: boolean }>('UPDATE gotchu.platform_state SET writes_frozen = false, reconciliation_reference = $1, updated_at = now() RETURNING recovery_epoch, writes_frozen', [z.string().min(1).max(1000).parse(options.reconciliationReference)]);
    const row = result.rows[0];
    if (!row) throw new Error('Recovery state is missing');
    await client.query('COMMIT');
    return { epoch: String(row.recovery_epoch), frozen: row.writes_frozen };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { await client.end(); }
}
