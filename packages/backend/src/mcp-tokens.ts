import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { createMcpAccessTokenSchema, mcpAccessTokenSchema, mcpBearerTokenSchema, type McpAccessToken } from '@gotchu/contracts';
import type { Transaction } from '@gotchu/database';
import { audit, authorize, BackendError, parse, sha256, type BaseDependencies, type Identity } from './core.js';

/** What a verified MCP bearer token may act as: one member, in one workspace, with that member's current role. */
export interface McpPrincipal { identity: Identity; organizationId: string; tokenId: string }

const MAX_ACTIVE_TOKENS_PER_MEMBER = 10;
const workspaceScope = z.object({ organizationId: z.uuid() }).strict();
const tokenProjection = `id,label,user_id,created_at,expires_at,last_used_at,revoked_at,
  CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at<=clock_timestamp() THEN 'expired' ELSE 'active' END AS state`;
type TokenRow = { id: string; label: string; user_id: string; created_at: Date; expires_at: Date; last_used_at: Date | null; revoked_at: Date | null; state: string };

function project(row: TokenRow): McpAccessToken {
  return mcpAccessTokenSchema.parse({ id: row.id, label: row.label, userId: row.user_id, state: row.state, createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(), lastUsedAt: row.last_used_at?.toISOString() ?? null, revokedAt: row.revoked_at?.toISOString() ?? null });
}

const unauthenticated = () => new BackendError('mcp_token_invalid', 'The MCP access token is missing, expired, revoked or no longer backed by a membership', 401);

export function createMcpTokenService(deps: BaseDependencies) {
  async function tokenById(tx: Transaction, organizationId: string, id: string) {
    const result = await tx.query<TokenRow>(`SELECT ${tokenProjection} FROM gotchu.mcp_access_tokens WHERE organization_id=$1 AND id=$2`, [organizationId, id]);
    return result.rows[0];
  }

  return {
    /** Any member may mint a token for themselves; it never carries more than their role, and approvals stay outside MCP. */
    async create(identity: Identity, input: { organizationId: string } & z.input<typeof createMcpAccessTokenSchema>) {
      const { organizationId, ...raw } = input;
      const value = parse(workspaceScope.extend(createMcpAccessTokenSchema.shape).strict(), { organizationId, ...raw });
      const id = randomUUID();
      const secret = randomBytes(32).toString('base64url');
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`mcp-tokens:${value.organizationId}:${identity.userId}`]);
        const active = await tx.query<{ total: number }>(`SELECT count(*)::int AS total FROM gotchu.mcp_access_tokens
          WHERE organization_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [value.organizationId, identity.userId]);
        if ((active.rows[0]?.total ?? MAX_ACTIVE_TOKENS_PER_MEMBER) >= MAX_ACTIVE_TOKENS_PER_MEMBER) {
          throw new BackendError('mcp_token_limit', 'Revoke an existing MCP token before creating another', 429);
        }
        await tx.query(`INSERT INTO gotchu.mcp_access_tokens(organization_id,id,user_id,label,secret_hash,expires_at)
          VALUES($1,$2,$3,$4,$5,clock_timestamp()+make_interval(days=>$6))`, [value.organizationId, id, identity.userId, value.label, sha256(secret), value.expiresInDays]);
        await audit(tx, value.organizationId, identity.userId, 'mcp.token_created', id, { expiresInDays: value.expiresInDays });
        const row = await tokenById(tx, value.organizationId, id);
        if (!row) throw new Error('Created MCP token disappeared');
        return { token: project(row), secret: mcpBearerTokenSchema.parse(`gmcp.${value.organizationId}.${id}.${secret}`) };
      });
    },

    /** Owners see every member's tokens so they can revoke them; other members see their own. */
    async list(identity: Identity, input: { organizationId: string }): Promise<McpAccessToken[]> {
      const value = parse(workspaceScope, input);
      return deps.database.tenant(value.organizationId, async tx => {
        const role = await authorize(tx, value.organizationId, identity);
        const result = await tx.query<TokenRow>(`SELECT ${tokenProjection} FROM gotchu.mcp_access_tokens WHERE organization_id=$1 AND ($2 OR user_id=$3)
          ORDER BY CASE WHEN revoked_at IS NULL AND expires_at>clock_timestamp() THEN 0 ELSE 1 END,created_at DESC,id LIMIT 1000`, [value.organizationId, role === 'owner', identity.userId]);
        return result.rows.map(project);
      });
    },

    async revoke(identity: Identity, input: { organizationId: string; tokenId: string }): Promise<McpAccessToken> {
      const value = parse(workspaceScope.extend({ tokenId: z.uuid() }).strict(), input);
      return deps.database.tenant(value.organizationId, async tx => {
        const role = await authorize(tx, value.organizationId, identity);
        const current = await tokenById(tx, value.organizationId, value.tokenId);
        if (!current || (role !== 'owner' && current.user_id !== identity.userId)) throw new BackendError('not_found', 'MCP token not found', 404);
        await tx.query(`UPDATE gotchu.mcp_access_tokens SET revoked_at=clock_timestamp(),revoked_by=$3
          WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL`, [value.organizationId, value.tokenId, identity.userId]);
        await audit(tx, value.organizationId, identity.userId, 'mcp.token_revoked', value.tokenId, { ownerUserId: current.user_id });
        const row = await tokenById(tx, value.organizationId, value.tokenId);
        if (!row) throw new Error('Revoked MCP token disappeared');
        return project(row);
      });
    },

    /** Verifies a bearer token on every MCP request. Failures are indistinguishable to the caller. */
    async authenticate(bearer: string): Promise<McpPrincipal> {
      const parsed = mcpBearerTokenSchema.safeParse(bearer);
      if (!parsed.success) throw unauthenticated();
      const [, organizationId = '', tokenId = '', secret = ''] = parsed.data.split('.');
      if (!z.uuid().safeParse(organizationId).success || !z.uuid().safeParse(tokenId).success) throw unauthenticated();
      return deps.database.tenant(organizationId, async tx => {
        const result = await tx.query<{ user_id: string; secret_hash: string; usable: boolean; stale_use: boolean }>(`SELECT t.user_id,t.secret_hash,
          (t.revoked_at IS NULL AND t.expires_at>clock_timestamp() AND m.joined_at<=t.created_at) AS usable,
          coalesce(t.last_used_at<clock_timestamp()-interval '1 minute',true) AS stale_use
          FROM gotchu.mcp_access_tokens t LEFT JOIN gotchu.memberships m ON m.organization_id=t.organization_id AND m.user_id=t.user_id
          WHERE t.organization_id=$1 AND t.id=$2`, [organizationId, tokenId]);
        const row = result.rows[0];
        const expected = Buffer.from(row?.secret_hash ?? '0'.repeat(64), 'hex');
        const matches = timingSafeEqual(expected, Buffer.from(sha256(secret), 'hex'));
        // A member who left and was invited back does not revive tokens minted before they left.
        if (!row || !matches || !row.usable) throw unauthenticated();
        if (row.stale_use) await tx.query('UPDATE gotchu.mcp_access_tokens SET last_used_at=clock_timestamp() WHERE organization_id=$1 AND id=$2', [organizationId, tokenId]);
        return { identity: { userId: row.user_id }, organizationId: organizationId.toLowerCase(), tokenId: tokenId.toLowerCase() };
      });
    },
  };
}
