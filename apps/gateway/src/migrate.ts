import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

/** Operator-only: run after @gotchu/database migrations, never using the gateway runtime login. */
export async function migrateGateway(options: { connectionString: string }): Promise<void> {
  const client = new pg.Client({ connectionString: options.connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(612481953)');
    await client.query('SET LOCAL ROLE gotchu_owner');
    await client.query('CREATE TABLE IF NOT EXISTS gotchu.gateway_schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>('SELECT checksum FROM gotchu.gateway_schema_migrations WHERE name=$1', [name]);
      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) throw new Error(`Gateway migration checksum mismatch: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO gotchu.gateway_schema_migrations(name,checksum) VALUES ($1,$2)', [name, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { await client.end(); }
}
