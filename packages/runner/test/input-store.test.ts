import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readLocalInputObject } from '../src/input-store.js';

const organizationId = 'dc7dc303-1601-4d3e-ae5a-611839b33167';
const objectId = 'e15a9a1a-62e0-4a76-aa98-5c62386ee1a6';
let root = '';

async function makeRoot() {
  root = await mkdtemp(join(tmpdir(), 'gotchu-runner-input-'));
  await mkdir(join(root, organizationId));
  return root;
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('local input object resolver', () => {
  it('reads a regular object within the organization directory', async () => {
    const directory = await makeRoot();
    await writeFile(join(directory, organizationId, objectId), 'archive bytes');
    await expect(readLocalInputObject(directory, { objectId, sha256: 'a'.repeat(64), sizeBytes: 13 }, { organizationId, jobId: crypto.randomUUID() }))
      .resolves.toEqual(Buffer.from('archive bytes'));
  });

  it('rejects symlinks for both organization and object paths', async () => {
    const directory = await makeRoot();
    await rm(join(directory, organizationId), { recursive: true });
    await symlink(tmpdir(), join(directory, organizationId));
    await expect(readLocalInputObject(directory, { objectId, sha256: 'a'.repeat(64), sizeBytes: 1 }, { organizationId, jobId: crypto.randomUUID() }))
      .rejects.toThrow(/real directory/);

    await rm(join(directory, organizationId));
    await mkdir(join(directory, organizationId));
    const externalFile = join(directory, 'host-only.txt');
    await writeFile(externalFile, 'must not be read');
    await symlink(externalFile, join(directory, organizationId, objectId));
    await expect(readLocalInputObject(directory, { objectId, sha256: 'a'.repeat(64), sizeBytes: 16 }, { organizationId, jobId: crypto.randomUUID() }))
      .rejects.toThrow();
  });
});
