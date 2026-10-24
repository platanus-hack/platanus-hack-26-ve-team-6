import { z } from 'zod';

export const recipeAvailabilitySchema = z.enum(['candidate_patch', 'guided_review', 'integration_required']);
export const detectorAvailabilitySchema = z.enum(['available', 'not_implemented']);
export const recipeCoverageSchema = z.enum(['inspected', 'unknown', 'not_requested', 'unsupported', 'not_reported']);
export const recipeOptionSchema = z.object({ id: z.string().min(1).max(80), title: z.string().min(1).max(160), detail: z.string().min(1).max(500) }).strict();
export const recipeCatalogEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,80}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  category: z.enum(['injection', 'shell_execution', 'tls_verification', 'secret_exposure', 'dependency_advisory', 'kubernetes_configuration', 'https_headers', 'authentication_spray', 'route_enumeration', 'application_errors', 'resource_pressure', 'provider_outage']),
  title: z.string().min(1).max(160),
  riskSummary: z.string().min(1).max(500),
  candidateChangeDescription: z.string().min(1).max(240).nullable().optional(),
  expectedRuleIds: z.array(z.string().min(1).max(128)).max(8),
  detectorAvailability: detectorAvailabilitySchema,
  detectorCapability: z.string().min(1).max(128).nullable(),
  scope: z.enum(['source', 'https', 'operational']),
  owaspCategories: z.array(z.string().regex(/^A\d\d:2021$/)).max(2),
  options: z.array(recipeOptionSchema).min(1).max(5),
  requirements: z.array(z.string().min(1).max(300)).max(8),
}).strict();

export type RecipeAvailability = z.infer<typeof recipeAvailabilitySchema>;
export type DetectorAvailability = z.infer<typeof detectorAvailabilitySchema>;
export type RecipeCoverage = z.infer<typeof recipeCoverageSchema>;
export type RecipeOption = z.infer<typeof recipeOptionSchema>;
export type RecipeCatalogEntry = z.infer<typeof recipeCatalogEntrySchema>;

