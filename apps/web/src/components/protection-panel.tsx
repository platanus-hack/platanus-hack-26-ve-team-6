import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RuntimeProtectionDetection } from '@gotchu/contracts';
import { operationsApi, type OperationsScope } from './operations-client';

type AttackKind = RuntimeProtectionDetection['kind'];
const detectorLabels: Record<AttackKind, string> = {
  sql_injection: 'Inyección SQL',
  path_traversal: 'Acceso fuera de la ruta permitida',
  command_injection: 'Inyección de comandos',
  ssrf: 'Acceso a red privada o metadatos',
};
const evidenceLabels: Record<RuntimeProtectionDetection['evidence'], string> = {
  sql_boolean_tautology: 'La entrada añade una condición SQL tautológica',
  sql_union_select: 'La entrada añade una cláusula UNION SELECT',
  sql_statement_chain: 'La entrada añade una segunda sentencia SQL',
  sql_comment_termination: 'La entrada termina una cadena SQL con un comentario',
  path_outside_root: 'La ruta resuelta sale del directorio permitido',
  shell_operator_in_input: 'La entrada contiene un operador de shell',
  private_destination: 'El destino resuelve a una dirección privada o reservada',
};
const sinkLabels: Record<RuntimeProtectionDetection['sink'], string> = {
  sql: 'consulta SQL', filesystem: 'sistema de archivos', child_process: 'proceso hijo', fetch: 'fetch', http: 'cliente HTTP',
};
const formatDate = (value: string) => new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export function ProtectionPanel({ scope, canManage }: { scope: OperationsScope; canManage: boolean }) {
  const queryClient = useQueryClient();
  const queryKey = ['runtime-protection', scope.organizationId, scope.applicationId] as const;
  const config = useQuery({ queryKey, queryFn: () => operationsApi.protection(scope), retry: false, refetchInterval: 10_000 });
  const detections = useQuery({ queryKey: [...queryKey, 'detections'], queryFn: () => operationsApi.protectionDetections(scope), retry: false, refetchInterval: 10_000 });
  const [draft, setDraft] = useState<{ mode: 'monitor' | 'block'; enabledDetectors: AttackKind[] } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (config.data) setDraft({ mode: config.data.mode, enabledDetectors: config.data.enabledDetectors });
  }, [config.data?.version]);

  const mode = draft?.mode ?? config.data?.mode ?? 'monitor';
  const enabledDetectors = draft?.enabledDetectors ?? config.data?.enabledDetectors ?? [];
  const update = useMutation({
    mutationFn: () => operationsApi.configureProtection(scope, { mode, enabledDetectors }),
    onSuccess: async saved => {
      setError(null);
      setDraft({ mode: saved.mode, enabledDetectors: saved.enabledDetectors });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: [...queryKey, 'detections'] }),
      ]);
    },
    onError: () => setError('No se pudo guardar la configuración. Revisa tu permiso y vuelve a intentarlo.'),
  });
  const dirty = Boolean(config.data && (mode !== config.data.mode
    || enabledDetectors.length !== config.data.enabledDetectors.length
    || enabledDetectors.some(kind => !config.data?.enabledDetectors.includes(kind))));
  const setup = `pnpm add @gotchu/sdk

import express from 'express';
import { createGotchuGuard, GotchuProtectionBlockedError } from '@gotchu/sdk';

const guard = createGotchuGuard({
  integrationId: process.env.GOTCHU_INTEGRATION_ID ?? '',
  applicationId: '${scope.applicationId}',
  secret: Buffer.from(process.env.GOTCHU_SIGNING_KEY ?? '', 'base64'),
  baseUrl: process.env.GOTCHU_URL ?? '',
});

const app = express();
app.use(express.json());
app.use(guard.middleware()); // after body parsing, before route handlers

app.get('/search', async (request, response) => {
  const searchTerm = String(request.query.q ?? '');
  const sql = 'SELECT id FROM users WHERE name = $1';
  try {
    // Sustituye database por el cliente SQL de tu aplicación.
    await guard.sql(sql, () => database.query(sql, [searchTerm]));
    response.sendStatus(200);
  } catch (error) {
    if (error instanceof GotchuProtectionBlockedError) return response.sendStatus(403);
    throw error;
  }
});`;

  async function copySetup() {
    try {
      if (!navigator.clipboard) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(setup);
      setCopyState('copied');
    } catch { setCopyState('error'); }
  }

  function toggleDetector(kind: AttackKind, checked: boolean) {
    const next = checked ? [...enabledDetectors, kind] : enabledDetectors.filter(value => value !== kind);
    setDraft({ mode, enabledDetectors: next });
  }

  return <section className="customer-card customer-protection" aria-labelledby="runtime-protection-title">
    <div className="customer-card-heading">
      <div><h2 id="runtime-protection-title">Protección en ejecución</h2><p className="customer-card-copy">El SDK inspecciona entradas que llegan a puntos de uso instrumentados. Los valores de entrada nunca se envían a Gotchu.</p></div>
      {config.data && <span className={`customer-status ${config.data.mode === 'block' ? 'customer-protection-status-block' : 'customer-status-muted'}`}>
        {config.data.mode === 'block' ? 'Bloqueo configurado' : 'Monitorización configurada'}
      </span>}
    </div>

    {config.isPending ? <p className="customer-protection-message" role="status">Cargando configuración…</p>
      : config.error ? <p className="customer-form-error" role="alert">No se pudo cargar la configuración. <button className="customer-link-button" type="button" onClick={() => { config.refetch().catch(() => undefined); }}>Reintentar</button></p>
        : config.data && <>
          <div className="customer-protection-status" role="status" aria-live="polite">
            <span className={`customer-status ${config.data.receiving ? 'customer-status-ready' : 'customer-status-pending'}`}>
              {config.data.receiving ? 'SDK conectado · eventos recientes' : 'Sin eventos recientes del SDK'}
            </span>
            <span>{config.data.lastEventAt ? `Último evento: ${formatDate(config.data.lastEventAt)}` : 'Aún no se ha recibido un evento de protección.'}</span>
          </div>

          <div className="customer-protection-layout">
            <div className="customer-protection-settings">
              <fieldset disabled={!canManage || update.isPending}>
                <legend>Respuesta</legend>
                <label><input type="radio" name="runtime-protection-mode" checked={mode === 'monitor'} onChange={() => setDraft({ mode: 'monitor', enabledDetectors })} /> Monitorizar: registrar indicios y dejar continuar la operación.</label>
                <label><input type="radio" name="runtime-protection-mode" checked={mode === 'block'} onChange={() => setDraft({ mode: 'block', enabledDetectors })} /> Bloquear: detener la operación antes del punto instrumentado.</label>
              </fieldset>
              <fieldset disabled={!canManage || update.isPending}>
                <legend>Detectores activos</legend>
                {(Object.entries(detectorLabels) as Array<[AttackKind, string]>).map(([kind, label]) => <label key={kind}>
                  <input type="checkbox" checked={enabledDetectors.includes(kind)} onChange={event => toggleDetector(kind, event.target.checked)} /> {label}
                </label>)}
              </fieldset>
              <p className="customer-field-note">Si la política firmada caduca o Gotchu no responde, el SDK continúa en monitorización. El bloqueo se aplica sólo a procesos activos que usen estos wrappers.</p>
              <button className="customer-button customer-button-primary" type="button" disabled={!canManage || update.isPending || !dirty || mode === 'block' && enabledDetectors.length === 0} onClick={() => update.mutate()}>
                {update.isPending ? 'Guardando…' : 'Guardar configuración'}
              </button>
              {!canManage && <p className="customer-field-note">Sólo Propietarios y Administradores pueden cambiar esta configuración.</p>}
              {mode === 'block' && enabledDetectors.length === 0 && <p className="customer-form-error">Activa al menos un detector para guardar el bloqueo.</p>}
              {error && <p className="customer-form-error" role="alert">{error}</p>}
            </div>

            <div className="customer-protection-evidence">
              <h3>Intentos detectados</h3>
              {detections.isPending ? <p role="status">Cargando eventos…</p>
                : detections.error ? <p className="customer-form-error" role="alert">No se pudieron cargar los eventos recientes. Vuelve a intentarlo en unos segundos.</p>
                  : detections.data?.length ? <ol>{detections.data.slice(0, 12).map(item => <li key={item.id}>
                    <div><strong>{detectorLabels[item.kind]}</strong><span className={`customer-status ${item.outcome === 'blocked' ? 'customer-protection-status-block' : 'customer-status-pending'}`}>{item.outcome === 'blocked' ? 'Bloqueado' : 'Observado'}</span></div>
                    <p>{evidenceLabels[item.evidence]}</p>
                    <small>{sinkLabels[item.sink]} · <code>{item.route}</code> · {formatDate(item.receivedAt)}</small>
                  </li>)}</ol> : <p>No hay intentos registrados en los últimos 30 días.</p>}
            </div>
          </div>

          <details className="customer-protection-setup">
            <summary>Instalar el SDK de Node</summary>
            <p>Usa la clave de la integración HMAC de “Telemetría firmada” para esta aplicación. Guarda la clave sólo en el entorno privado del servidor. En Express, instala el middleware después del parser de JSON y antes de las rutas.</p>
            <pre><code>{setup}</code></pre>
            <button className="customer-button customer-button-secondary" type="button" onClick={() => { void copySetup(); }}>{copyState === 'copied' ? 'Copiado' : copyState === 'error' ? 'No se pudo copiar' : 'Copiar instrucciones'}</button>
          </details>
        </>}
  </section>;
}
