import { randomBytes, randomUUID } from 'node:crypto';
import { githubBindInputSchema, githubConnectionSchema, githubLinkInputSchema, githubScopeSchema, type GitHubConnection } from '@gotchu/contracts';
import { audit, authorize, BackendError, parse, sha256, type BaseDependencies, type Identity } from './core.js';

export function createGitHubConnectionService(deps: BaseDependencies) {
  return {
    async createState(identity: Identity, input: unknown): Promise<string> {
      const scope = parse(githubScopeSchema, input);
      const state = randomBytes(32).toString('base64url');
      const result = await deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity, ['owner', 'operator']);
        const created = await tx.query<{ created: boolean }>('SELECT gotchu.github_create_state($1,$2,$3) AS created', [scope.organizationId, identity.userId, sha256(state)]);
        if (created.rows[0]?.created) await audit(tx, scope.organizationId, identity.userId, 'github.oauth_started', null);
        return created;
      });
      if (!result.rows[0]?.created) throw new BackendError('forbidden', 'Organization membership does not authorize GitHub connections', 403);
      return state;
    },
    async consumeState(identity: Identity, state: string): Promise<string> {
      const result = await deps.database.tenant('00000000-0000-0000-0000-000000000000', tx => tx.query<{ organization_id: string }>(
        'SELECT organization_id FROM gotchu.github_consume_state($1,$2)', [sha256(state), identity.userId],
      ));
      const organizationId = result.rows[0]?.organization_id;
      if (!organizationId) throw new BackendError('github_state_invalid', 'La conexión de GitHub expiró o ya se utilizó. Inicia la conexión de nuevo.', 400);
      return organizationId;
    },
    async bind(identity: Identity, input: unknown): Promise<GitHubConnection> {
      const value = parse(githubBindInputSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator']);
        const result = await tx.query<{ result: string }>('SELECT gotchu.github_bind_installation($1,$2,$3,$4) AS result', [value.organizationId, identity.userId, value.installationId, value.accountLogin]);
        const status = result.rows[0]?.result;
        if (status === 'already_bound') throw new BackendError('github_installation_bound', 'Esta instalación ya está vinculada a otro espacio de trabajo.', 409);
        if (status === 'owner_required_to_move') throw new BackendError('github_move_owner_required', 'Un Owner debe autorizar el traslado de una instalación desconectada desde otro espacio de trabajo.', 403);
        if (status !== 'bound') throw new BackendError('forbidden', 'No se pudo autorizar esta instalación para el espacio de trabajo.', 403);
        await audit(tx, value.organizationId, identity.userId, 'github.installation_connected', null, { installationId: value.installationId, accountLogin: value.accountLogin });
        return parse(githubConnectionSchema, { installationId: value.installationId, accountLogin: value.accountLogin, state: 'active', connectedAt: new Date().toISOString() });
      });
    },
    async list(identity: Identity, input: unknown): Promise<GitHubConnection[]> {
      const scope = parse(githubScopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity);
        const result = await tx.query<{ installation_id: string; account_login: string; state: 'active' | 'revoked'; connected_at: Date }>('SELECT installation_id,account_login,state,connected_at FROM gotchu.github_installations WHERE organization_id=$1 ORDER BY connected_at DESC LIMIT 20', [scope.organizationId]);
        return result.rows.map(row => parse(githubConnectionSchema, { installationId: row.installation_id, accountLogin: row.account_login, state: row.state, connectedAt: row.connected_at.toISOString() }));
      });
    },
    async revoke(identity: Identity, organizationId: string, installationId: string): Promise<void> {
      const scope = parse(githubScopeSchema, { organizationId });
      await deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity, ['owner', 'operator']);
        const result = await tx.query<{ revoked: boolean }>('SELECT gotchu.github_revoke_installation($1,$2,$3) AS revoked', [scope.organizationId, identity.userId, installationId]);
        if (!result.rows[0]?.revoked) throw new BackendError('not_found', 'La conexión ya está revocada o no existe.', 404);
        await audit(tx, scope.organizationId, identity.userId, 'github.installation_revoked', null, { installationId });
      });
    },
    async createRepositoryLink(identity: Identity, input: unknown) {
      const value = parse(githubLinkInputSchema, input);
      const id = randomUUID();
      const linkId = await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator']);
        const result = await tx.query<{ link_id: string | null }>('SELECT gotchu.github_create_repository_link($1,$2,$3,$4,$5,$6,$7) AS link_id', [value.organizationId, value.applicationId, identity.userId, value.installationId, id, `gh-${value.repositoryId}`, value.defaultBranch]);
        const linkId = result.rows[0]?.link_id;
        if (!linkId) throw new BackendError('forbidden', 'El repositorio no pertenece a una instalación activa de este espacio.', 403);
        await audit(tx, value.organizationId, identity.userId, 'github.repository_linked', linkId, { installationId: value.installationId, repositoryId: value.repositoryId, repository: value.fullName });
        return linkId;
      });
      return { id: linkId, applicationId: value.applicationId, repositoryKey: `gh-${value.repositoryId}`, fullName: value.fullName, defaultBranch: value.defaultBranch, readAccess: 'granted' as const, writeAccess: 'not_granted' as const };
    },
  };
}
