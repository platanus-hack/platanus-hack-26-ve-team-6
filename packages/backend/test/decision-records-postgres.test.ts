import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from '../../database/test/support.js';
import { createBackend, type Backend } from '../src/index.js';

const live = liveUrl ? describe : describe.skip;
live('customer decision records with real Postgres tenant RLS', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  let api: Backend;

  beforeAll(async () => { f = await fixture(); api = createBackend({ database: f.databases.gotchu_api }); }, 30_000);
  afterAll(async () => { await f?.close(); });

  async function insertRecord(organizationId: string, input: {
    actorId?: string; action: string; subjectId?: string | null; detail?: Record<string, unknown>; createdAt?: Date;
  }) {
    const id = randomUUID();
    await f.admin.query(`INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail,created_at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,COALESCE($7,clock_timestamp()))`, [organizationId, id, input.actorId ?? f.a.userId,
      input.action, input.subjectId ?? null, JSON.stringify(input.detail ?? {}), input.createdAt ?? null]);
    return id;
  }

  it('allows workspace readers, denies another workspace, and scopes subject filters to the selected tenant', async () => {
    const viewerId = `viewer:${randomUUID()}`;
    await f.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [f.a.organizationId, viewerId]);
    const ownSubject = randomUUID();
    const otherSubject = randomUUID();
    await insertRecord(f.a.organizationId, { action: 'alert.acknowledged', subjectId: ownSubject });
    await insertRecord(f.b.organizationId, { action: 'alert.acknowledged', subjectId: otherSubject });

    await expect(api.decisionRecords.list({ userId: viewerId }, { organizationId: f.a.organizationId, subjectType: 'alert', subjectId: ownSubject }))
      .resolves.toMatchObject({ records: [{ subject: { type: 'alert', id: ownSubject } }] });
    await expect(api.decisionRecords.list({ userId: f.a.userId }, { organizationId: f.b.organizationId }))
      .rejects.toMatchObject({ status: 403 });
    await expect(api.decisionRecords.list({ userId: f.a.userId }, { organizationId: f.a.organizationId, subjectType: 'alert', subjectId: otherSubject }))
      .resolves.toEqual({ records: [], nextCursor: null });
  });

  it('enforces the maximum page size and returns older records through a stable keyset cursor', async () => {
    const createdAt = new Date('2026-10-24T12:00:00.000Z');
    const ids = await Promise.all(Array.from({ length: 53 }, () => insertRecord(f.a.organizationId, { action: 'future.audit_action', createdAt })));
    const first = await api.decisionRecords.list({ userId: f.a.userId }, { organizationId: f.a.organizationId, subjectType: 'other', limit: 50 });
    expect(first.records).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(api.decisionRecords.list({ userId: f.a.userId }, { organizationId: f.a.organizationId, subjectType: 'other', limit: 51 }))
      .rejects.toMatchObject({ code: 'invalid_input' });

    const second = await api.decisionRecords.list({ userId: f.a.userId }, { organizationId: f.a.organizationId, subjectType: 'other', limit: 50, cursor: first.nextCursor ?? undefined });
    const returnedIds = [...first.records, ...second.records].map(record => record.id);
    expect(second.records).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(new Set(returnedIds).size).toBe(53);
    expect(returnedIds).toEqual(expect.arrayContaining(ids));
  });

  it('redacts raw details, actor IDs, and unknown action details from the customer DTO', async () => {
    await f.admin.query('UPDATE gotchu.memberships SET email=$3 WHERE organization_id=$1 AND user_id=$2', [f.a.organizationId, f.a.userId, 'owner@example.test']);
    await insertRecord(f.a.organizationId, {
      action: 'target.enrolled', subjectId: f.a.integrationId,
      detail: { credential: 'credential-secret', apiKey: 'api-secret', ip: '192.0.2.45', internalNote: 'private' },
    });
    await insertRecord(f.a.organizationId, {
      actorId: 'future-worker', action: 'future.audit_action', detail: { token: 'unknown-action-secret' },
    });

    const page = await api.decisionRecords.list({ userId: f.a.userId }, { organizationId: f.a.organizationId, subjectType: 'target', limit: 10 });
    const unknown = await api.decisionRecords.list({ userId: f.a.userId }, { organizationId: f.a.organizationId, subjectType: 'other', limit: 10 });
    const serialized = JSON.stringify({ page, unknown });
    expect(serialized).not.toContain('credential-secret');
    expect(serialized).not.toContain('api-secret');
    expect(serialized).not.toContain('192.0.2.45');
    expect(serialized).not.toContain('unknown-action-secret');
    expect(serialized).not.toContain(f.a.userId);
    expect(page.records).toEqual([expect.objectContaining({ actor: { kind: 'member', displayName: 'owner@example.test' }, action: 'target.enrolled', subject: { type: 'target', id: f.a.integrationId } })]);
    expect(unknown.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: { kind: 'member', displayName: 'Miembro anterior' }, action: 'future.audit_action', summary: 'Esta actividad quedó registrada en el historial del espacio.', subject: { type: 'other' } }),
    ]));
  });
});
