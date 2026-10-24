import { osvAdvisoryMetadataSchema, type OsvAdvisoryMetadata } from '@gotchu/contracts';
import { z } from 'zod';

export const packageNameSchema = z.string().min(1).max(214).regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/);
const stableVersion = z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);

const registryReleaseSchema = z.object({
  version: z.string().max(100),
  dist: z.object({ tarball: z.string().url().max(2_048), integrity: z.string().max(512) }).passthrough(),
  dependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  peerDependenciesMeta: z.record(z.string(), z.unknown()).optional(),
  engines: z.unknown().optional(),
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  license: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  hasInstallScript: z.boolean().optional(),
  bundleDependencies: z.array(z.string()).optional(),
  bundledDependencies: z.array(z.string()).optional(),
}).passthrough();
export const npmPackumentSchema = z.object({ versions: z.record(z.string(), registryReleaseSchema) }).passthrough();

export interface NpmRegistryPort { getPackument(name: string, signal: AbortSignal): Promise<unknown> }

export const createNpmRegistryAdapter = (fetcher: typeof globalThis.fetch = globalThis.fetch): NpmRegistryPort => ({
  async getPackument(rawName, parentSignal) {
    const name = packageNameSchema.parse(rawName);
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(8_000)]);
    const response = await fetcher('https://registry.npmjs.org/' + encodeURIComponent(name), {
      method: 'GET', redirect: 'error', signal,
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    });
    if (!response.ok) throw new Error('npm_registry_http_failed');
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') throw new Error('npm_registry_encoding_unsupported');
    const contentLength = response.headers.get('content-length');
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > 1_048_576)) throw new Error('npm_registry_output_limit');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('npm_registry_body_missing');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 1_048_576) { await reader.cancel(); throw new Error('npm_registry_output_limit'); }
      chunks.push(result.value);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
    const payload: unknown = JSON.parse(text);
    return npmPackumentSchema.parse(payload);
  },
});

export type NpmFixReason = 'source_incomplete' | 'lockfile_unsupported' | 'package_not_direct' | 'transitive_override_not_supported'
  | 'workspace_not_supported'
  | 'advisory_metadata_missing' | 'advisory_withdrawn' | 'advisory_range_ambiguous' | 'advisory_version_mismatch'
  | 'no_patch_or_minor_fix' | 'package_tree_change_required' | 'prerelease_not_supported' | 'major_fix_required'
  | 'package_declaration_ambiguous' | 'lockfile_change_out_of_scope' | 'registry_unavailable' | 'source_not_repository_bound'
  | 'github_connection_unavailable' | 'validation_suite_missing';

type ParsedVersion = { major: number; minor: number; patch: number };
function parseStableVersion(value: string): ParsedVersion | undefined {
  const parsed = stableVersion.safeParse(value);
  if (!parsed.success) return undefined;
  const [major, minor, patch] = value.split('.').map(Number);
  return major === undefined || minor === undefined || patch === undefined ? undefined : { major, minor, patch };
}
function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}
function parseOsvRange(range: { type: string; events: Array<{ introduced?: string | undefined; fixed?: string | undefined; last_affected?: string | undefined; limit?: string | undefined }> }): Array<{ start: string; end: string | null; endInclusive: boolean }> | undefined {
  if (range.type !== 'SEMVER') return undefined;
  const intervals: Array<{ start: string; end: string | null; endInclusive: boolean }> = [];
  let start: string | null = null;
  for (const event of range.events) {
    const [kind, value] = Object.entries(event).find(([, item]) => item !== undefined) ?? [];
    if (!kind || typeof value !== 'string' || value.length === 0) return undefined;
    if (kind === 'introduced') {
      if (start !== null || value !== '0' && !parseStableVersion(value)) return undefined;
      start = value === '0' ? '0.0.0' : value;
      continue;
    }
    if ((kind !== 'fixed' && kind !== 'last_affected') || start === null || !parseStableVersion(value)) return undefined;
    intervals.push({ start, end: value, endInclusive: kind === 'last_affected' });
    start = null;
  }
  if (start !== null) intervals.push({ start, end: null, endInclusive: false });
  return intervals.length ? intervals : undefined;
}

function versionInRange(version: string, intervals: readonly { start: string; end: string | null; endInclusive: boolean }[]): boolean {
  const value = parseStableVersion(version);
  if (!value) return false;
  return intervals.some(interval => {
    const start = parseStableVersion(interval.start);
    const end = interval.end ? parseStableVersion(interval.end) : null;
    if (!start || compareVersions(value, start) < 0) return false;
    if (!end) return true;
    const comparison = compareVersions(value, end);
    return interval.endInclusive ? comparison <= 0 : comparison < 0;
  });
}

