import { z } from 'zod';
import { correlationWindowInputSchema } from './inputs.js';

export const hypothesisKindSchema = z.enum(['application_regression', 'abuse', 'provider_dependency', 'legitimate_load', 'unknown']);
export const hypothesisStatusSchema = z.enum(['supported', 'weak', 'contradicted', 'withdrawn']);
export const confidenceSchema = z.enum(['low', 'medium', 'high']);
export const impactObservationSchema = z.enum(['none_observed_at_checked_points', 'degraded', 'unavailable', 'unknown']);
export const evidenceRefSchema = z.object({ ref: z.string(), detail: z.string() }).strict();
export const hypothesisSchema = z.object({
  kind: hypothesisKindSchema,
  status: hypothesisStatusSchema,
  confidence: confidenceSchema,
  ruleIds: z.array(z.string()),
  evidenceFor: z.array(evidenceRefSchema),
  evidenceAgainst: z.array(evidenceRefSchema),
  missingData: z.array(z.string()),
  nextCheck: z.string(),
}).strict();
export const triageImpactSchema = z.object({
  observed: impactObservationSchema,
  affectedServices: z.array(z.string()),
  window: correlationWindowInputSchema.shape.window,
  checkedPoints: z.array(evidenceRefSchema),
  missingData: z.array(z.string()),
}).strict();
export const triageRevisionSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  previousRevisionId: z.string().nullable(),
  rulesVersion: z.string(),
  inputDigest: z.string(),
  impact: triageImpactSchema,
  hypotheses: z.array(hypothesisSchema),
  unknownInvestigable: z.array(z.string()),
}).strict();

export type HypothesisKind = z.infer<typeof hypothesisKindSchema>;
export type HypothesisStatus = z.infer<typeof hypothesisStatusSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type ImpactObservation = z.infer<typeof impactObservationSchema>;
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type Hypothesis = z.infer<typeof hypothesisSchema>;
export type TriageRevision = z.infer<typeof triageRevisionSchema>;