const recipeCatalog = [
  {
    id: 'dynamic-evaluation', version: '1.0.0', category: 'injection', title: 'Review dynamic evaluation',
    riskSummary: 'Untrusted input reaching dynamic evaluation can become code injection; the finding alone does not establish reachability or exploitation.',
    expectedRuleIds: ['gotchu.javascript.eval'], detectorAvailability: 'available', detectorCapability: 'semgrep', scope: 'source', owaspCategories: ['A03:2021'],
    options: [{ id: 'trace-input', title: 'Trace the input boundary', detail: 'Identify who controls the evaluated value and whether validation or a data parser can replace dynamic evaluation without changing intended behavior.' }],
    requirements: ['Review the call and its input trust boundary.', 'Use behavior-focused tests before replacing a dynamic expression.'],
  },
  {
    id: 'shell-command-execution', version: '1.0.0', category: 'shell_execution', title: 'Review shell command construction',
    riskSummary: 'A shell call can interpret attacker-controlled command text; the static match does not prove that untrusted data reaches it.',
    expectedRuleIds: ['gotchu.javascript.shell-exec'], detectorAvailability: 'available', detectorCapability: 'semgrep', scope: 'source', owaspCategories: ['A03:2021'],
    options: [{ id: 'remove-shell-interpolation', title: 'Remove shell interpretation', detail: 'Review whether a fixed executable with separately validated arguments can preserve the required behavior.' }],
    requirements: ['Review every input that can reach the command.', 'Preserve argument boundaries and verify the intended operation with tests.'],
  },
  {
    id: 'tls-certificate-verification', version: '1.0.0', category: 'tls_verification', title: 'Enable TLS certificate verification',
    riskSummary: 'Disabling certificate checks can remove peer authentication for this client connection.',
    candidateChangeDescription: 'Enabled TLS certificate verification at the reported source property.',
    expectedRuleIds: ['gotchu.javascript.tls-disabled'], detectorAvailability: 'available', detectorCapability: 'semgrep', scope: 'source', owaspCategories: ['A02:2021'],
    options: [{ id: 'verify-peer', title: 'Verify the certificate', detail: 'Set the existing rejectUnauthorized property to true and confirm the client fails closed for an untrusted certificate.' }],
    requirements: ['Confirm this is the client configuration associated with the finding.', 'Check that the intended trust roots are configured separately.'],
  },
  {
    id: 'credential-exposure', version: '1.0.0', category: 'secret_exposure', title: 'Revoke and rotate exposed credentials',
    riskSummary: 'A secret-like value may be exposed; validity and use are unknown. Removing text from the current snapshot does not revoke it.',
    expectedRuleIds: ['gotchu-private-key', 'gotchu-aws-access-key', 'gotchu-assigned-secret'], detectorAvailability: 'available', detectorCapability: 'gitleaks', scope: 'source', owaspCategories: ['A02:2021'],
    options: [{ id: 'rotate-at-issuer', title: 'Rotate at the issuing provider', detail: 'Use the credential issuer to revoke or rotate the value, then separately review source history and the replacement’s storage.' }],
    requirements: ['A credential owner must identify the issuing provider privately.', 'Confirm revocation or rotation through an authorized provider integration.', 'Do not infer invalidation from source cleanup.'],
  },
  {
    id: 'dependency-advisory', version: '1.0.0', category: 'dependency_advisory', title: 'Resolve the exact dependency advisory',
    riskSummary: 'An exact lockfile version matched an advisory; installation, deployment, reachability, fix availability, and exploitability remain unknown.',
    expectedRuleIds: ['osv.*'], detectorAvailability: 'available', detectorCapability: 'npm_advisories', scope: 'source', owaspCategories: ['A06:2021'],
    options: [{ id: 'verify-fix', title: 'Verify a supported fixed release', detail: 'Check the authoritative advisory and package release metadata, then update the manifest and lockfile through the package manager and validate the application.' }],
    requirements: ['Verify the advisory and fixed version against a trusted current source.', 'Resolve and review the full dependency path.', 'Run the project’s configured validation before rescanning.'],
  },
  {
    id: 'kubernetes-config-hardening', version: '1.0.0', category: 'kubernetes_configuration', title: 'Review Kubernetes configuration hardening',
    riskSummary: 'A Kubernetes configuration finding may weaken a security boundary; runtime use and workload requirements are not established.',
    candidateChangeDescription: 'Disabled the reported Kubernetes securityContext privilege setting.',
    expectedRuleIds: ['AVD-KSV*'], detectorAvailability: 'available', detectorCapability: 'trivy', scope: 'source', owaspCategories: ['A05:2021'],
    options: [{ id: 'review-kubernetes-hardening', title: 'Review the flagged configuration', detail: 'If the exact finding is a privileged or allowPrivilegeEscalation property, consider setting that literal to false and validate the workload behavior.' }],
    requirements: ['Review the exact finding and its configuration location.', 'Validate workload behavior and cluster policy before applying a change.'],
  },
  {
    id: 'https-security-headers', version: '1.0.0', category: 'https_headers', title: 'Review missing response security headers',
    riskSummary: 'The authorized root response omitted a browser hardening header; one response does not establish policy across other routes.',
    expectedRuleIds: ['https.missing-*'], detectorAvailability: 'available', detectorCapability: 'root_headers', scope: 'https', owaspCategories: ['A05:2021'],
    options: [{ id: 'configure-header-policy', title: 'Configure the response policy', detail: 'Use the repository’s identified framework or proxy configuration to set a policy appropriate to the application, then assess the affected responses again.' }],
    requirements: ['Review policy requirements for all relevant routes and assets.', 'Validate header values and browser behavior; header presence alone does not prove effectiveness.'],
  },
  {
    id: 'authentication-failure-spike', version: '1.0.0', category: 'authentication_spray', title: 'Review repeated authentication failures',
    riskSummary: 'A bounded login-failure detector can identify suspicious activity, but failed attempts do not prove account compromise or attack attribution.',
    expectedRuleIds: ['auth.login_failures.v1.account', 'auth.login_failures.v1.ip'], detectorAvailability: 'available', detectorCapability: null, scope: 'operational', owaspCategories: ['A07:2021'],
    options: [{ id: 'review-auth-controls', title: 'Review authentication protections', detail: 'Use the scoped event evidence to review rate limits, account recovery protections, and whether a responder should contact affected users.' }],
    requirements: ['Operational event evidence and a responder review are required.', 'Do not treat failed attempts as proof of successful access.'],
  },
  {
    id: 'route-enumeration', version: '1.0.0', category: 'route_enumeration', title: 'Investigate unusual route discovery',
    riskSummary: 'Route enumeration is not currently measured by the customer assessment report; route volume alone would not establish unauthorized access.',
    expectedRuleIds: ['http.route-enumeration.v1'], detectorAvailability: 'not_implemented', detectorCapability: null, scope: 'operational', owaspCategories: [],
    options: [{ id: 'add-route-telemetry', title: 'Add scoped route telemetry', detail: 'Instrument bounded route outcomes and review unusual patterns with application context before changing access controls.' }],
    requirements: ['A route-level event contract and bounded detector are required.', 'Preserve authorized scope and avoid broad active route probing.'],
  },
  {
    id: 'application-errors', version: '1.0.0', category: 'application_errors', title: 'Investigate recurring application errors',
    riskSummary: 'Operational error evidence can identify a reliability issue; an error burst does not by itself establish an attack.',
    expectedRuleIds: ['application.unhandled_errors.v1'], detectorAvailability: 'not_implemented', detectorCapability: null, scope: 'operational', owaspCategories: [],
    options: [{ id: 'trace-error-context', title: 'Review bounded error context', detail: 'Correlate minimized error records with deployment and application health evidence; keep sensitive request data out of reports.' }],
    requirements: ['A privacy-bounded error event source and detector are required.', 'Do not infer exploitability from an error message or count alone.'],
  },
  {
    id: 'resource-pressure', version: '1.0.0', category: 'resource_pressure', title: 'Review sustained resource pressure',
    riskSummary: 'Resource pressure can affect availability; it does not identify cause or establish a denial-of-service attack.',
    expectedRuleIds: ['application.resource_pressure.v1'], detectorAvailability: 'not_implemented', detectorCapability: null, scope: 'operational', owaspCategories: [],
    options: [{ id: 'compare-resource-signals', title: 'Compare bounded health signals', detail: 'Review CPU, memory, queue, and application health measurements over the same interval before changing resource limits.' }],
    requirements: ['A resource telemetry adapter and bounded threshold policy are required.', 'Keep incident severity separate from action permissions.'],
  },
  {
    id: 'provider-outage', version: '1.0.0', category: 'provider_outage', title: 'Review a provider availability incident',
    riskSummary: 'An integration outage can reduce service or evidence coverage; it does not establish a customer attack or authorize recovery actions.',
    expectedRuleIds: ['provider.outage.v1'], detectorAvailability: 'not_implemented', detectorCapability: null, scope: 'operational', owaspCategories: [],
    options: [{ id: 'check-provider-health', title: 'Check integration health', detail: 'Compare the provider’s trusted health evidence with Gotchu delivery status and show any resulting assessment coverage gap.' }],
    requirements: ['A provider health and delivery-status adapter is required.', 'Provider recovery remains a separately authorized action.'],
  },
] as const satisfies readonly RecipeCatalogEntry[];

export const remediationRecipeCatalog: readonly RecipeCatalogEntry[] = Object.freeze(recipeCatalog.map((entry) => recipeCatalogEntrySchema.parse(entry)));

export function findRecipeForRule(ruleId: string): RecipeCatalogEntry | undefined {
  // Semgrep prefixes the mounted profile's filename in its actual JSON output.
  const normalizedRuleId = ruleId.startsWith('profile.gotchu.javascript.') ? ruleId.slice('profile.'.length) : ruleId;
  return remediationRecipeCatalog.find((recipe) => recipe.expectedRuleIds.some((pattern) => {
    if (pattern.endsWith('*')) return normalizedRuleId.startsWith(pattern.slice(0, -1));
    return pattern === normalizedRuleId;
  }));
}
