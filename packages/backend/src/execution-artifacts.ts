import { createHash } from 'node:crypto';
import type { Database } from '@gotchu/database';
import { computeGitTreeSha } from '@gotchu/git-adapters';
import { customerSourceSnapshotSchema } from '@gotchu/contracts';
import { z } from 'zod';
import { BackendError, canonicalJson, sha256 } from './core.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const fileSchema = z.object({
  path: z.string().min(1).max(512),
  mode: z.enum(['100644', '100755']),
  contentBase64: z.string().max(1_400_000),
  sha256: digest,
}).strict();
const artifactSchema = z.object({
  baseCommit: commit,
  files: z.array(fileSchema).max(1000),
  candidateTreeSha: z.string().regex(/^[a-f0-9]{40}$/),
  treeSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  treeComplete: z.boolean(),
  unsupportedReason: z.enum(['source_snapshot_completeness_unknown', 'artifact_patch_unsupported', 'repository_tree_truncated', 'repository_tree_unavailable']).nullable(),
  commitMessage: z.string().min(1).max(512),
  snapshotSha256: digest,
  patchSha256: digest,
  artifactSha256: digest,
  sizeBytes: z.number().int().nonnegative().max(4_194_304),
}).strict().refine(value => value.artifactSha256 === value.snapshotSha256
  && (value.treeComplete ? value.treeSha !== null && value.unsupportedReason === null : value.treeSha === null && value.unsupportedReason !== null));
export type ExecutionArtifact = z.infer<typeof artifactSchema>;
export type ArtifactDigestCheck = { valid: boolean; unsupportedReason: string | null };

/** Private publication material; only the executor service role can read file bytes. */
export function createExecutionArtifactService(database: Database) {
  return {
    async readForExecutor(input: { organizationId: string; applicationId: string; proposalId: string }): Promise<ExecutionArtifact> {
      if (database.role !== 'gotchu_executor') throw new BackendError('forbidden', 'Execution artifacts are available only to the executor service', 403);
      return readArtifact(database, input);
    },
    /** The web verifier can check integrity labels and eligibility without reading artifact bytes. */
    async verifyCandidateDigest(input: { organizationId: string; applicationId: string; candidateSourceId: string; snapshotSha256: string; patchSha256: string }): Promise<ArtifactDigestCheck> {
      if (database.role !== 'gotchu_api' && database.role !== 'gotchu_executor') throw new BackendError('forbidden', 'Execution artifact verification is unavailable to this service', 403);
      return database.tenant(input.organizationId, async tx => {
        const result = await tx.query<{ snapshot_sha256: string; patch_sha256: string; artifact_sha256: string; tree_complete: boolean; unsupported_reason: string | null }>(`SELECT snapshot_sha256,patch_sha256,artifact_sha256,tree_complete,unsupported_reason
          FROM gotchu.execution_artifacts WHERE organization_id=$1 AND application_id=$2 AND candidate_source_id=$3`, [input.organizationId, input.applicationId, input.candidateSourceId]);
        const row = result.rows[0];
        if (!row) return { valid: false, unsupportedReason: 'execution_artifact_missing' };
        const digestsMatch = row.snapshot_sha256 === input.snapshotSha256
          && row.artifact_sha256 === input.snapshotSha256 && row.patch_sha256 === input.patchSha256;
        if (!digestsMatch) return { valid: false, unsupportedReason: 'execution_artifact_digest_mismatch' };
        if (!row.tree_complete) return { valid: false, unsupportedReason: row.unsupported_reason ?? 'repository_tree_unavailable' };
        return { valid: true, unsupportedReason: null };
      });
    },
  };
}

async function readArtifact(database: Database, input: { organizationId: string; applicationId: string; proposalId: string }): Promise<ExecutionArtifact> {
  const stored = await database.tenant(input.organizationId, async tx => {
    const result = await tx.query<{
      base_commit: string; files: unknown; candidate_tree_sha: string; tree_sha: string | null; tree_complete: boolean;
      unsupported_reason: string | null; commit_message: string; snapshot_sha256: string; patch_sha256: string;
      artifact_sha256: string; size_bytes: number; source_body: unknown; source_digest: string; deleted_at: Date | null;
    }>(`SELECT a.base_commit,a.files,a.candidate_tree_sha,a.tree_sha,a.tree_complete,a.unsupported_reason,a.commit_message,
        a.snapshot_sha256,a.patch_sha256,a.artifact_sha256,a.size_bytes,s.body AS source_body,s.digest AS source_digest,s.deleted_at
      FROM gotchu.execution_artifacts a
      JOIN gotchu.customer_sources s ON s.organization_id=a.organization_id AND s.application_id=a.application_id AND s.id=a.candidate_source_id
      WHERE a.organization_id=$1 AND a.application_id=$2 AND a.proposal_id=$3`, [input.organizationId, input.applicationId, input.proposalId]);
    const row = result.rows[0];
    if (!row) throw new BackendError('not_found', 'Execution artifact not found', 404);
    if (row.deleted_at !== null || row.source_digest !== row.snapshot_sha256) throw new BackendError('artifact_corrupt', 'The candidate source is unavailable or its digest changed', 409);
    const snapshot = customerSourceSnapshotSchema.safeParse(row.source_body);
    if (!snapshot.success || sha256(canonicalJson(snapshot.data)) !== row.snapshot_sha256) throw new BackendError('artifact_corrupt', 'The stored candidate source failed its digest check', 409);
    return artifactSchema.parse({
      baseCommit: row.base_commit, files: row.files, candidateTreeSha: row.candidate_tree_sha, treeSha: row.tree_sha,
      treeComplete: row.tree_complete, unsupportedReason: row.unsupported_reason, commitMessage: row.commit_message,
      snapshotSha256: row.snapshot_sha256, patchSha256: row.patch_sha256, artifactSha256: row.artifact_sha256, sizeBytes: row.size_bytes,
    });
  });
  let size = 0;
  const patchFiles: Array<{ path: string; content: string; mode: '100644'|'100755' }> = [];
  for (const file of stored.files) {
    const bytes = Buffer.from(file.contentBase64, 'base64');
    if (bytes.toString('base64') !== file.contentBase64 || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new BackendError('artifact_corrupt', 'Stored execution artifact failed its file digest check', 409);
    }
    const content = bytes.toString('utf8');
    if (!Buffer.from(content, 'utf8').equals(bytes)) throw new BackendError('artifact_corrupt', 'Stored execution artifact contains invalid UTF-8', 409);
    patchFiles.push({ path: file.path, mode: file.mode, content });
    size += Buffer.byteLength(file.path, 'utf8') + bytes.byteLength;
  }
  if (size !== stored.sizeBytes || size > 4_194_304) throw new BackendError('artifact_corrupt', 'Stored execution artifact failed its size check', 409);
  let candidateTreeSha: string;
  try { candidateTreeSha = await computeGitTreeSha(patchFiles); }
  catch (error) { throw new BackendError('artifact_corrupt', 'Stored execution artifact failed its Git tree check', 409, { cause: error }); }
  if (candidateTreeSha !== stored.candidateTreeSha) throw new BackendError('artifact_corrupt', 'Stored execution artifact failed its Git tree digest check', 409);
  return stored;
}
