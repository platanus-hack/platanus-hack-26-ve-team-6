import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { ProviderConnection } from '@gotchu/contracts';
import { customerApi, CustomerApiError } from './customer-client';

export function ProviderConnectionButton({ organizationId, provider, disabled, prepare, onConnected, onPendingChange }: {
  organizationId: string; provider: 'codex' | 'claude_code' | 'openrouter'; disabled: boolean; prepare(): Promise<unknown>;
  onConnected(): void; onPendingChange(pending: boolean): void;
}) {
  const [connection, setConnection] = useState<ProviderConnection | null>(null);
  const [authorizationCode, setAuthorizationCode] = useState('');
  const label = provider === 'codex' ? 'ChatGPT' : provider === 'claude_code' ? 'Claude' : 'OpenRouter';
  const [copied, setCopied] = useState(false);
  const popup = useRef<Window | null>(null);
  const notified = useRef<string | null>(null);
  const start = useMutation({
    mutationFn: async () => { await prepare(); return customerApi.startProviderConnection(organizationId, provider); },
    onSuccess: value => {
      setConnection(value); setCopied(false);
      if (value.status === 'pending' && popup.current && !popup.current.closed) popup.current.location.replace(value.verificationUrl);
    },
    onError: () => { popup.current?.close(); },
  });
  const poll = useQuery({
    queryKey: ['customer-data', organizationId, provider, 'provider-connection', connection?.id],
    queryFn: () => {
      if (!connection) throw new Error('Connection required');
      return customerApi.providerConnection(organizationId, provider, connection.id);
    },
    enabled: connection?.status === 'pending', retry: false,
    gcTime: 0,
    refetchInterval: query => query.state.error || (query.state.data && query.state.data.status !== 'pending') ? false : 2000,
    refetchIntervalInBackground: true,
  });
  const current: ProviderConnection | null = poll.error && connection ? { id: connection.id, status: 'failed' } : poll.data ?? connection;
  const pending = start.isPending || current?.status === 'pending';
  useEffect(() => { onPendingChange(pending); return () => onPendingChange(false); }, [pending, onPendingChange]);
  useEffect(() => {
    if (current?.status === 'connected' && notified.current !== current.id) { notified.current = current.id; onConnected(); }
  }, [current, onConnected]);
  const cancel = useMutation({
    mutationFn: () => {
      if (!connection) throw new Error('Connection required');
      return customerApi.cancelProviderConnection(organizationId, provider, connection.id);
    },
    onSuccess: value => { setConnection(value); void poll.refetch(); },
  });
  const submitCode = useMutation({
    mutationFn: () => {
      if (!connection) throw new Error('Connection required');
      return customerApi.providerConnection(organizationId, provider, connection.id, authorizationCode.trim());
    },
    onSuccess: () => { setAuthorizationCode(''); void poll.refetch(); },
  });
  const error = start.error ?? poll.error ?? cancel.error ?? submitCode.error;
  return <div className="customer-provider-connection">
    <p>Conecta tu cuenta {label} para usar {provider === 'openrouter' ? 'tus créditos' : 'tu suscripción'}. La sesión se guarda sólo en el servidor de Gotchu. Si ya autorizaste datos, comprobaremos la conexión al volver.</p>
    <button type="button" className="customer-button customer-button-primary" disabled={disabled || pending} onClick={() => {
      // Open during the click so popup blockers do not interrupt the asynchronous ceremony.
      popup.current = window.open('about:blank', '_blank');
      if (popup.current) popup.current.opener = null;
      setConnection(null); start.mutate();
    }}>{start.isPending ? 'Preparando conexión…' : `Conectar ${label}`}</button>
    {current?.status === 'pending' && <div role="status" aria-live="polite">
      <p>Autoriza la conexión en {label}:</p>
      {current.userCode && <p><code className="customer-provider-device-code">{current.userCode}</code>{' '}
        <button type="button" className="customer-button" onClick={() => {
          void navigator.clipboard.writeText(current.userCode ?? '').then(() => setCopied(true)).catch(() => setCopied(false));
        }}>{copied ? 'Código copiado' : 'Copiar código'}</button></p>}
      <p><a href={current.verificationUrl} target="_blank" rel="noopener noreferrer">Abrir {label} para autorizar</a></p>
      <p>Gotchu detectará la conexión automáticamente. El código caduca en diez minutos.{provider === 'codex' && ' Si OpenAI lo solicita, habilita el acceso por código de dispositivo en la seguridad de tu cuenta ChatGPT.'}</p>
      {current.acceptsCode && <>
        <label htmlFor="provider-authorization-code">Si Claude muestra un código, pégalo aquí</label>
        <input id="provider-authorization-code" type="password" autoComplete="off" maxLength={513} value={authorizationCode} onChange={event => setAuthorizationCode(event.target.value)} />
        <button type="button" className="customer-button" disabled={!authorizationCode.trim() || submitCode.isPending} onClick={() => submitCode.mutate()}>Completar autorización</button>
      </>}
      <button type="button" className="customer-button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancelar conexión</button>
    </div>}
    {current?.status === 'connected' && <p role="status">{label} conectado en este espacio.</p>}
    {current && ['expired', 'cancelled', 'failed'].includes(current.status) && <p role="status">{current.status === 'expired' ? 'El código caducó. Vuelve a conectar tu cuenta.' : current.status === 'cancelled' ? 'Conexión cancelada.' : 'La autorización no se completó. Vuelve a conectar tu cuenta.'}</p>}
    {error && <p className="customer-form-error" role="alert">{error instanceof CustomerApiError ? error.message : 'No se pudo conectar tu cuenta. Vuelve a intentarlo.'}</p>}
  </div>;
}
