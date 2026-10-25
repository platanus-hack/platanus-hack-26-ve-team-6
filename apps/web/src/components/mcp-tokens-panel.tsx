import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { McpAccessToken } from '@gotchu/contracts';
import { CustomerApiError } from './customer-client';
import { mcpTokensApi } from './mcp-client';

const stateNames: Record<McpAccessToken['state'], string> = { active: 'Activo', expired: 'Caducado', revoked: 'Revocado' };
const lifetimes = [7, 30, 90] as const;
const examples = [
  '¿Qué alertas abiertas tiene mi aplicación?',
  'Resume el último informe y ordena los hallazgos por gravedad.',
  'Dame el prompt para corregir el hallazgo más grave y aplícalo en este repositorio.',
];

function formattedDate(value: string) { return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function friendlyError(error: unknown) {
  if (error instanceof CustomerApiError) return error.code === 'mcp_token_limit' ? 'Ya tienes 10 tokens activos en este espacio. Revoca uno antes de crear otro.' : error.message;
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
}

/** Manual setup for the clients we document. The token stays in GOTCHU_MCP_TOKEN, never in shared files. */
function manualSetup(endpoint: string) {
  return [
    { label: 'Claude Code', value: `claude mcp add --transport http --scope user gotchu ${endpoint} --header "Authorization: Bearer $GOTCHU_MCP_TOKEN"` },
    { label: 'Codex (~/.codex/config.toml)', value: `[mcp_servers.gotchu]\nurl = "${endpoint}"\nbearer_token_env_var = "GOTCHU_MCP_TOKEN"` },
    { label: 'IDE con mcp.json (Cursor, VS Code y similares)', value: JSON.stringify({ mcpServers: { gotchu: { url: endpoint, headers: { Authorization: 'Bearer ${GOTCHU_MCP_TOKEN}' } } } }, null, 2) },
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
  async function copy(value: string, copied = 'Copiado.') {
    try { await navigator.clipboard.writeText(value); setNotice(copied); }
    catch { setNotice('No se pudo copiar automáticamente. Selecciona el texto y cópialo.'); }
  }
  const snippet = (title: string, value: string, copied?: string) => <div className="customer-mcp-snippet" key={title}>
    <span>{title}</span><pre>{value}</pre>
    <button type="button" className="customer-link-button" onClick={() => { void copy(value, copied); }}>Copiar</button>
  </div>;

  return <div className="customer-mcp-page">
    {notice && <p className="customer-success" role="status">{notice}</p>}

    <section className="customer-card customer-panel" aria-labelledby="mcp-step-token">
      <h2 id="mcp-step-token">1. Crea un token</h2>
      <p className="customer-field-note">Es personal y sólo da acceso de lectura a este espacio de trabajo.</p>
      {shown ? <div className="customer-notification-secret" role="alert">
        <strong>Token de {shown.label}</strong><p>Cópialo ahora: no se volverá a mostrar. Guárdalo en la variable de entorno <code>GOTCHU_MCP_TOKEN</code>.</p>
        <code>{shown.secret}</code>
        <div className="customer-inline-control">
          <button type="button" className="customer-button customer-button-small" onClick={() => { void copy(`export GOTCHU_MCP_TOKEN=${shown.secret}`, 'Copiado. Pégalo en tu terminal o en el perfil de tu shell.'); }}>Copiar como variable</button>
          <button type="button" className="customer-link-button" onClick={() => setShown(null)}>Ya lo guardé</button>
        </div>
      </div> : <form className="customer-form customer-mcp-form" onSubmit={submit}>
        <label htmlFor={`mcp-label-${organizationId}`}>Nombre</label>
        <input id={`mcp-label-${organizationId}`} required maxLength={120} placeholder="Claude Code en mi portátil" value={label} onChange={event => setLabel(event.target.value)} />
        <label htmlFor={`mcp-lifetime-${organizationId}`}>Caduca en</label>
        <select id={`mcp-lifetime-${organizationId}`} value={expiresInDays} onChange={event => setExpiresInDays(lifetimes.find(days => String(days) === event.target.value) ?? 30)}>{lifetimes.map(days => <option key={days} value={days}>{days} días</option>)}</select>
        {create.error && <p className="customer-form-error" role="alert">{friendlyError(create.error)}</p>}
        <button className="customer-button customer-button-primary" disabled={create.isPending || !label.trim()}>{create.isPending ? 'Creando…' : 'Crear token'}</button>
      </form>}
    </section>

    <section className="customer-card customer-panel" aria-labelledby="mcp-step-connect">
      <h2 id="mcp-step-connect">2. Conecta tu asistente</h2>
      {snippet('Pídeselo a Claude, Codex o tu IDE', installRequest, 'Copiado. Pégalo en tu asistente.')}
      <details className="customer-mcp-manual">
        <summary>Configurarlo a mano</summary>
        {manualSetup(endpoint).map(item => snippet(item.label, item.value))}
      </details>
    </section>

    <section className="customer-card customer-panel" aria-labelledby="mcp-step-ask">
      <h2 id="mcp-step-ask">3. Pregúntale</h2>
      <ul className="customer-mcp-examples">{examples.map(example => <li key={example}>{example}</li>)}</ul>
      <p className="customer-field-note">Puede ver aplicaciones, informes, hallazgos con su evidencia y su prompt de corrección, alertas y el estado de la vigilancia. No puede lanzar análisis, ejecutar agentes, aprobar ni cambiar nada.</p>
    </section>

    <section className="customer-card customer-panel" aria-labelledby="mcp-tokens-title">
      <h2 id="mcp-tokens-title">Tokens</h2>
      {tokens.isPending ? <div className="customer-loading" role="status">Cargando tokens…</div>
        : tokens.isError ? <div className="customer-form-error" role="alert">{friendlyError(tokens.error)} <button type="button" className="customer-link-button" onClick={() => { tokens.refetch().catch(() => undefined); }}>Reintentar</button></div>
        : tokens.data?.length ? <ul className="customer-ruled-list">{tokens.data.map(token => <li key={token.id}><div className="customer-notification-channel"><div>
            <strong>{token.label}</strong>
            <small>{stateNames[token.state]}{token.userId === userId ? '' : ` · de ${token.userId}`} · creado {formattedDate(token.createdAt)}</small>
            <small>{token.state === 'revoked' && token.revokedAt ? `Revocado ${formattedDate(token.revokedAt)}` : `Caduca ${formattedDate(token.expiresAt)}`} · {token.lastUsedAt ? `último uso ${formattedDate(token.lastUsedAt)}` : 'sin usar'}</small>
          </div><div className="customer-notification-actions">{token.state === 'active' && <button type="button" className="customer-link-button" disabled={revoke.isPending} onClick={() => revoke.mutate(token.id)}>Revocar</button>}</div></div></li>)}</ul>
        : <p className="customer-empty-inline">Todavía no hay tokens.</p>}
      {revoke.error && <p className="customer-form-error" role="alert">{friendlyError(revoke.error)}</p>}
    </section>
  </div>;
}
