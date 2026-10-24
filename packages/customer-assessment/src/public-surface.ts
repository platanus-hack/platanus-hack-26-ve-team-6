import { z } from 'zod';
import { customerRunInputSchema } from '@gotchu/contracts';
import { analysis, evidence, finding, finish, sha256 } from './common.js';
import { createHttpsPageProbe, type HttpsOptions } from './https.js';
import { deriveHttpResponseFindings } from './response-findings.js';

const customerTargetSchema = customerRunInputSchema.shape.target.unwrap();
export const publicSurfaceTargetSchema = customerTargetSchema.extend({ scanProfile: z.literal('public_surface') }).strict();

export type PublicSurfaceTarget = z.infer<typeof publicSurfaceTargetSchema>;
export type PublicSurfaceDiscoverySource = 'profile' | 'robots_sitemap' | 'sitemap' | 'html_link';
export type PublicSurfaceStopReason = 'authorization_expired' | 'deadline_exceeded' | 'request_cap' | 'response_byte_cap' | 'discovery_candidate_cap';
export type PublicSurfaceCoverageGap = 'authorization_expired' | 'deadline_exceeded' | 'response_byte_cap' | 'request_cap' | 'discovery_candidate_cap' | 'transport_unavailable' | 'discovery_response_incomplete' | 'discovery_source_not_readable';

export interface PublicSurfaceEntrypoint {
  path: string;
  discoveredBy: PublicSurfaceDiscoverySource;
  observedAt: string;
  requestAttempted: boolean;
  status: number | null;
  headers: Readonly<Record<string, string>>;
  tlsVerified: boolean | null;
  bodyBytes: number;
  incomplete: string | null;
}

/** A typed inventory of the explicitly authorized origin, not a company-wide asset list. */
export interface PublicSurfaceInventory {
  profile: 'public_surface';
  asset: { type: 'verified_https_origin'; targetId: string; targetVersion: number; origin: string };
  entrypoints: PublicSurfaceEntrypoint[];
  requestAttempts: number;
  responseBytes: number;
  maxRequests: 10;
  maxResponseBytes: 65_536;
  unrequestedEntrypoints: number;
  unrequestedKnownPaths: string[];
  ignoredCandidates: number;
  discoveryCandidateCapReached: boolean;
  discoveryIncomplete: boolean;
  unknownCoverage: PublicSurfaceCoverageGap[];
  stoppedBecause: PublicSurfaceStopReason | null;
}

const MAX_REQUESTS = 10 as const;
const MAX_RESPONSE_BYTES = 65_536 as const;
const MAX_PAGE_BYTES = 16_384;
const MAX_DISCOVERY_CANDIDATES = 100;
const REQUEST_INTERVAL_MS = 250;
const KNOWN_PATHS: ReadonlyArray<{ path: string; source: PublicSurfaceDiscoverySource }> = [
  { path: '/', source: 'profile' },
  { path: '/.well-known/security.txt', source: 'profile' },
  { path: '/security.txt', source: 'profile' },
  { path: '/robots.txt', source: 'profile' },
  { path: '/sitemap.xml', source: 'profile' },
];

interface QueuedEntrypoint { path: string; source: PublicSurfaceDiscoverySource }

