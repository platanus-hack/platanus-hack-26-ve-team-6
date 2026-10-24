import { z } from 'zod';
import { customerScopeSchema } from './customer-assessment.js';

export const modelProviderSchema = z.enum(['openai_compatible', 'anthropic_messages']);
export const investigationDataScopeSchema = z.enum([
  'application_context',
  'finding_details',
  'source_excerpts',
  'assessment_diffs',
  'validation_results',
  'triage_summaries',
  'runtime_summaries',
]);
export const investigationModelEndpointSchema = z.string().trim().min(1).max(2_048).url().refine(value => {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}, 'Use HTTPS or a local loopback HTTP model server');

export const configureInvestigationModelSchema = z.object({
  provider: modelProviderSchema,
  endpoint: investigationModelEndpointSchema,
  modelId: z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  apiKey: z.string().min(1).max(4_096).optional(),
  consentToExternalProcessing: z.boolean(),
  dataScopes: z.array(investigationDataScopeSchema).max(7),
  inputPriceMicroUsdPerMillionTokens: z.number().int().min(0).max(1_000_000_000),
  outputPriceMicroUsdPerMillionTokens: z.number().int().min(0).max(1_000_000_000),
  organizationBudgetCents: z.number().int().min(0).max(100_000_000),
  organizationTokenBudget: z.number().int().min(0).max(100_000_000),
}).strict().superRefine((value, context) => {
  if (new Set(value.dataScopes).size !== value.dataScopes.length) {
    context.addIssue({ code: 'custom', path: ['dataScopes'], message: 'Data scopes must be unique' });
  }
  if (value.consentToExternalProcessing && value.dataScopes.length === 0) {
    context.addIssue({ code: 'custom', path: ['dataScopes'], message: 'Select the data categories allowed for model processing' });
  }
});

export const investigationModelSettingsSchema = z.object({
  status: z.enum(['disabled', 'ready']),
  disabledReason: z.enum(['not_configured', 'consent_required', 'data_scope_required', 'secret_unavailable', 'budget_unconfigured']).nullable(),
  provider: modelProviderSchema.nullable(),
  endpoint: investigationModelEndpointSchema.nullable(),
  modelId: z.string().max(200).nullable(),
  apiKeyConfigured: z.boolean(),
  consentToExternalProcessing: z.boolean(),
  dataScopes: z.array(investigationDataScopeSchema).max(7),
  inputPriceMicroUsdPerMillionTokens: z.number().int().nonnegative(),
  outputPriceMicroUsdPerMillionTokens: z.number().int().nonnegative(),
  organizationBudgetCents: z.number().int().nonnegative(),
  organizationTokenBudget: z.number().int().nonnegative(),
  spentMicroUsd: z.number().int().nonnegative(),
  reservedMicroUsd: z.number().int().nonnegative(),
  tokensSpent: z.number().int().nonnegative(),
  tokensReserved: z.number().int().nonnegative(),
}).strict();

export const investigationSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('finding'), subjectId: z.uuid(), reportId: z.uuid() }).strict(),
  z.object({ kind: z.literal('alert'), subjectId: z.uuid() }).strict(),
  z.object({ kind: z.literal('incident'), subjectId: z.uuid() }).strict(),
]);
export const requestInvestigationSchema = customerScopeSchema.extend({ subject: investigationSubjectSchema }).strict();
export const investigationRunSchema = z.object({
  organizationId: z.uuid(), applicationId: z.uuid(), jobId: z.uuid(), subject: investigationSubjectSchema,
  state: z.enum(['queued', 'running', 'succeeded', 'failed']),
  status: z.enum(['pending', 'investigating', 'investigated', 'inconclusive', 'delayed', 'cancelled', 'reconciliation_required']),
  summary: z.string().max(2_000).nullable(),
  assessment: z.enum(['candidate_issue', 'no_issue_supported', 'inconclusive']).nullable(),
  citedEvidenceIds: z.array(z.uuid()).max(20),
  hypotheses: z.array(z.object({ statement: z.string().min(1).max(500), evidenceIds: z.array(z.uuid()).min(1).max(20) }).strict()).max(8),
  candidateSuggestion: z.object({ kind: z.enum(['source_change', 'dependency_change', 'configuration_change']), summary: z.string().min(1).max(500), path: z.string().max(512).nullable(), evidenceIds: z.array(z.uuid()).min(1).max(20), validationRequired: z.literal('D05') }).strict().nullable(),
  tokensSpent: z.number().int().nonnegative(),
  costMicroUsd: z.number().int().nonnegative(),
  reservedCostMicroUsd: z.number().int().nonnegative(),
  reservedTokens: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  cancelRequested: z.boolean(),
}).strict();
export const investigationActionSchema = z.object({ status: z.enum(['accepted', 'already_active', 'already_exists', 'cancel_requested', 'resumed']) }).strict();
export const investigationResumeRequestSchema = customerScopeSchema.extend({ jobId: z.uuid() }).strict();
export const investigationCancelRequestSchema = investigationResumeRequestSchema;

export const investigationModelSuggestions = Object.freeze({
  openai_compatible: { endpoint: 'https://api.openai.com/v1', modelId: 'gpt-5.5' },
  anthropic_messages: { endpoint: 'https://api.anthropic.com/v1', modelId: 'claude-sonnet-5-5' },
});

export type InvestigationDataScope = z.infer<typeof investigationDataScopeSchema>;
export type InvestigationSubject = z.infer<typeof investigationSubjectSchema>;
