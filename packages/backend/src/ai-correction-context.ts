import { posix } from 'node:path';
import { z } from 'zod';
import {
  aiCorrectionInputSchema, aiCorrectionPatchSchema, customerSourceSnapshotSchema,
  investigationDataScopeSchema, investigationProviderCatalog, investigationProviderPresetIdSchema, modelProviderSchema,
  type AiCorrectionInput, type AiCorrectionPatch, type CustomerSourceSnapshot,
} from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { BackendError, canonicalJson, parse, sha256 } from './core.js';
import { loadAssessment, type CorrectionReportScope } from './corrections.js';
import { modelConfigurationFingerprint } from './model-configuration.js';

export function correctionBoundary(code: string): never {
  throw new BackendError(code, 'AI correction no longer matches its authorized source, context or model configuration', 409);
}

/** References only; provider credentials remain exclusively in the gateway's secret store. */
export async function correctionModelFingerprint(tx: Transaction, organizationId: string, admission = false) {
  const result = await tx.query<{
    model_opt_in: boolean; model_budget_micros: string; model_token_budget: string;
    model_spent_micros: string; model_reserved_micros: string; model_tokens_spent: string; model_tokens_reserved: string;
    provider: string; provider_preset_id: string; endpoint: string; model_id: string; secret_ref: string | null;
    consent_to_external_processing: boolean; data_scopes: unknown;
    input_price_micro_usd_per_million_tokens: string; output_price_micro_usd_per_million_tokens: string;
  }>(`SELECT o.model_opt_in,o.model_budget_micros,o.model_token_budget,o.model_spent_micros,o.model_reserved_micros,
    o.model_tokens_spent,o.model_tokens_reserved,s.provider,s.provider_preset_id,s.endpoint,s.model_id,s.secret_ref,
    s.consent_to_external_processing,s.data_scopes,s.input_price_micro_usd_per_million_tokens,s.output_price_micro_usd_per_million_tokens
    FROM gotchu.organizations o JOIN gotchu.investigation_model_settings s ON s.organization_id=o.id WHERE o.id=$1`, [organizationId]);
  const row = result.rows[0];
  const subscription = investigationProviderCatalog.find(preset => preset.id === row?.provider_preset_id)?.billing === 'subscription';
  if (!row || !row.model_opt_in || !row.consent_to_external_processing
    || BigInt(row.model_budget_micros) <= 0n || (!subscription && BigInt(row.model_token_budget) <= 0n)
    || row.provider !== 'openai_compatible' && !row.secret_ref) correctionBoundary('model_consent_required');
  const scopes = parse(z.array(investigationDataScopeSchema).max(7), row.data_scopes);
  if (!scopes.includes('finding_details') || !scopes.includes('source_excerpts')) correctionBoundary('model_scope_required');
  if (admission && (BigInt(row.model_budget_micros) <= BigInt(row.model_spent_micros) + BigInt(row.model_reserved_micros)
    || (!subscription && BigInt(row.model_token_budget) <= BigInt(row.model_tokens_spent) + BigInt(row.model_tokens_reserved)))) {
    throw new BackendError('model_budget_exhausted', 'Model budget has no remaining capacity', 429);
  }
  return modelConfigurationFingerprint({ provider: parse(modelProviderSchema, row.provider),
    providerPresetId: parse(investigationProviderPresetIdSchema, row.provider_preset_id), endpoint: row.endpoint,
    modelId: row.model_id, secretRef: row.secret_ref, consentToExternalProcessing: true, dataScopes: scopes,
    inputPriceMicroUsdPerMillionTokens: Number(row.input_price_micro_usd_per_million_tokens),
    outputPriceMicroUsdPerMillionTokens: Number(row.output_price_micro_usd_per_million_tokens) });
}

/** Existing application code only: no dependency manifests, credentials, CI, tests or script entrypoints. */
export function correctionPathAllowed(path: string) {
  return /\.(?:[cm]?[jt]sx?|py|go|java)$/i.test(path)
    && !path.split('/').some(part => part.startsWith('.') || /^(?:node_modules|vendor|scripts?|bin|ci|workflows?|tests?|__tests__|__fixtures__)$/i.test(part))
    && !/(?:^|\/)(?:[^/]*\.(?:test|spec)\.[^/]+|[^/]*config\.[^/]+|conftest\.py|setup\.py)$/i.test(path);
}

export async function correctionAssessment(tx: Transaction, scope: CorrectionReportScope & { findingId: string; expectedSourceDigest: string }) {
  const assessment = await loadAssessment(tx, scope);
  const source = assessment.input.source;
  const report = assessment.report;
  if (!source || source.digest !== scope.expectedSourceDigest || report.organizationId !== scope.organizationId
    || report.applicationId !== scope.applicationId || report.subject.sourceSnapshotId !== source.id
    || report.subject.sourceDigest !== source.digest) correctionBoundary('correction_source_mismatch');
  const finding = report.internal?.findings.find(item => item.id === scope.findingId);
  const snapshotRef = `source:${source.id}:sha256:${source.digest}`;
  if (report.internal?.snapshotRef !== snapshotRef || !finding || finding.origin !== 'internal'
    || finding.evidenceIds.some(id => !report.internal?.evidence.some(item => item.id === id && item.snapshotRef === snapshotRef && item.origin === 'internal'))) {
    correctionBoundary('correction_finding_unavailable');
  }
  const path = finding.location.replace(/:\d+(?::\d+)?$/, '');
  const target = source.files.find(file => file.path === path);
  if (!target || !correctionPathAllowed(path) || target.content.length > 12_000) correctionBoundary('correction_target_unsupported');
  return { source, finding, target };
}

