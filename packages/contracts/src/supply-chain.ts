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

export const dependencyComponentSchema = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(100),
  purl: z.string().min(1).max(512),
  sourceFile: z.string().min(1).max(512),
  location: z.string().min(1).max(1_024),
  relationship: z.enum(['direct', 'transitive', 'unknown']),
  dependencies: z.array(z.string().min(1).max(512)).max(100),
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
