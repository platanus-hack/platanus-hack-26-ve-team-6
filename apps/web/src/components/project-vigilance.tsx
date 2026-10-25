import type { CustomerSourceSummary, CustomerTarget } from '@gotchu/contracts';
import { OperationsPanel } from './operations-panel';
import { ProtectionPanel } from './protection-panel';
import { NotificationsPanel } from './notifications-panel';
import { IncidentList } from './incident-card';
import { InvestigationsTimeline } from './investigations-panel';

export function ProjectVigilance({ userId, organizationId, projectId, sources, targets, canManage, archived }: {
  userId: string;
  organizationId: string;
  projectId: string;
  sources: CustomerSourceSummary[];
  targets: CustomerTarget[];
  canManage: boolean;
  archived: boolean;
}) {
  const canOperate = canManage && !archived;
  return <>
    <OperationsPanel key={`${userId}:${organizationId}:${projectId}`} userId={userId} organizationId={organizationId} applicationId={projectId} sources={sources} targets={targets} canManage={canOperate} />
    <ProtectionPanel key={`${userId}:${organizationId}:${projectId}:protection`} scope={{ organizationId, applicationId: projectId }} canManage={canOperate} />
    <InvestigationsTimeline organizationId={organizationId} applicationId={projectId} canManage={canOperate} />
    <IncidentList organizationId={organizationId} applicationId={projectId} canManage={canOperate} />
    <NotificationsPanel key={`${userId}:${organizationId}:${projectId}:notifications`} userId={userId} organizationId={organizationId} applicationId={projectId} canManage={canOperate} />
  </>;
}
