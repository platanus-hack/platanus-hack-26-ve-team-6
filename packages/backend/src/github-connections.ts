import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Transaction } from '@gotchu/database';
import { customerScopeSchema, customerSourceSnapshotSchema, githubBindInputSchema, githubCapturedSourceInputSchema, githubConnectionSchema,
  githubLinkInputSchema, githubScopeSchema, githubSingleAppBindInputSchema, githubSingleAppOAuthStartSchema,
  githubOAuthContextSchema, singleGitHubPublicAppSchema, type GitHubConnection } from '@gotchu/contracts';
import { audit, authorize, BackendError, canonicalJson, identitySchema, parse, sha256, type BaseDependencies, type Identity } from './core.js';

const appIdSchema = singleGitHubPublicAppSchema.shape.id;
const installationScopeSchema = githubScopeSchema.extend({ applicationId: z.uuid().optional(), installationId: appIdSchema }).strict();
const repositoryScopeSchema = githubScopeSchema.extend({ applicationId: z.uuid(), repositoryLinkId: z.uuid() }).strict();
const installationRowSchema = z.object({ installation_id: appIdSchema, app_id: appIdSchema }).strict();
const repositoryRowSchema = installationRowSchema.extend({ repository_link_id: z.uuid(), repository_id: z.string().regex(/^[0-9]{1,20}$/),
  repository_key: z.string().regex(/^gh-[0-9]{1,20}$/), default_branch: z.string().min(1).max(200) }).strict();
type OAuthContextRow = { organization_id: string; pkce_verifier: string | null; installation_id: string | null; purpose: string };
function oauthContext(row: OAuthContextRow | undefined) {
  if (!row) throw new BackendError('github_state_invalid', 'La conexión de GitHub expiró o ya se utilizó. Inicia la conexión de nuevo.', 400);
  return parse(githubOAuthContextSchema, { organizationId: row.organization_id, verifier: row.pkce_verifier, installationId: row.installation_id, purpose: row.purpose });
}
function requireBound(status: string | undefined) {
  if (status === 'already_bound') throw new BackendError('github_installation_bound', 'Esta instalación ya está vinculada a otro espacio de trabajo.', 409);
  if (status === 'owner_required_to_move') throw new BackendError('github_move_owner_required', 'Un Owner debe autorizar el traslado de una instalación desconectada desde otro espacio de trabajo.', 403);
  if (status === 'reconnection_required') throw new BackendError('github_reconnection_required', 'Desconecta la instalación y vuelve a autorizar la GitHub App configurada.', 409);
  if (status !== 'bound') throw new BackendError('forbidden', 'No se pudo autorizar esta instalación para el espacio de trabajo.', 403);
}

/** Trusted broker authorization; the authenticated caller supplies tenant scope, never a provider URL. */
export async function loadSingleAppInstallation(tx: Transaction, scope: { organizationId: string; applicationId?: string; installationId: string }, appId: string) {
  const value = parse(installationScopeSchema, scope);
  const expectedApp = parse(appIdSchema, appId);
  const result = await tx.query('SELECT * FROM gotchu.github_single_app_installation($1,$2,$3,$4)',
    [value.organizationId, value.applicationId ?? null, value.installationId, expectedApp]);
  if (!result.rows[0]) throw new BackendError('github_connection_unavailable', 'Vuelve a conectar la GitHub App para este espacio.', 403);
  const row = parse(installationRowSchema, result.rows[0]);
  return { installationId: row.installation_id, appId: row.app_id };
}

export async function loadSingleAppRepository(tx: Transaction, scope: { organizationId: string; applicationId: string; repositoryLinkId: string }, appId: string) {
  const value = parse(repositoryScopeSchema, scope);
  const expectedApp = parse(appIdSchema, appId);
  const result = await tx.query('SELECT * FROM gotchu.github_single_app_repository($1,$2,$3,$4)',
    [value.organizationId, value.applicationId, value.repositoryLinkId, expectedApp]);
  if (!result.rows[0]) throw new BackendError('github_repository_not_authorized', 'El repositorio ya no tiene acceso de lectura autorizado.', 403);
  const row = parse(repositoryRowSchema, result.rows[0]);
  const repositoryId = parse(z.number().int().positive(), Number(row.repository_id));
  return { repositoryLinkId: row.repository_link_id, repositoryId, repositoryKey: row.repository_key,
    defaultBranch: row.default_branch, installationId: row.installation_id, appId: row.app_id };
}

