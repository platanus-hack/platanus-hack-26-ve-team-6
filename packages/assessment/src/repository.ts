import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { demoRevisionSchema, type DemoRevision } from '@gotchu/contracts';
import { controlledSourceFileSchema, InspectionUnavailable, MAX_FILE_BYTES, type ControlledSourceFile } from './profile.js';

export interface ControlledRepositoryPort {
  readFile(revision: DemoRevision, path: ControlledSourceFile): Promise<Uint8Array>;
}

export async function readBoundedFile(path: string, maxBytes: number): Promise<Uint8Array> {
  // This is a trusted bundled fixture reader, not a customer-checkout isolation boundary.
  if (await realpath(path) !== path) throw new InspectionUnavailable('Symbolic links are outside fixture scope');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new InspectionUnavailable('File type or size is outside fixture limits');
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new InspectionUnavailable('File grew beyond fixture limits');
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}

export function createBundledRepository(): ControlledRepositoryPort {
  return {
    readFile(revision, path) {
      const checkedRevision = demoRevisionSchema.parse(revision);
      const checkedPath = controlledSourceFileSchema.parse(path);
      return readBoundedFile(fileURLToPath(new URL(`../../../apps/demo-target/src/fixtures/${checkedRevision}/${checkedPath}`, import.meta.url)), MAX_FILE_BYTES);
    },
  };
}
