import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { DecisionRecord } from '@gotchu/contracts';
import { customerApi } from './customer-client';

type SubjectType = DecisionRecord['subject']['type'];
type Filter = { subjectType: SubjectType; subjectId: string };

const actionLabels: Record<DecisionRecord['action'], string> = {
  'workspace.created': 'Creó el espacio de trabajo',
  'application.created': 'Añadió un proyecto', 'application.updated': 'Actualizó un proyecto',
  'target.enrolled': 'Solicitó evaluar un origen HTTPS', 'target.verified': 'Comprobó el TXT de un origen HTTPS', 'target.revoked': 'Quitó un origen del alcance',
  'source.uploaded': 'Subió una instantánea de código', 'source.deleted': 'Eliminó una instantánea de código',
  'assessment.queued': 'Solicitó una evaluación', 'assessment.recorded': 'Se generó un informe',
  'customer_assessment.queued': 'Solicitó una evaluación', 'customer_assessment.recorded': 'Se generó un informe', 'report.download_requested': 'Solicitó descargar un informe',
  'monitor.configured': 'Actualizó la vigilancia', 'monitor.materialized': 'Se preparó una evaluación de vigilancia',
  'alert.acknowledged': 'Reconoció una alerta', 'alert.resolved': 'Marcó una alerta como resuelta',
  'operation_plan.created': 'Creó una guía de revisión', 'operation_plan.preparation_requested': 'Solicitó preparar una guía', 'operation_plan.attested': 'Registró una declaración en una guía',
  'proposal.created': 'Se preparó una propuesta de acción', 'proposal.approved': 'Aprobó una propuesta de acción', 'proposal.invalidated': 'Se invalidó una propuesta de acción',
  'action.proposed': 'Propuso una acción', 'action.approved': 'Aprobó una acción', 'action.cancelled': 'Canceló una propuesta', 'action.rejected': 'Rechazó una propuesta',
  'execution.claimed': 'Se inició la ejecución de una acción', 'execution.succeeded': 'La ejecución informó éxito', 'execution.failed': 'La ejecución informó un fallo',
  'execution.uncertain': 'La ejecución quedó sin confirmar', 'execution.reconciled': 'Se reconcilió el resultado de una ejecución',
  'correction.prepared': 'Solicitó preparar una corrección privada', 'validation.suite_configured': 'Configuró una suite de validación',
  'step_up.factor_enrolled': 'Añadió un método de verificación', 'step_up.factor_revoked': 'Revocó un método de verificación',
  'events.connected': 'Conectó eventos de el proyecto', 'events.disabled': 'Desactivó eventos de el proyecto', 'events.accepted': 'Se recibieron eventos firmados',
  'triage.status_changed': 'Actualizó el estado de un incidente', 'triage.evidence_requested': 'Solicitó actualizar evidencia de vigilancia', 'triage.probe_route_declared': 'Declaró una ruta de interés',
  'context.environment_created': 'Añadió un entorno', 'context.environment_updated': 'Actualizó un entorno', 'context.environment_archived': 'Archivó un entorno',
  'context.service_created': 'Añadió un servicio', 'context.service_updated': 'Actualizó un servicio',
  'context.repository_linked': 'Vinculó un repositorio', 'context.repository_revoked': 'Revocó un repositorio', 'context.deployment_created': 'Registró un despliegue',
  'context.repository_write_access_granted': 'Concedió escritura al Writer App', 'context.repository_write_access_revoked': 'Revocó la escritura del Writer App',
  'context.dependency_created': 'Declaró una dependencia', 'context.origin_created': 'Declaró un origen',
  'member.invitation_created': 'Invitó a una persona', 'member.invitation_revoked': 'Revocó una invitación', 'member.invitation_accepted': 'Se aceptó una invitación',
  'member.role_changed': 'Cambió el rol de una persona', 'member.removed': 'Retiró a una persona del espacio',
  'model.settled': 'Se cerró el uso de un modelo',
  unknown: 'Actividad registrada',
};
const outcomeLabels: Record<DecisionRecord['outcome'], string> = {
  recorded: 'Registrado', requested: 'Solicitado', acknowledged: 'Reconocido', resolved: 'Resuelto', approved: 'Aprobado', rejected: 'Rechazado',
  cancelled: 'Cancelado', completed: 'Completado', failed: 'Fallido', uncertain: 'Sin confirmar', changed: 'Actualizado', unknown: 'Sin resultado',
};
const subjectLabels: Record<SubjectType, string> = {
  workspace: 'Espacio de trabajo', application: 'Proyecto', alert: 'Alerta', plan: 'Guía de operación', action: 'Propuesta o acción',
  execution: 'Ejecución', report: 'Informe', assessment: 'Evaluación', target: 'Origen HTTPS', source: 'Instantánea de código', correction: 'Corrección',
  member: 'Miembro', invitation: 'Invitación', integration: 'Integración', event_batch: 'Lote de eventos', incident: 'Incidente', operation: 'Vigilancia',
  validation: 'Validación', credential: 'Verificación', model: 'Modelo', environment: 'Entorno', service: 'Servicio', repository: 'Repositorio',
  deployment: 'Despliegue', dependency: 'Dependencia', origin: 'Origen declarado', other: 'Otro asunto',
};

