import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixture, liveUrl } from './support.js';

const live = liveUrl ? describe : describe.skip;
live('Owner session approval constraints on real PostgreSQL', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => { f = await fixture(); });
  afterAll(async () => { await f?.close(); });

  async function proposal(version: 1 | 2, kind = 'dependency_pull_request') {
    const id = randomUUID();
    const hash = id.replaceAll('-','').repeat(2);
    await f.admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind)
      VALUES($1,$2,$3,$4,'{}',1,$5,$6)`,[f.a.organizationId,f.a.applicationId,id,hash,version,kind]);
    return {id,hash};
  }
  async function insert(p: {id:string;hash:string}, method: string | null, proofId: string | null) {
    return f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query(`
      INSERT INTO gotchu.approvals(organization_id,id,proposal_id,action_hash,user_id,recovery_epoch,expires_at,proof_id,authorization_method)
      VALUES($1,$2,$3,$4,$5,1,clock_timestamp()+interval '5 minutes',$6,coalesce($7,'step_up'))
      RETURNING authorization_method,proof_id`,[f.a.organizationId,randomUUID(),p.id,p.hash,f.a.userId,proofId,method]));
  }
  it('preserves legacy proof uniqueness and requires a proof on the legacy path', async () => {
    const p = await proposal(1);
    const proof = randomUUID();
    const legacy = await f.databases.gotchu_api.tenant(f.a.organizationId, tx => tx.query(`
      INSERT INTO gotchu.approvals(organization_id,id,proposal_id,action_hash,user_id,recovery_epoch,expires_at,proof_id)
      VALUES($1,$2,$3,$4,$5,1,clock_timestamp()+interval '5 minutes',$6)
      RETURNING authorization_method,proof_id`,[f.a.organizationId,randomUUID(),p.id,p.hash,f.a.userId,proof]));
    expect(legacy.rows).toEqual([{authorization_method:'step_up',proof_id:proof}]);
    await expect(insert(p,'step_up',proof)).rejects.toMatchObject({code:'23505'});
    await expect(insert(p,'step_up',null)).rejects.toMatchObject({code:'23514'});
    await expect(insert(p,'owner_session',null)).rejects.toThrow('owner_session_approval_requires_pr');
  });
  it('allows proof-free v2 PR approvals only and rejects fake proofs or unknown methods', async () => {
    for (const kind of ['source_patch_pull_request','dependency_pull_request']) {
      const p = await proposal(2,kind);
      expect((await insert(p,'owner_session',null)).rows).toEqual([{authorization_method:'owner_session',proof_id:null}]);
      await expect(insert(p,'owner_session',randomUUID())).rejects.toMatchObject({code:'23514'});
      await expect(insert(p,'automatic',null)).rejects.toMatchObject({code:'23514'});
      await expect(f.databases.gotchu_api.tenant(f.b.organizationId, tx => tx.query(
        'SELECT id FROM gotchu.approvals WHERE organization_id=$1 AND proposal_id=$2',[f.a.organizationId,p.id])))
        .resolves.toMatchObject({rowCount:0});
    }
    for (const kind of ['merge_pull_request','deploy_release','rollback_release','provider_response']) {
      await expect(insert(await proposal(2,kind),'owner_session',null)).rejects.toThrow('owner_session_approval_requires_pr');
    }
  });
});
