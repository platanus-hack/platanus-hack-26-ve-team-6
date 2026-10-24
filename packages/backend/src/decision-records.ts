import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { decisionRecordActionSchema, decisionRecordPageSchema, decisionRecordQuerySchema, decisionRecordSchema, decisionRecordSubjectTypeSchema, type DecisionRecordPage } from '@gotchu/contracts';
import { authorize, BackendError, parse, type BaseDependencies, type Identity } from './core.js';

const inputSchema = z.object({ organizationId: z.uuid(), ...decisionRecordQuerySchema.shape }).strict()
  .refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), { message: 'Invalid time range' });
const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).strict();
const rowSchema = z.object({
  id: z.string(), actor_id: z.string(), actor_email: z.string().nullable(), action: z.string().min(1).max(256),
  subject_id: z.string().nullable(), subject_type: decisionRecordSubjectTypeSchema, created_at: z.iso.datetime(),
}).strict();
const systemActorNames: Record<string, string> = {
  coordinator: 'Sistema de evaluación',
  'independent-verifier': 'Verificador independiente',
  'trusted-preparer': 'Preparador de acciones',
  executor: 'Ejecutor de acciones',
  'model-gateway': 'Gestión de modelos',
};
const subjectCase = `CASE
  WHEN action = 'workspace.created' THEN 'workspace'
  WHEN action LIKE 'alert.%' THEN 'alert'
  WHEN action LIKE 'operation_plan.%' THEN 'plan'
  WHEN action LIKE 'action.%' OR action LIKE 'proposal.%' THEN 'action'
  WHEN action LIKE 'execution.%' THEN 'execution'
  WHEN action IN ('assessment.recorded','customer_assessment.recorded','report.download_requested') THEN 'report'
  WHEN action IN ('assessment.queued','customer_assessment.queued') THEN 'assessment'
  WHEN action LIKE 'target.%' THEN 'target'
  WHEN action LIKE 'source.%' THEN 'source'
  WHEN action LIKE 'correction.%' THEN 'correction'
  WHEN action LIKE 'member.invitation_%' THEN 'invitation'
  WHEN action LIKE 'member.%' THEN 'member'
  WHEN action IN ('events.connected','events.disabled') THEN 'integration'
  WHEN action = 'events.accepted' THEN 'event_batch'
  WHEN action LIKE 'triage.%' AND action <> 'triage.probe_route_declared' THEN 'incident'
  WHEN action LIKE 'monitor.%' OR action = 'triage.probe_route_declared' THEN 'operation'
  WHEN action LIKE 'validation.%' THEN 'validation'
  WHEN action LIKE 'step_up.%' THEN 'credential'
  WHEN action LIKE 'model.%' THEN 'model'
  WHEN action LIKE 'context.environment_%' THEN 'environment'
  WHEN action LIKE 'context.service_%' THEN 'service'
  WHEN action LIKE 'context.repository_%' THEN 'repository'
  WHEN action LIKE 'context.deployment_%' THEN 'deployment'
  WHEN action LIKE 'context.dependency_%' THEN 'dependency'
  WHEN action LIKE 'context.origin_%' THEN 'origin'
  WHEN action LIKE 'application.%' THEN 'application'
  ELSE 'other'
END`;

function decodeCursor(value: string | undefined) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('Invalid base64url');
    const payload: unknown = JSON.parse(decoded.toString('utf8'));
    return cursorSchema.parse(payload);
  } catch (cause) {
    throw new BackendError('invalid_input', 'Decision history cursor is invalid', 400, { cause });
  }
}

function outcomeFor(action: string) {
  if (action === 'alert.acknowledged') return 'acknowledged';
  if (action === 'alert.resolved') return 'resolved';
  if (action === 'correction.prepared') return 'requested';
  if (action.endsWith('.approved')) return 'approved';
  if (action.endsWith('.rejected')) return 'rejected';
  if (action.endsWith('.cancelled')) return 'cancelled';
  if (action.endsWith('.failed')) return 'failed';
  if (action.endsWith('.uncertain')) return 'uncertain';
  if (action === 'execution.succeeded') return 'completed';
  if (action.endsWith('.queued') || action.endsWith('.requested') || action.endsWith('.proposed')) return 'requested';
  if (action.endsWith('.updated') || action.endsWith('.revoked') || action.endsWith('.disabled') || action.endsWith('.deleted') || action.endsWith('.removed') || action.endsWith('.changed') || action.endsWith('.archived') || action.endsWith('.invalidated')) return 'changed';
  if (action.endsWith('.reconciled') || action.endsWith('.settled')) return 'completed';
  if (action.endsWith('.created') || action.endsWith('.recorded') || action.endsWith('.configured') || action.endsWith('.prepared') || action.endsWith('.attested') || action.endsWith('.enrolled') || action.endsWith('.verified') || action.endsWith('.accepted') || action.endsWith('.uploaded') || action.endsWith('.connected') || action.endsWith('.claimed') || action.endsWith('.materialized')) return 'recorded';
  return 'unknown';
}

