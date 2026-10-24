import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { AssessmentEvidence, DependencyArtifactAnalysis, DependencyArtifactFinding } from '@gotchu/contracts';

export const MAX_NPM_ARTIFACT_PACKAGES = 3;
export const MAX_NPM_TARBALL_BYTES = 8 * 1_048_576;
export const MAX_NPM_TARBALL_UNCOMPRESSED_BYTES = 32 * 1_048_576;
export const MAX_NPM_TARBALL_RATIO = 100;
export const MAX_NPM_TARBALL_FILES = 5_000;
export const MAX_NPM_ARTIFACT_SOURCE_BYTES = 4 * 1_048_576;
export const MAX_NPM_ARTIFACT_SOURCE_FILES = 1_000;

const npmName = z.string().max(214).regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/);
const semver = z.string().max(100).regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const registryMetadataSchema = z.object({
  name: npmName,
  version: semver,
  dist: z.object({ tarball: z.url(), integrity: z.string().max(1_024).optional() }).passthrough(),
}).passthrough();
const textSourcePath = /(?:^|\/)(?:[^/]+\.(?:[cm]?[jt]sx?|json|ya?ml|toml)|dockerfile(?:\.[a-z0-9_-]+)?)$/i;
const registryOrigin = 'https://registry.npmjs.org';

export interface NpmArtifactPackage { name: string; version: string; integrity: string | null }
export interface NpmArtifactSourceFile { path: string; content: string }
export interface NpmArtifactTool { name: 'semgrep' | 'gitleaks'; version: string; image: string; profileChecksum: string }
export interface NpmArtifactScanResult { findings: DependencyArtifactFinding[]; tools: NpmArtifactTool[]; evidence: AssessmentEvidence[]; complete: boolean }
export type NpmArtifactScanner = (input: { package: NpmArtifactPackage; artifactSha256: string; extractedFileCount: number }, files: readonly NpmArtifactSourceFile[], signal: AbortSignal) => Promise<NpmArtifactScanResult>;
export interface NpmArtifactReport { analysis: DependencyArtifactAnalysis; evidence: AssessmentEvidence[] }
export interface NpmArtifactAdapter { analyze(packages: readonly NpmArtifactPackage[], signal: AbortSignal): Promise<Map<string, NpmArtifactReport>> }
export interface NpmArtifactTransport { get(url: URL, limit: number, signal: AbortSignal): Promise<Buffer> }

class ArtifactError extends Error {
  readonly kind: 'unavailable' | 'unsafe_archive';
  constructor(kind: 'unavailable' | 'unsafe_archive', message: string) { super(message); this.kind = kind; }
}

function parseSha512Integrity(value: string | null) {
  if (value === null) return { state: 'missing' as const, digests: [] as string[] };
  const digests = value.split(/\s+/).flatMap(token => {
    const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(token);
    if (!match?.[1]) return [];
    const decoded = Buffer.from(match[1], 'base64');
    return decoded.length === 64 && decoded.toString('base64') === match[1] ? [decoded.toString('hex')] : [];
  });
  return digests.length ? { state: 'valid' as const, digests } : { state: 'invalid' as const, digests: [] as string[] };
}

export function verifySha512Integrity(integrity: string | null, artifact: Uint8Array): 'verified' | 'mismatch' | 'missing' | 'invalid' {
  const expected = parseSha512Integrity(integrity);
  if (expected.state === 'missing') return 'missing';
  if (expected.state === 'invalid') return 'invalid';
  const actual = createHash('sha512').update(artifact).digest('hex');
  return expected.digests.includes(actual) ? 'verified' : 'mismatch';
}

function boundedHttpsGet(url: URL, limit: number, signal: AbortSignal) {
  return new Promise<Buffer>((resolve, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, rejectUnauthorized: true, signal, maxHeaderSize: 8_192,
      headers: { accept: 'application/json, application/octet-stream', 'accept-encoding': 'identity' },
    }, response => {
      const encoding = response.headers['content-encoding'];
      if (response.statusCode !== 200 || encoding && encoding !== 'identity') {
        response.destroy(); reject(new ArtifactError('unavailable', 'registry_http_status')); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > limit) { response.destroy(); reject(new ArtifactError('unavailable', 'registry_response_limit')); }
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', () => reject(new ArtifactError('unavailable', 'registry_transport_error')));
    });
    req.on('error', () => reject(new ArtifactError('unavailable', 'registry_transport_error')));
    req.end();
  });
}

function registryMetadataPath(name: string, version: string) {
  const encodedName = encodeURIComponent(name).replace('%40', '@').replace('%2F', '%2f');
  return `${registryOrigin}/${encodedName}/${encodeURIComponent(version)}`;
}