function isSafePath(path: string) {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('//') || path.length > 512 || /[?#\\\x00-\x20\x7f]/.test(path) || /%(?:2f|5c)/i.test(path)) return false;
  try {
    const decoded = decodeURIComponent(path);
    return !/[\x00-\x20\x7f]/.test(decoded) && !decoded.includes('\\') && !decoded.split('/').some(part => part === '.' || part === '..');
  } catch { return false; }
}

function decodeEntities(value: string) {
  return value.replace(/&(?:amp|#0*38|#x0*26);/gi, '&')
    .replace(/&(?:quot|#0*34|#x0*22);/gi, '"')
    .replace(/&(?:apos|#0*39|#x0*27);/gi, "'")
    .replace(/&(?:lt|#0*60|#x0*3c);/gi, '<')
    .replace(/&(?:gt|#0*62|#x0*3e);/gi, '>');
}

function resolvesToSameOriginPath(origin: string, basePath: string, reference: string) {
  const candidate = decodeEntities(reference).trim();
  if (!candidate || candidate.length > 2_048 || /[?#\x00-\x20\x7f\\]/.test(candidate)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(candidate); } catch { return null; }
  const pathPart = decoded.split(/[?#]/, 1)[0] ?? '';
  if (pathPart.split('/').some(part => part === '.' || part === '..')) return null;
  try {
    const base = new URL(basePath, origin);
    const url = new URL(candidate, base);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.search || url.hash || !isSafePath(url.pathname)) return null;
    return url.pathname;
  } catch { return null; }
}

function htmlLinks(body: string) {
  const links: string[] = [];
  const anchor = /<a\b[^>]{0,2048}?\bhref\s*=\s*(?:"([^"]{0,2048})"|'([^']{0,2048})'|([^\s"'=<>`]{1,2048}))/gi;
  let truncated = false;
  for (const match of body.matchAll(anchor)) {
    if (links.length >= MAX_DISCOVERY_CANDIDATES) { truncated = true; break; }
    const link = match[1] ?? match[2] ?? match[3];
    if (link) links.push(link);
  }
  return { links, truncated };
}

function sitemapLinks(body: string) {
  const links: string[] = [];
  const loc = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi;
  let truncated = false;
  for (const match of body.matchAll(loc)) {
    if (links.length >= MAX_DISCOVERY_CANDIDATES) { truncated = true; break; }
    const value = match[1]?.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim();
    if (value) links.push(value);
  }
  return { links, truncated };
}

function robotsSitemaps(body: string) {
  const links: string[] = [];
  let truncated = false;
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S+)\s*$/i.exec(line);
    if (match?.[1] && links.length >= MAX_DISCOVERY_CANDIDATES) { truncated = true; break; }
    if (match?.[1]) links.push(match[1]);
  }
  return { links, truncated };
}

function waitForInterval(signal: AbortSignal) {
  return new Promise<boolean>(resolve => {
    if (signal.aborted) { resolve(false); return; }
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(ready);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), REQUEST_INTERVAL_MS);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function entrypoint(path: string, source: PublicSurfaceDiscoverySource, data: Partial<PublicSurfaceEntrypoint> = {}): PublicSurfaceEntrypoint {
  return {
    path,
    discoveredBy: source,
    observedAt: data.observedAt ?? new Date().toISOString(),
    requestAttempted: data.requestAttempted ?? false,
    status: data.status ?? null,
    headers: data.headers ?? {},
    tlsVerified: data.tlsVerified ?? null,
    bodyBytes: data.bodyBytes ?? 0,
    incomplete: data.incomplete ?? null,
  };
}

function markUnknown(inventory: PublicSurfaceInventory, gap: PublicSurfaceCoverageGap) {
  inventory.discoveryIncomplete = true;
  if (!inventory.unknownCoverage.includes(gap)) inventory.unknownCoverage.push(gap);
}

function likelyXml(path: string, contentType: string | undefined) {
  return /\.xml$/i.test(path) || /(?:application|text)\/(?:xml|[^;]+\+xml)/i.test(contentType ?? '');
}

function classifyDiscoverySource(path: string, headers: Readonly<Record<string, string>>) {
  if (path === '/robots.txt') return 'robots' as const;
  if (/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(headers['content-type'] ?? '')) return 'html' as const;
  if (likelyXml(path, headers['content-type'])) return 'sitemap' as const;
  return 'html' as const;
}

async function runPublicSurfaceProbe(target: PublicSurfaceTarget, signal: AbortSignal, probePage: ReturnType<typeof createHttpsPageProbe>): Promise<PublicSurfaceInventory> {
    const inventory: PublicSurfaceInventory = {
      profile: 'public_surface',
      asset: { type: 'verified_https_origin', targetId: target.id, targetVersion: target.version, origin: target.origin },
      entrypoints: [], requestAttempts: 0, responseBytes: 0, maxRequests: MAX_REQUESTS,
      maxResponseBytes: MAX_RESPONSE_BYTES, unrequestedEntrypoints: 0, unrequestedKnownPaths: [],
      ignoredCandidates: 0, discoveryCandidateCapReached: false, discoveryIncomplete: false, unknownCoverage: [], stoppedBecause: null,
    };

    const queue: QueuedEntrypoint[] = KNOWN_PATHS.map(item => ({ ...item }));
    const queuedPaths = new Set(queue.map(item => item.path));
    let cursor = 0;
    let discoveredCandidates = 0;
    const addCandidates = (links: ReadonlyArray<string>, source: PublicSurfaceDiscoverySource, basePath: string, truncated = false) => {
      if (truncated) {
        inventory.discoveryCandidateCapReached = true;
        markUnknown(inventory, 'discovery_candidate_cap');
      }
      for (const link of links) {
        if (discoveredCandidates >= MAX_DISCOVERY_CANDIDATES) {
          inventory.discoveryCandidateCapReached = true;
          markUnknown(inventory, 'discovery_candidate_cap');
          continue;
        }
        discoveredCandidates++;
        const path = resolvesToSameOriginPath(target.origin, basePath, link);
        if (!path) { inventory.ignoredCandidates++; continue; }
        if (queuedPaths.has(path)) continue;
        queuedPaths.add(path);
        queue.push({ path, source });
      }
    };

    while (cursor < queue.length && inventory.requestAttempts < MAX_REQUESTS) {
      const current = queue[cursor];
      if (!current) break;
      cursor++;

      if (inventory.requestAttempts > 0 && !(await waitForInterval(signal))) {
        markUnknown(inventory, 'deadline_exceeded');
        inventory.stoppedBecause = 'deadline_exceeded';
        inventory.entrypoints.push(entrypoint(current.path, current.source, { incomplete: 'deadline_exceeded' }));
        break;
      }
      if (signal.aborted) {
        markUnknown(inventory, 'deadline_exceeded');
        inventory.stoppedBecause = 'deadline_exceeded';
        inventory.entrypoints.push(entrypoint(current.path, current.source, { incomplete: 'deadline_exceeded' }));
        break;
      }
      if (Date.parse(target.verifiedAt) > Date.now() || Date.parse(target.expiresAt) <= Date.now()) {
        markUnknown(inventory, 'authorization_expired');
        inventory.stoppedBecause = 'authorization_expired';
        inventory.entrypoints.push(entrypoint(current.path, current.source, { incomplete: 'authorization_expired' }));
        break;
      }
      const remainingBodyBytes = MAX_RESPONSE_BYTES - inventory.responseBytes;
      if (remainingBodyBytes <= 0) {
        cursor--;
        markUnknown(inventory, 'response_byte_cap');
        inventory.stoppedBecause = 'response_byte_cap';
        break;
      }

      inventory.requestAttempts++;
      let page;
      try {
        page = await probePage(target.origin, current.path, signal, target.expiresAt, Math.min(MAX_PAGE_BYTES, remainingBodyBytes));
      } catch {
        const expired = Date.parse(target.expiresAt) <= Date.now();
        const deadline = signal.aborted;
        const incomplete = expired ? 'authorization_expired' : deadline ? 'deadline_exceeded' : 'transport_unavailable';
        inventory.entrypoints.push(entrypoint(current.path, current.source, { requestAttempted: true, incomplete }));
        markUnknown(inventory, expired ? 'authorization_expired' : deadline ? 'deadline_exceeded' : 'transport_unavailable');
        if (expired) inventory.stoppedBecause = 'authorization_expired';
        else if (deadline) inventory.stoppedBecause = 'deadline_exceeded';
        if (inventory.stoppedBecause) break;
        continue;
      }

      inventory.responseBytes += page.bodyBytes;
      inventory.entrypoints.push(entrypoint(current.path, current.source, {
        observedAt: new Date().toISOString(), requestAttempted: true, status: page.status, headers: page.headers, tlsVerified: page.tlsVerified,
        bodyBytes: page.bodyBytes, incomplete: page.incomplete,
      }));
      if (page.incomplete === 'deadline_exceeded') {
        markUnknown(inventory, Date.parse(target.expiresAt) <= Date.now() ? 'authorization_expired' : 'deadline_exceeded');
        inventory.stoppedBecause = Date.parse(target.expiresAt) <= Date.now() ? 'authorization_expired' : 'deadline_exceeded';
        break;
      }
      if (page.incomplete && (current.path === '/' || current.path === '/robots.txt' || likelyXml(current.path, page.headers['content-type']) || /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(page.headers['content-type'] ?? ''))) markUnknown(inventory, 'discovery_response_incomplete');
      if ((current.path === '/' || current.path === '/robots.txt' || likelyXml(current.path, page.headers['content-type']))
        && (page.status === 401 || page.status === 403 || page.status >= 500)) markUnknown(inventory, 'discovery_source_not_readable');
      if (current.path === '/' && page.status >= 200 && page.status < 300 && !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(page.headers['content-type'] ?? '') && !likelyXml(current.path, page.headers['content-type'])) markUnknown(inventory, 'discovery_source_not_readable');
      if (page.status < 200 || page.status >= 300 || page.incomplete) continue;

      const source = classifyDiscoverySource(current.path, page.headers);
      if (source === 'robots') {
        const extracted = robotsSitemaps(page.body);
        addCandidates(extracted.links, 'robots_sitemap', current.path, extracted.truncated);
      } else if (source === 'sitemap') {
        const extracted = sitemapLinks(page.body);
        addCandidates(extracted.links, 'sitemap', current.path, extracted.truncated);
      } else if (/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(page.headers['content-type'] ?? '')) {
        const extracted = htmlLinks(page.body);
        addCandidates(extracted.links, 'html_link', current.path, extracted.truncated);
      }
    }

    const unrequested = queue.slice(cursor);
    inventory.unrequestedEntrypoints = unrequested.length;
    inventory.unrequestedKnownPaths = unrequested.filter(item => item.source === 'profile').map(item => item.path);
    if (unrequested.length > 0) {
      if (inventory.requestAttempts >= MAX_REQUESTS && inventory.stoppedBecause === null) {
        inventory.stoppedBecause = 'request_cap';
        markUnknown(inventory, 'request_cap');
      } else if (inventory.responseBytes >= MAX_RESPONSE_BYTES && inventory.stoppedBecause === null) {
        inventory.stoppedBecause = 'response_byte_cap';
        markUnknown(inventory, 'response_byte_cap');
      }
    }
    if (inventory.discoveryCandidateCapReached && inventory.stoppedBecause === null) inventory.stoppedBecause = 'discovery_candidate_cap';
    return inventory;
}

export function createPublicSurfaceProbe(options: HttpsOptions = {}) {
  const probePage = createHttpsPageProbe(options);
  return (rawTarget: unknown, signal: AbortSignal): Promise<PublicSurfaceInventory> => runPublicSurfaceProbe(publicSurfaceTargetSchema.parse(rawTarget), signal, probePage);
}

function coverageDetail(inventory: PublicSurfaceInventory) {
  const parts = [`Observed ${inventory.entrypoints.filter(item => item.status !== null).length} HTTP responses from ${inventory.requestAttempts} bounded HTTPS request attempts. Every successful response followed a fresh DNS lookup, public-address validation and pinning, and TLS verification for the enrolled hostname.`];
  if (inventory.unrequestedKnownPaths.length) parts.push(`Known paths not requested: ${inventory.unrequestedKnownPaths.join(', ')}.`);
  if (inventory.unrequestedEntrypoints > 0) parts.push(`${inventory.unrequestedEntrypoints} queued same-origin candidates were left unknown by the profile bound.`);
  if (inventory.ignoredCandidates > 0) parts.push(`Ignored ${inventory.ignoredCandidates} candidates that were cross-origin, used a query/fragment, or failed safe-path checks.`);
  if (inventory.discoveryCandidateCapReached) parts.push(`Candidate extraction stopped after ${MAX_DISCOVERY_CANDIDATES} links.`);
  if (inventory.stoppedBecause) parts.push(`Stopped because ${inventory.stoppedBecause}.`);
  if (inventory.unknownCoverage.length) {
    const descriptions: Record<PublicSurfaceCoverageGap, string> = {
      authorization_expired: 'authorization expired before all profile requests completed',
      deadline_exceeded: 'the profile deadline ended before all requests completed',
      response_byte_cap: 'the total response-byte cap left entrypoints unrequested',
      request_cap: 'the request cap left same-origin entrypoints unrequested',
      discovery_candidate_cap: 'candidate extraction reached its fixed cap',
      transport_unavailable: 'a requested entrypoint did not return a TLS-verified HTTP response',
      discovery_response_incomplete: 'a response used for discovery was truncated, redirected, or interrupted',
      discovery_source_not_readable: 'an index response was protected, failed, or had no supported content type',
    };
    parts.push(`Coverage gaps: ${inventory.unknownCoverage.map(gap => descriptions[gap]).join('; ')}.`);
  }
  return parts.join(' ');
}

export async function assessPublicSurface(target: PublicSurfaceTarget, signal: AbortSignal, options: HttpsOptions = {}) {
  const parsedTarget = publicSurfaceTargetSchema.parse(target);
  const snapshotRef = `target:${parsedTarget.id}:${parsedTarget.version}:${sha256(parsedTarget.origin)}:public_surface`;
  const a = analysis('external', snapshotRef);
  const result = await runPublicSurfaceProbe(parsedTarget, signal, createHttpsPageProbe(options));
  a.limitations.push(
    'The public_surface profile makes at most 10 serial same-origin HTTPS GET requests, waits 250 ms between requests, and reads at most 64 KiB total with a 16 KiB per-response limit.',
    'Only the verified origin is in scope. The profile checks the root, two security.txt locations, robots.txt, sitemap.xml, and bounded query-free links from parseable same-origin HTML or sitemap sources.',
    'This is not a company-wide asset inventory. Subdomains, other ports, non-HTTPS services, JavaScript-generated routes, authenticated routes, query-based routes, API methods, and redirect destinations remain unknown.',
    'No response bodies, cookies, authorization headers, redirect locations, or customer credentials are retained. HTTP status and selected response headers apply only to the requested path.',
  );
  let completeResponseCount = 0;
  for (const item of result.entrypoints) {
    if (item.status === null || !item.tlsVerified) continue;
    const id = evidence(a, 'http_response', `${parsedTarget.origin}${item.path}`, {
      profile: result.profile, targetId: parsedTarget.id, targetVersion: parsedTarget.version,
      path: item.path, discoveredBy: item.discoveredBy, status: item.status, headers: item.headers,
      tlsVerified: item.tlsVerified, bodyBytes: item.bodyBytes, incomplete: item.incomplete,
    }, { name: 'node:https', version: process.versions.node }, item.observedAt);
    if (item.incomplete === null) completeResponseCount++;
    for (const responseFinding of deriveHttpResponseFindings({
      location: `${parsedTarget.origin}${item.path}`, status: item.status, headers: item.headers,
      tlsVerified: item.tlsVerified, incomplete: item.incomplete, evidenceId: id,
    })) finding(a, responseFinding);
  }
  const unknownResponseCount = result.entrypoints.filter(item =>
    item.status === null || !item.tlsVerified || item.incomplete !== null,
  ).length + result.unrequestedEntrypoints;
  const responseHeaderCoverageComplete = completeResponseCount > 0 && unknownResponseCount === 0;
  const pathsWithResponses = new Set(result.entrypoints.filter(item => item.status !== null && item.tlsVerified).map(item => item.path));
  const missingKnown = KNOWN_PATHS.filter(item => !pathsWithResponses.has(item.path)).map(item => item.path);
  const rootObserved = pathsWithResponses.has('/');
  const allKnownObserved = missingKnown.length === 0;
  const discoveryComplete = !result.discoveryIncomplete && result.unrequestedEntrypoints === 0;
  a.coverage.push(
    { capability: 'public_surface_origin', state: rootObserved ? 'inspected' : 'unavailable', detail: rootObserved ? `Observed the verified HTTPS origin. ${coverageDetail(result)}` : `The root response could not be verified. ${coverageDetail(result)}` },
    { capability: 'public_surface_known_paths', state: allKnownObserved ? 'inspected' : 'unavailable', detail: allKnownObserved ? `Received TLS-verified HTTP responses from the fixed known paths. ${coverageDetail(result)}` : `Known paths without a TLS-verified HTTP response: ${missingKnown.join(', ')}. ${coverageDetail(result)}` },
    { capability: 'public_surface_response_headers', state: responseHeaderCoverageComplete ? 'inspected' : 'unavailable', detail: `Derived path-specific findings from ${completeResponseCount} complete TLS-verified HTTP responses. ${unknownResponseCount} attempted or queued responses have unknown header coverage; no header absence is inferred for incomplete, failed, or unrequested paths.` },
    { capability: 'same_origin_link_discovery', state: discoveryComplete ? 'inspected' : 'unavailable', detail: `${coverageDetail(result)} Only parseable HTML anchors, robots.txt Sitemap directives, and sitemap loc entries were considered.` },
    { capability: 'authenticated_routes', state: 'unsupported', detail: 'No credentials or authenticated requests were used. A 401/403 response does not establish the behavior or completeness of protected routes.' },
    { capability: 'subdomains_and_non_https_services', state: 'unsupported', detail: 'No subdomain enumeration, alternate port checks, non-HTTPS checks, or company-wide asset discovery were performed.' },
    { capability: 'javascript_and_query_routes', state: 'unsupported', detail: 'JavaScript was not executed, API methods were not called, and links with a query or fragment were ignored.' },
  );
  return finish(a);
}
