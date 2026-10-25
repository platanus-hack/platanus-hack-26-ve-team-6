import { randomUUID } from 'node:crypto';
import type { CustomerAssessmentReport } from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { audit, canonicalJson, sha256 } from './core.js';
import { enqueue } from './jobs.js';

const severity = { unknown: 0, informational: 0, low: 1, medium: 2, high: 3, critical: 4 };
const limit = 3;

/** Admission runs in the report transaction; only the durable worker can call a model. */
export async function enqueueAutomaticSourceInvestigations(tx: Transaction, report: CustomerAssessmentReport) {
  if (!report.internal || !report.subject.sourceSnapshotId) return;
  const eligible = report.internal.findings.filter(finding => severity[finding.severity] >= severity.medium && finding.evidenceIds.length > 0)
    .sort((a, b) => severity[b.severity] - severity[a.severity] || a.id.localeCompare(b.id));
  if (eligible.length === 0) return;
  const enabled = await tx.query(`SELECT 1 FROM gotchu.investigation_model_settings s
    JOIN gotchu.organizations o ON o.id=s.organization_id
    JOIN gotchu.applications a ON a.organization_id=o.id AND a.id=$2
    WHERE s.organization_id=$1 AND s.automatic_source_investigations AND s.consent_to_external_processing
      AND s.data_scopes ? 'finding_details' AND s.secret_ref IS NOT NULL AND o.model_opt_in AND NOT a.archived
      AND o.model_token_budget>o.model_tokens_spent+o.model_tokens_reserved
      AND o.model_budget_micros>o.model_spent_micros+o.model_reserved_micros`, [report.organizationId, report.applicationId]);
  if (!enabled.rowCount) return;
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`automatic-investigations:${report.organizationId}:${report.applicationId}`]);
  const active = await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM gotchu.jobs
    WHERE organization_id=$1 AND application_id=$2 AND kind='investigation' AND state IN ('queued','running')`, [report.organizationId, report.applicationId]);
  const available = Math.max(0, limit - Number(active.rows[0]?.count ?? 0));
  let added = 0;
  for (const finding of eligible) {
    if (added >= available) break;
    const payload = { version: 2 as const, subject: { kind: 'finding' as const, subjectId: finding.id, reportId: report.id }, evidenceIds: finding.evidenceIds.slice(0, 20) };
    const id = randomUUID();
    const jobId = await enqueue(tx, { organizationId: report.organizationId, applicationId: report.applicationId, id, kind: 'investigation',
      idempotencyKey: `investigate:finding:${finding.id}:${sha256(canonicalJson(payload))}`, payload });
    if (jobId !== id) continue;
    added += 1;
    await audit(tx, report.organizationId, 'coordinator', 'investigation.automatically_requested', jobId, {
      reportId: report.id, subjectId: finding.id, evidenceCount: payload.evidenceIds.length,
    });
  }
  await audit(tx, report.organizationId, 'coordinator', 'investigation.automatic_admission_completed', report.id, { added, eligibleCount: eligible.length, activeLimit: limit });
}
