import { DecisionRecordHistory } from './decision-record-history';
import { LicensePolicyPanel, RetentionPolicyPanel } from './customer-supply-chain';
import { InvestigationModelSettings } from './investigations-panel';
import { MembersPanel } from './members-panel';
import { McpTokensPanel } from './mcp-tokens-panel';
import { PageHeader } from './dashboard-sidebar';

type WorkspacePage = 'members' | 'decision-records' | 'license-policy' | 'retention-policy' | 'investigation-model' | 'assistants';

export function WorkspacePages({ page, userId, organizationId, role, canManage }: {
  page: WorkspacePage;
  userId: string;
  organizationId: string;
  role: 'owner' | 'operator' | 'viewer';
  canManage: boolean;
}) {
  if (page === 'investigation-model') return <>
    <PageHeader title="Modelos de IA" description="Qué modelo investiga y corrige los hallazgos, y qué datos puede recibir." />
    <InvestigationModelSettings key={`${userId}:${organizationId}`} organizationId={organizationId} isOwner={role === 'owner'} />
  </>;
  if (page === 'assistants') return <>
    <PageHeader title="MCP" description="Consulta los hallazgos y alertas de este espacio desde Claude, Codex o tu IDE." />
    <McpTokensPanel key={`${userId}:${organizationId}`} userId={userId} organizationId={organizationId} />
  </>;
  if (page === 'members') return <>
    <PageHeader title="Equipo" description="Quién tiene acceso a este espacio de trabajo y con qué rol." />
    <MembersPanel key={`${userId}:${organizationId}`} organizationId={organizationId} userId={userId} role={role} />
  </>;
  if (page === 'decision-records') return <>
    <PageHeader title="Decisiones" description="Registro de lo que se solicitó, aprobó o cambió en este espacio de trabajo." />
    <DecisionRecordHistory userId={userId} organizationId={organizationId} />
  </>;
  if (page === 'license-policy') return <>
    <PageHeader title="Licencias" description="Qué licencias de dependencias se permiten, se deniegan o requieren revisión." />
    <LicensePolicyPanel key={`${userId}:${organizationId}`} userId={userId} organizationId={organizationId} canManage={canManage} />
  </>;
  return <>
    <PageHeader title="Retención" description="Cuántos días se conservan el código, los informes y el resto de datos." />
    <RetentionPolicyPanel key={`${userId}:${organizationId}`} userId={userId} organizationId={organizationId} isOwner={role === 'owner'} />
  </>;
}