function actionLabel(action: DecisionRecord['action']) {
  return actionLabels[action];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function DecisionRecordHistory({ userId, organizationId, filter, compact = false }: { userId: string; organizationId: string; filter?: Filter; compact?: boolean }) {
  const [expanded, setExpanded] = useState(!compact);
  const query = useInfiniteQuery({
    queryKey: ['customer-data', userId, 'decision-records', organizationId, filter?.subjectType, filter?.subjectId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => customerApi.decisionRecords(organizationId, {
      limit: compact ? 5 : 25,
      ...(pageParam ? { cursor: pageParam } : {}),
      ...(filter ? { subjectType: filter.subjectType, subjectId: filter.subjectId } : {}),
    }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: expanded,
    retry: false,
  });

  const records = query.data?.pages.flatMap(page => page.records) ?? [];
  const content = <div className={compact ? 'customer-decision-history-content is-compact' : 'customer-decision-history-content'}>
    {query.isPending ? <div className="customer-loading" role="status"><span className="customer-spinner" />Cargando el historial…</div>
      : records.length === 0 && query.error ? <div className="customer-inline-error" role="alert">No se pudo cargar el historial. <button className="customer-link-button" type="button" onClick={() => { query.refetch().catch(() => undefined); }}>Reintentar</button></div>
        : records.length === 0 ? <div className="customer-empty-inline">Todavía no hay decisiones registradas en este espacio.</div>
          : <ol className="customer-decision-record-list">{records.map(record => <li className="customer-decision-record" key={record.id}>
            <div className="customer-decision-record-heading"><div><strong>{actionLabel(record.action)}</strong><small>{record.actor.displayName} · {formatDate(record.createdAt)}</small></div><span className="customer-status customer-status-muted">{outcomeLabels[record.outcome]}</span></div>
            <p>{record.summary}</p><small className="customer-decision-subject">Asunto: {subjectLabels[record.subject.type]}</small>
          </li>)}</ol>}
    {query.error && records.length > 0 && <div className="customer-inline-error" role="alert">No se pudieron cargar más registros. <button className="customer-link-button" type="button" onClick={() => { query.fetchNextPage().catch(() => undefined); }}>Reintentar</button></div>}
    {query.hasNextPage && !query.error && <button className="customer-button customer-button-secondary customer-decision-more" type="button" disabled={query.isFetchingNextPage} onClick={() => { query.fetchNextPage().catch(() => undefined); }}>{query.isFetchingNextPage ? 'Cargando…' : 'Cargar registros anteriores'}</button>}
  </div>;

  if (compact) return <details className="customer-decision-inline" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Historial de esta decisión</summary>{expanded && content}
  </details>;
  return <section className="customer-card customer-decision-history"><div className="customer-card-heading"><div><h2>Historial de decisiones</h2></div></div>{content}</section>;
}
