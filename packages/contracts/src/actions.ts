import { z } from 'zod';

const uuid = z.uuid();
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const evidence = z.array(z.object({ id: uuid, sha256: digest, kind: z.string().min(1).max(100) }).strict()).min(1).max(100);
const repositoryTarget = z.object({ kind: z.literal('repository'), repositoryLinkId: uuid, repositoryKey: z.string().min(1).max(200), branch: z.string().min(1).max(200) }).strict();
const environmentTarget = z.object({ kind: z.literal('environment'), environmentId: uuid, name: z.string().min(1).max(200) }).strict();
const base = { version: z.literal(2), organizationId: uuid, applicationId: uuid, policyVersion: z.string().min(1).max(100), evidence };
const dependency = z.object({ name: z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/).max(214), from: z.string().regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/), to: z.string().regex(/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/) }).strict().refine(change => {
  const [oldMajor = NaN, oldMinor = NaN, oldPatch = NaN] = change.from.split('.').map(Number);
  const [newMajor = NaN, newMinor = NaN, newPatch = NaN] = change.to.split('.').map(Number);
  return oldMajor === newMajor && (newMinor > oldMinor || (newMinor === oldMinor && newPatch > oldPatch));
}, 'Only increasing patch or minor dependency versions are eligible');

export const actionV2Schema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('dependency_pull_request'), capabilityId: z.literal('repository.dependency_pr'), target: repositoryTarget, baseCommit: commit, candidateCommit: commit, changes: z.array(dependency).min(1).max(100).refine(changes => new Set(changes.map(item => item.name)).size === changes.length), lockfileSha256: digest, patchSha256: digest, rescanAttestationId: uuid, suiteAttestationId: uuid }).strict().refine(action => action.baseCommit !== action.candidateCommit),
  z.object({ ...base, kind: z.literal('source_patch_pull_request'), capabilityId: z.literal('repository.source_patch_pr'), target: repositoryTarget, baseCommit: commit, recipeId: z.string().min(1).max(100), recipeVersion: z.string().min(1).max(100), snapshotSha256: digest, patchSha256: digest, findingIdentities: z.array(z.string().min(1).max(256)).min(1).max(100), validationAttestationIds: z.array(uuid).max(100) }).strict(),
  z.object({ ...base, kind: z.literal('merge_pull_request'), capabilityId: z.literal('repository.merge'), target: repositoryTarget, pullRequestNumber: z.number().int().positive().max(2_147_483_647), expectedHeadSha: commit, baseSha: commit, requiredChecks: z.array(z.string().min(1).max(200)).min(1).max(100), policyVersion: z.string().min(1).max(100), originatingApprovedActionId: uuid }).strict(),
  z.object({ ...base, kind: z.literal('deploy_release'), capabilityId: z.literal('environment.deploy'), target: environmentTarget, artifactDigest: digest, releaseId: z.string().min(1).max(256), previousReleaseId: z.string().min(1).max(256).nullable(), planId: uuid }).strict(),
  z.object({ ...base, kind: z.literal('rollback_release'), capabilityId: z.literal('environment.rollback'), target: environmentTarget, expectedCurrentReleaseId: z.string().min(1).max(256), targetPreviousReleaseId: z.string().min(1).max(256) }).strict(),
  z.object({ ...base, kind: z.literal('provider_response'), capabilityId: z.literal('provider.response'), target: environmentTarget, provider: z.string().min(1).max(100), response: z.string().min(1).max(100) }).strict(),
]);
export type ActionV2 = z.infer<typeof actionV2Schema>;
export const actionKindV2Schema = z.enum(['dependency_pull_request', 'source_patch_pull_request', 'merge_pull_request', 'deploy_release', 'rollback_release', 'provider_response']);
