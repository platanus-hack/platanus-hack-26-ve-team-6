import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ModelSecretStore } from './investigation-models.js';

/** Local development adapter. Hosted deployments must inject an encrypted secret store. */
export function createFileModelSecretStore(directory: string): ModelSecretStore {
  const root = resolve(directory);
  function filename(reference: string) {
    const id = /^local-model:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(reference)?.[1];
    if (!id) throw new Error('invalid_model_secret_reference');
    return join(root, id);
  }
  async function privateDirectory() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('unsafe_model_secret_directory');
    }
  }
  return {
    async get(reference) {
      await privateDirectory();
      const file = await open(filename(reference), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > 4_096 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
          throw new Error('unsafe_model_secret_file');
        }
        const secret = await file.readFile();
        if (secret.length < 1 || secret.length > 4_096) throw new Error('model_secret_changed');
        return secret;
      } finally { await file.close(); }
    },
    async put(reference, secret) {
      if (secret.byteLength < 1 || secret.byteLength > 4_096) throw new Error('invalid_model_secret');
      await privateDirectory();
      const file = await open(filename(reference), 'wx', 0o600);
      try { await file.writeFile(secret); await file.sync(); }
      catch (cause) {
        try { await unlink(filename(reference)); }
        catch (cleanup) { throw new AggregateError([cause, cleanup], 'Model credential cleanup failed'); }
        throw cause;
      } finally { await file.close(); }
    },
    async delete(reference) {
      await privateDirectory();
      try { await unlink(filename(reference)); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    },
  };
}
