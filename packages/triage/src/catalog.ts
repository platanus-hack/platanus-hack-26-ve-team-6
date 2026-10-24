export type ScenarioId =
  | 'code-vulnerability' | 'dependency-vulnerability' | 'exposed-secret' | 'insecure-configuration'
  | 'abusive-authentication' | 'enumeration' | 'application-error' | 'release-regression' | 'unavailability'
  | 'dns-tls-failure' | 'provider-failure' | 'resource-exhaustion' | 'legitimate-traffic-increase';
export interface ScenarioEntry {
  readonly id: ScenarioId;
  readonly version: string;
  readonly title: string;
  readonly preconditions: readonly string[];
  readonly requiredSignals: readonly string[];
  readonly contraryEvidence: readonly string[];
  readonly minimumCoverage: readonly string[];
  readonly severityRules: readonly string[];
  readonly confidenceRules: readonly string[];
  readonly responseOptions: readonly { readonly id: string; readonly guidance: string; readonly adapter: 'none' | string }[];
  readonly stopConditions: readonly string[];
  readonly supported: boolean;
  readonly reason: string;
}
const guide = (id: string, guidance: string, adapter: 'none' | string = 'none') => ({ id, guidance, adapter });
const catalog = [
  ['code-vulnerability','Code vulnerability',true,'Source scanners provide limited static coverage.',['authorized source snapshot'],['scanner finding'],['independent review','runtime reachability unknown'],['coverage unavailable','no reachability evidence']],
  ['dependency-vulnerability','Dependency vulnerability',true,'Advisories do not establish use or exploitability.',['dependency inventory'],['exact advisory match'],['lockfile and package identity'],['exact version mismatch']],
  ['exposed-secret','Exposed secret',true,'A secret-like value requires issuer-side validity and revocation checks.',['authorized source snapshot'],['secret scanner finding'],['issuer identity and validity'],['redacted value','no issuer confirmation']],
  ['insecure-configuration','Insecure configuration',true,'Literal configuration checks are not runtime proof.',['authorized configuration'],['configuration finding'],['relevant config coverage'],['config not loaded']],
  ['abusive-authentication','Abusive authentication',true,'Failures indicate suspicious activity, not account compromise.',['auth failure telemetry'],['repeated failures'],['success events and scoped actor coverage'],['failures only']],
  ['enumeration','Enumeration',false,'Route enumeration lacks a complete route-level detector contract.',['route outcomes'],['unusual route breadth'],['route and actor coverage'],['incomplete route inventory']],
  ['application-error','Application error',true,'Errors indicate a reliability symptom, not an attack.',['error telemetry'],['error rate increase'],['matching service baseline'],['stale telemetry']],
  ['release-regression','Release regression',true,'Requires a deployment, a service error rise, and no degraded dependency evidence.',['deployment time','service error series'],['release in window and error rise'],['dependency status and service baseline'],['dependency degraded','deployment unverified']],
  ['unavailability','Unavailability',true,'Only checked points support a scoped availability statement.',['independent HTTPS probes'],['unavailable probe'],['multiple relevant routes'],['no probes']],
  ['dns-tls-failure','DNS/TLS failure',false,'DNS and TLS diagnostic coverage is not yet represented by these inputs.',['authorized DNS/TLS probe'],['DNS/TLS failure'],['independent resolver and certificate evidence'],['probe unavailable']],
  ['provider-failure','External dependency/provider failure',true,'Provider status is upstream context; customer impact needs compatible dependency and service evidence.',['provider status','verified dependency','service probe/metrics'],['matching dependency failures'],['regional/component scope'],['global-only status','healthy control route']],
  ['resource-exhaustion','Resource exhaustion',true,'Resource pressure is not automatically caused by traffic or an attack.',['resource utilization','service baseline'],['sustained utilization rise'],['fresh resource samples'],['no error/latency impact']],
  ['legitimate-traffic-increase','Legitimate traffic increase',true,'Traffic growth without degradation is not grounds for capacity changes.',['request rate','baseline'],['request increase without impact'],['fresh error and latency signals'],['degradation observed']],
] as const;
export const scenarioCatalog: readonly ScenarioEntry[] = Object.freeze(catalog.map(([id,title,supported,reason,preconditions,requiredSignals,contraryEvidence,minimumCoverage]) => ({
  id, version: '1.0.0', title, supported, reason, preconditions, requiredSignals, contraryEvidence, minimumCoverage,
  severityRules: ['Report observed impact separately from scenario severity.', 'Severity never grants permissions.'],
  confidenceRules: ['Use ordinal confidence only with listed evidence.', 'Temporal coincidence alone is weak at most.'],
  responseOptions: [guide('investigate', 'Collect the missing scoped evidence.'), guide('review', 'Review the evidence with an authorized operator.')],
  stopConditions: ['Stop when evidence is stale, out of scope, or the required coverage is unavailable.'],
} satisfies ScenarioEntry)));

export type SupportMatrixEntry = Pick<ScenarioEntry, 'id' | 'version' | 'title' | 'supported' | 'reason'>;
export function supportMatrix(): readonly SupportMatrixEntry[] {
  return scenarioCatalog.map(({ id, version, title, supported, reason }) => ({ id, version, title, supported, reason }));
}