export const authorizedCorrectionFilesSchema = z.array(aiCorrectionInputSchema.shape.files.element.omit({ content: true })).min(1).max(4);

export function selectCorrectionInput(scope: AiCorrectionInput['scope'], correctionId: string,
  assessment: Awaited<ReturnType<typeof correctionAssessment>>, suggestion: AiCorrectionInput['suggestion']): AiCorrectionInput {
  const { source, finding, target } = assessment;
  let input = parse(aiCorrectionInputSchema, { task: 'prepare_correction', scope, correctionId, sourceDigest: source.digest,
    finding, suggestion, files: [{ ...target, sha256: sha256(target.content) }] });
  // This intentionally covers direct relative JS/TS imports only, never claims complete repository context.
  const imports = target.content.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.{1,2}\/[^'"\r\n]+)['"]/g);
  for (const match of imports) {
    if (input.files.length === 4) break;
    const specifier = match[1];
    if (!specifier) continue;
    const relative = posix.normalize(posix.join(posix.dirname(target.path), specifier));
    const stem = relative.replace(/\.[cm]?jsx?$/, '');
    const paths = [relative, ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].map(ext => stem + ext), `${relative}/index.ts`, `${relative}/index.js`];
    const file = paths.map(path => source.files.find(item => item.path === path)).find(item => item !== undefined);
    if (!file || !correctionPathAllowed(file.path) || file.content.length > 12_000 || input.files.some(item => item.path === file.path)) continue;
    const expanded = aiCorrectionInputSchema.safeParse({ ...input, files: [...input.files, { ...file, sha256: sha256(file.content) }] });
    if (expanded.success) input = expanded.data;
  }
  return input;
}

export function restoreCorrectionInput(scope: AiCorrectionInput['scope'], correctionId: string,
  assessment: Awaited<ReturnType<typeof correctionAssessment>>, authorizedFiles: unknown, suggestion: unknown): AiCorrectionInput {
  const pinned = parse(authorizedCorrectionFilesSchema, authorizedFiles);
  if (new Set(pinned.map(file => file.path)).size !== pinned.length || pinned[0]?.path !== assessment.target.path) correctionBoundary('correction_context_mismatch');
  const files = pinned.map(file => {
    const stored = assessment.source.files.find(item => item.path === file.path);
    if (!stored || !correctionPathAllowed(file.path) || sha256(stored.content) !== file.sha256) correctionBoundary('correction_context_mismatch');
    return { ...file, content: stored.content };
  });
  return parse(aiCorrectionInputSchema, { task: 'prepare_correction', scope, correctionId,
    sourceDigest: assessment.source.digest, finding: assessment.finding, suggestion, files });
}

/** Every match is located against the original file; replacement text cannot create another match. */
export function applyCorrectionPatch(input: AiCorrectionInput, original: CustomerSourceSnapshot, raw: unknown) {
  const patch: AiCorrectionPatch = parse(aiCorrectionPatchSchema, raw);
  if (sha256(canonicalJson(original)) !== input.sourceDigest) correctionBoundary('correction_source_mismatch');
  const diff = patch.changes.map(change => {
    const file = input.files.find(item => item.path === change.path);
    if (!file || !correctionPathAllowed(change.path) || file.sha256 !== change.originalSha256
      || sha256(file.content) !== change.originalSha256 || original.files.find(item => item.path === file.path)?.content !== file.content) correctionBoundary('correction_patch_out_of_scope');
    const spans = change.replacements.map(replacement => {
      const start = file.content.indexOf(replacement.before);
      if (!replacement.before.trim() || replacement.before === replacement.after || start < 0
        || file.content.indexOf(replacement.before, start + 1) !== -1) correctionBoundary('correction_patch_match_invalid');
      return { start, end: start + replacement.before.length, after: replacement.after };
    }).sort((a, b) => a.start - b.start);
    let cursor = 0;
    let after = '';
    for (const span of spans) {
      if (span.start < cursor) correctionBoundary('correction_patch_overlap');
      after += file.content.slice(cursor, span.start) + span.after;
      cursor = span.end;
    }
    after += file.content.slice(cursor);
    if (!after.trim() || after === file.content || after.length > 24_000) correctionBoundary('correction_patch_invalid');
    return { path: file.path, before: file.content, after };
  });
  if (!diff.some(file => file.path === input.files[0]?.path)) correctionBoundary('correction_target_unchanged');
  const changed = new Map(diff.map(file => [file.path, file.after]));
  const snapshot = parse(customerSourceSnapshotSchema, { revision: original.revision,
    files: original.files.map(file => ({ path: file.path, content: changed.get(file.path) ?? file.content })) });
  const candidateDigest = sha256(canonicalJson(snapshot));
  const patchHash = sha256(canonicalJson({ sourceDigest: input.sourceDigest, candidateDigest, changes: patch.changes }));
  return { patch, diff, snapshot, candidateDigest, patchHash };
}
