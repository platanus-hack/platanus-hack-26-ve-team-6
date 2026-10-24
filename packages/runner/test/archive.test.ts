import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ArchiveValidationError, validateInputArchive } from '../src/archive.js';
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
