import { createHttpsProbe, type HttpsObservation, type HttpsOptions } from '@gotchu/customer-assessment';
import { customerOriginSchema } from '@gotchu/contracts';
import type { TrustedCustomerTarget, MonitoringCandidate, MonitoringEvidence } from './types.js';
import { canonicalJson, sha256 } from './source.js';
import { MONITORING_ADAPTER_VERSION } from './types.js';

export interface AuthorizedHttpsHealthOptions {
  https?: HttpsOptions;
  probe?: (origin: string, signal: AbortSignal, expiresAt: string) => Promise<HttpsObservation>;
  now?: () => Date;
  ttlMs?: number;
}

export interface AuthorizedHttpsHealthObservation {
  targetId: string;
  targetVersion: number;
  origin: string;
  observedAt: string;
  expiresAt: string;
  status: number;
  headers: Record<string, string>;
  bodyBytes: number;
  tlsVerified: true;
  incomplete: string | null;
  evidence: MonitoringEvidence;
  candidate: MonitoringCandidate | null;
  limitations: string[];
}

export function createAuthorizedHttpsHealthAdapter(options: AuthorizedHttpsHealthOptions = {}) {
  const probe = options.probe ?? createHttpsProbe(options.https);
  return {
    async read(target: TrustedCustomerTarget, signal: AbortSignal): Promise<AuthorizedHttpsHealthObservation> {
      const now = (options.now ?? (() => new Date()))();
      assertTrustedTarget(target, now.getTime());
      const origin = customerOriginSchema.parse(target.origin);
      const observedAt = now.toISOString();
      const result = await probe(origin, signal, target.expiresAt);
      const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1000) throw new Error('invalid_health_observation_ttl');
      const expiresAt = new Date(Date.parse(observedAt) + ttlMs).toISOString();
      const checksum = sha256(canonicalJson({
        status: result.status,
        headers: result.headers,
        bodyBytes: result.bodyBytes,
        tlsVerified: result.tlsVerified,
        incomplete: result.incomplete,
        targetId: target.id,
        targetVersion: target.version,
        origin,
        observedAt,
      }));
      const evidence: MonitoringEvidence = {
        source: 'assessment',
        reference: origin + '/',
        checksum,
        collectedAt: observedAt,
        adapter: 'authorized_public_https_probe',
        adapterVersion: MONITORING_ADAPTER_VERSION,
      };
      const candidate = healthCandidate(result, evidence, observedAt, expiresAt);
      return {
        targetId: target.id,
        targetVersion: target.version,
        origin,
        observedAt,
        expiresAt,
        status: result.status,
        headers: result.headers,
        bodyBytes: result.bodyBytes,
        tlsVerified: result.tlsVerified,
        incomplete: result.incomplete,
        evidence,
        candidate,
        limitations: [
          'One bounded GET to the verified public HTTPS origin; no credentials, cookies, redirects, private addresses, or response body are retained.',
          'A successful root response does not establish application correctness or full service health.',
        ],
      };
    },
  };
}

function assertTrustedTarget(target: TrustedCustomerTarget, now: number): void {
  if (!target || typeof target !== 'object' || !target.id || !Number.isInteger(target.version) || target.version < 1
      || !target.verifiedAt || !target.expiresAt || !Number.isFinite(Date.parse(target.verifiedAt))
      || !Number.isFinite(Date.parse(target.expiresAt))) throw new Error('authorized_target_invalid');
  if (Date.parse(target.expiresAt) <= now) throw new Error('authorized_target_expired');
}

function healthCandidate(
  result: HttpsObservation,
  evidence: MonitoringEvidence,
  observedAt: string,
  expiresAt: string,
): MonitoringCandidate | null {
  if (!Number.isInteger(result.status) || result.status < 100 || result.status > 599) {
    return {
      kind: 'coverage_gap',
      summary: 'The authorized HTTPS probe returned no valid HTTP status code; target health remains unknown.',
      severity: 'info',
      confidence: 'low',
      observedAt,
      expiresAt,
      evidence: [evidence],
      metrics: null,
      incidentId: null,
      upstreamImpact: 'not_applicable',
    };
  }
  if (result.incomplete) {
    return {
      kind: 'coverage_gap',
      summary: 'The authorized public HTTPS probe did not complete fully: ' + result.incomplete + '. No application outage is asserted.',
      severity: 'info',
      confidence: 'low',
      observedAt,
      expiresAt,
      evidence: [evidence],
      metrics: null,
      incidentId: null,
      upstreamImpact: 'not_applicable',
    };
  }
  if (result.status >= 400 && result.status < 500) {
    return {
      kind: 'coverage_gap',
      summary: 'The authorized public HTTPS origin returned HTTP ' + result.status + '. The target responded, but service health is not confirmed by this status.',
      severity: 'info',
      confidence: 'low',
      observedAt,
      expiresAt,
      evidence: [evidence],
      metrics: null,
      incidentId: null,
      upstreamImpact: 'not_applicable',
    };
  }
  if (result.status < 400) {
    return {
      kind: 'coverage_check',
      summary: 'The authorized public HTTPS origin completed the bounded GET to / with HTTP ' + result.status + '. This confirms only the observed public endpoint response, not overall application health.',
      severity: 'info',
      confidence: 'high',
      observedAt,
      expiresAt,
      evidence: [evidence],
      metrics: null,
      incidentId: null,
      upstreamImpact: 'not_applicable',
    };
  }
  return {
    kind: 'public_surface',
    summary: 'The verified public HTTPS origin returned HTTP ' + result.status + ' during one bounded GET to /. This is a direct response observation, not proof of duration or cause.',
    severity: result.status >= 500 ? 'high' : 'medium',
    confidence: 'medium',
    observedAt,
    expiresAt,
    evidence: [evidence],
    metrics: null,
    incidentId: null,
    upstreamImpact: 'not_applicable',
  };
}
