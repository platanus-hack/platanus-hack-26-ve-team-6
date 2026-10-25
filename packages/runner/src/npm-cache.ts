import { createHash } from 'node:crypto';
import { z } from 'zod';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_TARBALL_BYTES = 192 * 1024 * 1024;
const DEFAULT_TARBALL_BYTES = 16 * 1024 * 1024;
const selectedPlatform = { os: 'linux', cpu: 'x64', libc: 'glibc' } as const;
const lockSchema = z.object({
  lockfileVersion: z.union([z.literal(2), z.literal(3)]),
  packages: z.record(z.string(), z.object({
    resolved: z.string().optional(),
    integrity: z.string().optional(),
    link: z.boolean().optional(),
  }).passthrough()),
}).passthrough();
const platformValue = z.string().regex(/^!?[A-Za-z0-9._-]+$/);
const selectedPackageMetadataSchema = z.object({
  optional: z.boolean().optional(),
  os: z.array(platformValue).optional(),
  cpu: z.array(platformValue).optional(),
  libc: z.array(platformValue).optional(),
}).passthrough();

export type NpmFetchFailure = 'invalid-lockfile' | 'unsupported-dependency' | 'missing-integrity' | 'download-failed' | 'size-limit' | 'integrity-mismatch';

export class NpmFetchError extends Error {
  constructor(readonly reason: NpmFetchFailure, message: string) {
    super(message);
    this.name = 'NpmFetchError';
  }
}

export interface FetchedTarball {
  readonly name: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly integrity: string;
}

export interface FetchedNpmDependencies {
  readonly lockfileSha256: string;
  readonly tarballSetSha256: string;
  readonly tarballs: readonly FetchedTarball[];
}

function fail(reason: NpmFetchFailure, message: string): never {
  throw new NpmFetchError(reason, message);
}

