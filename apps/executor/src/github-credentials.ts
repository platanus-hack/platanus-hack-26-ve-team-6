import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { z } from 'zod';

const credentialSchema = z.object({
  id: z.union([z.string().regex(/^[0-9]+$/),z.number().int().positive()]).transform(String),
  privateKeyPem: z.string().min(100).max(32_000),
}).passthrough();
const targetSchema=z.object({installationId:z.union([z.string().regex(/^[0-9]+$/),z.number().int().positive()]).transform(String),owner:z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),repository:z.string().min(1).max(100)}).strict();
export type GitHubWriterCredentials = z.infer<typeof credentialSchema> & z.infer<typeof targetSchema>;

/** Read only in the executor process. Never include the returned key in diagnostics. */
export async function loadGitHubWriterCredentials(path: string, target: z.input<typeof targetSchema>): Promise<GitHubWriterCredentials> {
  if (!path.startsWith('/') || path.includes('\0')) throw new Error('writer_credentials_path_invalid');
  const beforeOpen=await lstat(path);
  if(!beforeOpen.isFile()||beforeOpen.isSymbolicLink()||(beforeOpen.mode&0o077)!==0) throw new Error('writer_credentials_file_unsafe');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const opened=await handle.stat();
    if(!opened.isFile()||opened.dev!==beforeOpen.dev||opened.ino!==beforeOpen.ino||(opened.mode&0o077)!==0||opened.size>64_000) throw new Error('writer_credentials_file_unsafe');
    const bytes=Buffer.alloc(opened.size+1); const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
    if(bytesRead!==opened.size) throw new Error('writer_credentials_file_changed');
    let input: unknown;
    try { input=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8')); } catch { throw new Error('writer_credentials_invalid'); }
    return { ...credentialSchema.parse(input), ...targetSchema.parse(target) };
  } finally { await handle.close(); }
}
