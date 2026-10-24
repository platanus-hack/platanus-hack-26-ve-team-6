import { z } from 'zod';

const licenseValue = z.string().trim().min(1).max(200);
const policyLicense = licenseValue.refine(value => value === 'UNKNOWN' || /^[A-Za-z0-9.+:()\s-]+$/.test(value));

export const licensePolicySchema = z.object({
  allow: z.array(policyLicense).max(100),
  deny: z.array(policyLicense).max(100),
  review: z.array(policyLicense).max(100),
}).strict().superRefine((policy, context) => {
  const groups = [policy.allow, policy.deny, policy.review];
  for (const group of groups) {
    if (new Set(group).size !== group.length) context.addIssue({ code: 'custom', message: 'License policy lists cannot contain duplicates' });
  }
  const allow = new Set(policy.allow);
  if (policy.deny.some(value => allow.has(value)) || policy.review.some(value => allow.has(value))
    || policy.deny.some(value => policy.review.includes(value))) {
    context.addIssue({ code: 'custom', message: 'A license cannot appear in more than one policy list' });
  }
});
export const workspaceLicensePolicySchema = z.object({
  organizationId: z.uuid().transform(value => value.toLowerCase()),
  policy: licensePolicySchema,
  updatedAt: z.iso.datetime().refine(value => !value.startsWith('0000-')).nullable(),
  configured: z.boolean(),
}).strict();

export const defaultLicensePolicy = {
  allow: ['0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MIT'],
  deny: [],
  review: ['AGPL-1.0-only', 'AGPL-1.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'GPL-1.0-only', 'GPL-1.0-or-later', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'SSPL-1.0', 'UNKNOWN'],
} satisfies z.infer<typeof licensePolicySchema>;

export const dependencyLockfileSchema = z.object({
  sourceFile: z.string().min(1).max(512),
  format: z.enum(['npm-v2', 'npm-v3', 'pnpm-v6', 'pnpm-v9', 'yarn-v1', 'yarn-berry', 'unsupported']),
  state: z.enum(['inspected', 'unavailable', 'unsupported']),
  packageCount: z.number().int().min(0).max(2_000),
}).strict();

export const dependencyReachabilitySchema = z.object({
  state: z.enum(['reachable', 'imported', 'not_found_static', 'unknown']),
  symbolCoverage: z.enum(['available', 'not_found_static', 'unknown']),
  symbols: z.array(z.string().min(1).max(256)).max(50),
  importEvidence: z.array(z.object({
    file: z.string().min(1).max(512),
    line: z.number().int().positive().max(1_000_000),
    specifier: z.string().min(1).max(512),
    kind: z.enum(['import', 'require', 'dynamic_import', 're_export']),
  }).strict()).max(20),
  symbolEvidence: z.array(z.object({
    file: z.string().min(1).max(512),
    line: z.number().int().positive().max(1_000_000),
    symbol: z.string().min(1).max(256),
  }).strict()).max(20),
  dependencyPath: z.array(z.string().min(1).max(512)).max(20).nullable(),
  limitation: z.array(z.string().min(1).max(500)).max(10),
}).strict();

export const dependencyArtifactFindingSchema = z.object({
  tool: z.enum(['semgrep', 'gitleaks']),
  ruleId: z.string().min(1).max(128),
  title: z.string().min(1).max(256),
  location: z.string().min(1).max(1_024),
  severity: z.enum(['unknown', 'informational', 'low', 'medium', 'high', 'critical']),
  confidence: z.enum(['observed', 'inferred', 'uncertain']),
  exploitability: z.enum(['unknown', 'not_demonstrated', 'demonstrated_in_fixture']),
  description: z.string().min(1).max(2_000),
  evidenceIds: z.array(z.uuid()).min(1).max(20),
}).strict();

export const dependencyArtifactAnalysisSchema = z.object({
  status: z.enum(['not_requested', 'verified', 'checksum_mismatch', 'unavailable', 'unsafe_archive', 'scan_incomplete']),
  integrity: z.enum(['verified', 'mismatch', 'missing', 'invalid']),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  extractedFileCount: z.number().int().min(0).max(5_000),
  scannedFileCount: z.number().int().min(0).max(1_000),
  tools: z.array(z.object({
    name: z.enum(['semgrep', 'gitleaks']),
    version: z.string().min(1).max(100),
    image: z.string().min(1).max(300),
    profileChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(2),
  findings: z.array(dependencyArtifactFindingSchema).max(40),
  limitation: z.array(z.string().min(1).max(500)).max(10),
}).strict();

export const dependencyComponentSchema = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(100),
  purl: z.string().min(1).max(512),
  sourceFile: z.string().min(1).max(512),
  location: z.string().min(1).max(1_024),
  relationship: z.enum(['direct', 'transitive', 'unknown']),
  dependencies: z.array(z.string().min(1).max(512)).max(100),
  integrity: z.string().max(1_024).nullable().optional(),
  reachability: dependencyReachabilitySchema.optional(),
  artifactAnalysis: dependencyArtifactAnalysisSchema.optional(),
  declaredLicense: z.string().max(200).nullable(),
  licenseExpression: z.string().max(200).nullable(),
  licenseSource: z.enum(['lockfile', 'registry', 'unknown']),
  licenseConfidence: z.enum(['declared', 'unknown']),
  policyStatus: z.enum(['allowed', 'review', 'denied']),
}).strict();

export const dependencyInventorySchema = z.object({
  components: z.array(dependencyComponentSchema).max(1_000),
  lockfiles: z.array(dependencyLockfileSchema).max(50),
  policy: licensePolicySchema,
  complete: z.boolean(),
  graphComplete: z.boolean(),
  unknownCount: z.number().int().min(0).max(100_000),
}).strict().superRefine((inventory, context) => {
  const edgeCount = inventory.components.reduce((sum, component) => sum + component.dependencies.length, 0);
  if (edgeCount > 5_000) context.addIssue({ code: 'custom', message: 'Dependency graph exceeds the report bound' });
});

export type LicensePolicy = z.infer<typeof licensePolicySchema>;
export type WorkspaceLicensePolicy = z.infer<typeof workspaceLicensePolicySchema>;
export type DependencyComponent = z.infer<typeof dependencyComponentSchema>;
export type DependencyInventory = z.infer<typeof dependencyInventorySchema>;
export type DependencyReachability = z.infer<typeof dependencyReachabilitySchema>;
export type DependencyArtifactAnalysis = z.infer<typeof dependencyArtifactAnalysisSchema>;
export type DependencyArtifactFinding = z.infer<typeof dependencyArtifactFindingSchema>;
