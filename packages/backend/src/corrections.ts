import { z } from 'zod';
import { customerAssessmentIntentSchema, customerAssessmentReportSchema, customerRunInputSchema, customerScopeSchema, customerSourceSnapshotSchema, type CustomerAssessmentReport, type CustomerRunInput, type OsvAdvisoryMetadata, type DependencyFixRecommendation, dependencyFixPreparationRequestSchema, dependencyFixPreparationResponseSchema, type DependencyFixPreparationRequest, type DependencyFixPreparationResponse } from '@gotchu/contracts';
import type { Database, Transaction } from '@gotchu/database';
import { prepareCorrectionRequestSchema, type PrepareCorrectionResponse, type ReportRecommendationsResponse } from '@gotchu/scenarios/contracts';
import { buildRecipeRecommendations, correctionResponseForQueuedScan, prepareCandidatePatch, RecipeBoundaryError } from '@gotchu/scenarios/server';
import { audit, authorize, BackendError, canonicalJson, identitySchema, parse, sha256, type BaseDependencies, type Identity } from './core.js';
import { createCustomerService } from './customers.js';
import { createValidationService, enqueueValidation } from './validations.js';
import { createNpmRegistryAdapter, parseNpmAdvisoryEvidence, prepareNpmDependencyPatch, type NpmFixReason, type NpmRegistryPort } from './npm-dependency-fix.js';

export const correctionReportScopeSchema = customerScopeSchema.extend({ reportId: z.uuid() }).strict();
export const prepareCorrectionInputSchema = correctionReportScopeSchema.extend(prepareCorrectionRequestSchema.shape).strict();
export const prepareDependencyFixInputSchema = correctionReportScopeSchema.extend(dependencyFixPreparationRequestSchema.shape).strict();
export type CorrectionReportScope = z.infer<typeof correctionReportScopeSchema>;
export type PrepareCorrectionInput = z.infer<typeof prepareCorrectionInputSchema>;
export type PrepareDependencyFixInput = z.infer<typeof prepareDependencyFixInputSchema>;

export async function lockCorrectionApplication(tx: Transaction, scope: CorrectionReportScope) {
  const organization = await tx.query<{ exists: boolean }>('SELECT gotchu.lock_customer_organization($1) AS exists', [scope.organizationId]);
  if (!organization.rows[0]?.exists) throw new BackendError('not_found', 'Workspace not found', 404);
  const result = await tx.query<{ app: unknown }>('SELECT gotchu.lock_customer_application($1,$2) AS app', [scope.organizationId, scope.applicationId]);
  if (!result.rows[0]?.app) throw new BackendError('not_found', 'Application not found', 404);
  const app = parse(z.object({ name: z.string(), archived: z.boolean() }).strict(), result.rows[0].app);
  if (app.archived) throw new BackendError('application_archived', 'Restore the application before preparing corrections', 409);
}

function scopeMismatch(): never {
  throw new BackendError('assessment_scope_mismatch', 'Stored assessment does not match its canonical request and source', 409);
}

