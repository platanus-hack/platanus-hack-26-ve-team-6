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
    <OperationsPanel key={`${userId}:${organizationId}:${projectId}`} userId={userId} organizationId={organizationId} applicationId={projectId} sources={sources} targets={targets} canManage={canOperate}
      integrations={<>
        <details className="customer-settings-row"><summary><strong>Protección en ejecución</strong><small>Qué hacer con intentos de inyección o acceso indebido en los puntos integrados.</small></summary><ProtectionPanel key={`${userId}:${organizationId}:${projectId}:protection`} scope={{ organizationId, applicationId: projectId }} canManage={canOperate} /></details>
        <details className="customer-settings-row"><summary><strong>Notificaciones</strong><small>Correo o webhook para recibir alertas fuera de Gotchu.</small></summary><NotificationsPanel key={`${userId}:${organizationId}:${projectId}:notifications`} userId={userId} organizationId={organizationId} applicationId={projectId} canManage={canOperate} /></details>
      </>} />
    <InvestigationsTimeline organizationId={organizationId} applicationId={projectId} canManage={canOperate} />
    <IncidentList organizationId={organizationId} applicationId={projectId} canManage={canOperate} />
  </>;
}
