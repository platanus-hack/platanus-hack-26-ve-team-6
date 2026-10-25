import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ArchiveValidationError, readArchiveFiles, validateInputArchive } from '../src/archive.js';
import { runnerJobSchema } from '../src/contracts.js';
import { validateSelectedTestFiles } from '../src/profile.js';
import { makeTar } from './tar.js';

describe('input archive validation', () => {
  it('accepts a small regular file and bounded gzip tar', () => {
    const archive = makeTar([{ path: 'package.json', content: '{"name":"fixture"}', type: '0' }]);
    expect(validateInputArchive(archive)).toMatchObject({ files: 1, totalBytes: 18 });
    expect(validateInputArchive(gzipSync(archive)).files).toBe(1);
  });

  it.each(['/etc/passwd', '../escape.txt', 'nested/../../escape.txt', 'nested\\escape.txt'])('rejects unsafe path %s', (path) => {
    expect(() => validateInputArchive(makeTar([{ path }]))).toThrow(ArchiveValidationError);
  });

  it('rejects symlink entries and a forged tar checksum', () => {
    expect(() => validateInputArchive(makeTar([{ path: 'escape', content: 'target', type: '2' }]))).toThrow(/links/);
    const malformed = makeTar([{ path: 'file.txt' }]);
    malformed[0] = 'X'.charCodeAt(0);
    expect(() => validateInputArchive(malformed)).toThrow(/checksum/);
  });

  it('rejects extreme compression ratios', () => {
    const archive = makeTar([{ path: 'large.txt', content: 'x'.repeat(4096) }]);
    expect(() => validateInputArchive(gzipSync(archive))).toThrow(/compression ratio/);
  });
});

describe('selected test archive membership', () => {
  it('accepts an existing empty regular test but rejects missing files and directory entries', () => {
    const job = runnerJobSchema.parse({
      jobId: '4f8a1e08-bfde-4597-a753-21c0040bf51f', organizationId: 'dc7dc303-1601-4d3e-ae5a-611839b33167',
      profile: 'node24-tsx-selected-v1', testSelection: { files: ['tests/empty.test.ts'] },
      input: { objectId: 'e15a9a1a-62e0-4a76-aa98-5c62386ee1a6', sha256: 'a'.repeat(64), sizeBytes: 2048 },
      limits: { vcpu: 1, memMiB: 512, pids: 64, wallMs: 30_000, outputBytes: 32_768, diskMiB: 2048 }, networkPolicy: { mode: 'deny' },
    });
    const files = (entries: Parameters<typeof makeTar>[0]) => readArchiveFiles(validateInputArchive(makeTar(entries)).tarBytes);
    expect(() => validateSelectedTestFiles(job, files([{ path: 'tests/empty.test.ts', content: '' }]))).not.toThrow();
    expect(() => validateSelectedTestFiles(job, files([{ path: 'tests/other.test.ts', content: '' }]))).toThrow('not a regular input archive file');
    expect(() => validateSelectedTestFiles(job, files([{ path: 'tests/empty.test.ts', type: '5' }]))).toThrow('not a regular input archive file');
  });
});
