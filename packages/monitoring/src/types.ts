import type { CustomerSourceSnapshot, CustomerRunInput } from '@gotchu/contracts';

export const MONITORING_ADAPTER_VERSION = '0.1.0';

export type OperationObservationKind =
  | 'repository_change'
  | 'dependency_advisory'
  | 'public_surface'
  | 'upstream_outage'
  | 'coverage_gap'
  | 'coverage_check';
export type ObservationSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type ObservationConfidence = 'low' | 'medium' | 'high';

/**
 * Structural match for the operation contract. Adapters return evidence only;
 * the coordinator adds the tenant scope, idempotency key, and run/lease basis.
 */
export interface MonitoringEvidence {
  source: 'repository' | 'provider_status' | 'assessment' | 'advisory_database';
  reference: string;
  checksum: string;
  collectedAt: string;
  adapter: string;
  adapterVersion: string;
}

export interface MonitoringCandidate {
  kind: OperationObservationKind;
  summary: string;
  severity: ObservationSeverity;
  confidence: ObservationConfidence;
  observedAt: string;
  expiresAt: string;
  evidence: MonitoringEvidence[];
  metrics: null;
  incidentId: null;
  upstreamImpact: 'unverified' | 'not_applicable';
}

export interface RepositoryCommit {
  sha: string;
  committedAt: string | null;
  treeSha: string | null;
}

export interface RepositoryChange {
  state: 'baseline' | 'unchanged' | 'changed';
  previousRevision: string | null;
  revision: string;
  files: Array<{ path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' }>;
  filesTruncated: boolean;
  historyTruncated: boolean;
}

export interface RepositorySnapshotObservation {
  repositoryKey: string;
  provider: 'local_git' | 'github';
  commit: RepositoryCommit;
  change: RepositoryChange;
  snapshot: CustomerSourceSnapshot;
  digest: string;
  includedFiles: number;
  excludedUnsupportedFiles: number;
  excludedSymlinks: number;
  excludedSubmodules: number;
  capturedAt: string;
  evidence: MonitoringEvidence[];
  candidate: MonitoringCandidate | null;
  limitations: string[];
}

export type TrustedCustomerTarget = NonNullable<CustomerRunInput['target']>;

export interface ProviderStatusComponent {
  name: string;
  status: string;
}

export interface ProviderStatusObservation {
  provider: 'cloudflare' | 'railway';
  pageUrl: string;
  collectedAt: string;
  publishedAt: string | null;
  fresh: boolean;
  components: ProviderStatusComponent[];
  activeItems: Array<{ id: string | null; title: string; status: string }>;
  evidence: MonitoringEvidence;
  candidate: MonitoringCandidate | null;
  limitations: string[];
}

export interface DependencyAdvisory {
  id: string;
  packageName: string;
  version: string;
  summary: string | null;
  published: string | null;
  modified: string | null;
  aliases: string[];
  references: string[];
  databaseSeverity: ObservationSeverity | null;
  evidence: MonitoringEvidence[];
}

export interface DependencyObservation {
  repositoryKey: string;
  commitSha: string;
  lockfilesFound: number;
  packagesChecked: number;
  packagesSkipped: number;
  advisoryCount: number;
  advisories: DependencyAdvisory[];
  evidence: MonitoringEvidence[];
  complete: boolean;
  candidates: MonitoringCandidate[];
  limitations: string[];
}
