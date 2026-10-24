import { createHash } from 'node:crypto';
import { z } from 'zod';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const lockSchema = z.object({
  lockfileVersion: z.union([z.literal(2), z.literal(3)]),
  packages: z.record(z.string(), z.object({
    resolved: z.string().optional(),
    integrity: z.string().optional(),
    link: z.boolean().optional(),
  }).passthrough()),
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
  options: { registry?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number; maxCount?: number; maxBytes?: number; concurrency?: number } = {},
): Promise<FetchedNpmDependencies> {
  let parsedJson: unknown;
  try { parsedJson = JSON.parse(Buffer.from(lockfileBytes).toString('utf8')); }
  catch { return fail('invalid-lockfile', 'package-lock.json is not valid JSON'); }
  const parsed = lockSchema.safeParse(parsedJson);
  if (!parsed.success) return fail('invalid-lockfile', 'Only npm lockfileVersion 2 and 3 are supported');
  const registry = new URL(options.registry ?? DEFAULT_REGISTRY);
  if (registry.protocol !== 'https:') return fail('unsupported-dependency', 'The package registry must use HTTPS');
  if (!registry.pathname.endsWith('/')) registry.pathname += '/';
  const dependencies = Object.entries(parsed.data.packages).filter(([key]) => key !== '');
  const maxCount = options.maxCount ?? 500;
  if (dependencies.length > maxCount) return fail('size-limit', `Lockfile has more than ${maxCount} packages`);
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
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const perTarball = 16 * 1024 * 1024;
  const results: FetchedTarball[] = new Array(records.length);
  let cursor = 0;
  let total = 0;
  const workers = Array.from({ length: Math.min(options.concurrency ?? 4, records.length) }, async () => {
    while (true) {
      const index = cursor++;
      const record = records[index];
      if (!record) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetcher(record.url, { signal: controller.signal, redirect: 'error' });
        if (!response.ok) fail('download-failed', `Registry returned HTTP ${response.status} for ${record.name}`);
        const reader = response.body?.getReader();
        if (!reader) fail('download-failed', `Registry response for ${record.name} has no body`);
        const chunks: Uint8Array[] = [];
        let received = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.length;
          if (received > perTarball || total + received > maxBytes) {
            await reader.cancel();
            fail('size-limit', `Tarball ${record.name} exceeds the configured download limit`);
          }
          chunks.push(chunk.value);
        }
        const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), received);
        if (bytes.length > perTarball) fail('size-limit', `Tarball ${record.name} exceeds ${perTarball} bytes`);
        total += bytes.length;
        if (total > maxBytes) fail('size-limit', `Dependency tarballs exceed ${maxBytes} bytes`);
        const expected = Buffer.from(record.integrity.slice('sha512-'.length), 'base64');
        const actual = createHash('sha512').update(bytes).digest();
        if (!actual.equals(expected)) fail('integrity-mismatch', `Tarball integrity mismatch for ${record.name}`);
        results[index] = { name: record.name, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: record.integrity };
      } catch (error) {
        if (error instanceof NpmFetchError) throw error;
        fail('download-failed', `Could not fetch ${record.name}: ${error instanceof Error ? error.message : 'unknown error'}`);
      } finally { clearTimeout(timer); }
    }
  });
  await Promise.all(workers);
  const lockfileSha256 = createHash('sha256').update(lockfileBytes).digest('hex');
  const manifest = results.map(({ name, sha256 }) => ({ name, sha256 })).sort((a, b) => a.name.localeCompare(b.name));
  const tarballSetSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return { lockfileSha256, tarballSetSha256, tarballs: results };
}
