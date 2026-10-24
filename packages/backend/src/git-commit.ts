import { createHash } from 'node:crypto';
import { z } from 'zod';

export function dependencyCommitMessage(input: { packageName: string; fromVersion: string; toVersion: string }): string {
  return `Gotchu dependency fix ${input.packageName} ${input.fromVersion} -> ${input.toVersion}`;
}

/** Uses Git's SHA-1 commit object format and fixed metadata for a reproducible candidate commit. */
export function expectedDependencyCommitSha(treeSha: string, baseCommit: string, message: string): string {
  const tree = z.string().regex(/^[a-f0-9]{40}$/).parse(treeSha);
  const parent = z.string().regex(/^[a-f0-9]{40}$/).parse(baseCommit);
  const commit = `tree ${tree}\nparent ${parent}\nauthor Gotchu <actions@gotchu.dev> 0 +0000\ncommitter Gotchu <actions@gotchu.dev> 0 +0000\n\n${z.string().min(1).max(512).parse(message)}\n`;
  return createHash('sha1').update(`commit ${Buffer.byteLength(commit, 'utf8')}\0`).update(commit, 'utf8').digest('hex');
}
