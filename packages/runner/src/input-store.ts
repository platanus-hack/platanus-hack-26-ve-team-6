import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunnerJob } from './contracts.js';
import { MAX_ARCHIVE_BYTES } from './archive.js';

export async function readLocalInputObject(
  root: string,
  reference: RunnerJob['input'],
  scope: { readonly organizationId: string; readonly jobId: string },
): Promise<Buffer> {
  const organizationPath = join(root, scope.organizationId);
  const organizationInfo = await lstat(organizationPath);
  if (!organizationInfo.isDirectory() || organizationInfo.isSymbolicLink()) {
    throw new Error('Local input organization path must be a real directory.');
  }

  const file = await open(join(organizationPath, reference.objectId), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Local input object must be a regular file.');
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_ARCHIVE_BYTES) throw new Error('Input object exceeds the runner bound.');
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await file.close();
  }
}