/** Historical reports use persisted intent, never the lease-only scanner hydration API. */
export async function loadAssessment(tx: Transaction, scope: CorrectionReportScope) {
  const result = await tx.query<{ body: unknown; job_id: string; input: unknown; payload: unknown; kind: string; source_id: string | null; target_id: string | null }>(`SELECT p.body,p.job_id,r.input,r.source_id,r.target_id,j.payload,j.kind
    FROM gotchu.customer_reports p
    JOIN gotchu.customer_requests r ON r.organization_id=p.organization_id AND r.application_id=p.application_id AND r.job_id=p.job_id
    JOIN gotchu.jobs j ON j.organization_id=r.organization_id AND j.application_id=r.application_id AND j.id=r.job_id
    WHERE p.organization_id=$1 AND p.application_id=$2 AND p.id=$3`, [scope.organizationId, scope.applicationId, scope.reportId]);
  const row = result.rows[0];
  if (!row) throw new BackendError('not_found', 'Report not found in this application', 404);
  const intent = parse(customerAssessmentIntentSchema, row.input);
  const report = parse(customerAssessmentReportSchema, row.body);
  if (row.kind !== 'audit' || canonicalJson(intent) !== canonicalJson(row.payload)
    || intent.organizationId !== scope.organizationId || intent.applicationId !== scope.applicationId || intent.jobId !== row.job_id
    || (intent.source?.id ?? null) !== row.source_id || (intent.target?.id ?? null) !== row.target_id
    || report.id !== scope.reportId || report.jobId !== row.job_id) scopeMismatch();
  let source = null;
  if (intent.source) {
    const sources = await tx.query<{ body: unknown; digest: string; deleted_at: Date | null }>(
      'SELECT body,digest,deleted_at FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3',
      [scope.organizationId, scope.applicationId, intent.source.id]);
    const stored = sources.rows[0];
    if (!stored || stored.deleted_at !== null || stored.body === null) throw new BackendError('source_unavailable', 'The original source snapshot is no longer available; the report remains readable', 409);
    const snapshot = parse(customerSourceSnapshotSchema, stored.body);
    if (stored.digest !== intent.source.digest || snapshot.revision !== intent.source.revision || sha256(canonicalJson(snapshot)) !== intent.source.digest) scopeMismatch();
    source = { ...snapshot, ...intent.source };
  }
  return { input: parse(customerRunInputSchema, { ...intent, source }), report };
}

function recipeBoundary<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof RecipeBoundaryError) throw new BackendError(error.code, 'Correction evidence or source digest does not match this assessment', 409, { cause: error });
    throw error;
  }
}

/** Only the current tenant transaction is available to the existing customer services. */
export function transactionDatabase(database: Pick<Database, 'role'>, organizationId: string, tx: Transaction): Database {
  const unavailable = async (): Promise<never> => { throw new Error('Correction transaction capability does not allow this operation'); };
  return {
    role: database.role,
    tenant: async (requestedOrganizationId, work) => {
      if (requestedOrganizationId !== organizationId) throw new BackendError('forbidden', 'Correction transaction cannot change tenant', 403);
      return work(tx);
    },
    integration: unavailable,
    system: unavailable,
    checkHealth: unavailable,
    close: unavailable,
  };
}

interface DependencyFindingGroup {
  packageName: string;
  fromVersion: string;
  location: string;
  relationship: 'direct' | 'transitive';
  findingIds: string[];
  withdrawnFindingIds: string[];
  advisoryIds: string[];
  withdrawnAdvisoryIds: string[];
  advisories: Array<OsvAdvisoryMetadata | null>;
}

interface DependencyCandidateRow {
  candidate_source_id: string;
  validation_run_id: string;
  package_name: string;
  from_version: string;
  to_version: string;
  patch_sha256: string;
  advisory_ids: unknown;
  validation_state: 'queued' | 'running' | 'passed' | 'failed' | 'inconclusive' | 'quarantined' | 'expired';
}