/** Shared trusted import transaction; stored bytes and current authority are checked before binding. */
export async function bindCapturedSource(tx: Transaction, identity: Identity, value: z.infer<typeof githubCapturedSourceInputSchema>): Promise<void> {
  await authorize(tx, value.organizationId, identity, ['owner', 'operator']);
  const repository = await loadSingleAppRepository(tx, { organizationId: value.organizationId,
    applicationId: value.applicationId, repositoryLinkId: value.repositoryLinkId }, value.appId);
  if (repository.installationId !== value.installationId || repository.repositoryId !== value.repositoryId) {
    throw new BackendError('github_source_scope_mismatch', 'La captura no corresponde al repositorio autorizado.', 409);
  }
  const result = await tx.query<{ body: unknown; digest: string; deleted_at: Date | null }>(
    'SELECT body,digest,deleted_at FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2 AND id=$3',
    [value.organizationId, value.applicationId, value.sourceSnapshotId]);
  const source = result.rows[0];
  const snapshot = customerSourceSnapshotSchema.safeParse(source?.body);
  if (!source || source.deleted_at !== null || !snapshot.success || snapshot.data.revision !== value.commitSha
    || source.digest !== value.digest || sha256(canonicalJson(snapshot.data)) !== value.digest) {
    throw new BackendError('github_source_digest_mismatch', 'La fuente almacenada no coincide con la captura de GitHub.', 409);
  }
  const bound = await tx.query<{ imported: boolean }>('SELECT gotchu.github_import_captured_source($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS imported',
    [value.organizationId, value.applicationId, identity.userId, value.repositoryLinkId, value.sourceSnapshotId,
      value.appId, value.installationId, String(value.repositoryId), value.commitSha, value.treeSha, value.digest]);
  if (!bound.rows[0]?.imported) throw new BackendError('github_source_binding_conflict', 'La fuente ya tiene otra identidad de repositorio o perdió su autorización.', 409);
  await audit(tx, value.organizationId, identity.userId, 'github.source_imported', value.sourceSnapshotId, {
    applicationId: value.applicationId, repositoryLinkId: value.repositoryLinkId, appId: value.appId,
    installationId: value.installationId, repositoryId: value.repositoryId, commitSha: value.commitSha, treeSha: value.treeSha, digest: value.digest,
  });
}

