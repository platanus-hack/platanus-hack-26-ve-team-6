import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';

export async function grantGitHubWriteFixture(admin: pg.Client, tenant: { organizationId: string; applicationId: string; userId: string }, linkId: string) {
  const proposalId = randomUUID();
  const actionHash = randomBytes(32).toString('hex');
  await admin.query(`UPDATE gotchu.application_repository_links SET write_access='granted',
    writer_installation_id='991',writer_verified_at=now(),writer_verified_commit=$3
    WHERE organization_id=$1 AND id=$2`, [tenant.organizationId, linkId, 'a'.repeat(40)]);
  await admin.query(`INSERT INTO gotchu.proposals(organization_id,application_id,id,action_hash,body,recovery_epoch,version,kind,capability_id,state,blocking_reasons)
    VALUES($1,$2,$3,$4,$5::jsonb,1,2,'dependency_pull_request','repository.dependency_pr','approved','[]'::jsonb)`, [
    tenant.organizationId, tenant.applicationId, proposalId, actionHash, JSON.stringify({ target: { repositoryLinkId: linkId } }),
  ]);
  await admin.query(`INSERT INTO gotchu.approvals(organization_id,id,proposal_id,action_hash,user_id,proof_id,recovery_epoch,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,1,clock_timestamp()+interval '5 minutes')`, [tenant.organizationId, randomUUID(), proposalId, actionHash, tenant.userId, randomUUID()]);
  return proposalId;
}
