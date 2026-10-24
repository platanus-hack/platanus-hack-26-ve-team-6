import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { WritableEventCredentials } from '@gotchu/backend';

/** Local development storage. Hosted runtimes should replace this with an encrypted secret store. */
export function createFileEventCredentials(directory: string): WritableEventCredentials {
  const root = resolve(directory);
  function filename(reference: string) {
    const id = /^local-event:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.exec(reference)?.[1];
    if (!id) throw new Error('invalid_event_credential_reference');
    return join(root, id);
  }
  async function privateDirectory() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error('unsafe_event_credential_directory');
  }
  return {
    async getSigningSecret(reference) {
      await privateDirectory();
      const file = await open(filename(reference), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error('unsafe_event_credential_file');
        const secret = await file.readFile();
        if (secret.length !== 32) throw new Error('event_credential_changed');
        return secret;
      } finally { await file.close(); }
    },
    async putSigningSecret(reference, secret) {
      if (secret.byteLength !== 32) throw new Error('invalid_event_signing_key');
      await privateDirectory();
      const path = filename(reference); const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(secret); await file.sync(); }
      catch (cause) {
        try { await unlink(path); }
        catch (cleanup) { throw new AggregateError([cause, cleanup], 'Event credential cleanup failed'); }
        throw cause;
      } finally { await file.close(); }
    },
    async deleteSigningSecret(reference) {
      await privateDirectory();
      try { await unlink(filename(reference)); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    },
  };
}
