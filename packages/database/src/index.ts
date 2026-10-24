import pg, { type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { z } from 'zod';
export { migrate, provisionRuntimeLogin, setRecoveryState } from './migrate.js';

export const runtimeRoleSchema = z.enum(['gotchu_api', 'gotchu_ingest', 'gotchu_coordinator', 'gotchu_executor', 'gotchu_validator']);
export type RuntimeRole = z.infer<typeof runtimeRoleSchema>;
export interface Transaction {
  query<R extends QueryResultRow = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}
export interface Database {
  readonly role: RuntimeRole;
  tenant<T>(organizationId: string, work: (tx: Transaction) => Promise<T>): Promise<T>;
  integration<T>(integrationId: string, work: (tx: Transaction) => Promise<T>): Promise<T>;
  checkHealth(): Promise<void>;
  close(): Promise<void>;
}

/** This is a trusted server capability, never a client authorization mechanism. */
export function createDatabase(options: { connectionString: string; role: RuntimeRole; max?: number }): Database {
  const role = runtimeRoleSchema.parse(options.role);
  const pool = new pg.Pool({ connectionString: options.connectionString, max: options.max ?? 10, connectionTimeoutMillis: 5_000 });
  // Do not expose credentials through an unhandled pool error.
  pool.on('error', () => { process.emitWarning('An idle Gotchu database connection failed; the pool will replace it'); });
  async function transaction<T>(organizationId: string | null, integrationId: string | null, work: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await assertSafeLogin(client, role);
      // Only one of four compile-time allowlisted identifiers; never interpolate caller identifiers.
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query("SELECT set_config('search_path', 'pg_catalog,gotchu', true), set_config('statement_timeout', '10000', true), set_config('lock_timeout', '5000', true), set_config('idle_in_transaction_session_timeout', '15000', true), set_config('gotchu.organization_id', $1, true), set_config('gotchu.integration_id', $2, true)", [organizationId ?? '', integrationId ?? '']);
      let active = true;
      const tx: Transaction = { query: (text, values) => {
        if (!active) throw new Error('Transaction is no longer active');
        return client.query(text, values);
      } };
      let result: T;
      try { result = await work(tx); } finally { active = false; }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally {
      // Clear even accidental session-level settings from a trusted callback before pool reuse.
      try { if (!discard) await client.query('RESET ALL; RESET ROLE'); } catch { discard = true; }
      client.release(discard);
    }
  }
  return {
    role,
    tenant: (id, work) => transaction(z.uuid().parse(id), null, work),
    integration: (id, work) => {
      if (role !== 'gotchu_ingest') throw new Error('Integration lookup requires the intake database role');
      return transaction(null, z.uuid().parse(id), work);
    },
    checkHealth: () => transaction(null, null, async tx => { await tx.query('SELECT 1'); }),
    close: () => pool.end(),
  };
}

async function assertSafeLogin(client: PoolClient, role: RuntimeRole): Promise<void> {
  const result = await client.query<{ unsafe: boolean; authorized: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_roles r WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolname = 'gotchu_owner')
        AND (r.rolname = session_user OR pg_has_role(session_user, r.oid, 'MEMBER'))
    ) OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='gotchu' AND pg_has_role(session_user, c.relowner, 'MEMBER')
    ) OR EXISTS (
      SELECT 1 FROM pg_namespace n WHERE n.nspname='gotchu' AND pg_has_role(session_user, n.nspowner, 'MEMBER')
    ) AS unsafe, pg_has_role(session_user, $1, 'MEMBER') AS authorized`, [role]);
  if (result.rows[0]?.unsafe || !result.rows[0]?.authorized) throw new Error('Runtime login must be a non-owner, non-privileged member of its service role');
  const others = await client.query<{ allowed: boolean }>(`SELECT NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = ANY($1::text[]) AND rolname <> $2 AND pg_has_role(session_user, oid, 'MEMBER')
  ) AS allowed`, [runtimeRoleSchema.options, role]);
  if (!others.rows[0]?.allowed) throw new Error('Use one isolated login per service role');
}
