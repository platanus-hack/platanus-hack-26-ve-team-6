import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';
import { singleGitHubPublicAppSchema } from '@gotchu/contracts';

const credentialSchema = z.object({
  id: z.union([z.string().regex(/^[0-9]+$/),z.number().int().positive()]).transform(String),
  privateKeyPem: z.string().min(100).max(32_000),
}).passthrough();
const singleAppCredentialSchema = z.object({
  id: z.union([z.string().regex(/^[0-9]+$/),z.number().int().positive()]).transform(String),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(4096),
  slug: singleGitHubPublicAppSchema.shape.slug,
  privateKeyPem: z.string().min(100).max(32_000),
}).strict();
const targetSchema=z.object({installationId:z.union([z.string().regex(/^[0-9]+$/),z.number().int().positive()]).transform(String),owner:z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/),repository:z.string().min(1).max(100)}).strict();
export type GitHubWriterCredentials = z.infer<typeof credentialSchema> & z.infer<typeof targetSchema>;

export type GitHubWriterAppCredentials = { appId: string; privateKeyPem: string };
export type GitHubSingleAppCredentials = z.infer<typeof singleAppCredentialSchema>;
export type GitHubPublicApp = z.infer<typeof singleGitHubPublicAppSchema>;

/** Load only the App identity/key once; keep the returned key inside the executor process. */
export async function loadGitHubWriterAppCredentials(path: string): Promise<GitHubWriterAppCredentials> {
  const input = await readCredentialFile(path);
  const key = createPrivateKey(input.privateKeyPem);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('writer_credentials_invalid');
  return { appId: input.id, privateKeyPem: input.privateKeyPem };
}

/** Load the public descriptor and private App credentials only inside the executor. */
export async function loadGitHubSingleAppCredentials(input: {
  privateFile: string;
  publicFile: string;
}): Promise<{ app: GitHubSingleAppCredentials; publicApp: GitHubPublicApp }> {
  const privateInput = await readJsonCredentialFile(input.privateFile, 64_000);
  const app = singleAppCredentialSchema.parse(privateInput);
  const key = createPrivateKey(app.privateKeyPem);
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('single_app_credentials_invalid');

  const publicInput = await readJsonCredentialFile(input.publicFile, 16_384);
  const publicApp = singleGitHubPublicAppSchema.parse(publicInput);
  if (publicApp.id !== app.id || publicApp.clientId !== app.clientId || publicApp.slug !== app.slug) throw new Error('single_app_credentials_mismatch');
  return { app, publicApp };
}

/** Read only in the executor process. Never include the returned key in diagnostics. */
export async function loadGitHubWriterCredentials(path: string, target: z.input<typeof targetSchema>): Promise<GitHubWriterCredentials> {
  const credentials = await readCredentialFile(path);
  return { ...credentials, ...targetSchema.parse(target) };
}

async function readCredentialFile(path: string): Promise<z.infer<typeof credentialSchema>> {
  return credentialSchema.parse(await readJsonCredentialFile(path, 64_000));
}

async function readJsonCredentialFile(path: string, maxBytes: number): Promise<unknown> {
  if (!path.startsWith('/') || path.includes('\0')) throw new Error('writer_credentials_path_invalid');
  const beforeOpen=await lstat(path);
  if(!beforeOpen.isFile()||beforeOpen.isSymbolicLink()||(beforeOpen.mode&0o077)!==0) throw new Error('writer_credentials_file_unsafe');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const opened=await handle.stat();
    if(!opened.isFile()||opened.dev!==beforeOpen.dev||opened.ino!==beforeOpen.ino||(opened.mode&0o077)!==0||opened.size>maxBytes) throw new Error('writer_credentials_file_unsafe');
    const bytes=Buffer.alloc(opened.size+1); const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
    if(bytesRead!==opened.size) throw new Error('writer_credentials_file_changed');
    let input: unknown;
    try { input=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8')); } catch { throw new Error('writer_credentials_invalid'); }
    return input;
  } finally { await handle.close(); }
}
