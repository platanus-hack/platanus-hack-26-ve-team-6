import { DecisionRecordHistory } from './decision-record-history';
import { LicensePolicyPanel, RetentionPolicyPanel } from './customer-supply-chain';
import { MembersPanel } from './members-panel';

type WorkspacePage = 'members' | 'decision-records' | 'license-policy' | 'retention-policy';

export function WorkspacePages({ page, userId, organizationId, role, canManage }: {
  page: WorkspacePage;
  userId: string;
  organizationId: string;
  role: 'owner' | 'operator' | 'viewer';
  canManage: boolean;
}) {
  if (page === 'members') return <MembersPanel key={`${userId}:${organizationId}`} organizationId={organizationId} userId={userId} role={role} />;
  if (page === 'decision-records') return <>
    <div className="customer-page-heading"><div><h1>Decisiones</h1></div></div>
    <DecisionRecordHistory userId={userId} organizationId={organizationId} />
  </>;
  if (page === 'license-policy') return <>
    <div className="customer-page-heading"><div><h1>Licencias</h1></div></div>
    <LicensePolicyPanel key={`${userId}:${organizationId}`} userId={userId} organizationId={organizationId} canManage={canManage} />
  </>;
  return <>
    <div className="customer-page-heading"><div><h1>Retención</h1></div></div>
    <RetentionPolicyPanel key={`${userId}:${organizationId}`} userId={userId} organizationId={organizationId} isOwner={role === 'owner'} />
  </>;
}
