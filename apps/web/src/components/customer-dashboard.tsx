import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import {
  CUSTOMER_MAX_SOURCE_BYTES,
  CUSTOMER_MAX_CONTAINER_IMAGE_BYTES,
  customerSourceFileSchema,
  customerSourceSnapshotSchema,
  customerOriginSchema,
  customerPublicImageReferenceSchema,
  customerScanProfileSchema,
  customerScopeSchema,
  type AssessmentMode,
  type CustomerAssessmentReport,
  type CustomerReportSummary,
  type CustomerSourceSummary,
  type CustomerContainerImageSummary,
  type CustomerTarget,
  type CustomerWorkspace,
} from '@gotchu/contracts';
import { CustomerApiError, customerApi, type CustomerJob, type CustomerScanProfile, type CustomerSession } from './customer-client';
import { OperationsPanel } from './operations-panel';
import { ProtectionPanel } from './protection-panel';
import { NotificationsPanel } from './notifications-panel';
import { ReportRecommendations } from './report-recommendations';
import { ComparisonPresence, ComparisonSummary, ComparisonVerification, ExternalHttpsEvidence } from './customer-report-components';
import { coverageCapabilityLabel, exploitabilityLabel, reportInputLabel } from './customer-report-model';
import { ContextPanel } from './context-panel';
import { IncidentList } from './incident-card';
import { StepUpPanel } from './step-up-panel';
import { MembersPanel } from './members-panel';
import { membersApi } from './members-client';
import { ApprovalPanel } from './approval-panel';
import { GitHubRepositoryPanel, Onboarding } from './onboarding';
import { WorkflowExceptions } from './workflow-exceptions';
import { DecisionRecordHistory } from './decision-record-history';
import { InvestigationActionButton, InvestigationModelSettings, InvestigationsTimeline } from './investigations-panel';
import { DependencyInventoryPanel, LicensePolicyPanel, RetentionPolicyPanel } from './customer-supply-chain';
import './customer-dashboard.css';

type Page = 'overview' | 'applications' | 'operations' | 'reports' | 'members' | 'decision-records' | 'license-policy' | 'retention-policy';

const pages: { id: Page; label: string; glyph: string }[] = [
  { id: 'overview', label: 'Inicio', glyph: '⌂' },
  { id: 'applications', label: 'Aplicaciones', glyph: '▦' },
  { id: 'operations', label: 'Vigilancia', glyph: '◉' },
  { id: 'reports', label: 'Informes', glyph: '≋' },
  { id: 'license-policy', label: 'Licencias', glyph: '©' },
  { id: 'retention-policy', label: 'Retención', glyph: '◴' },
  { id: 'members', label: 'Equipo', glyph: '♧' },
  { id: 'decision-records', label: 'Decisiones', glyph: '◷' },
];