function tarText(header: Buffer, start: number, length: number) {
  const end = header.indexOf(0, start);
  const value = header.subarray(start, end < 0 || end >= start + length ? start + length : end);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
  catch { throw new ArtifactError('unsafe_archive', 'archive_path_encoding'); }
}

function tarOctal(header: Buffer, start: number, length: number) {
  const value = header.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!value) return 0;
  if (!/^[0-7]+$/.test(value)) throw new ArtifactError('unsafe_archive', 'archive_invalid_numeric_field');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new ArtifactError('unsafe_archive', 'archive_invalid_numeric_field');
  return parsed;
}

function checkedTarPath(name: string, prefix: string) {
  const joined = [prefix, name].filter(Boolean).join('/').replace(/\/$/, '');
  if (!joined || joined.startsWith('/') || joined.includes('\\') || joined.includes('\0')) throw new ArtifactError('unsafe_archive', 'archive_path_rejected');
  const parts = joined.split('/');
  if (parts[0] !== 'package' || parts.some(part => !part || part === '.' || part === '..')) throw new ArtifactError('unsafe_archive', 'archive_path_rejected');
  return parts.slice(1).join('/');
}

function verifyTarHeader(header: Buffer) {
  const expected = tarOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index++) actual += index >= 148 && index < 156 ? 32 : header[index] ?? 0;
  if (actual !== expected) throw new ArtifactError('unsafe_archive', 'archive_header_checksum');
}

export function extractNpmTarball(compressed: Uint8Array): { files: NpmArtifactSourceFile[]; fileCount: number; capped: boolean } {
  if (compressed.byteLength === 0 || compressed.byteLength > MAX_NPM_TARBALL_BYTES) throw new ArtifactError('unsafe_archive', 'archive_compressed_size');
  let tar: Buffer;
  try { tar = gunzipSync(compressed, { maxOutputLength: MAX_NPM_TARBALL_UNCOMPRESSED_BYTES }); }
  catch { throw new ArtifactError('unsafe_archive', 'archive_decompression_limit_or_format'); }
  if (tar.byteLength > MAX_NPM_TARBALL_UNCOMPRESSED_BYTES || tar.byteLength / compressed.byteLength > MAX_NPM_TARBALL_RATIO) {
    throw new ArtifactError('unsafe_archive', 'archive_decompression_ratio');
  }
  if (tar.byteLength % 512 !== 0) throw new ArtifactError('unsafe_archive', 'archive_truncated');
  const files: NpmArtifactSourceFile[] = [];
  const paths = new Set<string>();
  let offset = 0;
  let fileCount = 0;
  let sourceBytes = 0;
  let capped = false;
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.subarray(offset).some(byte => byte !== 0)) throw new ArtifactError('unsafe_archive', 'archive_trailing_data');
      break;
    }
    verifyTarHeader(header);
    const name = tarText(header, 0, 100);
    const prefix = tarText(header, 345, 155);
    const size = tarOctal(header, 124, 12);
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156] ?? 0);
    const path = checkedTarPath(name, prefix);
    if (paths.has(path)) throw new ArtifactError('unsafe_archive', 'archive_duplicate_path');
    if (path) paths.add(path);
    if (type === '2' || type === '1') throw new ArtifactError('unsafe_archive', 'archive_link_rejected');
    if (type !== '0' && type !== '5') throw new ArtifactError('unsafe_archive', 'archive_member_type_rejected');
    const dataOffset = offset + 512;
    if (size > MAX_NPM_TARBALL_UNCOMPRESSED_BYTES || dataOffset + size > tar.byteLength) throw new ArtifactError('unsafe_archive', 'archive_member_size');
    fileCount++;
    if (fileCount > MAX_NPM_TARBALL_FILES) throw new ArtifactError('unsafe_archive', 'archive_file_count');
    if (type === '0') {
      const parts = path.split('/');
      if (parts.some(part => part.toLowerCase() === 'node_modules' || part.toLowerCase() === '.git' || part.toLowerCase().startsWith('.env'))) capped = true;
      else if (textSourcePath.test(path) && size <= 1_048_576 && files.length < MAX_NPM_ARTIFACT_SOURCE_FILES && sourceBytes + size <= MAX_NPM_ARTIFACT_SOURCE_BYTES) {
        const bytes = tar.subarray(dataOffset, dataOffset + size);
        try {
          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          if (content.includes('\0')) capped = true;
          else { files.push({ path, content }); sourceBytes += size; }
        } catch { capped = true; }
      } else if (textSourcePath.test(path)) capped = true;
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  if (offset > tar.byteLength) throw new ArtifactError('unsafe_archive', 'archive_truncated');
  return { files, fileCount, capped };
}

