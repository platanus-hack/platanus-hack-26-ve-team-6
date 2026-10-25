import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { McpAccessToken } from '@gotchu/contracts';
import { CustomerApiError } from './customer-client';
import { mcpTokensApi } from './mcp-client';

const stateNames: Record<McpAccessToken['state'], string> = { active: 'Activo', expired: 'Caducado', revoked: 'Revocado' };
const lifetimes = [7, 30, 90] as const;

function formattedDate(value: string) { return new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(value)); }
function friendlyError(error: unknown) {
  if (error instanceof CustomerApiError) return error.code === 'mcp_token_limit' ? 'Ya tienes 10 tokens activos en este espacio. Revoca uno antes de crear otro.' : error.message;
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
}

export function McpTokensPanel({ userId, organizationId }: { userId: string; organizationId: string }) {
  const queryClient = useQueryClient();
  const key = ['customer-data', userId, 'mcp-tokens', organizationId] as const;
  const tokens = useQuery({ queryKey: key, queryFn: () => mcpTokensApi.list(organizationId), retry: false });
  const [label, setLabel] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<(typeof lifetimes)[number]>(30);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState<'install' | 'token' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => mcpTokensApi.create(organizationId, { label, expiresInDays }), onSuccess: async result => {
    setSecret(result.secret); setCopied(null); setLabel(''); setMessage(null); await queryClient.invalidateQueries({ queryKey: key });
  } });
  const revoke = useMutation({ mutationFn: (tokenId: string) => mcpTokensApi.revoke(organizationId, tokenId), onSuccess: async () => {
    setMessage('Token revocado. Los asistentes que lo usaban pierden el acceso.'); await queryClient.invalidateQueries({ queryKey: key });
  } });
  const installRequest = `Instala Gotchu siguiendo ${typeof window === 'undefined' ? '' : window.location.origin}/install`;

  function submit(event: FormEvent) { event.preventDefault(); create.mutate(); }
  async function copy(value: string, which: 'install' | 'token') {
    try { await navigator.clipboard.writeText(value); setCopied(which); }
    catch { setMessage('No se pudo copiar automáticamente. Selecciona el texto y cópialo.'); }
  }

  return <section className="customer-card customer-panel" aria-label="Servidor MCP">
    {message && <p role="status" className="customer-success">{message}</p>}
    <p>Solo lectura: ve informes, hallazgos con su prompt de corrección, alertas y vigilancia. No puede lanzar análisis, ejecutar agentes ni aprobar cambios.</p>

    <div className="customer-invite-link">
      <label htmlFor="mcp-install-request">Pídeselo a Claude, Codex o tu IDE</label>
      <div className="customer-inline-control">
        <input id="mcp-install-request" readOnly value={installRequest} onFocus={event => event.currentTarget.select()} />
        <button type="button" className="customer-button customer-button-small" onClick={() => { void copy(installRequest, 'install'); }}>{copied === 'install' ? 'Copiado' : 'Copiar'}</button>
      </div>
    </div>

    <form className="customer-form" onSubmit={submit}>
      <h3>Crear token</h3>
      <label htmlFor="mcp-token-label">Nombre</label>
      <input id="mcp-token-label" required maxLength={120} placeholder="Claude Code en mi portátil" value={label} onChange={event => setLabel(event.target.value)} />
      <label htmlFor="mcp-token-lifetime">Caduca en</label>
      <select id="mcp-token-lifetime" value={expiresInDays} onChange={event => setExpiresInDays(lifetimes.find(days => String(days) === event.target.value) ?? 30)}>{lifetimes.map(days => <option key={days} value={days}>{days} días</option>)}</select>
      <p className="customer-field-note">El asistente te lo pedirá al instalarse. Guárdalo en la variable de entorno GOTCHU_MCP_TOKEN.</p>
      {create.error && <p role="alert" className="customer-form-error">{friendlyError(create.error)}</p>}
      <button className="customer-button customer-button-primary" disabled={create.isPending || !label.trim()}>{create.isPending ? 'Creando…' : 'Crear token'}</button>
    </form>
    {secret && <div className="customer-invite-link">
      <label htmlFor="mcp-token-secret">Cópialo ahora: no se volverá a mostrar</label>
      <div className="customer-inline-control">
        <input id="mcp-token-secret" readOnly value={secret} onFocus={event => event.currentTarget.select()} />
        <button type="button" className="customer-button customer-button-small" onClick={() => { void copy(secret, 'token'); }}>{copied === 'token' ? 'Copiado' : 'Copiar token'}</button>
      </div>
    </div>}

    <section aria-labelledby="mcp-tokens-title"><h3 id="mcp-tokens-title">Tokens</h3>
      {tokens.isPending ? <div role="status" className="customer-loading">Cargando tokens…</div>
        : tokens.error ? <div role="alert" className="customer-form-error">{friendlyError(tokens.error)} <button type="button" className="customer-link-button" onClick={() => { tokens.refetch().catch(() => undefined); }}>Reintentar</button></div>
        : tokens.data?.length === 0 ? <p className="customer-empty-inline">Todavía no hay tokens.</p>
        : <ul className="customer-ruled-list">{tokens.data?.map(token => <li key={token.id}><div className="customer-member-row">
          <span className="customer-ruled-title"><strong>{token.label}</strong>
            <small>{token.userId === userId ? '' : `${token.userId} · `}{token.state === 'revoked' && token.revokedAt ? `revocado ${formattedDate(token.revokedAt)}` : `caduca ${formattedDate(token.expiresAt)}`} · {token.lastUsedAt ? `usado ${formattedDate(token.lastUsedAt)}` : 'sin usar'}</small></span>
          <span className="customer-status customer-status-muted">{stateNames[token.state]}</span>
          {token.state === 'active' && <button type="button" className="customer-link-button" disabled={revoke.isPending} onClick={() => revoke.mutate(token.id)}>Revocar</button>}
        </div></li>)}</ul>}
      {revoke.error && <p role="alert" className="customer-form-error">{friendlyError(revoke.error)}</p>}
    </section>
  </section>;
}
