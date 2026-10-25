import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from './support.js';

const live = liveUrl ? describe : describe.skip;
live('requested HTTPS scope migration on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture(); });
  afterAll(async () => { await f?.close(); });

  it('preserves legacy verified scope, leaves pending scope inactive, and keeps revocation', async () => {
    await f.admin.query('BEGIN');
    try {
      await f.admin.query(`ALTER TABLE gotchu.customer_targets DROP CONSTRAINT customer_targets_authorization_check;
        ALTER TABLE gotchu.customer_targets DROP CONSTRAINT customer_targets_status_check;
        ALTER TABLE gotchu.customer_targets RENAME COLUMN authorized_at TO verified_at;
        UPDATE gotchu.customer_targets SET status='verified' WHERE status='authorized';
        ALTER TABLE gotchu.customer_targets RENAME COLUMN requested_by TO consent_actor;
        ALTER TABLE gotchu.customer_targets RENAME COLUMN requested_at TO consent_at;
        ALTER TABLE gotchu.customer_targets ADD COLUMN challenge_hash text NOT NULL DEFAULT repeat('a',64) CHECK(challenge_hash ~ '^[a-f0-9]{64}$');
        ALTER TABLE gotchu.customer_targets ADD COLUMN challenge_expires_at timestamptz NOT NULL DEFAULT now();
        ALTER TABLE gotchu.customer_targets ADD CONSTRAINT customer_targets_status_check CHECK(status IN ('pending','verified','revoked'));
        ALTER TABLE gotchu.customer_targets ADD CONSTRAINT customer_targets_check CHECK(status <> 'verified' OR (verified_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at>verified_at));`);

      const cases = [
        { id: randomUUID(), status: 'verified', actor: 'legacy:verified' },
        { id: randomUUID(), status: 'pending', actor: 'legacy:pending' },
        { id: randomUUID(), status: 'revoked', actor: 'legacy:revoked' },
      ] as const;
      for (const target of cases) {
        const applicationId = randomUUID();
        await f.admin.query('INSERT INTO gotchu.applications(organization_id,id,name) VALUES($1,$2,$3)', [f.a.organizationId, applicationId, `Legacy ${target.status} ${target.id}`]);
        const verifiedAt = target.status === 'verified' ? new Date() : null;
        const expiresAt = target.status === 'verified' ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null;
        await f.admin.query(`INSERT INTO gotchu.customer_targets(organization_id,application_id,id,origin,version,status,consent_actor,consent_at,challenge_hash,challenge_expires_at,verified_at,expires_at)
          VALUES($1,$2,$3,'https://legacy.example',4,$4,$5,clock_timestamp()-interval '1 day',repeat('b',64),clock_timestamp()+interval '1 day',$6,$7)`,
        [f.a.organizationId, applicationId, target.id, target.status, target.actor, verifiedAt, expiresAt]);
      }

      const migration = await readFile(new URL('../migrations/052_requested_https_scope.sql', import.meta.url), 'utf8');
      await f.admin.query(migration);
      const rows = await f.admin.query<{ id: string; status: string; origin: string; version: number; requested_by: string; authorized_at: Date | null; expires_at: Date | null }>(
        'SELECT id,status,origin,version,requested_by,authorized_at,expires_at FROM gotchu.customer_targets WHERE id=ANY($1::uuid[]) ORDER BY requested_by',
        [cases.map(item => item.id)]);
      expect(rows.rows).toHaveLength(3);
      const verified = rows.rows.find(row => row.requested_by === 'legacy:verified');
      expect(verified).toMatchObject({ status: 'authorized', origin: 'https://legacy.example', version: 4 });
      expect(verified?.authorized_at).toBeInstanceOf(Date);
      expect(verified?.expires_at).toBeInstanceOf(Date);
      const pending = rows.rows.find(row => row.requested_by === 'legacy:pending');
      expect(pending).toMatchObject({ status: 'revoked', authorized_at: null, expires_at: null, version: 4 });
      const revoked = rows.rows.find(row => row.requested_by === 'legacy:revoked');
      expect(revoked).toMatchObject({ status: 'revoked', authorized_at: null, expires_at: null, version: 4 });
      const columns = await f.admin.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema='gotchu' AND table_name='customer_targets'`);
      expect(columns.rows.map(row => row.column_name)).not.toEqual(expect.arrayContaining(['challenge_hash', 'challenge_expires_at', 'verified_at', 'consent_actor', 'consent_at']));
    } finally {
      await f.admin.query('ROLLBACK');
    }
  });
});
