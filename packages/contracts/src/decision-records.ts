import { z } from 'zod';

const uuid = z.uuid().transform(value => value.toLowerCase());
const timestamp = z.iso.datetime().refine(value => !value.startsWith('0000-'));

export const decisionRecordSubjectTypeSchema = z.enum([
  'workspace', 'application', 'alert', 'plan', 'action', 'execution', 'report', 'assessment',
  'target', 'source', 'correction', 'member', 'invitation', 'integration', 'event_batch',
  'incident', 'operation', 'validation', 'credential', 'model', 'environment', 'service',
  'repository', 'deployment', 'dependency', 'origin', 'other',
]);
export const decisionRecordOutcomeSchema = z.enum([
  'recorded', 'requested', 'acknowledged', 'resolved', 'approved', 'rejected', 'cancelled',
  'completed', 'failed', 'uncertain', 'changed', 'unknown',
]);
export const decisionRecordActionSchema = z.enum([
  'workspace.created', 'application.created', 'application.updated',
  'target.enrolled', 'target.verified', 'target.revoked', 'source.uploaded', 'source.deleted',
  'assessment.queued', 'assessment.recorded', 'customer_assessment.queued', 'customer_assessment.recorded', 'report.download_requested',
  'monitor.configured', 'monitor.materialized', 'alert.acknowledged', 'alert.resolved',
  'operation_plan.created', 'operation_plan.preparation_requested', 'operation_plan.attested',
  'proposal.created', 'proposal.approved', 'proposal.invalidated', 'action.proposed', 'action.approved', 'action.cancelled', 'action.rejected',
  'execution.claimed', 'execution.succeeded', 'execution.failed', 'execution.uncertain', 'execution.reconciled',
  'correction.prepared', 'validation.suite_configured', 'step_up.factor_enrolled', 'step_up.factor_revoked',
  'events.connected', 'events.disabled', 'events.accepted',
  'triage.status_changed', 'triage.evidence_requested', 'triage.probe_route_declared',
  'context.environment_created', 'context.environment_updated', 'context.environment_archived',
  'context.service_created', 'context.service_updated', 'context.repository_linked', 'context.repository_revoked',
  'context.repository_write_access_granted', 'context.repository_write_access_revoked',
  'context.deployment_created', 'context.dependency_created', 'context.origin_created',
  'member.invitation_created', 'member.invitation_revoked', 'member.invitation_accepted', 'member.role_changed', 'member.removed',
  'model.settled', 'unknown',
]);

/** A customer-safe projection of one workspace audit row. It deliberately has no raw detail or actor ID. */
export const decisionRecordSchema = z.object({
  id: uuid,
  actor: z.object({ kind: z.enum(['member', 'system']), displayName: z.string().min(1).max(254) }).strict(),
  action: decisionRecordActionSchema,
  subject: z.object({ type: decisionRecordSubjectTypeSchema, id: uuid.nullable() }).strict(),
  createdAt: timestamp,
  outcome: decisionRecordOutcomeSchema,
  summary: z.string().min(1).max(300),
}).strict();

export const decisionRecordQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional(),
  subjectType: decisionRecordSubjectTypeSchema.optional(),
  subjectId: uuid.optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
}).strict().refine(value => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to), {
  message: 'The start time must not be after the end time', path: ['from'],
});

export const decisionRecordPageSchema = z.object({
  records: z.array(decisionRecordSchema).max(50),
  nextCursor: z.string().max(200).nullable(),
}).strict();

export type DecisionRecord = z.infer<typeof decisionRecordSchema>;
export type DecisionRecordAction = z.infer<typeof decisionRecordActionSchema>;
export type DecisionRecordQuery = z.infer<typeof decisionRecordQuerySchema>;
export type DecisionRecordPage = z.infer<typeof decisionRecordPageSchema>;
