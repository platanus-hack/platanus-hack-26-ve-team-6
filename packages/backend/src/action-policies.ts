/** Code-owned action policy versions. Bump a version when its safety rules change. */
export const ACTION_POLICY_REGISTRY: Readonly<Record<string, string>> = {
  'repository.dependency_pr': 'gotchu-dependency-pr-v1',
  'repository.source_patch_pr': 'gotchu-source-patch-pr-v1',
};

export function actionPolicyVersion(capabilityId: string): string | undefined {
  return ACTION_POLICY_REGISTRY[capabilityId];
}