export function createGitHubConnectionService(deps: BaseDependencies) {
  return {
    async workspaceName(identity: Identity, organizationId: string): Promise<string> {
      const scope = parse(githubScopeSchema, { organizationId });
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity, ['owner', 'operator']);
        const result = await tx.query<{ name: string }>('SELECT name FROM gotchu.organizations WHERE id=$1', [scope.organizationId]);
        const name = result.rows[0]?.name;
        if (!name) throw new BackendError('not_found', 'El espacio de trabajo no está disponible.', 404);
        return name;
      });
    },
    async createState(identity: Identity, input: unknown) {
      const scope = parse(githubSingleAppOAuthStartSchema, input);
      const state = randomBytes(32).toString('base64url');
      const verifier = scope.purpose === 'authorize' ? randomBytes(32).toString('base64url') : null;
      const result = await deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity, ['owner', 'operator']);
        const parameters = [scope.organizationId, identity.userId, sha256(state), verifier, scope.installationId, scope.purpose];
        const created = scope.appId === undefined
          ? await tx.query<{ created: boolean }>('SELECT gotchu.github_create_state($1,$2,$3,$4,$5,$6) AS created', parameters)
          : await tx.query<{ created: boolean }>('SELECT gotchu.github_create_single_app_state($1,$2,$3,$4,$5,$6,$7) AS created', [...parameters, scope.appId]);
        if (created.rows[0]?.created) await audit(tx, scope.organizationId, identity.userId, 'github.oauth_started', null);
        return created;
      });
      if (!result.rows[0]?.created) throw new BackendError('forbidden', 'Organization membership does not authorize GitHub connections', 403);
      return { state, codeChallenge: verifier ? Buffer.from(sha256(verifier), 'hex').toString('base64url') : null };
    },
    async consumeState(identity: Identity, state: string, appId?: string) {
      const actor = parse(identitySchema, identity);
      const result = await deps.database.tenant('00000000-0000-0000-0000-000000000000', tx => appId === undefined
        ? tx.query<OAuthContextRow>('SELECT * FROM gotchu.github_consume_state($1,$2)', [sha256(state), actor.userId])
        : tx.query<OAuthContextRow>('SELECT * FROM gotchu.github_consume_public_state($1,$2,$3)', [sha256(state), actor.userId, parse(appIdSchema, appId)]));
      return oauthContext(result.rows[0]);
    },
    async consumeSingleAppState(actorId: string, state: string, appId: string) {
      if (deps.database.role !== 'gotchu_executor') throw new BackendError('forbidden', 'Single-App OAuth requires the executor role', 403);
      const actor = parse(identitySchema, { userId: actorId });
      const expectedApp = parse(appIdSchema, appId);
      const value = parse(githubBindInputSchema.shape.state, state);
      const result = await deps.database.tenant('00000000-0000-0000-0000-000000000000', tx =>
        tx.query<OAuthContextRow>('SELECT * FROM gotchu.github_consume_single_app_state($1,$2,$3)', [sha256(value), actor.userId, expectedApp]));
      return oauthContext(result.rows[0]);
    },
    async bind(identity: Identity, input: unknown): Promise<GitHubConnection> {
      const value = parse(githubBindInputSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator']);
        const result = await tx.query<{ result: string }>('SELECT gotchu.github_bind_installation($1,$2,$3,$4) AS result', [value.organizationId, identity.userId, value.installationId, value.accountLogin]);
        requireBound(result.rows[0]?.result);
        await audit(tx, value.organizationId, identity.userId, 'github.installation_connected', null, { installationId: value.installationId, accountLogin: value.accountLogin, githubUserId: value.githubUserId, githubAccountId: value.githubAccountId, consentVersion: 1 });
        return parse(githubConnectionSchema, { installationId: value.installationId, accountLogin: value.accountLogin, state: 'active', connectedAt: new Date().toISOString() });
      });
    },
    async bindSingleApp(identity: Identity, input: unknown): Promise<GitHubConnection> {
      if (deps.database.role !== 'gotchu_executor') throw new BackendError('forbidden', 'Single-App binding requires the executor role', 403);
      const value = parse(githubSingleAppBindInputSchema, input);
      const actor = parse(identitySchema, identity);
      if (value.userId !== actor.userId) throw new BackendError('forbidden', 'GitHub authorization actor changed', 403);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, actor, ['owner', 'operator']);
        const result = await tx.query<{ result: string }>('SELECT gotchu.github_bind_single_app($1,$2,$3,$4,$5) AS result',
          [value.organizationId, actor.userId, value.installationId, value.accountLogin, value.appId]);
        requireBound(result.rows[0]?.result);
        await audit(tx, value.organizationId, actor.userId, 'github.installation_connected', null, {
          installationId: value.installationId, accountLogin: value.accountLogin, githubUserId: value.githubUserId,
          githubAccountId: value.githubAccountId, consentVersion: 2, appId: value.appId, connectionMode: 'single_app',
        });
        return parse(githubConnectionSchema, { installationId: value.installationId, accountLogin: value.accountLogin,
          state: 'active', connectedAt: new Date().toISOString() });
      });
    },
    /** Server-only: input must come from an authenticated broker capture, never a customer request body. */
    async importCapturedSource(identity: Identity, input: unknown): Promise<void> {
      if (deps.database.role !== 'gotchu_api') throw new BackendError('forbidden', 'Captured source import requires the API role', 403);
      const value = parse(githubCapturedSourceInputSchema, input);
      await deps.database.tenant(value.organizationId, tx => bindCapturedSource(tx, identity, value));
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
    /** Active App-connected repositories of one application, for choosing what to monitor. */
    async listRepositoryLinks(identity: Identity, input: { organizationId: string; applicationId: string }) {
      const scope = parse(customerScopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity);
        const result = await tx.query<{ repository_key: string; installation_id: string }>(`SELECT l.repository_key,l.installation_id FROM gotchu.application_repository_links l
          JOIN gotchu.github_installations g ON g.organization_id=l.organization_id AND g.installation_id=l.installation_id
          WHERE l.organization_id=$1 AND l.application_id=$2 AND l.source='github_app' AND NOT l.revoked AND l.read_access='granted' AND g.state='active'
          ORDER BY l.created_at LIMIT 20`, [scope.organizationId, scope.applicationId]);
        return result.rows.map(row => ({ repositoryKey: row.repository_key, installationId: row.installation_id }));
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