function emptyAnalysis(status: DependencyArtifactAnalysis['status'], integrity: DependencyArtifactAnalysis['integrity'], limitation: string): DependencyArtifactAnalysis {
  return { status, integrity, artifactSha256: null, extractedFileCount: 0, scannedFileCount: 0, tools: [], findings: [], limitation: [limitation] };
}

export function createNpmArtifactAdapter(scanner: NpmArtifactScanner, transport: NpmArtifactTransport = { get: boundedHttpsGet }): NpmArtifactAdapter {
  return {
    async analyze(packages, parentSignal) {
      if (packages.length > MAX_NPM_ARTIFACT_PACKAGES) throw new Error('npm_artifact_package_cap');
      const analyses = new Map<string, NpmArtifactReport>();
      for (const rawPackage of packages) {
        parentSignal.throwIfAborted();
        const pkg = { name: npmName.parse(rawPackage.name), version: semver.parse(rawPackage.version), integrity: rawPackage.integrity };
        const key = `${pkg.name}\0${pkg.version}`;
        try {
          const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(8_000)]);
          const metadataUrl = new URL(registryMetadataPath(pkg.name, pkg.version));
          const metadataBytes = await transport.get(metadataUrl, 262_144, signal);
          const metadata = registryMetadataSchema.parse(JSON.parse(metadataBytes.toString('utf8')));
          if (metadata.name !== pkg.name || metadata.version !== pkg.version) throw new ArtifactError('unavailable', 'registry_package_identity_mismatch');
          const tarballUrl = new URL(metadata.dist.tarball);
          if (tarballUrl.protocol !== 'https:' || tarballUrl.hostname !== 'registry.npmjs.org' || tarballUrl.port || tarballUrl.username || tarballUrl.password || tarballUrl.hash) {
            throw new ArtifactError('unavailable', 'registry_tarball_origin_rejected');
          }
          const compressed = await transport.get(tarballUrl, MAX_NPM_TARBALL_BYTES, signal);
          const artifactSha256 = createHash('sha256').update(compressed).digest('hex');
          const lockVerification = verifySha512Integrity(pkg.integrity, compressed);
          const registryVerification = verifySha512Integrity(metadata.dist.integrity ?? null, compressed);
          const lockMismatch = lockVerification === 'mismatch';
          const registryMismatch = registryVerification === 'mismatch';
          if (lockMismatch || registryMismatch) {
            analyses.set(key, { analysis: { status: 'checksum_mismatch', integrity: 'mismatch', artifactSha256, extractedFileCount: 0, scannedFileCount: 0, tools: [], findings: [], limitation: ['The downloaded registry tarball SHA-512 differs from lockfile and/or registry metadata integrity; contents were not extracted or scanned.', 'A mismatch is a high-signal integrity observation; it does not by itself establish malicious substitution or exploitation.', 'Maintainer Git main was not compared with this published artifact.'] }, evidence: [] });
            continue;
          }
          const integrity = lockVerification;
          const archive = extractNpmTarball(compressed);
          const scan = await scanner({ package: pkg, artifactSha256, extractedFileCount: archive.fileCount }, archive.files, parentSignal);
          const complete = scan.complete && !archive.capped && integrity === 'verified';
          analyses.set(key, { analysis: {
              status: complete ? 'verified' : 'scan_incomplete',
              integrity,
              artifactSha256,
              extractedFileCount: archive.fileCount,
              scannedFileCount: archive.files.length,
              tools: scan.tools.slice(0, 2),
              findings: scan.findings.slice(0, 40),
              limitation: [
              ...(integrity === 'verified' ? [] : ['The lockfile does not contain a usable SHA-512 integrity value; registry-only integrity is not equivalent to lockfile verification.']),
              ...(archive.capped ? ['Some package files were omitted by text, path, file-count or byte limits; package scan coverage is partial.'] : []),
              ...(!scan.complete ? ['One or more pinned source profiles were unavailable, incomplete or failed to parse this package artifact.'] : []),
              'Only the published registry tarball was scanned; maintainer Git main was not compared with this artifact.',
              'No package installation, lifecycle hook, build, test or code execution occurred.',
              ].slice(0, 10),
            }, evidence: scan.evidence });
        } catch (error) {
          if (parentSignal.aborted) throw error;
          if (error instanceof Error && error.message === 'scanner_cleanup_unavailable') throw error;
          const unsafe = error instanceof ArtifactError && error.kind === 'unsafe_archive';
          const message = error instanceof ArtifactError ? error.message : 'registry_metadata_invalid_or_unavailable';
          analyses.set(key, { analysis: emptyAnalysis(unsafe ? 'unsafe_archive' : 'unavailable', 'missing', unsafe ? `Package archive rejected by a safety limit (${message}); no file was extracted.` : `Exact package artifact could not be verified or retrieved (${message}).`), evidence: [] });
        }
      }
      return analyses;
    },
  };
}
