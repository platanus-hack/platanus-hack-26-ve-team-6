import { gunzipSync } from 'node:zlib';

export const MAX_ARCHIVE_FILES = 1000;
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 20;

export class ArchiveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveValidationError';
  }
}

export interface ValidatedArchive {
  readonly tarBytes: Buffer;
  readonly files: number;
  readonly totalBytes: number;
}

function readString(header: Buffer, start: number, end: number): string {
  const zero = header.indexOf(0, start);
  return header.toString('utf8', start, zero === -1 || zero >= end ? end : zero);
}

function readOctal(header: Buffer, start: number, end: number): number {
  const raw = readString(header, start, end).trim().replace(/\0.*$/, '');
  if (!/^[0-7]*$/.test(raw)) throw new ArchiveValidationError('Invalid tar size field');
  return raw.length === 0 ? 0 : Number.parseInt(raw, 8);
}

function validateChecksum(header: Buffer): void {
  const expected = readOctal(header, 148, 156);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  if (actual !== expected) throw new ArchiveValidationError('Invalid tar header checksum');
}

function safePath(path: string): string {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    throw new ArchiveValidationError('Archive contains an absolute or invalid path');
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..' || segment === '.' || segment.length === 0)) {
    throw new ArchiveValidationError('Archive path traversal is prohibited');
  }
  return path;
}

export function validateInputArchive(input: Uint8Array): ValidatedArchive {
  const source = Buffer.from(input);
  if (source.length === 0 || source.length > MAX_ARCHIVE_BYTES) {
    throw new ArchiveValidationError('Archive exceeds the compressed input limit');
  }

  let tarBytes: Buffer;
  try {
    tarBytes = source[0] === 0x1f && source[1] === 0x8b
      ? gunzipSync(source, { maxOutputLength: MAX_ARCHIVE_BYTES })
      : source;
  } catch (cause) {
    throw new ArchiveValidationError(`Invalid or oversized gzip archive: ${String(cause)}`);
  }
  if (tarBytes.length > MAX_ARCHIVE_BYTES) throw new ArchiveValidationError('Archive exceeds the expanded size limit');

  let offset = 0;
  let files = 0;
  let totalBytes = 0;
  const paths = new Set<string>();
  let ended = false;
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    validateChecksum(header);
    const type = header[156] ?? 0;
    if (type !== 0 && type !== 48 && type !== 53) {
      throw new ArchiveValidationError('Archive links, extensions, and special files are prohibited');
    }
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 500);
    const rawPath = prefix.length === 0 ? name : `${prefix}/${name}`;
    const path = safePath(type === 53 && rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath);
    if (paths.has(path)) throw new ArchiveValidationError('Archive contains duplicate paths');
    paths.add(path);

    const size = type === 53 ? 0 : readOctal(header, 124, 136);
    if (size > MAX_ARCHIVE_BYTES || totalBytes + size > MAX_ARCHIVE_BYTES) {
      throw new ArchiveValidationError('Archive exceeds the expanded size limit');
    }
    if (type !== 53) {
      totalBytes += size;
    }
    files += 1;
    if (files > MAX_ARCHIVE_FILES) throw new ArchiveValidationError('Archive contains too many entries');
    const padded = Math.ceil(size / 512) * 512;
    offset += 512 + padded;
    if (offset > tarBytes.length) throw new ArchiveValidationError('Archive entry extends beyond the input');
  }
  if (!ended) throw new ArchiveValidationError('Archive is missing its end marker');
  if (totalBytes / source.length > MAX_COMPRESSION_RATIO) {
    throw new ArchiveValidationError('Archive exceeds the file content compression ratio limit');
  }
  return { tarBytes, files, totalBytes };
}
