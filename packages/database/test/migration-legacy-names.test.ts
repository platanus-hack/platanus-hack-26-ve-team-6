import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { fixture, liveUrl, present } from './support.js';

const legacy = [
  ['046_self_host_bootstrap_status.sql', '038_self_host_bootstrap_status.sql'],
  ['047_monitoring_quota_retention.sql', '041_monitoring_quota_retention.sql'],
  ['048_investigation_provider_presets.sql', '043_investigation_provider_presets.sql'],
  ['049_investigation_model_probes.sql', '044_investigation_model_probes.sql'],
] as const;

const live = liveUrl ? describe : describe.skip;
live('legacy migration filenames (GOTCHU_TEST_DATABASE_URL)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture(); }, 30_000);
  afterAll(async () => { await f?.close(); });

  it('recognizes old checksummed names after numbering collisions are fixed', async () => {
    const currentNames = legacy.map(([current]) => current);
    const rows = await f.admin.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM gotchu.schema_migrations WHERE name = ANY($1::text[])',
      [currentNames],
    );
    expect(rows.rows).toHaveLength(legacy.length);
    const checksums = new Map(rows.rows.map(row => [row.name, row.checksum]));

    await f.admin.query('BEGIN');
    try {
      await f.admin.query('DELETE FROM gotchu.schema_migrations WHERE name = ANY($1::text[])', [currentNames]);
      for (const [current, previous] of legacy) {
        const checksum = checksums.get(current);
        if (checksum === undefined) throw new Error(`Missing migration checksum: ${current}`);
        await f.admin.query('INSERT INTO gotchu.schema_migrations(name, checksum) VALUES ($1, $2)', [previous, checksum]);
      }
      await f.admin.query('COMMIT');
    } catch (error) {
      await f.admin.query('ROLLBACK');
      throw error;
    }

    await migrate({ connectionString: present(liveUrl) });
    const remaining = await f.admin.query<{ name: string }>(
      'SELECT name FROM gotchu.schema_migrations WHERE name = ANY($1::text[])',
      [currentNames],
    );
    expect(remaining.rows).toEqual([]);
  });
});