function advisoryAffects(advisory: OsvAdvisoryMetadata, name: string, version: string): { affected: boolean; reason?: NpmFixReason } {
  const entries = advisory.affected.filter(item => item.package.ecosystem === 'npm' && item.package.name === name);
  if (!entries.length) return { affected: false, reason: 'advisory_version_mismatch' };
  let affected = false;
  for (const entry of entries) {
    const versions = entry.versions ?? [];
    if (versions.some(item => !parseStableVersion(item))) return { affected: false, reason: 'advisory_range_ambiguous' };
    let rangeAffected = false;
    if (entry.ranges?.length) {
      for (const range of entry.ranges) {
        const intervals = parseOsvRange(range);
        if (!intervals) return { affected: false, reason: 'advisory_range_ambiguous' };
        rangeAffected ||= versionInRange(version, intervals);
      }
    } else if (!versions.length) return { affected: false, reason: 'advisory_range_ambiguous' };
    affected ||= versions.includes(version) || rangeAffected;
  }
  return { affected };
}

function compatibleWithDeclaration(declaration: string, from: string, to: ParsedVersion): boolean {
  const current = parseStableVersion(from);
  if (!current) return false;
  const match = /^(\^|~)?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.exec(declaration);
  if (!match) return declaration === from && to.major === current.major;
  const [, operator, majorText, minorText, patchText] = match;
  const base = { major: Number(majorText), minor: Number(minorText), patch: Number(patchText) };
  if (!operator) return declaration === from;
  if (compareVersions(to, base) < 0) return false;
  if (operator === '~') return to.major === base.major && to.minor === base.minor;
  if (base.major > 0) return to.major === base.major;
  if (base.minor > 0) return to.major === 0 && to.minor === base.minor;
  return to.major === 0 && to.minor === 0 && to.patch === base.patch;
}

export function selectNpmFixVersion(input: {
  name: string; fromVersion: string; declaration: string; advisories: readonly OsvAdvisoryMetadata[]; packument: unknown;
}): { toVersion: string } | { reason: NpmFixReason } {
  const current = parseStableVersion(input.fromVersion);
  if (!current) return { reason: 'prerelease_not_supported' };
  if (input.declaration !== input.fromVersion && !/^(?:\^|~)?(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/.test(input.declaration)) {
    return { reason: 'package_declaration_ambiguous' };
  }
  if (!compatibleWithDeclaration(input.declaration, input.fromVersion, current)) return { reason: 'package_declaration_ambiguous' };
  const parsedPackument = npmPackumentSchema.safeParse(input.packument);
  if (!parsedPackument.success) return { reason: 'no_patch_or_minor_fix' };
  const advisories = input.advisories.map(advisory => osvAdvisoryMetadataSchema.safeParse(advisory));
  if (advisories.some(advisory => !advisory.success)) return { reason: 'advisory_range_ambiguous' };
  const active = advisories.flatMap(result => result.success ? [result.data] : []).filter(advisory => advisory.withdrawn === undefined || advisory.withdrawn === null);
  if (!active.length) return { reason: 'advisory_withdrawn' };
  for (const advisory of active) {
    const currentResult = advisoryAffects(advisory, input.name, input.fromVersion);
    if (currentResult.reason) return { reason: currentResult.reason };
    if (!currentResult.affected) return { reason: 'advisory_version_mismatch' };
  }
  const versions = Object.keys(parsedPackument.data.versions).flatMap(version => {
    const parsed = parseStableVersion(version);
    return parsed ? [{ version, parsed }] : [];
  }).filter(item => item.parsed.major === current.major && compareVersions(item.parsed, current) > 0)
    .sort((left, right) => compareVersions(left.parsed, right.parsed));
  let majorFixExists = false;
  for (const item of Object.keys(parsedPackument.data.versions)) {
    const parsed = parseStableVersion(item);
    if (parsed && parsed.major > current.major && active.every(advisory => !advisoryAffects(advisory, input.name, item).affected)) majorFixExists = true;
  }
  for (const candidate of versions) {
    let fixed = true;
    for (const advisory of active) {
      const result = advisoryAffects(advisory, input.name, candidate.version);
      if (result.reason) return { reason: result.reason };
      if (result.affected) { fixed = false; break; }
    }
    if (fixed) return { toVersion: candidate.version };
  }
  return { reason: majorFixExists ? 'major_fix_required' : 'no_patch_or_minor_fix' };
}
