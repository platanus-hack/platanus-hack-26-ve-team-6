import { z } from 'zod';
import { assessmentAnalysisSchema } from './assessment.js';
import { dependencyArtifactAnalysisSchema, dependencyInventorySchema } from './supply-chain.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid().transform(value => value.toLowerCase());
export const validationTestSelectionSchema = z.object({
  files: z.array(z.string().min(1).max(512).regex(
    /^(?:[A-Za-z0-9_@][A-Za-z0-9_@.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/,
  ).refine(path => !path.split('/').includes('node_modules'))).min(1).max(20)
    .refine(files => new Set(files).size === files.length),
  namePattern: z.string().min(1).max(256).refine(pattern => {
    if (/[\x00-\x1f\x7f]/.test(pattern)) return false;
    try { new RegExp(pattern); return true; } catch { return false; }
  }).optional(),
}).strict();

/** Digest computation and comparison belong to the independent server verifier. */
export const suiteBindingSchema = z.object({
  repositoryLinkId: uuid, suiteDefinitionId: uuid, suiteVersion: z.number().int().positive(),
  profile: z.literal('node24-tsx-selected-v1'), testSelection: validationTestSelectionSchema,
  selectionDigest: digest,
}).strict();
export type SuiteBinding = z.infer<typeof suiteBindingSchema>;

export const dependencyRescanPackageSchema = z.object({
  name: z.string().max(214).regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/),
  version: z.string().max(100).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
}).strict();
export const dependencyRescanArtifactResultSchema = dependencyRescanPackageSchema.extend({
  analysis: dependencyArtifactAnalysisSchema,
}).strict();
const packageKey = (pkg: z.infer<typeof dependencyRescanPackageSchema>) => `${pkg.name}\0${pkg.version}`;
const packages = z.array(dependencyRescanPackageSchema).min(1).max(2)
  .refine(values => new Set(values.map(packageKey)).size === values.length);
const results = z.array(dependencyRescanArtifactResultSchema).max(2)
  .refine(values => new Set(values.map(packageKey)).size === values.length);
const capabilities = assessmentAnalysisSchema.shape.coverage
  .refine(values => new Set(values.map(value => value.capability)).size === values.length);
const analysisState = z.object({
  status: assessmentAnalysisSchema.shape.status,
  findingCount: z.number().int().min(0).max(100), evidenceCount: z.number().int().min(0).max(200),
  inventory: z.object({
    complete: dependencyInventorySchema.shape.complete, graphComplete: dependencyInventorySchema.shape.graphComplete,
    unknownCount: dependencyInventorySchema.shape.unknownCount, lockfiles: dependencyInventorySchema.shape.lockfiles,
  }).strict().nullable(),
}).strict();

export const dependencyRescanScopeSchema = z.object({
  coverageScope: z.literal('dependency_rescan_v1'), baseSnapshotDigest: digest, candidateSnapshotDigest: digest,
  beforeCapabilities: capabilities, afterCapabilities: capabilities,
  beforeAnalysis: analysisState, afterAnalysis: analysisState,
  artifactScope: z.object({ before: packages, after: packages }).strict(),
  artifactResults: z.object({ before: results, after: results }).strict(),
}).strict();
export type DependencyRescanScope = z.infer<typeof dependencyRescanScopeSchema>;
export type DependencyRescanArtifactResult = z.infer<typeof dependencyRescanArtifactResultSchema>;
export type DependencyRescanPackage = z.infer<typeof dependencyRescanPackageSchema>;

const mandatory = ['semgrep', 'gitleaks', 'dependency_inventory', 'dependency_advisories', 'license_metadata'] as const;
const trivyProfiles = ['trivy_kubernetes', 'trivy_terraform', 'trivy_dockerfile'] as const;
const known = new Set<string>([...mandatory, ...trivyProfiles, 'trivy', 'dependency_reachability', 'dependency_artifact_analysis']);
const noTrivyInputs = 'No se encontraron candidatos para este perfil.';
const noTrivy = 'No se encontraron candidatos Kubernetes, Terraform ni Dockerfile.';
const noArtifacts = 'Exact package artifact analysis was not requested because OSV returned no advisory match.';
const noReachability = 'Reachability was not requested because no exact-version advisory match was available.';
const staticReachability = 'A TypeScript compiler AST inspected supported JavaScript/TypeScript import, require, literal dynamic import and re-export syntax. Static non-matches are not proof of unreachability.';

function capabilitiesCovered(values: DependencyRescanScope['beforeCapabilities']): boolean {
  const entries = new Map(values.map(value => [value.capability, value]));
  if (values.some(value => !known.has(value.capability)) || entries.size !== known.size) return false;
  if (mandatory.some(name => entries.get(name)?.state !== 'inspected')) return false;
  for (const name of trivyProfiles) {
    const entry = entries.get(name);
    if (!entry || !(entry.state === 'inspected' || entry.state === 'unsupported' && entry.detail === noTrivyInputs)) return false;
  }
  const trivy = entries.get('trivy');
  const noInputs = trivyProfiles.every(name => entries.get(name)?.state === 'unsupported');
  if (!trivy || (noInputs ? trivy.state !== 'unsupported' || trivy.detail !== noTrivy : trivy.state !== 'inspected')) return false;
  const reachability = entries.get('dependency_reachability');
  if (!reachability || !(reachability.state === 'inspected'
    || reachability.state === 'unavailable' && reachability.detail === staticReachability
    || reachability.state === 'not_requested' && reachability.detail === noReachability)) return false;
  const artifacts = entries.get('dependency_artifact_analysis');
  return artifacts !== undefined && (artifacts.state === 'inspected'
    || artifacts.state === 'not_requested' && artifacts.detail === noArtifacts);
}

function analysisCovered(value: DependencyRescanScope['beforeAnalysis']): boolean {
  const inventory = value.inventory;
  // A saturated report cannot establish that no observations were omitted.
  return value.status !== 'unavailable' && value.findingCount < 100 && value.evidenceCount < 200
    && inventory !== null && inventory.complete && inventory.unknownCount === 0
    && inventory.lockfiles.length > 0 && inventory.lockfiles.every(file => file.state === 'inspected' && file.format !== 'unsupported');
}

function artifactsCovered(requested: DependencyRescanPackage[], actual: DependencyRescanArtifactResult[]): boolean {
  if (actual.length !== requested.length) return false;
  return requested.every(pkg => {
    const result = actual.find(value => packageKey(value) === packageKey(pkg));
    if (!result) return false;
    const analysis = result.analysis;
    return analysis.status === 'verified' && analysis.integrity === 'verified' && analysis.artifactSha256 !== null
      && analysis.scannedFileCount > 0 && analysis.scannedFileCount <= analysis.extractedFileCount
      && analysis.findings.length < 40 && analysis.tools.length === 2
      && analysis.tools.some(tool => tool.name === 'semgrep') && analysis.tools.some(tool => tool.name === 'gitleaks');
  });
}

/** Scoped coverage only: this never upgrades global coverage or scores finding identities. */
export function scoreDependencyRescanCoverage(input: unknown): {
  result: 'passed' | 'inconclusive';
  reason: 'dependency_rescan_scope_invalid' | 'dependency_rescan_coverage_unknown' | 'dependency_rescan_artifacts_unknown' | null;
} {
  const parsed = dependencyRescanScopeSchema.safeParse(input);
  if (!parsed.success) return { result: 'inconclusive', reason: 'dependency_rescan_scope_invalid' };
  const scope = parsed.data;
  if (!analysisCovered(scope.beforeAnalysis) || !analysisCovered(scope.afterAnalysis)
    || !capabilitiesCovered(scope.beforeCapabilities) || !capabilitiesCovered(scope.afterCapabilities)) {
    return { result: 'inconclusive', reason: 'dependency_rescan_coverage_unknown' };
  }
  if (!artifactsCovered(scope.artifactScope.before, scope.artifactResults.before)
    || !artifactsCovered(scope.artifactScope.after, scope.artifactResults.after)) {
    return { result: 'inconclusive', reason: 'dependency_rescan_artifacts_unknown' };
  }
  return { result: 'passed', reason: null };
}
