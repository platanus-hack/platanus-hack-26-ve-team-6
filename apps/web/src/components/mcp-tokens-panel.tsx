import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { McpAccessToken } from '@gotchu/contracts';
import { CustomerApiError } from './customer-client';
import { mcpTokensApi } from './mcp-client';

const stateNames: Record<McpAccessToken['state'], string> = { active: 'Activo', expired: 'Caducado', revoked: 'Revocado' };
const lifetimes = [7, 30, 90] as const;

function formattedDate(value: string) { return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function friendlyError(error: unknown) {
  if (error instanceof CustomerApiError) return error.code === 'mcp_token_limit' ? 'Ya tienes 10 tokens activos en este espacio. Revoca uno antes de crear otro.' : error.message;
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
}

/** Connection snippets for the clients we document; the endpoint is this deployment's own origin. */
function connectionSnippets(endpoint: string, secret: string) {
  return [
    { label: 'Claude Code', value: `claude mcp add --transport http gotchu ${endpoint} --header "Authorization: Bearer ${secret}"` },
    { label: 'Codex (~/.codex/config.toml, con GOTCHU_MCP_TOKEN en el entorno)', value: `[mcp_servers.gotchu]\nurl = "${endpoint}"\nbearer_token_env_var = "GOTCHU_MCP_TOKEN"` },
    { label: 'IDE con mcp.json (Cursor, VS Code y similares)', value: JSON.stringify({ mcpServers: { gotchu: { url: endpoint, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2) },
  ];
}

export function McpTokensPanel({ userId, organizationId }: { userId: string; organizationId: string }) {
  const queryClient = useQueryClient();
  const key = ['customer-data', userId, 'mcp-tokens', organizationId] as const;
  const tokens = useQuery({ queryKey: key, queryFn: () => mcpTokensApi.list(organizationId), retry: false });
  const [label, setLabel] = useState('');
  const [expiresInDays, setExpiresInDays] = useState<(typeof lifetimes)[number]>(30);
  const [shown, setShown] = useState<{ label: string; secret: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => mcpTokensApi.create(organizationId, { label, expiresInDays }), onSuccess: async result => {
    setShown({ label: result.token.label, secret: result.secret }); setLabel(''); setNotice(null); await queryClient.invalidateQueries({ queryKey: key });
  } });
  const revoke = useMutation({ mutationFn: (tokenId: string) => mcpTokensApi.revoke(organizationId, tokenId), onSuccess: async () => {
    setNotice('Token revocado. Los asistentes que lo usaban pierden el acceso en su próxima llamada.'); await queryClient.invalidateQueries({ queryKey: key });
  } });
  const appOrigin = typeof window === 'undefined' ? '' : window.location.origin;
  const endpoint = `${appOrigin}/api/mcp`;
  const installRequest = `Instala Gotchu siguiendo ${appOrigin}/install`;

  function submit(event: FormEvent) { event.preventDefault(); create.mutate(); }
  async function copy(value: string, copied = 'Copiado. Guárdalo en el gestor de secretos de tu equipo.') {
    try { await navigator.clipboard.writeText(value); setNotice(copied); }
    catch { setNotice('No se pudo copiar automáticamente. Selecciona el texto y cópialo antes de cerrar esta vista.'); }
  }

  return <section className="customer-card customer-panel customer-mcp-card" aria-labelledby="mcp-title">
    <div className="customer-card-heading"><div><h2 id="mcp-title">Conectar un asistente de IA</h2></div><span className="customer-status customer-status-muted">Servidor MCP</span></div>
    <p className="customer-field-note">Acceso de sólo lectura: aplicaciones, informes, hallazgos con su evidencia y su prompt de corrección, alertas y estado de la vigilancia. No puede lanzar análisis, ejecutar agentes, aprobar ni cambiar nada.</p>

    <div className="customer-mcp-snippet"><span>Pídeselo a tu asistente</span><pre>{installRequest}</pre><button type="button" className="customer-link-button" onClick={() => { void copy(installRequest, 'Copiado. Pégalo en Claude, Codex o tu IDE y crea un token abajo cuando te lo pida.'); }}>Copiar</button></div>

    {notice && <p className="customer-success" role="status">{notice}</p>}
    {shown && <div className="customer-notification-secret" role="alert">
      <strong>Token de {shown.label}</strong><p>Cópialo ahora. Gotchu sólo guarda su huella y no podrá mostrarlo otra vez.</p>
      <code>{shown.secret}</code>
      <div className="customer-inline-control"><button type="button" className="customer-button customer-button-small" onClick={() => { void copy(shown.secret); }}>Copiar token</button><button type="button" className="customer-link-button" onClick={() => setShown(null)}>Ya lo guardé</button></div>
      {connectionSnippets(endpoint, shown.secret).map(snippet => <div className="customer-mcp-snippet" key={snippet.label}><span>{snippet.label}</span><pre>{snippet.value}</pre><button type="button" className="customer-link-button" onClick={() => { void copy(snippet.value); }}>Copiar</button></div>)}
    </div>}

    <form className="customer-form customer-mcp-form" onSubmit={submit}>
      <h3>Crear token</h3>
      <label htmlFor={`mcp-label-${organizationId}`}>Nombre</label>
      <input id={`mcp-label-${organizationId}`} required maxLength={120} placeholder="Claude Code en mi portátil" value={label} onChange={event => setLabel(event.target.value)} />
      <label htmlFor={`mcp-lifetime-${organizationId}`}>Caduca en</label>
      <select id={`mcp-lifetime-${organizationId}`} value={expiresInDays} onChange={event => setExpiresInDays(lifetimes.find(days => String(days) === event.target.value) ?? 30)}>{lifetimes.map(days => <option key={days} value={days}>{days} días</option>)}</select>
      {create.error && <p className="customer-form-error" role="alert">{friendlyError(create.error)}</p>}
      <button className="customer-button customer-button-primary" disabled={create.isPending || !label.trim()}>{create.isPending ? 'Creando…' : 'Crear token'}</button>
    </form>

    <div className="customer-notification-section"><h3>Tokens</h3>
      {tokens.isPending ? <div className="customer-loading" role="status">Cargando tokens…</div>
        : tokens.isError ? <div className="customer-form-error" role="alert">{friendlyError(tokens.error)} <button type="button" className="customer-link-button" onClick={() => { tokens.refetch().catch(() => undefined); }}>Reintentar</button></div>
        : tokens.data?.length ? <ul className="customer-ruled-list">{tokens.data.map(token => <li key={token.id}><div className="customer-notification-channel"><div>
            <strong>{token.label}</strong>
            <small>{stateNames[token.state]}{token.userId === userId ? '' : ` · de ${token.userId}`} · creado {formattedDate(token.createdAt)}</small>
            <small>{token.state === 'revoked' && token.revokedAt ? `Revocado ${formattedDate(token.revokedAt)}` : `Caduca ${formattedDate(token.expiresAt)}`} · {token.lastUsedAt ? `último uso ${formattedDate(token.lastUsedAt)}` : 'sin usar'}</small>
          </div><div className="customer-notification-actions">{token.state === 'active' && <button type="button" className="customer-link-button" disabled={revoke.isPending} onClick={() => revoke.mutate(token.id)}>Revocar</button>}</div></div></li>)}</ul>
        : <p className="customer-empty-inline">Todavía no hay tokens. Crea uno para conectar tu asistente.</p>}
      {revoke.error && <p className="customer-form-error" role="alert">{friendlyError(revoke.error)}</p>}
    </div>
  </section>;
}