function dependencyFindingGroups(input: CustomerRunInput, report: CustomerAssessmentReport): DependencyFindingGroup[] {
  const internal = report.internal;
  if (!input.source || !internal) return [];
  const evidence = new Map(internal.evidence.filter(item => item.kind === 'advisory').map(item => [item.id, item]));
  const groups = new Map<string, DependencyFindingGroup>();
  for (const finding of internal.findings) {
    const advisoryId = /^osv\.([A-Za-z0-9._-]{1,128})$/.exec(finding.ruleId)?.[1];
    if (!advisoryId) continue;
    const sourceEvidence = finding.evidenceIds.flatMap(id => {
      const item = evidence.get(id);
      const parsed = item ? parseNpmAdvisoryEvidence(item.excerpt) : undefined;
      return parsed && item && sha256(item.excerpt) === item.checksum && parsed.sourceDigest === input.source?.digest ? [{ item, parsed }] : [];
    })[0];
    if (!sourceEvidence) continue;
    const { parsed, item } = sourceEvidence;
    if (parsed.id !== advisoryId || parsed.advisory && parsed.advisory.id !== advisoryId) continue;
    const key = `${parsed.packageName}\0${parsed.version}\0${parsed.location}`;
    const group = groups.get(key) ?? { packageName: parsed.packageName, fromVersion: parsed.version, location: parsed.location,
      relationship: parsed.relationship, findingIds: [], withdrawnFindingIds: [], advisoryIds: [], withdrawnAdvisoryIds: [], advisories: [] };
    const withdrawn = parsed.advisory?.withdrawn !== undefined && parsed.advisory.withdrawn !== null;
    if (withdrawn) {
      if (!group.withdrawnFindingIds.includes(finding.id)) group.withdrawnFindingIds.push(finding.id);
      if (!group.withdrawnAdvisoryIds.includes(advisoryId)) group.withdrawnAdvisoryIds.push(advisoryId);
    } else {
      if (!group.findingIds.includes(finding.id)) group.findingIds.push(finding.id);
      if (!group.advisoryIds.includes(advisoryId)) {
        group.advisoryIds.push(advisoryId);
        group.advisories.push(parsed.advisory);
      }
    }
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => left.packageName.localeCompare(right.packageName) || left.fromVersion.localeCompare(right.fromVersion)).slice(0, 20);
}

function hasCompleteNpmLockfileCoverage(report: CustomerAssessmentReport) {
  const internal = report.internal;
  const inventory = internal?.dependencyInventory;
  return inventory?.complete === true
    && internal?.coverage.some(item => item.capability === 'dependency_inventory' && item.state === 'inspected') === true
    && inventory.lockfiles.some(file => file.state === 'inspected' && (file.format === 'npm-v2' || file.format === 'npm-v3'));
}

function recommendation(group: DependencyFindingGroup, status: 'eligible' | 'guidance_only', reason: NpmFixReason | null, toVersion: string | null,
  candidate?: Pick<DependencyCandidateRow, 'candidate_source_id' | 'validation_run_id' | 'validation_state'>, diffSummary?: string | null): DependencyFixRecommendation {
  return {
    packageName: group.packageName, fromVersion: group.fromVersion, toVersion, relationship: group.relationship,
    findingIds: (group.findingIds.length ? group.findingIds : group.withdrawnFindingIds).slice(0, 20),
    advisoryIds: (group.advisoryIds.length ? group.advisoryIds : group.withdrawnAdvisoryIds).slice(0, 20),
    withdrawnAdvisoryIds: group.withdrawnAdvisoryIds.slice(0, 20), status, reason,
    diffSummary: diffSummary ?? (status === 'eligible' && toVersion ? `Actualizar package.json y package-lock.json para ${group.packageName} de ${group.fromVersion} a ${toVersion}.` : null),
    validationState: candidate?.validation_state ?? null,
    candidateSourceId: candidate?.candidate_source_id ?? null, validationRunId: candidate?.validation_run_id ?? null,
  };
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      output[index] = await work(item);
    }
  }));
  return output;
}

