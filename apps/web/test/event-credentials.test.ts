import { mkdtemp, rm, chmod, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileEventCredentials } from '../src/server/event-credentials.js';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'gotchu-event-key-')); directories.push(path);
  return { path, store: createFileEventCredentials(path) };
}
describe('private local event credentials on the actual filesystem', () => {
  it('creates exclusively, reads exact signing bytes and removes only its named key', async () => {
    const { path, store } = await fixture(); const id = randomUUID(); const reference = `local-event:${id}`; const secret = randomBytes(32);
    await store.putSigningSecret(reference, secret);
    expect(await store.getSigningSecret(reference)).toEqual(secret);
    await expect(store.putSigningSecret(reference, randomBytes(32))).rejects.toThrow();
    expect(await readFile(join(path, id))).toEqual(secret);
    await store.deleteSigningSecret(reference); await store.deleteSigningSecret(reference);
    await expect(store.getSigningSecret(reference)).rejects.toThrow();
  });
  it('rejects unsafe file/directory permissions, symlinks and arbitrary path references', async () => {
    const { path, store } = await fixture(); const id = randomUUID(); const reference = `local-event:${id}`;
    await store.putSigningSecret(reference, randomBytes(32));
    await chmod(join(path, id), 0o644);
    await expect(store.getSigningSecret(reference)).rejects.toThrow('unsafe_event_credential_file');
    await store.deleteSigningSecret(reference);
    const outside = join(path, 'outside'); await writeFile(outside, randomBytes(32), { mode: 0o600 });
    await symlink(outside, join(path, id));
    await expect(store.getSigningSecret(reference)).rejects.toThrow();
    await expect(store.putSigningSecret(reference, randomBytes(32))).rejects.toThrow();
    await expect(store.getSigningSecret('local-event:../../outside')).rejects.toThrow('invalid_event_credential_reference');
    await chmod(path, 0o755);
    await expect(store.getSigningSecret(reference)).rejects.toThrow('unsafe_event_credential_directory');
  });
});