export async function fetchNpmDependencies(
  lockfileBytes: Uint8Array,
  options: { registry?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number; maxCount?: number; maxBytes?: number; maxTarballBytes?: number; concurrency?: number; targetPlatform?: 'linux-x64-glibc' } = {},
): Promise<FetchedNpmDependencies> {
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(Buffer.from(lockfileBytes).toString('utf8')); }
  catch { return fail('invalid-lockfile', 'package-lock.json is not valid JSON'); }
  const parsed = lockSchema.safeParse(parsedJson);
  if (!parsed.success) return fail('invalid-lockfile', 'Only npm lockfileVersion 2 and 3 are supported');
  const registry = new URL(options.registry ?? DEFAULT_REGISTRY);
  if (registry.protocol !== 'https:') return fail('unsupported-dependency', 'The package registry must use HTTPS');
  if (!registry.pathname.endsWith('/')) registry.pathname += '/';
  const packages = Object.entries(parsed.data.packages);
  const maxCount = options.maxCount ?? 500;
  const packageEntries = packages.filter(([name]) => name !== '');
  if (packageEntries.length > maxCount) return fail('size-limit', `Lockfile has more than ${maxCount} packages`);
  const dependencies: typeof packages = [];
  for (const [name, entry] of packages) {
    if (options.targetPlatform) {
      const metadata = selectedPackageMetadataSchema.safeParse(entry);
      if (!metadata.success) return fail('invalid-lockfile', `Dependency ${name || '<root>'} has invalid optional platform metadata`);
      if (name === '') continue;
      const { optional, os, cpu, libc } = metadata.data;
      const compatible = platformMatches(os, selectedPlatform.os)
        && platformMatches(cpu, selectedPlatform.cpu)
        && platformMatches(libc, selectedPlatform.libc);
      if (!compatible) {
        if (optional !== true) return fail('unsupported-dependency', `Required dependency ${name} is incompatible with the selected Linux x64 glibc platform`);
        continue;
      }
    } else if (name === '') {
      continue;
    }
    dependencies.push([name, entry]);
  }
  const records = dependencies.map(([name, entry]) => {
    if (entry.link || !entry.resolved || !entry.resolved.startsWith('https://')) return fail('unsupported-dependency', `Dependency ${name} is not a pinned HTTPS registry tarball`);
    const url = new URL(entry.resolved);
    if (url.origin !== registry.origin || !url.pathname.startsWith(registry.pathname) || url.search || url.hash || !url.pathname.endsWith('.tgz')) {
      return fail('unsupported-dependency', `Dependency ${name} resolves outside the configured npm registry`);
    }
    const integrity = entry.integrity?.split(/\s+/).find((item) => item.startsWith('sha512-'));
    if (!integrity || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) return fail('missing-integrity', `Dependency ${name} has no valid sha512 integrity`);
    return { name, url: url.href, integrity };
  });
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? MAX_TOTAL_BYTES;
  const perTarball = options.maxTarballBytes ?? DEFAULT_TARBALL_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TOTAL_BYTES) {
    return fail('size-limit', `Aggregate tarball limit must be between 1 and ${MAX_TOTAL_BYTES} bytes`);
  }
  if (!Number.isSafeInteger(perTarball) || perTarball < 1 || perTarball > MAX_TARBALL_BYTES) {
    return fail('size-limit', `Per-tarball limit must be between 1 and ${MAX_TARBALL_BYTES} bytes`);
  }
  const results: FetchedTarball[] = new Array(records.length);
  let cursor = 0;
  let totalReceived = 0;
  let firstFailure: NpmFetchError | undefined;
  const activeControllers = new Set<AbortController>();
  const abortActive = (except?: AbortController) => {
    for (const active of activeControllers) if (active !== except) active.abort();
  };
  const workers = Array.from({ length: Math.min(options.concurrency ?? 4, records.length) }, async () => {
    while (true) {
      if (firstFailure) return;
      const index = cursor++;
      const record = records[index];
      if (!record) return;
      const controller = new AbortController();
      activeControllers.add(controller);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(record.url, { signal: controller.signal, redirect: 'error' });
        if (!response.ok) {
          try { await response.body?.cancel(); } catch { /* Preserve the HTTP failure. */ }
          fail('download-failed', `Registry returned HTTP ${response.status} for ${record.name}`);
        }
        const reader = response.body?.getReader();
        if (!reader) fail('download-failed', `Registry response for ${record.name} has no body`);
        const rejectBody = async (reason: NpmFetchFailure, message: string): Promise<never> => {
          firstFailure ??= new NpmFetchError(reason, message);
          abortActive(controller);
          try { await reader.cancel(); } catch { /* Preserve the original download failure. */ }
          throw firstFailure;
        };
        const contentLength = response.headers.get('content-length');
        if (contentLength !== null) {
          if (!/^(0|[1-9][0-9]*)$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength))) {
            await rejectBody('download-failed', `Registry returned an invalid content length for ${record.name}`);
          }
          const declaredBytes = Number(contentLength);
          if (declaredBytes > perTarball || totalReceived + declaredBytes > maxBytes) {
            await rejectBody('size-limit', `Tarball ${record.name} exceeds the configured download limit`);
          }
        }
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const nextReceived = received + chunk.value.length;
          if (nextReceived > perTarball || totalReceived + chunk.value.length > maxBytes) {
            await rejectBody('size-limit', `Tarball ${record.name} exceeds the configured download limit`);
          }
          received = nextReceived;
          totalReceived += chunk.value.length;
          chunks.push(chunk.value);
        }
        const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received);
        if (contentLength !== null && bytes.length !== Number(contentLength)) fail('download-failed', `Registry response length did not match for ${record.name}`);
        const expected = Buffer.from(record.integrity.slice('sha512-'.length), 'base64');
        const actual = createHash('sha512').update(bytes).digest();
        if (!actual.equals(expected)) fail('integrity-mismatch', `Tarball integrity mismatch for ${record.name}`);
        results[index] = { name: record.name, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: record.integrity };
      } catch (error) {
        if (!firstFailure) {
          firstFailure = error instanceof NpmFetchError
            ? error
            : new NpmFetchError('download-failed', `Could not fetch ${record.name}: ${error instanceof Error ? error.message : 'unknown error'}`);
          abortActive(controller);
        }
      } finally {
        clearTimeout(timer);
        activeControllers.delete(controller);
      }
    }
  });
  await Promise.all(workers);
  if (firstFailure) throw firstFailure;
  const lockfileSha256 = createHash('sha256').update(lockfileBytes).digest('hex');
  const manifest = results.map(({ name, sha256 }) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name));
  const tarballSetSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return { lockfileSha256, tarballSetSha256, tarballs: results };
}

function platformMatches(restrictions: readonly string[] | undefined, target: string): boolean {
  if (!restrictions) return true;
  const negative = restrictions.filter((value) => value.startsWith('!')).map((value) => value.slice(1));
  if (negative.includes(target)) return false;
  const positive = restrictions.filter((value) => !value.startsWith('!'));
  return positive.length === 0 || positive.includes(target);
}
