import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { customerSourceSnapshotSchema } from '@gotchu/contracts';

function octal(value: number, width: number): Buffer {
  const text = value.toString(8).padStart(width - 1, '0') + '\0';
  return Buffer.from(text, 'ascii');
}

function header(path: string, size: number): Buffer {
  if (path.length > 255 || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid_source_path');
  const parts = path.split('/'); const name = parts.pop() ?? '';
  const prefix = parts.join('/');
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('source_path_too_long');
  const block = Buffer.alloc(512);
  block.write(name, 0, 100); octal(0o644, 8).copy(block, 100); octal(0, 8).copy(block, 108); octal(0, 8).copy(block, 116);
  octal(size, 12).copy(block, 124); octal(0, 12).copy(block, 136); block.fill(0x20, 148, 156); block[156] = 48; block.write('ustar\0', 257, 6); block.write('00', 263, 2); block.write('gotchu', 265, 6);
  if (prefix) block.write(prefix, 345, 155);
  let sum = 0; for (const byte of block.values()) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return block;
}

export function sourceArchive(raw: unknown): { bytes: Buffer; sha256: string } {
  const snapshot = customerSourceSnapshotSchema.parse(raw);
  const entries: Buffer[] = [];
  for (const file of snapshot.files) {
    const body = Buffer.from(file.content, 'utf8');
    entries.push(header(file.path, body.length), body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  const tar = Buffer.concat([...entries, Buffer.alloc(1024)]);
  const bytes = gzipSync(tar, { level: 9 });
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