function summaryFor(action: string) {
  const summaries: Record<string, string> = {
    'workspace.created': 'Se creó el espacio de trabajo.',
    'alert.acknowledged': 'Una persona reconoció esta alerta.',
    'alert.resolved': 'Una persona marcó esta alerta como resuelta.',
    'operation_plan.created': 'Se creó una guía de revisión para la aplicación.',
    'operation_plan.preparation_requested': 'Se solicitó preparar los siguientes pasos de la guía.',
    'operation_plan.attested': 'Se registró una declaración del equipo en la guía.',
    'member.invitation_created': 'Se invitó a una persona al espacio de trabajo.',
    'member.invitation_revoked': 'Se revocó una invitación al espacio de trabajo.',
    'member.invitation_accepted': 'Una persona aceptó la invitación al espacio de trabajo.',
    'member.role_changed': 'Se modificó el rol de una persona miembro.',
    'member.removed': 'Se retiró a una persona del espacio de trabajo.',
    'source.uploaded': 'Se cargó una instantánea privada de código.',
    'source.deleted': 'Se eliminó una instantánea privada de código.',
    'assessment.queued': 'Se solicitó una evaluación del alcance autorizado.',
    'assessment.recorded': 'Se registró un informe de evaluación.',
    'customer_assessment.queued': 'Se solicitó una evaluación del alcance autorizado.',
    'customer_assessment.recorded': 'Se registró un informe de evaluación.',
    'report.download_requested': 'Se solicitó una copia JSON del informe.',
    'correction.prepared': 'Se solicitó preparar una corrección privada y su reanálisis.',
    'context.repository_write_access_granted': 'Un Owner verificó y concedió escritura al Writer App para un repositorio.',
    'context.repository_write_access_revoked': 'Un Owner revocó el permiso de escritura del Writer App para un repositorio.',
  };
  if (summaries[action]) return summaries[action];
  if (action.startsWith('application.')) return 'Se actualizó la configuración de una aplicación.';
  if (action.startsWith('target.')) return 'Se cambió el estado de una autorización HTTPS.';
  if (action.startsWith('events.')) return 'Se cambió la conexión de eventos de una aplicación.';
  if (action.startsWith('context.')) return 'Se actualizó el inventario declarado de la aplicación.';
  if (action.startsWith('step_up.')) return 'Se cambió la configuración de verificación en dos pasos.';
  if (action.startsWith('action.') || action.startsWith('proposal.')) return 'Se registró un cambio en una propuesta o aprobación.';
  if (action.startsWith('execution.')) return 'Se registró un resultado de ejecución.';
  if (action.startsWith('triage.')) return 'Se actualizó el seguimiento de un incidente.';
  if (action.startsWith('validation.')) return 'Se actualizó la configuración de validación.';
  if (action.startsWith('monitor.')) return 'Se actualizó la configuración de vigilancia.';
  return 'Esta actividad quedó registrada en el historial del espacio.';
}

function displayActor(actorId: string, email: string | null, currentUserId: string) {
  if (email) return { kind: 'member' as const, displayName: email };
  if (actorId === currentUserId) return { kind: 'member' as const, displayName: 'Tú' };
  const systemName = systemActorNames[actorId] ?? (actorId.startsWith('integration:') ? 'Integración de eventos' : null);
  if (systemName) return { kind: 'system' as const, displayName: systemName };
  return { kind: 'member' as const, displayName: 'Miembro anterior' };
}

function encodeCursor(createdAt: string, id: string) {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
}

export function createDecisionRecordService(deps: BaseDependencies) {
  return {
    async list(identity: Identity, input: z.input<typeof inputSchema>): Promise<DecisionRecordPage> {
      const value = parse(inputSchema, input);
      const cursor = decodeCursor(value.cursor);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity);
        const result = await tx.query(`SELECT a.id,a.actor_id,m.email AS actor_email,a.action,a.subject_id,(${subjectCase}) AS subject_type,
            to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
          FROM gotchu.audit_records a
          LEFT JOIN gotchu.memberships m ON m.organization_id=a.organization_id AND m.user_id=a.actor_id
          WHERE a.organization_id=$1
            AND ($2::text IS NULL OR (${subjectCase})=$2)
            AND ($3::uuid IS NULL OR a.subject_id=$3)
            AND ($4::timestamptz IS NULL OR a.created_at >= $4)
            AND ($5::timestamptz IS NULL OR a.created_at <= $5)
            AND ($6::timestamptz IS NULL OR (a.created_at,a.id) < ($6::timestamptz,$7::uuid))
          ORDER BY a.created_at DESC,a.id DESC LIMIT $8`, [value.organizationId, value.subjectType ?? null,
          value.subjectId ?? null, value.from ?? null, value.to ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, value.limit + 1]);
        const rows = result.rows.map(row => rowSchema.parse(row));
        const hasMore = rows.length > value.limit;
        const records = rows.slice(0, value.limit).map(row => {
          const parsedAction = decisionRecordActionSchema.safeParse(row.action);
          const action = parsedAction.success ? parsedAction.data : 'unknown';
          return decisionRecordSchema.parse({
            id: row.id,
            actor: displayActor(row.actor_id, row.actor_email, identity.userId),
            action,
            subject: { type: row.subject_type, id: row.subject_id },
            createdAt: row.created_at,
            outcome: outcomeFor(action),
            summary: summaryFor(action),
          });
        });
        const cursorRow = rows[value.limit - 1];
        return decisionRecordPageSchema.parse({ records, nextCursor: hasMore && cursorRow
          ? encodeCursor(cursorRow.created_at, cursorRow.id) : null });
      });
    },
  };
}