const modeLabels: Record<AssessmentMode, string> = {
  internal: 'Código fuente',
  external: 'HTTPS autorizado',
  both: 'Código + HTTPS',
};
const sourceLabels = { internal: 'Código', external: 'HTTPS' };
const severityLabels = { unknown: 'Sin evaluar', critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', informational: 'Información' };
const confidenceLabels = { observed: 'Observado', inferred: 'Indicado', uncertain: 'Sin comprobar' };
const coverageLabels = { inspected: 'Evaluado', not_requested: 'No solicitado', unsupported: 'No disponible en este perfil', unavailable: 'No disponible' };
const analysisLabels = { completed: 'Completado', partial: 'Parcial', unavailable: 'No disponible' };
const scanProfileLabels: Record<CustomerScanProfile, string> = { root: 'Raíz del sitio', public_surface: 'Superficie pública limitada' };
const rememberedSignInKey = 'gotchu.sign-in-preference';
const rememberedSignInSchema = z.object({ email: z.string().max(254), method: z.string().min(1).max(128) }).strict();
const authCsrfResponseSchema = z.object({ csrfToken: z.string().min(1).max(256) }).strict();
const authRedirectResponseSchema = z.object({ url: z.url() }).strict();

function date(value: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function readableError(error: unknown) {
  if (error instanceof CustomerApiError && error.code === 'target_assessment_in_progress') return 'La autorización sigue activa mientras haya evaluaciones pendientes. Espera a que terminen; si el resultado es incierto, una persona operadora debe revisarlo antes de revocar o renovar.';
  if (error instanceof CustomerApiError) return error.message;
  if (error instanceof Error && !(error.name === 'ZodError')) return error.message;
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
}

function Icon({ children }: { children: string }) {
  return <span className="customer-icon" aria-hidden="true">{children}</span>;
}

function Loading({ label }: { label: string }) {
  return <div className="customer-loading" role="status"><span className="customer-spinner" />{label}</div>;
}

function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="customer-error" role="alert"><strong>No se pudo completar la operación</strong><p>{message}</p>{retry && <button className="customer-link-button" onClick={retry}>Reintentar</button>}</div>;
}

function ProviderLogo({ providerId }: { providerId: string }) {
  if (providerId === 'google') return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.49 12.27c0-.78-.07-1.53-.2-2.27H12v4.3h6.44a5.5 5.5 0 0 1-2.39 3.61v3h3.87c2.27-2.09 3.57-5.17 3.57-8.64Z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.93l-3.87-3c-1.08.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.73-4.95H1.27v3.09A12 12 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.27 14.27A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.55.37-2.27V6.64H1.27A12 12 0 0 0 0 12c0 1.94.46 3.78 1.27 5.36l4-3.09Z"/><path fill="#EA4335" d="M12 4.78c1.77 0 3.35.61 4.6 1.81l3.45-3.45C17.95 1.17 15.24 0 12 0A12 12 0 0 0 1.27 6.64l4 3.09C6.22 6.89 8.87 4.78 12 4.78Z"/></svg>;
  if (providerId === 'github') return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 1.72 2.62 1.22 3.26.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.24 1.16-3.03-.12-.29-.5-1.44.11-2.99 0 0 .95-.3 3.1 1.16a10.8 10.8 0 0 1 5.64 0c2.15-1.46 3.1-1.16 3.1-1.16.62 1.55.23 2.7.12 2.99.72.79 1.15 1.8 1.15 3.03 0 4.32-2.63 5.28-5.14 5.56.4.35.75 1.03.75 2.08v3.1c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M12 3 4.5 6v5.1c0 4.6 3.2 8.6 7.5 9.9 4.3-1.3 7.5-5.3 7.5-9.9V6L12 3Z"/><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="m9 12 2 2 4-4"/></svg>;
}

function AuthPanel({ session, onAuthenticated }: { session: CustomerSession; onAuthenticated: (session: CustomerSession) => void }) {
  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberAccess, setRememberAccess] = useState(false);
  const [lastMethod, setLastMethod] = useState<string | null>(null);
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(rememberedSignInKey);
      if (saved) {
        const parsed = rememberedSignInSchema.safeParse(JSON.parse(saved));
        if (parsed.success) {
          setEmail(parsed.data.email);
          setLastMethod(parsed.data.method);
          setRememberAccess(true);
        } else {
          window.localStorage.removeItem(rememberedSignInKey);
        }
      }
    } catch {
      try { window.localStorage.removeItem(rememberedSignInKey); } catch { /* Storage can be disabled by the browser. */ }
    }

    const url = new URL(window.location.href);
    const authError = url.searchParams.get('authError') ?? url.searchParams.get('error');
    const messages: Record<string, string> = {
      GoogleEmailUnverified: 'Google debe proporcionar un correo verificado para iniciar sesión.',
      GoogleAccountRequiresPassword: 'Ya existe una cuenta local con este correo. Inicia sesión con tu contraseña. Google no se ha vinculado; la opción para vincularlo desde la configuración de cuenta aún está pendiente.',
      BootstrapRequired: 'Esta instalación todavía necesita crear su primer Owner. Usa el enlace de un solo uso de /setup que imprime ./gotchu setup-link; ningún proveedor de acceso puede crear ese primer Owner.',
      OAuthAccountNotLinked: 'Ya existe una cuenta con este correo. Inicia sesión con tu contraseña; Gotchu no vinculará Google sin una acción explícita.',
    };
    if (authError && messages[authError]) setError(messages[authError]);
    if (authError) {
      url.searchParams.delete('authError');
      url.searchParams.delete('error');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  function saveAccessMethod(method: string) {
    setLastMethod(method);
    if (!rememberAccess) return;
    try { window.localStorage.setItem(rememberedSignInKey, JSON.stringify({ email: email.trim(), method })); } catch { /* Remembering is optional; never block sign-in. */ }
  }

  function changeRememberAccess(checked: boolean) {
    setRememberAccess(checked);
    if (checked) return;
    setLastMethod(null);
    try { window.localStorage.removeItem(rememberedSignInKey); } catch { /* Storage can be disabled by the browser. */ }
  }

  async function startProvider(providerId: string) {
    saveAccessMethod(providerId);
    setLoadingProvider(providerId);
    setError(null);
    try {
      const csrfResponse = await fetch('/api/auth/csrf', { headers: { Accept: 'application/json' } });
      if (!csrfResponse.ok) throw new Error('CSRF request failed');
      const csrf = authCsrfResponseSchema.parse(await csrfResponse.json());
      const response = await fetch(`/api/auth/signin/${encodeURIComponent(providerId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Auth-Return-Redirect': '1' },
        body: new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: '/dashboard' }),
      });
      if (!response.ok) throw new Error('Provider sign-in failed');
      const redirect = authRedirectResponseSchema.parse(await response.json());
      const redirectUrl = new URL(redirect.url, window.location.origin);
      if (redirectUrl.origin !== window.location.origin && redirectUrl.protocol !== 'https:') throw new Error('Unsafe provider redirect');
      window.location.assign(redirectUrl.href);
    } catch {
      setError('No se pudo iniciar sesión con este proveedor. Inténtalo de nuevo.');
      setLoadingProvider(null);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    saveAccessMethod('credentials');
    try {
      const signedIn = registering
        ? await customerApi.register(email.trim(), password)
        : await customerApi.signIn(email.trim(), password);
      onAuthenticated(signedIn);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  }

  const oauthProviders = session.providers.filter(provider => provider.type !== 'credentials');
  const socialProviders = ['google', 'github']
    .map(id => oauthProviders.find(provider => provider.id === id))
    .filter((provider): provider is (typeof oauthProviders)[number] => provider !== undefined);
  const ssoProviders = oauthProviders.filter(provider => provider.id !== 'google' && provider.id !== 'github');
  const lastProvider = oauthProviders.find(provider => provider.id === lastMethod);
  const lastMethodLabel = lastMethod === 'credentials' ? 'correo y contraseña' : lastProvider?.name ?? (lastMethod ? 'SSO' : null);
  return <main className="customer-auth-page">
    <section className="customer-auth-card" aria-labelledby="auth-title">
      <a className="customer-brand" href="/dashboard"><span className="customer-brand-mark">g</span>gotchu<span className="customer-brand-dot">.</span></a>
      <h1 id="auth-title">{registering ? 'Crea tu espacio de trabajo' : 'Inicia sesión en Gotchu'}</h1>
      <p className="customer-auth-copy">Accede para revisar tus espacios de trabajo y las aplicaciones que administra tu equipo.</p>

      {error && <div className="customer-inline-error" role="alert">{error}</div>}

      {socialProviders.length > 0 && <div className={`customer-auth-social-row ${socialProviders.length > 1 ? 'has-multiple' : 'has-single'}`} aria-label="Otros métodos de acceso">
        {socialProviders.map(provider => <button className="customer-button customer-provider-button customer-provider-button-social" key={provider.id} type="button" disabled={loadingProvider !== null} onClick={() => startProvider(provider.id)} aria-busy={loadingProvider === provider.id}>
          {loadingProvider === provider.id ? <span className="customer-spinner" aria-hidden="true" /> : <ProviderLogo providerId={provider.id} />}
          <span>{loadingProvider === provider.id ? `Conectando con ${provider.name}…` : provider.name}</span>
        </button>)}
      </div>}
      {ssoProviders.map(provider => <button className="customer-button customer-provider-button customer-provider-button-sso" key={provider.id} type="button" disabled={loadingProvider !== null} onClick={() => startProvider(provider.id)} aria-busy={loadingProvider === provider.id}>
        {loadingProvider === provider.id ? <span className="customer-spinner" aria-hidden="true" /> : <ProviderLogo providerId={provider.id} />}
        <span>{loadingProvider === provider.id ? 'Conectando con SSO…' : 'Continuar con SSO'}</span>
      </button>)}

      {oauthProviders.length > 0 && session.localAuthEnabled && <div className="customer-auth-divider"><span>O</span></div>}
      {session.localAuthEnabled && <form className="customer-form customer-auth-form" onSubmit={submit}>
        <label htmlFor="customer-email">Correo electrónico</label>
        <input id="customer-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} />
        <label htmlFor="customer-password">Contraseña</label>
        <div className="customer-auth-password"><input id="customer-password" type={showPassword ? 'text' : 'password'} autoComplete={registering ? 'new-password' : 'current-password'} required minLength={registering ? 15 : undefined} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /><button type="button" className="customer-auth-password-toggle" aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.6"/>{showPassword && <path d="m4 4 16 16"/>}</svg></button></div>
        {!registering && <label className="customer-auth-remember"><input type="checkbox" checked={rememberAccess} onChange={event => changeRememberAccess(event.target.checked)} /><span>Recordar email y método de acceso en este dispositivo</span></label>}
        {rememberAccess && lastMethodLabel && <p className="customer-auth-last-method" role="status">Último método: {lastMethodLabel}</p>}
        {registering && <p className="customer-field-note">Usa al menos 15 caracteres. La autenticación local está habilitada para este entorno.</p>}
        <button className="customer-button customer-button-primary customer-button-full" disabled={busy || loadingProvider !== null}>{busy ? <><span className="customer-spinner" />Conectando…</> : registering ? 'Crear cuenta' : 'Iniciar sesión'}</button>
        {session.registrationEnabled && <button className="customer-link-button customer-auth-switch" type="button" onClick={() => { setRegistering(value => !value); setError(null); }}>{registering ? 'Ya tienes cuenta: iniciar sesión' : 'Crear una cuenta de desarrollo'}</button>}
      </form>}

      {!session.localAuthEnabled && oauthProviders.length === 0 && <div className="customer-inline-error" role="status">El inicio de sesión todavía no está configurado para este entorno.</div>}
      <p className="customer-auth-privacy">Tus fuentes e informes pertenecen a tu espacio de trabajo. No ejecutamos código fuente ni hacemos cambios en tus aplicaciones.</p>
      <nav className="customer-auth-legal" aria-label="Información legal"><a href="/privacy">Privacidad</a><a href="/terms">Términos</a></nav>
    </section>
  </main>;
}

function WorkspaceCreate({ onCreated, disabled }: { onCreated: (workspace: CustomerWorkspace) => void; disabled: boolean }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => customerApi.createWorkspace(name),
    onSuccess: workspace => { setName(''); setError(null); onCreated(workspace); },
    onError: caught => setError(readableError(caught)),
  });
  return <form className="customer-inline-create" onSubmit={event => { event.preventDefault(); setError(null); create.mutate(); }}>
    <label htmlFor="new-workspace">Nuevo espacio</label>
    <div className="customer-inline-control"><input id="new-workspace" value={name} onChange={event => setName(event.target.value)} maxLength={200} required placeholder="Nombre del equipo" /><button className="customer-button customer-button-small" disabled={disabled || create.isPending || !name.trim()} aria-label="Crear espacio de trabajo">+</button></div>
    {error && <p className="customer-form-error" role="alert">{error}</p>}
  </form>;
}

function WorkspaceSettings({ organizationId, name, canManage, onSaved }: { organizationId: string; name: string; canManage: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: () => customerApi.updateWorkspace(organizationId, draft.trim()),
    onSuccess: () => { setError(null); setEditing(false); onSaved(); },
    onError: caught => setError(readableError(caught)),
  });
  useEffect(() => setDraft(name), [name]);
  if (!canManage) return null;
  if (!editing) return <button className="customer-link-button" onClick={() => setEditing(true)}>Cambiar nombre del espacio</button>;
  return <form className="customer-inline-create" onSubmit={event => { event.preventDefault(); setError(null); update.mutate(); }}>
    <label htmlFor="workspace-name">Nombre del espacio</label>
    <div className="customer-inline-control"><input id="workspace-name" value={draft} onChange={event => setDraft(event.target.value)} maxLength={200} required disabled={update.isPending} /><button className="customer-button customer-button-small" disabled={update.isPending || !draft.trim() || draft.trim() === name}>Guardar</button></div>
    <button type="button" className="customer-link-button" onClick={() => { setDraft(name); setEditing(false); setError(null); }}>Cancelar</button>
    {error && <p className="customer-form-error" role="alert">{error}</p>}
  </form>;
}

function ApplicationCreate({ organizationId, onCreated, disabled }: { organizationId: string; onCreated: (id: string) => void; disabled: boolean }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => customerApi.createApplication(organizationId, name),
    onSuccess: application => { setName(''); setError(null); onCreated(application.applicationId); },
    onError: caught => setError(readableError(caught)),
  });
  return <form className="customer-inline-create" onSubmit={event => { event.preventDefault(); setError(null); create.mutate(); }}>
    <label htmlFor="new-application">Añadir aplicación</label>
    <div className="customer-inline-control"><input id="new-application" value={name} onChange={event => setName(event.target.value)} maxLength={200} required placeholder="Nombre de la aplicación" /><button className="customer-button customer-button-small" disabled={disabled || create.isPending || !name.trim()} aria-label="Añadir aplicación">+</button></div>
    {error && <p className="customer-form-error" role="alert">{error}</p>}
  </form>;
}

function ApplicationSettings({ organizationId, applicationId, name, archived, canManage, onSaved }: { organizationId: string; applicationId: string; name: string; archived: boolean; canManage: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const update = useMutation({
    mutationFn: (input: { name?: string; archived?: boolean }) => customerApi.updateApplication({ organizationId, applicationId, ...input }),
    onSuccess: () => { setError(null); onSaved(); },
    onError: caught => setError(readableError(caught)),
  });
  useEffect(() => setDraft(name), [name]);
  return <section className="customer-card customer-settings-card">
    <div className="customer-card-heading"><div><span className="customer-eyebrow">CONFIGURACIÓN</span><h2>Aplicación</h2></div><span className={archived ? 'customer-status customer-status-muted' : 'customer-status customer-status-ready'}>{archived ? 'Archivada' : 'Activa'}</span></div>
    <form className="customer-form customer-application-edit" onSubmit={event => { event.preventDefault(); setError(null); update.mutate({ name: draft.trim() }); }}>
      <label htmlFor="application-name">Nombre</label><div className="customer-inline-control"><input id="application-name" value={draft} onChange={event => setDraft(event.target.value)} maxLength={200} required disabled={!canManage || update.isPending} /><button className="customer-button customer-button-small" disabled={!canManage || update.isPending || !draft.trim() || draft.trim() === name}>Guardar</button></div>
    </form>
    {canManage && <button className="customer-link-button customer-archive-button" disabled={update.isPending} onClick={() => { setError(null); update.mutate({ archived: !archived }); }}>{archived ? 'Reactivar aplicación' : 'Archivar aplicación'}</button>}
    {error && <p className="customer-form-error" role="alert">{error}</p>}
  </section>;
}

function TargetEnrollment({ organizationId, applicationId, targets, canManage, onChanged }: { organizationId: string; applicationId: string; targets: CustomerTarget[]; canManage: boolean; onChanged: () => void }) {
  const [origin, setOrigin] = useState('');
  const [scanProfile, setScanProfile] = useState<CustomerScanProfile>('root');
  const [authorized, setAuthorized] = useState(false);
  const [challenge, setChallenge] = useState<{ name: string; value: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enroll = useMutation({
    mutationFn: () => customerApi.enrollTarget({ organizationId, applicationId, origin: origin.trim(), authorized: true, scanProfile }),
    onSuccess: result => { setOrigin(result.target.origin); setScanProfile(result.target.scanProfile ?? 'root'); setChallenge(result.challenge); setAuthorized(false); setError(null); onChanged(); },
    onError: caught => setError(readableError(caught)),
  });
  const changeTarget = useMutation({
    mutationFn: ({ targetId, action }: { targetId: string; action: 'verify' | 'revoke' }) => action === 'verify'
      ? customerApi.verifyTarget(organizationId, applicationId, targetId)
      : customerApi.revokeTarget(organizationId, applicationId, targetId),
    onSuccess: target => { setError(null); setChallenge(null); setAuthorized(false); onChanged(); if (target.status === 'verified') { setOrigin(target.origin); setScanProfile(target.scanProfile ?? 'root'); } },
    onError: caught => setError(readableError(caught)),
  });
  const activeTarget = targets.find(target => target.status !== 'revoked');
  const revokedTargets = targets.filter(target => target.status === 'revoked');
  useEffect(() => {
    if (activeTarget && !origin) setOrigin(activeTarget.origin);
    if (activeTarget?.status === 'pending') setScanProfile(activeTarget.scanProfile ?? 'root');
  }, [activeTarget, origin]);
  const originIsValid = customerOriginSchema.safeParse(origin.trim()).success;

  return <section className="customer-card">
    <div className="customer-card-heading"><div><span className="customer-eyebrow">ALCANCE EXTERNO</span><h2>Aplicación HTTPS</h2></div><span className="customer-status customer-status-muted">Sólo lectura</span></div>
    <p className="customer-card-copy">El análisis externo puede ejecutarse sin acceso al código. Añade un origen público HTTPS y verifica que controlas el dominio antes de analizarlo.</p>
    {activeTarget && <div className="customer-target-row">
      <div><strong>{activeTarget.origin}</strong><span>Versión de autorización {activeTarget.version} · autorizado por {activeTarget.consentActor}</span><span>Perfil activo: {scanProfileLabels[activeTarget.scanProfile ?? 'root']}{(activeTarget.scanProfile ?? 'root') === 'public_surface' ? ' · hasta 10 solicitudes GET al origen verificado' : ' · una solicitud GET a /'}</span><span>Vence {activeTarget.expiresAt ? date(activeTarget.expiresAt) : 'sin fecha registrada'}</span></div>
      <span className={`customer-status ${activeTarget.status === 'verified' ? 'customer-status-ready' : 'customer-status-pending'}`}>{activeTarget.status === 'verified' ? 'Verificado' : 'Pendiente de verificación'}</span>
      {canManage && <div className="customer-target-actions">
        {activeTarget.status === 'pending' && <button className="customer-button customer-button-small" disabled={changeTarget.isPending} onClick={() => { setError(null); changeTarget.mutate({ targetId: activeTarget.id, action: 'verify' }); }}>Comprobar DNS</button>}
        <button className="customer-link-button customer-danger-link" disabled={changeTarget.isPending} onClick={() => { setError(null); changeTarget.mutate({ targetId: activeTarget.id, action: 'revoke' }); }}>Revocar</button>
      </div>}
    </div>}
    {activeTarget?.status === 'pending' && !challenge && <p className="customer-field-note">El valor completo del desafío sólo se muestra al crearlo. Si no lo guardaste, puedes renovar la verificación y publicar el nuevo valor.</p>}
    {activeTarget?.status === 'verified' && <p className="customer-field-note">El perfil vigente limita esta evaluación a este origen; no representa un inventario de toda la empresa. Para cambiarlo, revoca esta autorización y crea una nueva con consentimiento explícito.</p>}
    {revokedTargets.length > 0 && <details className="customer-revoked-targets"><summary>Autorizaciones revocadas ({revokedTargets.length})</summary>{revokedTargets.map(target => <div key={target.id}><span>{target.origin} · versión {target.version}</span><span>{date(target.consentAt)}</span></div>)}</details>}
    {challenge && <div className="customer-challenge" role="status">
      <div><strong>Publica este registro TXT para confirmar el dominio</strong><p>El desafío es temporal y sólo se muestra al crear o renovar esta autorización. Verifica después de que el DNS se haya propagado.</p></div>
      <dl><div><dt>Nombre</dt><dd>{challenge.name}</dd></div><div><dt>Valor</dt><dd><code>{challenge.value}</code></dd></div><div><dt>Vence</dt><dd>{date(challenge.expiresAt)}</dd></div></dl>
      <button className="customer-link-button" onClick={() => navigator.clipboard.writeText(`${challenge.name}\t${challenge.value}`).catch(() => setError('No se pudo copiar el registro. Selecciónalo para copiarlo manualmente.'))}>Copiar registro</button>
    </div>}
    {canManage && (!activeTarget || activeTarget.status === 'pending') && <form className="customer-form customer-enroll-form" onSubmit={event => { event.preventDefault(); setError(null); enroll.mutate(); }}>
      <label htmlFor="target-origin">Origen autorizado</label><input id="target-origin" type="url" inputMode="url" placeholder="https://app.example.com" value={origin} onChange={event => { setOrigin(event.target.value); setAuthorized(false); setChallenge(null); }} maxLength={300} required aria-describedby="target-origin-help" aria-invalid={origin.length > 0 && !originIsValid} />
      <p id="target-origin-help" className="customer-field-note">Origen HTTPS público sin ruta, consulta, fragmento ni puerto personalizado.</p>
      {origin.length > 0 && !originIsValid && <p className="customer-form-error">Usa un origen HTTPS público sin rutas, parámetros ni puerto personalizado.</p>}
      <label htmlFor="target-scan-profile">Perfil de evaluación autorizado</label>
      <select id="target-scan-profile" value={scanProfile} onChange={event => { const selected = customerScanProfileSchema.safeParse(event.target.value); if (selected.success) setScanProfile(selected.data); setAuthorized(false); setChallenge(null); }}>
        <option value="root">Raíz del sitio · una solicitud GET a /</option>
        <option value="public_surface">Superficie pública limitada · hasta 10 solicitudes GET, sólo a este origen</option>
      </select>
      <p className="customer-field-note">El perfil limitado consulta como máximo 10 rutas públicas del origen verificado. Los permisos no se amplían al cambiar de perfil y no se exploran otros dominios.</p>
      <label className="customer-checkbox"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} required /><span>Confirmo que tengo autorización para evaluar este dominio dentro del perfil «{scanProfileLabels[scanProfile]}» y que he definido el alcance con su propietario.</span></label>
      <button className="customer-button customer-button-primary" disabled={enroll.isPending || !authorized || !originIsValid}>{enroll.isPending ? 'Creando verificación…' : activeTarget ? 'Renovar verificación' : 'Autorizar origen'}</button>
    </form>}
    {!canManage && !activeTarget && <div className="customer-empty-inline">Una persona propietaria u operadora puede añadir y verificar el origen HTTPS.</div>}
    {!canManage && activeTarget?.status === 'pending' && <div className="customer-empty-inline">Una persona propietaria u operadora debe comprobar el registro DNS para activar este origen.</div>}
    {error && <p className="customer-form-error" role="alert">{error}</p>}
  </section>;
}

type SourceFile = { file: File; path: string; validPath: boolean };
const sourceReadConcurrency = 8;

async function readSourceFiles(selected: readonly SourceFile[]) {
  const files: { path: string; content: string }[] = [];
  for (let offset = 0; offset < selected.length; offset += sourceReadConcurrency) {
    const batch = selected.slice(offset, offset + sourceReadConcurrency);
    const contents = await Promise.all(batch.map(async item => ({
      path: item.path,
      content: new TextDecoder('utf-8', { fatal: true }).decode(await item.file.arrayBuffer()),
    })));
    files.push(...contents);
  }
  return files;
}

function SourceEnrollment({ organizationId, applicationId, sources, canManage, onChanged }: { organizationId: string; applicationId: string; sources: CustomerSourceSummary[]; canManage: boolean; onChanged: () => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [revision, setRevision] = useState('main');
  const [selected, setSelected] = useState<SourceFile[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const included = selected.filter(item => item.validPath);
  const excludedCount = selected.length - included.length;
  const includedBytes = included.reduce((total, item) => total + item.file.size, 0);
  const preview = included.slice(0, 6);
  useEffect(() => { fileInput.current?.setAttribute('webkitdirectory', ''); }, []);
  const fileCountCheck = customerSourceSnapshotSchema.safeParse({ revision: revision || 'main', files: included.map(item => ({ path: item.path, content: '' })) });
  const sizeExceeded = includedBytes > CUSTOMER_MAX_SOURCE_BYTES;
  const selectionError = !selected.length ? null
    : !included.length ? 'No hay archivos compatibles en la selección.'
    : sizeExceeded ? `La selección excede el límite actual de ${Math.ceil(CUSTOMER_MAX_SOURCE_BYTES / (1024 * 1024))} MiB.`
    : !fileCountCheck.success ? fileCountCheck.error.issues[0]?.message ?? 'La selección no cumple los límites actuales de fuente.'
    : null;
  const upload = useMutation({
    mutationFn: async () => {
      const files = await readSourceFiles(included);
      const snapshot = customerSourceSnapshotSchema.parse({ revision: revision.trim(), files });
      return customerApi.uploadSource({ organizationId, applicationId, snapshot, authorized: true });
    },
    onSuccess: () => { setSelected([]); setAuthorized(false); setError(null); onChanged(); },
    onError: caught => setError(caught instanceof Error && caught.name === 'ZodError'
      ? 'La selección supera los límites de tamaño o formato actuales. Ajusta los archivos e inténtalo de nuevo.'
      : readableError(caught)),
  });
  const remove = useMutation({
    mutationFn: (sourceId: string) => customerApi.deleteSource(organizationId, applicationId, sourceId),
    onSuccess: () => { setError(null); onChanged(); },
    onError: caught => setError(readableError(caught)),
  });

  function chooseFiles(list: FileList | null) {
    const items = Array.from(list ?? []).map(file => {
      const path = file.webkitRelativePath || file.name;
      return { file, path, validPath: customerSourceFileSchema.shape.path.safeParse(path).success };
    });
    setSelected(items);
    setAuthorized(false);
    setError(null);
  }

  return <section className="customer-card">
    <div className="customer-card-heading"><div><span className="customer-eyebrow">ALCANCE DE CÓDIGO</span><h2>Instantánea de código</h2></div><span className="customer-status customer-status-muted">No ejecutamos tu código</span></div>
    <p className="customer-card-copy">Sube una selección de archivos fuente para un análisis interno. Se conserva como una instantánea privada y no se instalan dependencias ni se ejecutan pruebas.</p><p className="customer-field-note">Si la consulta de avisos está habilitada, se envían al servicio de vulnerabilidades sólo nombres y versiones de paquetes npm; nunca los archivos.</p>
    {sources.length > 0 && <div className="customer-source-list"><strong>Instantáneas disponibles</strong>{sources.map(source => <div key={source.id}><span><code>{source.revision}</code> · {source.fileCount} archivos · SHA-256 <code>{source.digest.slice(0, 12)}…</code><small>{date(source.createdAt)}</small></span>{canManage && <button className="customer-link-button customer-danger-link" disabled={remove.isPending} onClick={() => { if (window.confirm(`¿Eliminar la instantánea «${source.revision}»? Esta acción no se puede deshacer.`)) { setError(null); remove.mutate(source.id); } }}>Eliminar</button>}</div>)}</div>}
    {canManage && <form className="customer-form customer-source-form" onSubmit={event => { event.preventDefault(); setError(null); upload.mutate(); }}>
      <label htmlFor="source-revision">Etiqueta de revisión</label><input id="source-revision" value={revision} onChange={event => setRevision(event.target.value)} maxLength={200} required placeholder="main, release/1.2, commit…" />
      <label htmlFor="source-files">Selecciona una carpeta del proyecto</label><input id="source-files" className="customer-file-input" ref={fileInput} type="file" multiple onChange={event => chooseFiles(event.target.files)} />
      <p className="customer-field-note">Se incluyen sólo rutas y extensiones admitidas por el contrato actual. Se excluyen dependencias, metadatos Git y archivos de entorno; la selección no representa necesariamente todo el repositorio.</p>
      {selected.length > 0 && <div className="customer-source-preview" aria-live="polite"><div><strong>{included.length} archivos seleccionados</strong><span>{(includedBytes / (1024 * 1024)).toFixed(2)} MiB{excludedCount > 0 ? ` · ${excludedCount} excluidos por ruta o formato` : ''}</span></div>{preview.map(item => <code key={`${item.path}:${item.file.size}`}>{item.validPath ? item.path : `${item.path} · no admitido`}</code>)}{included.length > preview.length && <small>y {included.length - preview.length} archivos más</small>}{selectionError && <p className="customer-form-error" role="alert">{selectionError}</p>}</div>}
      <label className="customer-checkbox"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} required /><span>Confirmo que tengo derecho a compartir esta selección para evaluarla.</span></label>
      {error && <p className="customer-form-error" role="alert">{error}</p>}
      <button className="customer-button customer-button-primary" disabled={upload.isPending || !authorized || !included.length || Boolean(selectionError)}>{upload.isPending ? 'Validando y subiendo…' : 'Guardar instantánea'}</button>
    </form>}
    {!canManage && <div className="customer-empty-inline">Una persona propietaria u operadora puede compartir una instantánea autorizada.</div>}
  </section>;
}

function ContainerImageEnrollment({ organizationId, applicationId, images, canManage, onChanged }: { organizationId: string; applicationId: string; images: CustomerContainerImageSummary[]; canManage: boolean; onChanged: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: () => {
      if (!file || file.size < 1 || file.size > CUSTOMER_MAX_CONTAINER_IMAGE_BYTES) throw new Error('El archivo debe ocupar entre 1 byte y 8 MiB.');
      return customerApi.uploadContainerImage({ organizationId, applicationId, file, label: file.name.slice(0, 200) || 'imagen.tar', authorized: true });
    },
    onSuccess: () => { setFile(null); setAuthorized(false); setError(null); onChanged(); },
    onError: caught => setError(readableError(caught)),
  });
  const remove = useMutation({
    mutationFn: (imageId: string) => customerApi.deleteContainerImage(organizationId, applicationId, imageId),
    onSuccess: () => { setError(null); onChanged(); },
    onError: caught => setError(readableError(caught)),
  });
  const fileError = file && (file.size < 1 || file.size > CUSTOMER_MAX_CONTAINER_IMAGE_BYTES)
    ? `El límite por archivo es ${Math.ceil(CUSTOMER_MAX_CONTAINER_IMAGE_BYTES / (1024 * 1024))} MiB.` : null;
  return <section className="customer-card">
    <div className="customer-card-heading"><div><span className="customer-eyebrow">ALCANCE DE CONTENEDOR</span><h2>Imagen de contenedor</h2></div><span className="customer-status customer-status-muted">No se ejecuta</span></div>
    <p className="customer-card-copy">Guarda un archivo <code>docker save</code> u OCI para evaluar sus paquetes sin iniciar la imagen. El análisis de CVE requiere una base Trivy preparada y fijada.</p>
    {images.length > 0 && <div className="customer-source-list"><strong>Archivos de imagen disponibles</strong>{images.map(image => <div key={image.id}><span>{image.label} · {(image.size / (1024 * 1024)).toFixed(2)} MiB · SHA-256 <code>{image.digest.slice(0, 12)}…</code><small>{date(image.createdAt)}</small></span>{canManage && <button className="customer-link-button customer-danger-link" disabled={remove.isPending} onClick={() => { if (window.confirm(`¿Eliminar el archivo de imagen «${image.label}»? Esta acción no se puede deshacer.`)) remove.mutate(image.id); }}>Eliminar</button>}</div>)}</div>}
    {canManage ? <form className="customer-form customer-source-form" onSubmit={event => { event.preventDefault(); setError(null); upload.mutate(); }}>
      <label htmlFor="container-image-file">Archivo OCI o Docker guardado</label><input id="container-image-file" className="customer-file-input" type="file" accept=".tar,application/x-tar,application/octet-stream" onChange={event => { setFile(event.target.files?.[0] ?? null); setAuthorized(false); setError(null); }} />
      <p className="customer-field-note">Límite: 8 MiB. Sólo se guarda el archivo y su digest; no se extrae en el servidor ni se ejecuta.</p>
      {file && <div className="customer-source-preview"><strong>{file.name}</strong><span>{(file.size / (1024 * 1024)).toFixed(2)} MiB</span>{fileError && <p className="customer-form-error" role="alert">{fileError}</p>}</div>}
      <label className="customer-checkbox"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} required /><span>Confirmo que tengo derecho a compartir esta imagen para evaluarla.</span></label>
      {error && <p className="customer-form-error" role="alert">{error}</p>}
      <button className="customer-button customer-button-primary" disabled={!file || !authorized || Boolean(fileError) || upload.isPending}>{upload.isPending ? 'Validando y subiendo…' : 'Guardar imagen'}</button>
    </form> : <div className="customer-empty-inline">Una persona propietaria u operadora puede compartir una imagen autorizada.</div>}
  </section>;
}

function ReportView({ report, summary, userId, organizationId, applicationId, canManage, archived, onCorrectionQueued }: {
  report: CustomerAssessmentReport;
  summary?: CustomerReportSummary;
  userId: string;
  organizationId: string;
  applicationId: string;
  canManage: boolean;
  archived: boolean;
  onCorrectionQueued: (jobId: string) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadingSbom, setDownloadingSbom] = useState(false);
  const [sbomError, setSbomError] = useState<string | null>(null);
  const [activeReportTab, setActiveReportTab] = useState<'findings' | 'dependencies'>('findings');
  const entries = [...report.internal?.findings ?? [], ...report.external?.findings ?? []];
  const evidence = [...report.internal?.evidence ?? [], ...report.external?.evidence ?? []];
  const byId = new Map(entries.map(finding => [finding.id, finding]));
  const findingTitles = new Map(entries.map(finding => [finding.id, finding.title]));
  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  const originSections = (['internal', 'external'] as const).map(origin => ({ origin, analysis: report[origin] }));

  return <div className="customer-report-detail">
    <div className="customer-report-title"><div><span className="customer-eyebrow">INFORME DE EVALUACIÓN</span><h2>{report.applicationName}</h2><p>{reportInputLabel(report)} · {date(report.finishedAt)}</p></div><button className="customer-button" disabled={downloading} onClick={async () => {
      setDownloading(true); setDownloadError(null);
      try { await customerApi.recordReportDownload(organizationId, applicationId, report.id); downloadReport(report); }
      catch (error) { setDownloadError(readableError(error)); }
      finally { setDownloading(false); }
    }}>{downloading ? 'Registrando descarga…' : 'Descargar JSON'}</button></div>
    {downloadError && <p className="customer-form-error" role="alert">{downloadError}</p>}
    <div className="customer-report-subject">
      {report.subject.sourceSnapshotId && <div><span>Instantánea de código</span><strong>{summary?.subject.sourceDigest?.slice(0, 16) ?? report.subject.sourceDigest?.slice(0, 16)}…</strong></div>}
      {report.subject.containerImageDigest && <div><span>Digest de imagen {report.subject.containerImageReference ? 'pública' : 'subida'}</span><strong>{report.subject.containerImageDigest.slice(0, 24)}…</strong>{report.subject.containerImageReference && <small>{report.subject.containerImageReference}</small>}</div>}
      {report.subject.origin && <div><span>Origen HTTPS autorizado</span><strong>{report.subject.origin}</strong></div>}
      {report.subject.targetVersion !== null && <div><span>Versión de autorización</span><strong>{report.subject.targetVersion}</strong></div>}
      <div><span>Perfil</span><strong>Observación · {report.actionsPerformed.length} acciones</strong></div>
    </div>
    <div className="customer-report-callout"><strong>{entries.length} observaciones registradas</strong><p>Los resultados describen el alcance evaluado. Una fuente ausente, un indicio o una cobertura limitada no equivale a una comprobación aprobada. No se han realizado cambios en la aplicación.</p></div>
    <ComparisonSummary comparisons={report.comparison} internal={report.internal} external={report.external} />
    <ExternalHttpsEvidence analysis={report.external} />
    <div className="customer-report-tabs" role="tablist" aria-label="Contenido del informe" onKeyDown={event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        setActiveReportTab(event.key === 'Home' || event.key === 'ArrowLeft' ? 'findings' : 'dependencies');
      }
    }}>
      <button type="button" className="customer-report-tab" id="report-findings-tab" role="tab" aria-controls="report-findings-panel" aria-selected={activeReportTab === 'findings'} tabIndex={activeReportTab === 'findings' ? 0 : -1} onClick={() => setActiveReportTab('findings')}>Hallazgos</button>
      <button type="button" className="customer-report-tab" id="report-dependencies-tab" role="tab" aria-controls="report-dependencies-panel" aria-selected={activeReportTab === 'dependencies'} tabIndex={activeReportTab === 'dependencies' ? 0 : -1} onClick={() => setActiveReportTab('dependencies')}>Dependencias y licencias</button>
    </div>
    {activeReportTab === 'dependencies' && <div id="report-dependencies-panel" className="customer-report-tabpanel" role="tabpanel" aria-labelledby="report-dependencies-tab" tabIndex={0}><DependencyInventoryPanel inventory={report.internal?.dependencyInventory} busy={downloadingSbom} error={sbomError} onDownload={async () => {
      setDownloadingSbom(true); setSbomError(null);
      try { const blob = await customerApi.downloadSbom(organizationId, applicationId, report.id); downloadBlob(blob, `gotchu-${report.id}.cdx.json`); }
      catch (error) { setSbomError(readableError(error)); }
      finally { setDownloadingSbom(false); }
    }} /></div>}
    {activeReportTab === 'findings' && <div id="report-findings-panel" className="customer-report-tabpanel" role="tabpanel" aria-labelledby="report-findings-tab" tabIndex={0}>
    <section className="customer-report-section"><div className="customer-section-heading"><div><span className="customer-eyebrow">HALLAZGOS</span><h3>Observaciones y contraste</h3></div></div>
      {report.comparison.length === 0 ? <div className="customer-empty-inline">Este informe no contiene observaciones. Consulta la cobertura para ver qué perfiles y capacidades se evaluaron.</div> : <div className="customer-findings">{report.comparison.map(item => {
        const linked = [...item.internalFindingIds, ...item.externalFindingIds].map(id => byId.get(id)).filter((finding): finding is NonNullable<typeof finding> => finding !== undefined);
        return <details className="customer-finding" key={item.key}><summary><span><strong>{linked[0]?.title ?? 'Aspecto no verificable'}</strong><small>{linked[0]?.location ?? item.explanation}</small></span><span className="customer-finding-badges"><ComparisonPresence item={item} /><ComparisonVerification item={item} />{linked[0] && <span className={`customer-severity customer-severity-${linked[0].severity}`}>{severityLabels[linked[0].severity]}</span>}</span></summary>
          <p>{item.explanation}</p>
          {linked.map(finding => <section className="customer-finding-body" key={finding.id}><div className="customer-tag-row"><span className="customer-status customer-status-muted">{sourceLabels[finding.origin]}</span><span className={`customer-severity customer-severity-${finding.severity}`}>{severityLabels[finding.severity]}</span><span className="customer-status customer-status-muted">Confianza: {confidenceLabels[finding.confidence]}</span><span className="customer-status customer-status-muted">Explotabilidad: {exploitabilityLabel(finding.exploitability)}</span></div><p>{finding.description}</p><InvestigationActionButton organizationId={organizationId} applicationId={applicationId} subject={{ kind: 'finding', subjectId: finding.id, reportId: report.id }} canManage={canManage && !archived && ['medium', 'high', 'critical'].includes(finding.severity)} /><h4>Impacto posible</h4><p>{finding.impact}</p><h4>Recomendación</h4><p>{finding.recommendation}</p>{finding.limitations.length > 0 && <><h4>Límites de esta observación</h4><ul>{finding.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></>}{finding.evidenceIds.map(id => {
            const itemEvidence = evidenceById.get(id);
            return itemEvidence ? <details className="customer-evidence" key={id}><summary>{itemEvidence.locator}</summary><p>{itemEvidence.tool.name} · v{itemEvidence.tool.version} · {date(itemEvidence.collectedAt)}</p><pre>{itemEvidence.excerpt}</pre><p className="customer-evidence-meta">SHA-256: {itemEvidence.checksum}</p><p className="customer-evidence-meta">Snapshot: {itemEvidence.snapshotRef}</p></details> : null;
          })}</section>)}
        </details>;
      })}</div>}
    </section>
    {report.subject.containerImageDigest ? <section className="customer-report-section"><div className="customer-section-heading"><div><span className="customer-eyebrow">ACTUALIZACIÓN</span><h3>Cómo corregir las CVE de la imagen</h3></div></div><p>Actualiza los paquetes en el Dockerfile o manifiestos de construcción, crea una nueva imagen y vuelve a evaluarla. Este informe no modifica ni reconstruye imágenes.</p></section> : <ReportRecommendations
      key={`${userId}:${organizationId}:${applicationId}:${report.id}`}
      userId={userId}
      organizationId={organizationId}
      applicationId={applicationId}
      reportId={report.id}
      reportMode={report.mode}
      reportSourceSnapshotId={report.subject.sourceSnapshotId}
      reportSourceDigest={report.subject.sourceDigest}
      findingTitles={findingTitles}
      canManage={canManage}
      archived={archived}
      onQueued={onCorrectionQueued}
    />}
    </div>}
    <section className="customer-report-section customer-coverage"><div className="customer-section-heading"><div><span className="customer-eyebrow">COBERTURA</span><h3>Qué se evaluó</h3></div></div>
      <div className="customer-analysis-grid">{originSections.map(({ origin, analysis }) => <article className="customer-analysis-card" key={origin}><div className="customer-card-heading"><h4>{report.subject.containerImageDigest && origin === 'internal' ? 'Imagen' : sourceLabels[origin]}</h4><span className="customer-status customer-status-muted">{analysis ? analysisLabels[analysis.status] : 'No solicitado'}</span></div>{analysis ? <><p>{analysis.tool.name} · v{analysis.tool.version}</p><ul>{analysis.coverage.map(item => <li key={item.capability}><span><strong>{coverageCapabilityLabel(item.capability)}</strong><small>{item.detail}</small></span><span className="customer-status customer-status-muted">{coverageLabels[item.state]}</span></li>)}</ul>{analysis.limitations.length > 0 && <details className="customer-analysis-limits"><summary>Límites del perfil ({analysis.limitations.length})</summary><ul>{analysis.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></details>}</> : <p>Esta perspectiva no se solicitó para este informe.</p>}</article>)}</div>
    </section>
    {report.limitations.length > 0 && <section className="customer-report-section"><div className="customer-section-heading"><div><span className="customer-eyebrow">CONTEXTO</span><h3>Límites del informe</h3></div></div><ul className="customer-report-limitations">{report.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></section>}
  </div>;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function downloadReport(report: CustomerAssessmentReport) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `gotchu-${report.id}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function AssessmentForm({ organizationId, applicationId, sources, images, targets, canManage, archived, onQueued }: { organizationId: string; applicationId: string; sources: CustomerSourceSummary[]; images: CustomerContainerImageSummary[]; targets: CustomerTarget[]; canManage: boolean; archived: boolean; onQueued: (jobId: string) => void }) {
  const [mode, setMode] = useState<AssessmentMode>('external');
  const [inputKind, setInputKind] = useState<'source_snapshot' | 'container_image'>('source_snapshot');
  const [sourceSnapshotId, setSourceSnapshotId] = useState('');
  const [imageSource, setImageSource] = useState<'archive' | 'registry'>('archive');
  const [imageId, setImageId] = useState('');
  const [registryReference, setRegistryReference] = useState('');
  const [targetId, setTargetId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const verifiedTargets = targets.filter(target => target.status === 'verified' && target.expiresAt && Date.parse(target.expiresAt) > Date.now());
  const usesImage = mode === 'internal' && inputKind === 'container_image';
  const parsedRegistryReference = customerPublicImageReferenceSchema.safeParse(registryReference.trim());
  const hasImage = imageSource === 'archive' ? images.some(image => image.id === imageId) : parsedRegistryReference.success;
  const queue = useMutation({
    mutationFn: () => customerApi.queue({
      organizationId, applicationId, mode,
      sourceSnapshotId: mode === 'external' || usesImage ? null : sourceSnapshotId || null,
      targetId: mode === 'internal' ? null : targetId || null,
      ...(usesImage ? { inputKind: 'container_image' as const, containerImage: imageSource === 'archive'
        ? { kind: 'archive' as const, imageId }
        : { kind: 'registry' as const, reference: customerPublicImageReferenceSchema.parse(registryReference.trim()) } } : {}),
    }),
    onSuccess: result => { setError(null); onQueued(result.jobId); },
    onError: caught => setError(readableError(caught)),
  });
  const needsSource = mode !== 'external' && !usesImage;
  const needsTarget = mode !== 'internal';
  const hasSource = sources.some(source => source.id === sourceSnapshotId);
  const hasTarget = verifiedTargets.some(target => target.id === targetId);
  const ready = (!needsSource || hasSource) && (!needsTarget || hasTarget) && (!usesImage || hasImage);

  return <section className="customer-card customer-assessment-card">
    <div className="customer-card-heading"><div><span className="customer-eyebrow">NUEVA EVALUACIÓN</span><h2>Define el alcance</h2></div><span className="customer-status customer-status-muted">Observación</span></div>
    <p className="customer-card-copy">Elige sólo las perspectivas que autorizas. El análisis de código y de imágenes no ejecuta archivos ni inicia contenedores.</p>
    <form className="customer-form customer-assessment-form" onSubmit={event => { event.preventDefault(); setError(null); queue.mutate(); }}>
      <label htmlFor="assessment-mode">Perspectiva</label><select id="assessment-mode" value={mode} onChange={event => { const nextMode = event.target.value as AssessmentMode; setMode(nextMode); if (nextMode !== 'internal') setInputKind('source_snapshot'); setError(null); }} disabled={queue.isPending}><option value="external">HTTPS autorizado (sin código)</option><option value="internal">Análisis interno</option><option value="both">Código + HTTPS</option></select>
      {mode === 'internal' && <><label htmlFor="assessment-input-kind">Tipo de activo interno</label><select id="assessment-input-kind" value={inputKind} onChange={event => setInputKind(event.target.value as 'source_snapshot' | 'container_image')} disabled={queue.isPending}><option value="source_snapshot">Código fuente</option><option value="container_image">Imagen de contenedor</option></select></>}
      {usesImage && <><label htmlFor="assessment-image-source">Origen de la imagen</label><select id="assessment-image-source" value={imageSource} onChange={event => setImageSource(event.target.value as 'archive' | 'registry')} disabled={queue.isPending}><option value="archive">Archivo Docker/OCI guardado</option><option value="registry">Referencia de registro público</option></select>{imageSource === 'archive' ? <><label htmlFor="assessment-image-archive">Archivo guardado</label><select id="assessment-image-archive" value={imageId} onChange={event => setImageId(event.target.value)} disabled={queue.isPending}><option value="">Selecciona una imagen subida</option>{images.map(image => <option key={image.id} value={image.id}>{image.label} · {image.digest.slice(0, 12)}…</option>)}</select></> : <><label htmlFor="assessment-image-reference">Referencia pública con digest</label><input id="assessment-image-reference" value={registryReference} onChange={event => setRegistryReference(event.target.value)} disabled={queue.isPending} maxLength={512} placeholder="docker.io/library/alpine@sha256:…" /><p className="customer-field-note">Sólo docker.io, ghcr.io, quay.io, public.ecr.aws y gcr.io, siempre con digest SHA-256. No se aceptan etiquetas mutables ni credenciales.</p>{registryReference && !parsedRegistryReference.success && <p className="customer-form-error" role="alert">Usa un registro público admitido y una referencia completa fijada por digest.</p>}</>}</>}
      {needsSource && <><label htmlFor="assessment-source">Instantánea de código</label><select id="assessment-source" value={sourceSnapshotId} onChange={event => setSourceSnapshotId(event.target.value)} disabled={queue.isPending}><option value="">Selecciona una instantánea</option>{sources.map(source => <option key={source.id} value={source.id}>{source.revision} · {source.fileCount} archivos · {date(source.createdAt)}</option>)}</select></>}
      {needsTarget && <><label htmlFor="assessment-target">Origen HTTPS verificado</label><select id="assessment-target" value={targetId} onChange={event => setTargetId(event.target.value)} disabled={queue.isPending}><option value="">Selecciona un origen verificado</option>{verifiedTargets.map(target => <option key={target.id} value={target.id}>{target.origin} · {scanProfileLabels[target.scanProfile ?? 'root']}{(target.scanProfile ?? 'root') === 'public_surface' ? ' · máx. 10 GET' : ''} · vence {target.expiresAt ? date(target.expiresAt) : '—'}</option>)}</select></>}
      {!ready && <p className="customer-field-note">{needsTarget && !hasTarget ? 'Verifica primero un dominio HTTPS autorizado. ' : ''}{needsSource && !hasSource ? 'Sube primero una instantánea de código. ' : ''}{usesImage && !hasImage ? imageSource === 'archive' ? 'Sube primero un archivo de imagen.' : 'Escribe una referencia pública fijada por digest.' : ''}</p>}
      {error && <p className="customer-form-error" role="alert">{error}</p>}
      <button className="customer-button customer-button-primary" disabled={!canManage || archived || !ready || queue.isPending}>{queue.isPending ? 'Guardando evaluación…' : 'Iniciar evaluación'}</button>
      {archived && <p className="customer-field-note">Reactiva esta aplicación antes de iniciar otra evaluación.</p>}
    </form>
  </section>;
}

function CustomerWorkspace({ session, userId, acceptedInvitationId, invitationMessage }: { session: CustomerSession; userId: string; acceptedInvitationId: string | null; invitationMessage: string | null }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState<Page>('overview');
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(null);
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<{ organizationId: string; applicationId: string; jobId: string; purpose: 'assessment' | 'correction' } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    if (!acceptedInvitationId) return;
    setSelectedWorkspaceId(acceptedInvitationId);
    queryClient.invalidateQueries({ queryKey: ['customer-data', userId, 'workspaces'] }).catch(caught => setPageError(readableError(caught)));
  }, [acceptedInvitationId, queryClient, userId]);
  useEffect(() => {
    const saved = sessionStorage.getItem('gotchu-pending-github-scope');
    if (!saved) return;
    try {
      const scope = customerScopeSchema.safeParse(JSON.parse(saved));
      if (scope.success) { setSelectedWorkspaceId(scope.data.organizationId); setSelectedApplicationId(scope.data.applicationId); }
    } catch { /* Invalid browser state is discarded below. */ }
    sessionStorage.removeItem('gotchu-pending-github-scope');
  }, []);

  const workspaces = useQuery({ queryKey: ['customer-data', userId, 'workspaces'], queryFn: customerApi.workspaces, retry: false });
  const organizationId = selectedWorkspaceId ?? workspaces.data?.[0]?.id ?? null;
  const workspace = workspaces.data?.find(item => item.id === organizationId) ?? null;
  const applications = useQuery({ queryKey: ['customer-data', userId, 'applications', organizationId], enabled: organizationId !== null, queryFn: () => {
    if (!organizationId) throw new Error('Selecciona un espacio de trabajo.');
    return customerApi.applications(organizationId);
  }, retry: false });
  const selectedApplication = applications.data?.find(item => item.applicationId === selectedApplicationId)
    ?? applications.data?.find(item => !item.archived)
    ?? applications.data?.[0]
    ?? null;
  const applicationId = selectedApplication?.applicationId ?? null;
  const canManage = workspace !== null && (workspace.role === 'owner' || workspace.role === 'operator');
  const targets = useQuery({ queryKey: ['customer-data', userId, 'targets', organizationId, applicationId], enabled: organizationId !== null && applicationId !== null, queryFn: () => {
    if (!organizationId || !applicationId) throw new Error('Selecciona una aplicación.');
    return customerApi.targets(organizationId, applicationId);
  }, retry: false });
  const sources = useQuery({ queryKey: ['customer-data', userId, 'sources', organizationId, applicationId], enabled: organizationId !== null && applicationId !== null, queryFn: () => {
    if (!organizationId || !applicationId) throw new Error('Selecciona una aplicación.');
    return customerApi.sources(organizationId, applicationId);
  }, retry: false });
  const images = useQuery({ queryKey: ['customer-data', userId, 'container-images', organizationId, applicationId], enabled: organizationId !== null && applicationId !== null, queryFn: () => {
    if (!organizationId || !applicationId) throw new Error('Selecciona una aplicación.');
    return customerApi.containerImages(organizationId, applicationId);
  }, retry: false });
  const reports = useQuery({ queryKey: ['customer-data', userId, 'reports', organizationId, applicationId], enabled: organizationId !== null && applicationId !== null, queryFn: () => {
    if (!organizationId || !applicationId) throw new Error('Selecciona una aplicación.');
    return customerApi.reports(organizationId, applicationId);
  }, retry: false });
  const visibleReportId = selectedReportId ?? reports.data?.[0]?.id ?? null;
  const report = useQuery({ queryKey: ['customer-data', userId, 'report', organizationId, applicationId, visibleReportId], enabled: organizationId !== null && applicationId !== null && visibleReportId !== null, queryFn: () => {
    if (!organizationId || !applicationId || !visibleReportId) throw new Error('Selecciona un informe.');
    return customerApi.report(organizationId, applicationId, visibleReportId);
  }, retry: false });
  const job = useQuery({
    queryKey: ['customer-data', userId, 'job', activeJob?.organizationId, activeJob?.applicationId, activeJob?.jobId],
    enabled: activeJob !== null,
    queryFn: () => {
      if (!activeJob) throw new Error('No hay una evaluación en curso.');
      return customerApi.job(activeJob.organizationId, activeJob.applicationId, activeJob.jobId);
    },
    refetchInterval: query => query.state.data?.state === 'succeeded' || query.state.data?.state === 'failed' ? false : 2_000,
    retry: 1,
  });

  const refreshApplicationData = () => {
    for (const queryKey of [
      ['customer-data', userId, 'applications', organizationId], ['customer-data', userId, 'targets', organizationId, applicationId],
      ['customer-data', userId, 'sources', organizationId, applicationId], ['customer-data', userId, 'reports', organizationId, applicationId],
      ['customer-data', userId, 'container-images', organizationId, applicationId],
    ]) queryClient.invalidateQueries({ queryKey }).catch(caught => setPageError(readableError(caught)));
  };
  const signOut = useMutation({
    mutationFn: customerApi.signOut,
    onSuccess: async value => {
      await queryClient.cancelQueries({ queryKey: ['customer-data'] });
      queryClient.removeQueries({ queryKey: ['customer-data'] });
      queryClient.setQueryData(['customer-session'], value); setPageError(null);
    },
    onError: caught => setPageError(readableError(caught)),
  });

  const jobResult: CustomerJob | undefined = job.data;
  useEffect(() => {
    if (!activeJob || !jobResult) return;
    if (jobResult.state === 'succeeded') {
      setActiveJob(null);
      if (jobResult.reportId) {
        setSelectedReportId(jobResult.reportId);
        setPage('reports');
        setNotice(activeJob.purpose === 'correction' ? 'El análisis interno independiente terminó y su informe ya está disponible.' : 'La evaluación terminó y su informe ya está disponible.');
      } else {
        setPageError(activeJob.purpose === 'correction'
          ? 'El análisis interno terminó, pero el nuevo informe todavía no está disponible. La instantánea privada se conserva; actualiza el historial para comprobarlo.'
          : 'La evaluación terminó, pero el informe todavía no está disponible. Actualiza el historial para comprobarlo.');
      }
      queryClient.invalidateQueries({ queryKey: ['customer-data', userId, 'reports', activeJob.organizationId, activeJob.applicationId] }).catch(caught => setPageError(readableError(caught)));
    } else if (jobResult.state === 'failed') {
      setActiveJob(null);
      setPageError(activeJob.purpose === 'correction'
        ? `El análisis independiente no finalizó${jobResult.reasonCode ? ` (${jobResult.reasonCode})` : ''}. La instantánea privada se preparó, pero no se validó; no se modificaron el repositorio, la fuente original ni producción.`
        : jobResult.reasonCode === 'assessment_reconciliation_required'
        ? 'No se pudo confirmar que el escáner haya terminado. Una persona operadora debe comprobarlo antes de revocar o renovar el origen. La autorización sigue activa y no se repetirá este trabajo automáticamente.'
        : jobResult.reasonCode ? `La evaluación no finalizó (${jobResult.reasonCode}).` : 'La evaluación no finalizó. Los informes anteriores siguen disponibles.');
    }
  }, [activeJob, jobResult, queryClient, userId]);

  const operationError = pageError;
  const pageTitle = pages.find(item => item.id === page)?.label ?? 'Inicio';
  const applicationReports = reports.data ?? [];
  const selectedSummary = applicationReports.find(item => item.id === visibleReportId);
  const needsReportData = page === 'overview' || page === 'reports';

  if (workspaces.isPending) return <main className="customer-app-shell"><Loading label="Cargando tus espacios de trabajo…" /></main>;
  if (workspaces.error) return <main className="customer-app-shell"><ErrorNotice message={readableError(workspaces.error)} retry={() => { workspaces.refetch().catch(caught => setPageError(readableError(caught))); }} /></main>;

  return <div className="customer-app-shell">
    <aside className="customer-sidebar">
      <a className="customer-brand" href="/dashboard"><span className="customer-brand-mark">g</span>gotchu<span className="customer-brand-dot">.</span></a>
      <div className="customer-workspace-select"><label htmlFor="workspace-select">ESPACIO DE TRABAJO</label><select id="workspace-select" value={organizationId ?? ''} onChange={event => { setSelectedWorkspaceId(event.target.value); setSelectedApplicationId(null); setSelectedReportId(null); setNotice(null); }}><option value="" disabled>Selecciona un espacio</option>{workspaces.data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{workspace && <span>{workspace.role === 'owner' ? 'Propietario' : workspace.role === 'operator' ? 'Operador' : 'Sólo lectura'}</span>}{workspace && <WorkspaceSettings key={workspace.id} organizationId={workspace.id} name={workspace.name} canManage={canManage} onSaved={() => { workspaces.refetch().catch(caught => setPageError(readableError(caught))); setNotice('El espacio de trabajo se actualizó.'); }} />}</div>
      {workspace && <div className="customer-application-select"><label htmlFor="application-select">APLICACIÓN</label><select id="application-select" value={applicationId ?? ''} onChange={event => { setSelectedApplicationId(event.target.value); setSelectedReportId(null); setNotice(null); }}><option value="" disabled>Selecciona una aplicación</option>{applications.data?.map(item => <option key={item.applicationId} value={item.applicationId}>{item.name}{item.archived ? ' · archivada' : ''}</option>)}</select></div>}
      <nav className="customer-nav" aria-label="Navegación principal">{pages.map(item => <button type="button" key={item.id} className={page === item.id ? 'customer-nav-item is-active' : 'customer-nav-item'} aria-current={page === item.id ? 'page' : undefined} onClick={() => setPage(item.id)}><Icon>{item.glyph}</Icon>{item.label}</button>)}</nav>
      <div className="customer-sidebar-bottom">
        {workspaces.data?.length === 0 && <div className="customer-sidebar-note">Crea tu primer espacio para incorporar aplicaciones autorizadas.</div>}
        {Boolean(workspaces.data?.length) && <WorkspaceCreate disabled={false} onCreated={created => { setSelectedWorkspaceId(created.id); setSelectedApplicationId(null); queryClient.invalidateQueries({ queryKey: ['customer-data', userId, 'workspaces'] }).catch(caught => setPageError(readableError(caught))); setNotice(`Espacio «${created.name}» creado.`); }} />}
        <div className="customer-user-row"><span className="customer-user-avatar">U</span><span>Sesión activa</span><button className="customer-icon-button" aria-label="Cerrar sesión" title="Cerrar sesión" disabled={signOut.isPending} onClick={() => signOut.mutate()}>↗</button></div>
      </div>
    </aside>
    <div className="customer-main-column">
      <header className="customer-topbar"><span className="customer-breadcrumb">{workspace?.name ?? 'Tu organización'} <span>/</span><strong>{pageTitle}</strong></span><span className="customer-mode-pill"><i />Evaluación en observación</span></header>
      <main className="customer-main">
        {invitationMessage && <div className="customer-success" role="status">{invitationMessage}</div>}
        {notice && <div className="customer-success" role="status"><span>{notice}</span><button className="customer-icon-button" aria-label="Descartar aviso" onClick={() => setNotice(null)}>×</button></div>}
        {operationError && <ErrorNotice message={operationError} retry={() => { setPageError(null); refreshApplicationData(); workspaces.refetch().catch(caught => setPageError(readableError(caught))); }} />}
        {page === 'members' && organizationId && workspace ? <MembersPanel key={`${userId}:${organizationId}`} organizationId={organizationId} userId={userId} role={workspace.role} />
        : !organizationId ? <Onboarding userId={userId} {...(session.user?.displayName ? { displayName: session.user.displayName } : {})} onWorkspaceCreated={() => { queryClient.invalidateQueries({ queryKey: ['customer-data', userId, 'workspaces'] }).catch(caught => setPageError(readableError(caught))); }} onScanQueued={(scope, jobId) => { queryClient.invalidateQueries({ queryKey: ['customer-data', userId, 'applications', scope.organizationId] }).catch(caught => setPageError(readableError(caught))); setSelectedWorkspaceId(scope.organizationId); setSelectedApplicationId(scope.applicationId); setActiveJob({ ...scope, jobId, purpose: 'assessment' }); setPage('overview'); }} />
        : page === 'decision-records' && organizationId ? <>
          <div className="customer-page-heading"><div><span className="customer-eyebrow">{workspace?.name}</span><h1>Historial de decisiones</h1><p>Consulta quién realizó cambios y qué evaluaciones, alertas y acciones quedaron registradas en este espacio de trabajo.</p></div></div>
          <DecisionRecordHistory userId={userId} organizationId={organizationId} />
        </>
        : page === 'license-policy' && organizationId ? <>
          <div className="customer-page-heading"><div><span className="customer-eyebrow">{workspace?.name}</span><h1>Política de licencias</h1><p>Define cómo clasificar las licencias declaradas en las dependencias exactas de cada evaluación de código.</p></div></div>
          <LicensePolicyPanel key={`${userId}:${organizationId}`} userId={userId} organizationId={organizationId} canManage={canManage} />
        </>
        : page === 'retention-policy' && organizationId ? <>
          <div className="customer-page-heading"><div><span className="customer-eyebrow">{workspace?.name}</span><h1>Retención y privacidad</h1><p>Elige cuánto tiempo conserva este espacio de trabajo los datos operativos y las fuentes que comparte con Gotchu.</p></div></div>
          <RetentionPolicyPanel key={`${userId}:${organizationId}`} userId={userId} organizationId={organizationId} isOwner={workspace?.role === 'owner'} />
        </>
        : applications.isPending ? <Loading label="Cargando aplicaciones…" />
        : applications.error ? <ErrorNotice message={readableError(applications.error)} retry={() => { applications.refetch().catch(caught => setPageError(readableError(caught))); }} />
        : !selectedApplication ? <Onboarding userId={userId} {...(session.user?.displayName ? { displayName: session.user.displayName } : {})} initialOrganizationId={organizationId} canManage={canManage} onWorkspaceCreated={() => undefined} onScanQueued={(scope, jobId) => { queryClient.invalidateQueries({ queryKey: ['customer-data', userId, 'applications', scope.organizationId] }).catch(caught => setPageError(readableError(caught))); setSelectedApplicationId(scope.applicationId); setActiveJob({ ...scope, jobId, purpose: 'assessment' }); setPage('overview'); }} />
        : page === 'overview' && sources.data?.length === 0 && images.data?.length === 0 && applicationReports.length === 0 && !activeJob ? <Onboarding userId={userId} {...(session.user?.displayName ? { displayName: session.user.displayName } : {})} initialOrganizationId={organizationId} initialApplicationId={selectedApplication.applicationId} canManage={canManage} onWorkspaceCreated={() => undefined} onScanQueued={(scope, jobId) => { setActiveJob({ ...scope, jobId, purpose: 'assessment' }); setPage('overview'); }} />
        : <>
          <div className="customer-page-heading"><div><span className="customer-eyebrow">{workspace?.name} · {selectedApplication.name}</span><h1>{page === 'overview' ? 'Seguridad de tus aplicaciones' : pageTitle}</h1><p>{page === 'overview' ? 'Evalúa únicamente los activos que tu equipo autoriza y revisa cada conclusión con su evidencia.' : page === 'applications' ? 'Administra el alcance externo y las instantáneas de código de esta aplicación.' : page === 'operations' ? 'Vigila esta aplicación, revisa señales y prepara pasos consultivos según la evidencia vigente.' : 'Historial de evaluaciones e informes con cobertura, observaciones y evidencia.'}</p></div>{selectedApplication.archived && <span className="customer-status customer-status-muted">Aplicación archivada</span>}</div>

          {targets.isPending || sources.isPending || images.isPending || (needsReportData && reports.isPending) ? <Loading label="Cargando el alcance de la aplicación…" /> : (targets.error || sources.error || images.error || (needsReportData && reports.error)) ? <ErrorNotice message={readableError(targets.error ?? sources.error ?? images.error ?? reports.error)} retry={() => refreshApplicationData()} /> : <>
            {page === 'overview' && <>
              {activeJob && <JobStatusBanner purpose={activeJob.purpose} job={jobResult} error={job.error ? readableError(job.error) : null} retry={() => { job.refetch().catch(caught => setPageError(readableError(caught))); }} />}
              <div className="customer-overview-grid"><section className="customer-welcome-card"><span className="customer-eyebrow">ALCANCE CONTROLADO</span><h2>{selectedApplication.name}</h2><p>El análisis HTTPS puede funcionar sin acceso al repositorio. El modo combinado requiere tanto una instantánea autorizada como un dominio verificado.</p><div className="customer-overview-stats"><div><strong>{sources.data?.length ?? 0}</strong><span>Instantáneas</span></div><div><strong>{targets.data?.filter(target => target.status === 'verified').length ?? 0}</strong><span>Orígenes verificados</span></div><div><strong>{applicationReports.length}</strong><span>Informes</span></div></div><button className="customer-button customer-button-secondary" onClick={() => setPage('applications')}>Configurar alcance</button></section>
                <AssessmentForm key={`${organizationId}:${selectedApplication.applicationId}`} organizationId={organizationId} applicationId={selectedApplication.applicationId} sources={sources.data ?? []} images={images.data ?? []} targets={targets.data ?? []} canManage={canManage} archived={selectedApplication.archived} onQueued={jobId => { setActiveJob({ organizationId, applicationId: selectedApplication.applicationId, jobId, purpose: 'assessment' }); setPageError(null); setNotice('La evaluación se guardó y se ejecutará en segundo plano.'); }} />
              </div>
              {applicationReports.length > 0 && <section className="customer-card customer-next-actions"><div><span className="customer-eyebrow">SIGUIENTE PASO</span><h2>Convierte el informe en trabajo claro</h2><p>Revisa las recomendaciones, comprueba incidentes y configura vigilancia desde esta aplicación.</p></div><button className="customer-button customer-button-primary" onClick={() => { setSelectedReportId(applicationReports[0]?.id ?? null); setPage('reports'); }}>Ver recomendaciones</button><button className="customer-button customer-button-secondary" onClick={() => setPage('operations')}>Ver incidentes</button><button className="customer-button customer-button-secondary" onClick={() => setPage('operations')}>Configurar vigilancia</button></section>}
              <section className="customer-card customer-recent-card"><div className="customer-card-heading"><div><span className="customer-eyebrow">ACTIVIDAD RECIENTE</span><h2>Informes</h2></div><button className="customer-link-button" onClick={() => setPage('reports')}>Ver historial →</button></div>{applicationReports.length === 0 ? <div className="customer-empty-inline">Todavía no hay informes para esta aplicación. Define el alcance e inicia una evaluación cuando esté listo.</div> : <ReportList reports={applicationReports.slice(0, 4)} selectedId={visibleReportId} select={id => { setSelectedReportId(id); setPage('reports'); }} />}</section>
            </>}

            {page === 'applications' && <>
              <section className="customer-card customer-applications-card"><div className="customer-card-heading"><div><span className="customer-eyebrow">APLICACIONES</span><h2>Activos de {workspace?.name}</h2></div>{canManage && <ApplicationCreate organizationId={organizationId} disabled={false} onCreated={id => { setSelectedApplicationId(id); applications.refetch().catch(caught => setPageError(readableError(caught))); }} />}</div>
                <div className="customer-application-grid">{(applications.data ?? []).map(application => <button className={application.applicationId === applicationId ? 'customer-application-card is-selected' : 'customer-application-card'} key={application.applicationId} onClick={() => { setSelectedApplicationId(application.applicationId); setSelectedReportId(null); }}><span className="customer-app-icon">▦</span><span><strong>{application.name}</strong><small>{application.archived ? 'Archivada' : 'Activa'} · Añadida {date(application.createdAt)}</small></span><span className="customer-app-role">{application.applicationId === applicationId ? 'Seleccionada' : 'Abrir'}</span></button>)}</div>
              </section>
              <div className="customer-asset-grid"><TargetEnrollment key={`${organizationId}:${selectedApplication.applicationId}`} organizationId={organizationId} applicationId={selectedApplication.applicationId} targets={targets.data ?? []} canManage={canManage && !selectedApplication.archived} onChanged={() => { setPageError(null); refreshApplicationData(); }} /><SourceEnrollment key={`${organizationId}:${selectedApplication.applicationId}`} organizationId={organizationId} applicationId={selectedApplication.applicationId} sources={sources.data ?? []} canManage={canManage && !selectedApplication.archived} onChanged={() => { setPageError(null); refreshApplicationData(); }} /><ContainerImageEnrollment key={`${organizationId}:${selectedApplication.applicationId}:images`} organizationId={organizationId} applicationId={selectedApplication.applicationId} images={images.data ?? []} canManage={canManage && !selectedApplication.archived} onChanged={() => { setPageError(null); refreshApplicationData(); }} /></div>
              <GitHubRepositoryPanel key={`${userId}:${organizationId}:${selectedApplication.applicationId}:github`} userId={userId} organizationId={organizationId} applicationId={selectedApplication.applicationId} canManage={canManage && !selectedApplication.archived} onScanQueued={jobId => { setActiveJob({ organizationId, applicationId: selectedApplication.applicationId, jobId, purpose: 'assessment' }); setPage('overview'); setNotice('La instantánea de GitHub está guardada y la primera evaluación se ejecuta en segundo plano.'); refreshApplicationData(); }} />
              <ContextPanel key={`${userId}:${organizationId}:${selectedApplication.applicationId}`} userId={userId} organizationId={organizationId} applicationId={selectedApplication.applicationId} canManage={canManage} archived={selectedApplication.archived} analyzedDigest={applicationReports[0]?.subject.sourceDigest ?? null} />
              <InvestigationModelSettings key={`${organizationId}:investigation-model`} organizationId={organizationId} isOwner={workspace?.role === 'owner'} />
              <ApprovalPanel key={`${userId}:${organizationId}:${selectedApplication.applicationId}:actions`} userId={userId} organizationId={organizationId} applicationId={selectedApplication.applicationId} canManage={canManage && !selectedApplication.archived} isOwner={workspace?.role === 'owner'} />
              <WorkflowExceptions userId={userId} organizationId={organizationId} applicationId={selectedApplication.applicationId} isOwner={workspace?.role === 'owner'} />
              <ApplicationSettings key={`${organizationId}:${selectedApplication.applicationId}`} organizationId={organizationId} applicationId={selectedApplication.applicationId} name={selectedApplication.name} archived={selectedApplication.archived} canManage={canManage} onSaved={() => { refreshApplicationData(); setNotice('La aplicación se actualizó.'); }} />
              {canManage && <StepUpPanel key={`${userId}:${organizationId}`} organizationId={organizationId} />}
            </>}

            {page === 'operations' && <><InvestigationsTimeline organizationId={organizationId} applicationId={selectedApplication.applicationId} canManage={canManage && !selectedApplication.archived} /><IncidentList organizationId={organizationId} applicationId={selectedApplication.applicationId} canManage={canManage && !selectedApplication.archived} /><ProtectionPanel key={`${userId}:${organizationId}:${selectedApplication.applicationId}:protection`} scope={{ organizationId, applicationId: selectedApplication.applicationId }} canManage={canManage && !selectedApplication.archived} /><OperationsPanel key={`${userId}:${organizationId}:${selectedApplication.applicationId}`} userId={userId} organizationId={organizationId} applicationId={selectedApplication.applicationId} sources={sources.data ?? []} targets={targets.data ?? []} canManage={canManage && !selectedApplication.archived} /><NotificationsPanel key={`${userId}:${organizationId}:${selectedApplication.applicationId}:notifications`} userId={userId} organizationId={organizationId} applicationId={selectedApplication.applicationId} canManage={canManage && !selectedApplication.archived} /></>}

          {page === 'reports' && <>
            {report.data && <section className="customer-card customer-next-actions"><div><span className="customer-eyebrow">INFORME DISPONIBLE</span><h2>¿Qué quieres hacer ahora?</h2><p>{report.data.subject.containerImageDigest ? 'Actualiza y vuelve a construir la imagen a partir de la evidencia del informe.' : 'Las recomendaciones y su cobertura aparecen dentro del informe.'} Incidentes y vigilancia están en el área operativa.</p></div>{!report.data.subject.containerImageDigest && <button className="customer-button customer-button-primary" onClick={() => document.getElementById('recommendations-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Ver recomendaciones</button>}<button className="customer-button customer-button-secondary" onClick={() => setPage('operations')}>Ver incidentes</button><button className="customer-button customer-button-secondary" onClick={() => setPage('operations')}>Configurar vigilancia</button></section>}
            {activeJob && activeJob.organizationId === organizationId && activeJob.applicationId === selectedApplication.applicationId && <JobStatusBanner purpose={activeJob.purpose} job={jobResult} error={job.error ? readableError(job.error) : null} retry={() => { job.refetch().catch(caught => setPageError(readableError(caught))); }} />}
            <div className="customer-report-layout"><section className="customer-card customer-report-history"><div className="customer-card-heading"><div><span className="customer-eyebrow">HISTORIAL</span><h2>{applicationReports.length} informes</h2></div></div>{applicationReports.length === 0 ? <div className="customer-empty-inline">Los informes aparecerán aquí cuando termine una evaluación.</div> : <ReportList reports={applicationReports} selectedId={visibleReportId} select={setSelectedReportId} />}</section><section className="customer-card customer-report-card">{report.isPending ? <Loading label="Cargando informe…" /> : report.error ? <ErrorNotice message={readableError(report.error)} retry={() => { report.refetch().catch(caught => setPageError(readableError(caught))); }} /> : report.data ? <ReportView key={`${userId}:${organizationId}:${selectedApplication.applicationId}:${report.data.id}`} report={report.data} {...(selectedSummary ? { summary: selectedSummary } : {})} userId={userId} organizationId={organizationId} applicationId={selectedApplication.applicationId} canManage={canManage} archived={selectedApplication.archived} onCorrectionQueued={jobId => { setActiveJob({ organizationId, applicationId: selectedApplication.applicationId, jobId, purpose: 'correction' }); setPageError(null); }} /> : <div className="customer-empty-inline">Selecciona un informe para revisar sus observaciones y evidencias.</div>}</section></div>
          </>}
          </>}
        </>}
        <footer className="customer-footer"><span>Las observaciones conservan su origen, confianza y cobertura.</span><span>Gotchu · Modo observación</span></footer>
      </main>
    </div>
  </div>;
}

function ReportList({ reports, selectedId, select }: { reports: CustomerReportSummary[]; selectedId: string | null; select: (id: string) => void }) {
  return <ul className="customer-report-list">{reports.map(report => <li key={report.id}><button className={selectedId === report.id ? 'is-selected' : ''} onClick={() => select(report.id)}><span className="customer-report-icon">▤</span><span className="customer-report-row-title"><strong>{report.subject.containerImageDigest ? 'Imagen de contenedor' : modeLabels[report.mode]}</strong><small>{date(report.finishedAt)} · {report.findingCount} observaciones</small></span><span className="customer-report-app">{report.applicationName}</span><span aria-hidden="true">›</span></button></li>)}</ul>;
}

function JobStatusBanner({ purpose, job, error, retry }: { purpose: 'assessment' | 'correction'; job: CustomerJob | undefined; error: string | null; retry: () => void }) {
  const correction = purpose === 'correction';
  const heading = correction
    ? job?.state === 'running' ? 'Analizando instantánea privada' : job?.state === 'failed' ? 'Análisis independiente no finalizado' : job?.state === 'succeeded' ? 'Análisis independiente finalizado' : 'Análisis independiente en cola'
    : job?.state === 'running' ? 'Evaluación en curso' : job?.state === 'failed' ? 'Evaluación no finalizada' : job?.state === 'succeeded' ? 'Evaluación finalizada' : 'Evaluación guardada';
  const detail = error
    ? 'No se pudo actualizar el estado. El trabajo puede continuar en segundo plano.'
    : correction
      ? 'El estado se actualiza automáticamente. Este análisis no modifica tu repositorio ni producción.'
      : 'El trabajo continúa en segundo plano. Tus informes anteriores siguen disponibles.';
  return <div id="customer-active-job" className="customer-job-banner" role="status" aria-live="polite"><span className="customer-spinner" /><div><strong>{heading}</strong><p>{detail}</p></div>{error && <button className="customer-link-button" type="button" onClick={retry}>Reintentar estado</button>}</div>;
}

export function CustomerDashboard() {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ['customer-session'], queryFn: customerApi.session, retry: false, staleTime: 30_000 });
  const [invitationToken, setInvitationToken] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState<string | null>(null);
  const [acceptedInvitation, setAcceptedInvitation] = useState<{ organizationId: string; role: 'operator' | 'viewer' } | null>(null);
  const [acceptAttempt, setAcceptAttempt] = useState(0);
  const accepting = useRef<string | null>(null);
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const fragmentToken = fragment.get('invitation');
    const token = fragmentToken && /^[A-Za-z0-9_-]{43}$/.test(fragmentToken)
      ? fragmentToken
      : sessionStorage.getItem('gotchu.pending-invitation');
    if (token) {
      sessionStorage.setItem('gotchu.pending-invitation', token);
      setInvitationToken(token);
    }
    if (fragmentToken) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
  }, []);
  useEffect(() => {
    if (!invitationToken || !session.data?.user || accepting.current === invitationToken) return;
    accepting.current = invitationToken;
    setInvitationError(null);
    membersApi.accept(invitationToken).then(result => {
      sessionStorage.removeItem('gotchu.pending-invitation');
      setAcceptedInvitation(result);
      setInvitationToken(null);
      return queryClient.invalidateQueries({ queryKey: ['customer-data', session.data.user?.id, 'workspaces'] });
    }).catch(caught => {
      setInvitationError(readableError(caught));
      accepting.current = null;
    });
  }, [acceptAttempt, invitationToken, queryClient, session.data?.user]);
  const invitationMessage = acceptedInvitation ? 'Invitación aceptada. Se abrió el nuevo espacio de trabajo.' : null;
  const invitationBanner = invitationError ? <div role="alert" className="customer-error"><p>No se pudo aceptar la invitación: {invitationError}</p><button type="button" className="customer-link-button" onClick={() => setAcceptAttempt(value => value + 1)}>Volver a intentar</button></div>
    : invitationToken && !session.data?.user ? <p role="status" className="customer-success">Inicia sesión con la cuenta invitada para aceptar esta invitación.</p> : null;
  if (session.isPending) return <main className="customer-auth-page"><Loading label="Comprobando tu sesión…" /></main>;
  if (session.error) return <main className="customer-auth-page"><section className="customer-auth-card"><a className="customer-brand" href="/dashboard"><span className="customer-brand-mark">g</span>gotchu<span className="customer-brand-dot">.</span></a>{invitationBanner}<ErrorNotice message={readableError(session.error)} retry={() => session.refetch()} /></section></main>;
  if (!session.data.user) return <>{invitationBanner}<AuthPanel session={session.data} onAuthenticated={value => { queryClient.setQueryData(['customer-session'], value); }} /></>;
  return <><CustomerWorkspace key={session.data.user.id} session={session.data} userId={session.data.user.id} acceptedInvitationId={acceptedInvitation?.organizationId ?? null} invitationMessage={invitationMessage} />{invitationBanner}</>;
}
