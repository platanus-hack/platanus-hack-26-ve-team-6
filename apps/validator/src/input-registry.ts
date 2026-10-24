import type { RunnerJob } from '@gotchu/runner';

export function createValidationInputRegistry() {
  const inputs = new Map<string, Uint8Array>();
  const key = (organizationId: string, objectId: string) => `${organizationId}:${objectId}`;
  const register = (organizationId: string, objectId: string, bytes: Uint8Array) => {
    inputs.set(key(organizationId, objectId), bytes);
  };
  const remove = (organizationId: string, objectId: string) => {
    inputs.delete(key(organizationId, objectId));
  };

  return {
    async withInput<T>(organizationId: string, objectId: string, bytes: Uint8Array, run: () => Promise<T>): Promise<T> {
      register(organizationId, objectId, bytes);
      try { return await run(); }
      finally { remove(organizationId, objectId); }
    },
    resolveInput: async (reference: RunnerJob['input'], scope: { organizationId: string; jobId: string }) => {
      const input = inputs.get(key(scope.organizationId, reference.objectId));
      if (!input) throw new Error('validation_input_expired');
      return input;
    },
  };
}
