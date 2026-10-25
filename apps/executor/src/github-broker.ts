import { createBackend } from '@gotchu/backend';
import {
  githubBrokerRequestSchema,
  githubBrokerResponseSchema,
  type GitHubBrokerRequest,
  type GitHubBrokerResponse,
} from '@gotchu/contracts';
import type { Database } from '@gotchu/database';
import type { GitHubSingleAppCredentials } from './github-credentials.js';
import {
  createSingleAppGitHubResolver,
  exchangeGitHubOAuthCode,
  githubUserInstallations,
  requireGitHubInstallationOwner,
  revokeGitHubOAuthToken,
} from './single-app-resolver.js';

export function createGitHubBroker(options: {
  database: Database;
  app: GitHubSingleAppCredentials;
  publicAppUrl: string;
  fetchImplementation?: typeof fetch;
}): { dispatch(input: unknown): Promise<GitHubBrokerResponse> } {
  const backend = createBackend({ database: options.database });
  const resolver = createSingleAppGitHubResolver({
    database: options.database, app: options.app,
    ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
  });

  async function authorize(input: Extract<GitHubBrokerRequest, { operation: 'authorize' }>) {
    const context = await backend.github.consumeSingleAppState(input.actorId, input.state, options.app.id);
    if (context.purpose !== 'authorize' || !context.verifier || input.code.length > 512) throw new Error('github_oauth_context_invalid');
    const token = await exchangeGitHubOAuthCode({
      app: options.app, publicAppUrl: options.publicAppUrl, code: input.code, verifier: context.verifier,
      ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
    });
    try {
      if (!context.installationId) {
        const installations = await githubUserInstallations(token, options.fetchImplementation);
        return {
          operation: 'authorize' as const,
          result: { kind: 'choose' as const, organizationId: context.organizationId,
            installations: installations.map(item => ({ id: item.id, account: item.account })) },
        };
      }
      const { installation, githubUserId } = await requireGitHubInstallationOwner(
        token, context.installationId, options.fetchImplementation,
      );
      await backend.github.bindSingleApp({ userId: input.actorId }, {
        organizationId: context.organizationId,
        userId: input.actorId,
        state: input.state,
        installationId: context.installationId,
        accountLogin: installation.account.login,
        githubUserId,
        githubAccountId: String(installation.account.id),
        appId: options.app.id,
      });
      return { operation: 'authorize' as const, result: { kind: 'connected' as const, organizationId: context.organizationId } };
    } finally {
      await revokeGitHubOAuthToken({ app: options.app, token, ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}) }).catch(() => undefined);
    }
  }

  async function dispatch(input: unknown): Promise<GitHubBrokerResponse> {
    const request = githubBrokerRequestSchema.parse(input);
    let response: unknown;
    switch (request.operation) {
      case 'authorize':
        response = await authorize(request);
        break;
      case 'installationStatus':
        response = { operation: request.operation, ...await resolver.installationStatus(request.organizationId, request.installationId) };
        break;
      case 'listRepositories':
        response = { operation: request.operation, ...await resolver.listRepositories(request.organizationId, request.applicationId, request.installationId) };
        break;
      case 'readRepository':
        response = { operation: request.operation, ...await resolver.readRepository(request) };
        break;
      default: {
        const exhaustive: never = request;
        throw new Error(`github_broker_operation_unsupported:${String(exhaustive)}`);
      }
    }
    return githubBrokerResponseSchema.parse(response);
  }

  return { dispatch };
}