export function createCorrectionService(deps: BaseDependencies & { npmRegistry?: NpmRegistryPort }) {
  const validations = createValidationService(deps);
  const registry = deps.npmRegistry ?? createNpmRegistryAdapter();
  async function dependencyContext(tx: Transaction, scope: CorrectionReportScope) {
    const assessment = await loadAssessment(tx, scope);
    const source = assessment.input.source;
    const bindingResult = source ? await tx.query<{ repository_link_id: string; commit_sha: string; source_digest: string; repository_key: string; default_branch: string; revoked: boolean; read_access: string; state: string; github_connection_active: boolean }>(`SELECT b.repository_link_id,b.commit_sha,b.source_digest,l.repository_key,l.default_branch,l.revoked,l.read_access,l.state,
        coalesce(g.state='active',false) AS github_connection_active
      FROM gotchu.customer_source_repository_bindings b JOIN gotchu.application_repository_links l
        ON l.organization_id=b.organization_id AND l.application_id=b.application_id AND l.id=b.repository_link_id
      LEFT JOIN gotchu.github_installations g ON g.organization_id=l.organization_id AND g.installation_id=l.installation_id
      WHERE b.organization_id=$1 AND b.application_id=$2 AND b.source_id=$3`, [scope.organizationId, scope.applicationId, source.id]) : null;
    const prepared = await tx.query<DependencyCandidateRow>(`SELECT c.candidate_source_id,c.validation_run_id,c.package_name,c.from_version,c.to_version,c.patch_sha256,c.advisory_ids,v.state AS validation_state
      FROM gotchu.dependency_fix_candidates c JOIN gotchu.customer_sources s
        ON s.organization_id=c.organization_id AND s.application_id=c.application_id AND s.id=c.candidate_source_id AND s.deleted_at IS NULL
      JOIN gotchu.validation_runs v ON v.organization_id=c.organization_id AND v.application_id=c.application_id AND v.id=c.validation_run_id
      WHERE c.organization_id=$1 AND c.application_id=$2 AND c.report_id=$3`, [scope.organizationId, scope.applicationId, scope.reportId]);
    const binding = bindingResult?.rows[0];
    const suite = binding ? await tx.query<{ id: string }>(`SELECT id FROM gotchu.validation_suite_definitions
      WHERE organization_id=$1 AND application_id=$2 AND repository_link_id=$3 ORDER BY version DESC LIMIT 1`,
    [scope.organizationId, scope.applicationId, binding.repository_link_id]) : null;
    return { assessment, binding, validationSuiteConfigured: Boolean(suite?.rows[0]), candidates: prepared.rows };
  }
  async function dependencyFixes(identity: Identity, input: CorrectionReportScope) {
    const actor = parse(identitySchema, identity); const scope = parse(correctionReportScopeSchema, input);
    const context = await deps.database.tenant(scope.organizationId, async tx => {
      await authorize(tx, scope.organizationId, actor);
      await lockCorrectionApplication(tx, scope);
      return dependencyContext(tx, scope);
    });
    const groups = dependencyFindingGroups(context.assessment.input, context.assessment.report);
    const packages = new Map<string, Promise<unknown>>();
    const recommendations = await mapConcurrent(groups, 3, async group => {
      if (!group.advisoryIds.length) return recommendation(group, 'guidance_only', 'advisory_withdrawn', null);
      if (!context.assessment.input.source) return recommendation(group, 'guidance_only', 'source_incomplete', null);
      if (!context.binding || context.binding.source_digest !== context.assessment.input.source.digest || context.binding.commit_sha !== context.assessment.input.source.revision
        || context.binding.revoked || context.binding.read_access !== 'granted' || context.binding.state !== 'verified') return recommendation(group, 'guidance_only', 'source_not_repository_bound', null);
      if (!context.binding.github_connection_active) return recommendation(group, 'guidance_only', 'github_connection_unavailable', null);
      if (!context.validationSuiteConfigured) return recommendation(group, 'guidance_only', 'validation_suite_missing', null);
      if (group.relationship === 'transitive') return recommendation(group, 'guidance_only', 'transitive_override_not_supported', null);
      const internal = context.assessment.report.internal;
      const advisoryCoverage = internal?.coverage.find(item => item.capability === 'dependency_advisories')?.state;
      if (!hasCompleteNpmLockfileCoverage(context.assessment.report) || advisoryCoverage !== 'inspected') return recommendation(group, 'guidance_only', 'source_incomplete', null);
      const existing = context.candidates.find(candidate => candidate.package_name === group.packageName && candidate.from_version === group.fromVersion);
      if (existing) return recommendation(group, 'eligible', null, existing.to_version, existing);
      if (group.advisoryIds.length > 20 || group.advisories.length !== group.advisoryIds.length || group.advisories.some(item => item === null)) return recommendation(group, 'guidance_only', 'advisory_metadata_missing', null);
      let packument = packages.get(group.packageName);
      if (!packument) {
        packument = registry.getPackument(group.packageName, AbortSignal.timeout(8_500));
        packages.set(group.packageName, packument);
      }
      try {
        const metadata = await packument;
        const result = prepareNpmDependencyPatch({ source: context.assessment.input.source, name: group.packageName, fromVersion: group.fromVersion, location: group.location,
          advisories: group.advisories.filter((item): item is OsvAdvisoryMetadata => item !== null), packument: metadata });
        if (result.status === 'guidance_only') return recommendation(group, 'guidance_only', result.reason, null);
        return recommendation(group, 'eligible', null, result.toVersion);
      } catch {
        return recommendation(group, 'guidance_only', 'registry_unavailable', null);
      }
    });
    return recommendations;
  }
  async function reportRecommendations(identity: Identity, input: CorrectionReportScope): Promise<ReportRecommendationsResponse> {
    const actor = parse(identitySchema, identity); const scope = parse(correctionReportScopeSchema, input);
    const base = await deps.database.tenant(scope.organizationId, async tx => {
      await authorize(tx, scope.organizationId, actor);
      await lockCorrectionApplication(tx, scope);
      const assessment = await loadAssessment(tx, scope);
      return recipeBoundary(() => buildRecipeRecommendations(assessment.input, assessment.report));
    });
    return { ...base, dependencyFixes: await dependencyFixes(actor, scope) };
  }
  async function prepareDependencyFix(identity: Identity, input: PrepareDependencyFixInput): Promise<DependencyFixPreparationResponse> {
    const actor = parse(identitySchema, identity);
    const scope = parse(prepareDependencyFixInputSchema, input);
    const initial = await deps.database.tenant(scope.organizationId, async tx => {
      await authorize(tx, scope.organizationId, actor, ['owner', 'operator']);
      await lockCorrectionApplication(tx, scope);
      const context = await dependencyContext(tx, scope);
      const group = dependencyFindingGroups(context.assessment.input, context.assessment.report).find(item => item.findingIds.includes(scope.findingId) || item.withdrawnFindingIds.includes(scope.findingId));
      if (!group || !context.assessment.input.source) throw new BackendError('dependency_finding_unavailable', 'This finding has no complete npm lockfile evidence', 409);
      if (scope.expectedSourceDigest !== context.assessment.input.source.digest) throw new BackendError('source_digest_mismatch', 'The source snapshot changed since this report was loaded', 409);
      return { context, group, existing: context.candidates.find(item => item.package_name === group.packageName && item.from_version === group.fromVersion) };
    });
    const source = initial.context.assessment.input.source;
    if (!source) throw new BackendError('source_unavailable', 'The report source snapshot is no longer available', 409);
    if (!initial.context.binding || initial.context.binding.source_digest !== source.digest || initial.context.binding.commit_sha !== source.revision
      || initial.context.binding.revoked || initial.context.binding.read_access !== 'granted' || initial.context.binding.state !== 'verified') {
      throw new BackendError('source_not_repository_bound', 'This source assessment is not bound to a verified repository commit', 409);
    }
    if (!initial.context.binding.github_connection_active) throw new BackendError('github_connection_unavailable', 'An active GitHub App connection for this repository is required', 409);
    if (!initial.context.validationSuiteConfigured) throw new BackendError('validation_suite_missing', 'Configure a versioned validation suite for this repository before preparing a dependency candidate', 409);
    if (!initial.group.advisoryIds.length) throw new BackendError('dependency_guidance_only', 'All matched OSV advisories were withdrawn', 409);
    if (initial.existing) return dependencyFixPreparationResponseSchema.parse({
      candidateSourceId: initial.existing.candidate_source_id, validationRunId: initial.existing.validation_run_id,
      fromVersion: initial.existing.from_version, toVersion: initial.existing.to_version,
      advisoryIds: initial.group.advisoryIds, patchSha256: initial.existing.patch_sha256,
      diffSummary: `Actualizar package.json y package-lock.json para ${initial.group.packageName} de ${initial.existing.from_version} a ${initial.existing.to_version}.`,
    });
    if (initial.group.relationship !== 'direct') throw new BackendError('dependency_guidance_only', 'Transitive upgrades require a safe npm override and remain guidance only', 409);
    const internal = initial.context.assessment.report.internal;
    if (!hasCompleteNpmLockfileCoverage(initial.context.assessment.report)
      || internal?.coverage.find(item => item.capability === 'dependency_advisories')?.state !== 'inspected') {
      throw new BackendError('dependency_guidance_only', 'The source or advisory coverage is incomplete', 409);
    }
    if (initial.group.advisories.some(item => item === null) || initial.group.advisories.length !== initial.group.advisoryIds.length) {
      throw new BackendError('dependency_guidance_only', 'OSV range metadata is incomplete for one or more advisories', 409);
    }
    let packument: unknown;
    try { packument = await registry.getPackument(initial.group.packageName, AbortSignal.timeout(8_500)); }
    catch (error) { throw new BackendError('registry_unavailable', 'The bounded npm registry lookup failed', 503, { cause: error }); }
    const resolution = prepareNpmDependencyPatch({ source, name: initial.group.packageName, fromVersion: initial.group.fromVersion, location: initial.group.location,
      advisories: initial.group.advisories.filter((item): item is OsvAdvisoryMetadata => item !== null), packument });
    if (resolution.status !== 'ready') throw new BackendError('dependency_guidance_only', `This finding is guidance only: ${resolution.reason}`, 409);

    return deps.database.tenant(scope.organizationId, async tx => {
      await authorize(tx, scope.organizationId, actor, ['owner', 'operator']);
      await lockCorrectionApplication(tx, scope);
      const current = await dependencyContext(tx, scope);
      const currentSource = current.assessment.input.source;
      const currentGroup = dependencyFindingGroups(current.assessment.input, current.assessment.report).find(item => item.findingIds.includes(scope.findingId) || item.withdrawnFindingIds.includes(scope.findingId));
      if (!currentSource || !currentGroup || currentSource.digest !== source.digest || currentSource.revision !== source.revision
        || currentGroup.packageName !== initial.group.packageName || currentGroup.fromVersion !== initial.group.fromVersion
        || canonicalJson(currentGroup.advisoryIds) !== canonicalJson(initial.group.advisoryIds)) {
        throw new BackendError('assessment_changed', 'The report evidence changed while the registry candidate was being resolved', 409);
      }
      const existing = current.candidates.find(item => item.package_name === currentGroup.packageName && item.from_version === currentGroup.fromVersion);
      if (existing) return dependencyFixPreparationResponseSchema.parse({ candidateSourceId: existing.candidate_source_id, validationRunId: existing.validation_run_id,
        fromVersion: existing.from_version, toVersion: existing.to_version, advisoryIds: currentGroup.advisoryIds, patchSha256: existing.patch_sha256,
        diffSummary: `Actualizar package.json y package-lock.json para ${currentGroup.packageName} de ${existing.from_version} a ${existing.to_version}.` });
      if (!current.binding || current.binding.source_digest !== currentSource.digest || current.binding.commit_sha !== currentSource.revision
        || current.binding.repository_link_id !== initial.context.binding?.repository_link_id || current.binding.revoked || current.binding.state !== 'verified'
        || current.binding.read_access !== 'granted') throw new BackendError('source_not_repository_bound', 'The repository binding changed while the candidate was being resolved', 409);
      if (!current.binding.github_connection_active) throw new BackendError('github_connection_unavailable', 'The GitHub App connection changed while the candidate was being resolved', 409);
      const currentResolution = prepareNpmDependencyPatch({ source: currentSource, name: currentGroup.packageName, fromVersion: currentGroup.fromVersion,
        location: currentGroup.location, advisories: currentGroup.advisories.filter((item): item is OsvAdvisoryMetadata => item !== null), packument });
      if (currentResolution.status !== 'ready' || currentResolution.patchSha256 !== resolution.patchSha256) {
        throw new BackendError('candidate_changed', 'The exact dependency candidate changed during preparation', 409);
      }
      const updatedFiles = new Map(currentResolution.files.map(file => [file.path, file.content]));
      const candidateSnapshot = parse(customerSourceSnapshotSchema, {
        revision: currentSource.revision,
        files: currentSource.files.map(file => ({ path: file.path, content: updatedFiles.get(file.path) ?? file.content })),
      });
      const customers = createCustomerService({ database: transactionDatabase(deps.database, scope.organizationId, tx) });
      const candidate = await customers.uploadSource(actor, { organizationId: scope.organizationId, applicationId: scope.applicationId, snapshot: candidateSnapshot, authorized: true });
      const validationRunId = await enqueueValidation(tx, {
        organizationId: scope.organizationId, applicationId: scope.applicationId, candidateSourceId: candidate.id,
        baseSourceId: currentSource.id, targetFindingId: currentGroup.findingIds[0]!, targetFindingIds: currentGroup.findingIds,
        baseDigest: currentSource.digest, candidateDigest: candidate.digest, patchDigest: currentResolution.patchSha256,
        repositoryLinkId: current.binding.repository_link_id, mode: 'dependency',
        dependencyAllowlist: [{ name: currentGroup.packageName, section: currentResolution.section, version: currentResolution.toVersion }],
      });
      await tx.query(`INSERT INTO gotchu.dependency_fix_candidates(organization_id,application_id,candidate_source_id,report_id,finding_id,finding_ids,base_source_id,repository_link_id,base_commit,
        package_name,dependency_section,from_version,to_version,advisory_ids,package_json_path,package_lock_path,base_digest,candidate_digest,lockfile_sha256,patch_sha256,validation_run_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21,$22)`, [
        scope.organizationId, scope.applicationId, candidate.id, scope.reportId, currentGroup.findingIds[0], JSON.stringify(currentGroup.findingIds), currentSource.id,
        current.binding.repository_link_id, current.binding.commit_sha, currentGroup.packageName, currentResolution.section, currentGroup.fromVersion, currentResolution.toVersion,
        JSON.stringify(currentGroup.advisoryIds), currentResolution.packageJsonPath, currentResolution.packageLockPath, currentSource.digest, candidate.digest,
        currentResolution.lockfileSha256, currentResolution.patchSha256, validationRunId, actor.userId,
      ]);
      await audit(tx, scope.organizationId, actor.userId, 'dependency_fix.prepared', candidate.id, {
        applicationId: scope.applicationId, reportId: scope.reportId, findingIds: currentGroup.findingIds,
        packageName: currentGroup.packageName, fromVersion: currentGroup.fromVersion, toVersion: currentResolution.toVersion,
        advisoryIds: currentGroup.advisoryIds, baseSourceId: currentSource.id, sourceId: candidate.id,
        baseDigest: currentSource.digest, candidateDigest: candidate.digest, patchSha256: currentResolution.patchSha256,
        lockfileSha256: currentResolution.lockfileSha256, validationRunId,
      });
      return dependencyFixPreparationResponseSchema.parse({ candidateSourceId: candidate.id, validationRunId, fromVersion: currentGroup.fromVersion,
        toVersion: currentResolution.toVersion, advisoryIds: currentGroup.advisoryIds, patchSha256: currentResolution.patchSha256,
        diffSummary: `Actualizar package.json y package-lock.json para ${currentGroup.packageName} de ${currentGroup.fromVersion} a ${currentResolution.toVersion}.` });
    });
  }
  return {
    validationStatus(identity: Identity, input: { organizationId: string; applicationId: string; candidateSourceId: string }) {
      return validations.getStatus(identity, input);
    },
    recommendations: reportRecommendations,
    reportRecommendations,
    prepareDependencyFix,
    async prepare(identity: Identity, input: PrepareCorrectionInput): Promise<PrepareCorrectionResponse> {
      const actor = parse(identitySchema, identity); const value = parse(prepareCorrectionInputSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, ['owner', 'operator']);
        await lockCorrectionApplication(tx, value);
        const assessment = await loadAssessment(tx, value);
        const preparation = recipeBoundary(() => prepareCandidatePatch(assessment.input, assessment.report, {
          recipeId: value.recipeId, findingId: value.findingId, expectedSourceDigest: value.expectedSourceDigest,
        }));
        if (preparation.status === 'blocked') throw new BackendError(preparation.reason, 'Correction preparation is blocked: ' + preparation.reason, 409);
        if (!preparation.scope.sourceSnapshotId || !preparation.scope.sourceDigest) throw new BackendError('source_unavailable', 'Independent validation requires the original source snapshot', 409);
        const idempotencyKey = `correction:${preparation.patchHash}`;
        // Replay precedes source/assessment admission, even if a completed candidate was later deleted.
        const prior = await tx.query<{ job_id: string; input: unknown; payload: unknown; source_id: string | null; target_id: string | null }>(`SELECT r.job_id,r.input,r.source_id,r.target_id,j.payload
          FROM gotchu.jobs j JOIN gotchu.customer_requests r ON r.organization_id=j.organization_id AND r.application_id=j.application_id AND r.job_id=j.id
          WHERE j.organization_id=$1 AND j.application_id=$2 AND j.kind='audit' AND j.idempotency_key=$3`,
        [value.organizationId, value.applicationId, idempotencyKey]);
        const replay = prior.rows[0];
        if (replay) {
          const intent = parse(customerAssessmentIntentSchema, replay.input);
          if (canonicalJson(intent) !== canonicalJson(replay.payload) || intent.organizationId !== value.organizationId || intent.applicationId !== value.applicationId
            || intent.jobId !== replay.job_id || intent.mode !== 'internal' || intent.target !== null || replay.target_id !== null
            || !intent.source || intent.source.id !== replay.source_id || intent.source.digest !== preparation.candidateSourceDigest
            || intent.source.revision !== preparation.candidateSourceSnapshot.revision) scopeMismatch();
          return correctionResponseForQueuedScan(preparation, intent.source.id, replay.job_id);
        }
        const customers = createCustomerService({ database: transactionDatabase(deps.database, value.organizationId, tx) });
        const scope = { organizationId: value.organizationId, applicationId: value.applicationId };
        const source = await customers.uploadSource(actor, { ...scope, snapshot: preparation.candidateSourceSnapshot, authorized: true });
        if (source.digest !== preparation.candidateSourceDigest) scopeMismatch();
        const job = await customers.queue(actor, { ...scope, mode: 'internal', sourceSnapshotId: source.id, targetId: null, idempotencyKey });
        const validationRunId = await enqueueValidation(tx, {
          organizationId: value.organizationId, applicationId: value.applicationId, candidateSourceId: source.id,
          baseSourceId: preparation.scope.sourceSnapshotId, targetFindingId: preparation.findingId, baseDigest: preparation.scope.sourceDigest,
          candidateDigest: source.digest, patchDigest: preparation.patchHash,
        });
        await audit(tx, value.organizationId, actor.userId, 'correction.prepared', source.id, {
          applicationId: value.applicationId, reportId: value.reportId, recipeId: preparation.recipeId, recipeVersion: preparation.recipeVersion,
          findingId: preparation.findingId, originalSourceId: preparation.scope.sourceSnapshotId, sourceId: source.id, jobId: job.jobId,
          sourceDigest: preparation.scope.sourceDigest, candidateSourceDigest: source.digest, patchHash: preparation.patchHash,
          path: preparation.path, originalFileSha256: preparation.originalFileSha256, candidateFileSha256: sha256(preparation.afterBytes), validationRunId,
        });
        return correctionResponseForQueuedScan(preparation, source.id, job.jobId);
      });
    },
  };
}
