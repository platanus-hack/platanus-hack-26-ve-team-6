import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { z } from 'zod';
import { AppWindowIcon, ArchiveIcon, ChevronRightIcon, EyeIcon, EyeOffIcon, FileTextIcon, GavelIcon, GlobeIcon, HouseIcon, LogOutIcon, PlusIcon, RadarIcon, ScaleIcon, SparklesIcon, UsersIcon, XIcon, type LucideIcon } from 'lucide-react';
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
import { readSavedCustomerScope } from './customer-scope-storage';
import { ReportRecommendations } from './report-recommendations';
import { ComparisonPresence, ComparisonSummary, ComparisonVerification, ExternalHttpsEvidence } from './customer-report-components';
import { coverageCapabilitiesLabel, exploitabilityLabel, groupCoverage, reportInputLabel } from './customer-report-model';
import { ContextPanel } from './context-panel';
import { membersApi } from './members-client';
import { ApprovalPanel } from './approval-panel';
import { GitHubRepositoryPanel } from './onboarding';
import { WorkflowExceptions } from './workflow-exceptions';
import { InvestigationActionButton, InvestigationsTimeline } from './investigations-panel';
import { AiCorrectionPanel } from './ai-correction-panel';
import { DependencyInventoryPanel } from './customer-supply-chain';
import { GotchuMark } from './gotchu-mark';
import { DotPlate } from './dot-field/dot-plate';
import { ThemeSwitch } from './theme-switch';
import { FilePicker } from './file-picker';
import { FirstProjectEmptyState } from './empty-state';
import { WorkspacePages } from './workspace-pages';
import { AssessmentProgress, ReportProgress } from './assessment-progress';
import { ProjectOverview } from './project-overview';
import { ProjectSources } from './project-sources';
import { ProjectReports } from './project-reports';
import { ProjectVigilance } from './project-vigilance';
import { DashboardShell } from './dashboard-shell';
import { ProjectHttpsAudit } from './project-https-audit';
import { ChoiceSelect } from './choice-select';
import { DashboardSectionContext, routePageFromPath } from './dashboard-route-view';
import './customer-shell.css';
import './customer-report.css';
import './customer-operations.css';

export type DashboardPage = 'overview' | 'applications' | 'https-audit' | 'operations' | 'reports' | 'members' | 'decision-records' | 'license-policy' | 'retention-policy' | 'investigation-model';
type Page = DashboardPage;
type WorkspacePage = Extract<Page, 'members' | 'decision-records' | 'license-policy' | 'retention-policy' | 'investigation-model'>;
type ActiveJob = { organizationId: string; applicationId: string; jobId: string; purpose: 'assessment' | 'correction' };

function isWorkspacePage(page: Page): page is WorkspacePage {
  return page === 'members' || page === 'decision-records' || page === 'license-policy' || page === 'retention-policy' || page === 'investigation-model';
}

function readLastProjectPath() {
  try { return typeof window === 'undefined' ? null : window.localStorage.getItem('gotchu.last-project-path'); }
  catch { return null; }
}

const pages: { id: Page; label: string; icon: LucideIcon }[] = [
  { id: 'overview', label: 'Inicio', icon: HouseIcon },
  { id: 'applications', label: 'Fuentes', icon: AppWindowIcon },
  { id: 'https-audit', label: 'Auditoría HTTPS', icon: GlobeIcon },
  { id: 'operations', label: 'Vigilancia', icon: RadarIcon },
  { id: 'reports', label: 'Informes', icon: FileTextIcon },
  { id: 'investigation-model', label: 'Modelos de IA', icon: SparklesIcon },
  { id: 'license-policy', label: 'Licencias', icon: ScaleIcon },
  { id: 'retention-policy', label: 'Retención', icon: ArchiveIcon },
  { id: 'members', label: 'Equipo', icon: UsersIcon },
  { id: 'decision-records', label: 'Decisiones', icon: GavelIcon },
];

function DashboardNavLink({ page, organizationId, applicationId, onNavigate }: { page: Page; organizationId: string | null; applicationId: string | null; onNavigate: () => void }) {
  const Icon = pages.find(item => item.id === page)?.icon ?? HouseIcon;
  const content = <><Icon aria-hidden="true" />{pages.find(item => item.id === page)?.label}</>;
  const common = { className: 'customer-nav-item', activeOptions: { exact: page !== 'reports' }, activeProps: { className: 'customer-nav-item is-active', 'aria-current': 'page' as const }, onClick: onNavigate };
  if (!organizationId) return null;
  if (!isWorkspacePage(page) && !applicationId) return null;
  switch (page) {
    case 'overview': return <Link {...common} to="/w/$workspaceId/p/$projectId" params={{ workspaceId: organizationId, projectId: applicationId ?? '' }}>{content}</Link>;
    case 'applications': return <Link {...common} to="/w/$workspaceId/p/$projectId/fuentes" params={{ workspaceId: organizationId, projectId: applicationId ?? '' }}>{content}</Link>;
    case 'https-audit': return <Link {...common} to="/w/$workspaceId/p/$projectId/https" params={{ workspaceId: organizationId, projectId: applicationId ?? '' }}>{content}</Link>;
    case 'operations': return <Link {...common} to="/w/$workspaceId/p/$projectId/vigilancia" params={{ workspaceId: organizationId, projectId: applicationId ?? '' }}>{content}</Link>;
    case 'reports': return <Link {...common} to="/w/$workspaceId/p/$projectId/informes" params={{ workspaceId: organizationId, projectId: applicationId ?? '' }}>{content}</Link>;
    case 'investigation-model': return <Link {...common} to="/w/$workspaceId/modelos" params={{ workspaceId: organizationId }}>{content}</Link>;
    case 'license-policy': return <Link {...common} to="/w/$workspaceId/licencias" params={{ workspaceId: organizationId }}>{content}</Link>;
    case 'retention-policy': return <Link {...common} to="/w/$workspaceId/retencion" params={{ workspaceId: organizationId }}>{content}</Link>;
    case 'members': return <Link {...common} to="/w/$workspaceId/equipo" params={{ workspaceId: organizationId }}>{content}</Link>;
    case 'decision-records': return <Link {...common} to="/w/$workspaceId/decisiones" params={{ workspaceId: organizationId }}>{content}</Link>;
  }
}

const modeLabels: Record<AssessmentMode, string> = {
  internal: 'Código fuente',
  external: 'HTTPS externo',
  both: 'Código + HTTPS',
};
const sourceLabels = { internal: 'Código', external: 'HTTPS' };
const severityLabels = { unknown: 'Sin evaluar', critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja', informational: 'Informativa' };
const confidenceLabels = { observed: 'Observado', inferred: 'Indicado', uncertain: 'Sin comprobar' };
const coverageLabels = { inspected: 'Evaluado', not_requested: 'No solicitado', unsupported: 'No disponible en este perfil', unavailable: 'No disponible' };
const analysisLabels = { completed: 'Completado', partial: 'Parcial', unavailable: 'No disponible' };
const scanProfileLabels: Record<CustomerScanProfile, string> = { root: 'Raíz del sitio', public_surface: 'Superficie pública limitada', api_checks: 'Web y API · escenarios HTTP activos' };
const rememberedSignInKey = 'gotchu.sign-in-preference';
const rememberedSignInSchema = z.object({ email: z.string().max(254), method: z.string().min(1).max(128) }).strict();
const authCsrfResponseSchema = z.object({ csrfToken: z.string().min(1).max(256) }).strict();
const authRedirectResponseSchema = z.object({ url: z.url() }).strict();

function date(value: string) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function count(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`;
}

function readableError(error: unknown) {
  if (error instanceof CustomerApiError && error.code === 'target_assessment_in_progress') return 'El alcance sigue activo mientras haya evaluaciones pendientes. Espera a que terminen; si el resultado es incierto, una persona operadora debe revisarlo antes de revocar o renovar.';
  if (error instanceof CustomerApiError && (error.code === 'target_not_authorized' || error.code === 'assessment_target_changed')) return 'El alcance HTTPS venció, cambió o se revocó. Renueva el origen antes de solicitar otra evaluación.';
  if (error instanceof CustomerApiError) return error.message;
  if (error instanceof Error && !(error.name === 'ZodError')) return error.message;
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
}

/** The landing's lockup: the mark plus the wordmark in the display face. */
function Brand() {
  return <a className="customer-brand" href="/dashboard" aria-label="Gotchu, inicio"><GotchuMark size={26} /><span>Gotchu</span></a>;
}

function Loading({ label }: { label: string }) {
  return <div className="customer-loading" role="status"><span className="customer-spinner" />{label}</div>;
}

function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="customer-error" role="alert"><p>{message}</p>{retry && <button className="customer-link-button" onClick={retry}>Reintentar</button>}</div>;
}

/** Sign-in layout: a brand band beside a focused form (the band is dropped below 900px). */
function AuthShell({ labelledBy, children }: { labelledBy?: string; children: ReactNode }) {
  return <main className="gl customer-auth-page">
    <div className="customer-auth-band">
      <a className="customer-brand" href="/" aria-label="Gotchu, inicio"><GotchuMark size={26} /><span>Gotchu</span></a>
      <div className="customer-auth-plate" aria-hidden="true"><DotPlate formation="globe" /></div>
      <div className="customer-auth-pitch">
        <p className="customer-auth-headline">Mira de cerca.<br /><span>Decide con pruebas.</span></p>
        <p>Revisa el código de tu app, tu web o ambos, con evidencia para entender cada hallazgo y saber por dónde seguir.</p>
      </div>
    </div>
    <div className="customer-auth-main">
      <header className="customer-auth-top">
        <a className="customer-brand customer-auth-mobile-brand" href="/" aria-label="Gotchu, inicio"><GotchuMark size={26} /><span>Gotchu</span></a>
        <nav className="customer-auth-nav" aria-label="Navegación principal"><a href="/">Inicio</a><a href="/#gl-codigo">Cómo funciona</a></nav>
        <ThemeSwitch />
      </header>
      <section className="customer-auth-card" {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}>{children}</section>
    </div>
  </main>;
}

function ProviderLogo({ providerId }: { providerId: string }) {
  if (providerId === 'google') return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.49 12.27c0-.78-.07-1.53-.2-2.27H12v4.3h6.44a5.5 5.5 0 0 1-2.39 3.61v3h3.87c2.27-2.09 3.57-5.17 3.57-8.64Z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.93l-3.87-3c-1.08.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.73-4.95H1.27v3.09A12 12 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.27 14.27A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.55.37-2.27V6.64H1.27A12 12 0 0 0 0 12c0 1.94.46 3.78 1.27 5.36l4-3.09Z"/><path fill="#EA4335" d="M12 4.78c1.77 0 3.35.61 4.6 1.81l3.45-3.45C17.95 1.17 15.24 0 12 0A12 12 0 0 0 1.27 6.64l4 3.09C6.22 6.89 8.87 4.78 12 4.78Z"/></svg>;
  if (providerId === 'github') return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 1.72 2.62 1.22 3.26.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.24 1.16-3.03-.12-.29-.5-1.44.11-2.99 0 0 .95-.3 3.1 1.16a10.8 10.8 0 0 1 5.64 0c2.15-1.46 3.1-1.16 3.1-1.16.62 1.55.23 2.7.12 2.99.72.79 1.15 1.8 1.15 3.03 0 4.32-2.63 5.28-5.14 5.56.4.35.75 1.03.75 2.08v3.1c0 .3.2.65.77.54A11.25 11.25 0 0 0 12 .75Z"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M12 3 4.5 6v5.1c0 4.6 3.2 8.6 7.5 9.9 4.3-1.3 7.5-5.3 7.5-9.9V6L12 3Z"/><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="m9 12 2 2 4-4"/></svg>;
}

function AuthPanel({ session, onAuthenticated, initialRegistering = false }: { session: CustomerSession; onAuthenticated: (session: CustomerSession) => void; initialRegistering?: boolean }) {
  const [registering, setRegistering] = useState(initialRegistering);
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
  return <AuthShell labelledBy="auth-title">
      <h1 id="auth-title">{registering ? 'Crea tu cuenta en Gotchu' : 'Inicia sesión en Gotchu'}</h1>

      {error && <div className="customer-inline-error" role="alert">{error}</div>}

      {socialProviders.length > 0 && <div className={`customer-auth-social-row ${socialProviders.length > 1 ? 'has-multiple' : 'has-single'}`} aria-label="Otros métodos de acceso">
        {socialProviders.map(provider => <button className="customer-button customer-provider-button customer-provider-button-social" key={provider.id} type="button" disabled={loadingProvider !== null} onClick={() => startProvider(provider.id)} aria-busy={loadingProvider === provider.id}>
          {loadingProvider === provider.id ? <span className="customer-spinner" aria-hidden="true" /> : <ProviderLogo providerId={provider.id} />}
          <span>{loadingProvider === provider.id ? `Conectando con ${provider.name}…` : provider.name}</span>
        </button>)}
      </div>}
      {ssoProviders.map(provider => <button className="customer-button customer-provider-button customer-provider-button-sso" key={provider.id} type="button" disabled={loadingProvider !== null} onClick={() => startProvider(provider.id)} aria-busy={loadingProvider === provider.id}>
        {loadingProvider === provider.id ? <span className="customer-spinner" aria-hidden="true" /> : <ProviderLogo providerId={provider.id} />}
        <span>{loadingProvider === provider.id ? 'Conectando con SSO…' : 'Iniciar sesión con SSO'}</span>
      </button>)}

      {oauthProviders.length > 0 && session.localAuthEnabled && <div className="customer-auth-divider"><span>o con tu correo</span></div>}
      {session.localAuthEnabled && <form className="customer-form customer-auth-form" onSubmit={submit}>
        <label htmlFor="customer-email">Correo electrónico</label>
        <input id="customer-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} />
        <label htmlFor="customer-password">Contraseña</label>
        <div className="customer-auth-password"><input id="customer-password" type={showPassword ? 'text' : 'password'} autoComplete={registering ? 'new-password' : 'current-password'} required minLength={registering ? 15 : undefined} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /><button type="button" className="customer-auth-password-toggle" aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={showPassword} onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}</button></div>
        {!registering && <label className="customer-checkbox customer-auth-remember"><input type="checkbox" checked={rememberAccess} onChange={event => changeRememberAccess(event.target.checked)} /><span>Recordar email y método de acceso en este dispositivo</span></label>}
        {rememberAccess && lastMethodLabel && <p className="customer-auth-last-method" role="status">Último método: {lastMethodLabel}</p>}
        {registering && <p className="customer-field-note">Usa al menos 15 caracteres.</p>}
        <button className="customer-button customer-button-primary customer-button-full" disabled={busy || loadingProvider !== null}>{busy ? <><span className="customer-spinner" />Conectando…</> : registering ? 'Crear cuenta' : 'Iniciar sesión'}</button>
        {session.registrationEnabled && <button className="customer-link-button customer-auth-switch" type="button" onClick={() => { setRegistering(value => !value); setError(null); }}>{registering ? 'Ya tienes cuenta: iniciar sesión' : 'Crear una cuenta'}</button>}
      </form>}

      {!session.localAuthEnabled && oauthProviders.length === 0 && <div className="customer-inline-error" role="status">El inicio de sesión todavía no está configurado para este entorno.</div>}
      <nav className="customer-auth-legal" aria-label="Información legal">Consulta los <a href="/terms">Términos de uso</a> y el <a href="/privacy">Aviso de privacidad</a>.</nav>
  </AuthShell>;
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
    <label htmlFor="new-workspace">Nuevo espacio de trabajo</label>
    <div className="customer-inline-control"><input id="new-workspace" value={name} onChange={event => setName(event.target.value)} maxLength={200} required placeholder="Nombre del espacio de trabajo" /><button className="customer-button customer-button-small" disabled={disabled || create.isPending || !name.trim()} aria-label="Crear espacio de trabajo"><PlusIcon aria-hidden="true" /></button></div>
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
    <label htmlFor="new-application">Nuevo proyecto</label>
    <div className="customer-inline-control"><input id="new-application" value={name} onChange={event => setName(event.target.value)} maxLength={200} required placeholder="Nombre del proyecto" /><button className="customer-button customer-button-small" disabled={disabled || create.isPending || !name.trim()} aria-label="Nuevo proyecto"><PlusIcon aria-hidden="true" /></button></div>
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
    <div className="customer-card-heading"><div><h2>Datos del proyecto</h2></div><span className={archived ? 'customer-status customer-status-muted' : 'customer-status customer-status-ready'}>{archived ? 'Archivada' : 'Activa'}</span></div>
    <form className="customer-form customer-application-edit" onSubmit={event => { event.preventDefault(); setError(null); update.mutate({ name: draft.trim() }); }}>
      <label htmlFor="application-name">Nombre del proyecto</label><div className="customer-inline-control"><input id="application-name" value={draft} onChange={event => setDraft(event.target.value)} maxLength={200} required disabled={!canManage || update.isPending} /><button className="customer-button customer-button-small" disabled={!canManage || update.isPending || !draft.trim() || draft.trim() === name}>Guardar</button></div>
    </form>
    {canManage && <button className="customer-link-button customer-archive-button" disabled={update.isPending} onClick={() => { setError(null); update.mutate({ archived: !archived }); }}>{archived ? 'Reactivar proyecto' : 'Archivar proyecto'}</button>}
    {error && <p className="customer-form-error" role="alert">{error}</p>}
  </section>;
}

function TargetEnrollment({ organizationId, applicationId, targets, canManage, onChanged }: { organizationId: string; applicationId: string; targets: CustomerTarget[]; canManage: boolean; onChanged: () => void }) {
  const [origin, setOrigin] = useState('');
  const [scanProfile, setScanProfile] = useState<CustomerScanProfile>('root');
  const [error, setError] = useState<string | null>(null);
  const enroll = useMutation({
    mutationFn: () => customerApi.enrollTarget({ organizationId, applicationId, origin: origin.trim(), scanProfile }),
    onSuccess: result => { setOrigin(result.target.origin); setScanProfile(result.target.scanProfile ?? 'root'); setError(null); onChanged(); },
    onError: caught => setError(readableError(caught)),
  });
  const changeTarget = useMutation({
    mutationFn: (targetId: string) => customerApi.revokeTarget(organizationId, applicationId, targetId),
    onSuccess: () => { setError(null); onChanged(); },
    onError: caught => setError(readableError(caught)),
  });
  const activeTarget = targets.find(target => target.status !== 'revoked');
  const revokedTargets = targets.filter(target => target.status === 'revoked');
  const targetCurrent = activeTarget?.status === 'authorized' && activeTarget.expiresAt !== null && Date.parse(activeTarget.expiresAt) > Date.now();
  useEffect(() => {
    if (activeTarget && !origin) setOrigin(activeTarget.origin);
    if (activeTarget?.status === 'authorized') setScanProfile(activeTarget.scanProfile ?? 'root');
  }, [activeTarget, origin]);
  const originIsValid = customerOriginSchema.safeParse(origin.trim()).success;

  return <section className="customer-card">
    <div className="customer-card-heading"><div><h2>Aplicación HTTPS</h2></div><span className="customer-status customer-status-muted">Sólo lectura</span></div>
    <p className="customer-card-copy">Elige un origen HTTPS y un perfil acotado. El análisis externo puede ejecutarse sin acceso al código.</p>
    {activeTarget && <div className="customer-target-row">
      <div><strong>{activeTarget.origin}</strong><span>Solicitado {date(activeTarget.requestedAt)} · alcance activo desde {activeTarget.authorizedAt ? date(activeTarget.authorizedAt) : '—'} · versión {activeTarget.version}</span><span>Perfil: {scanProfileLabels[activeTarget.scanProfile ?? 'root']}{activeTarget.scanProfile === 'api_checks' ? ' · hasta 16 GET/HEAD/OPTIONS' : activeTarget.scanProfile === 'public_surface' ? ' · hasta 10 solicitudes GET' : ' · una solicitud GET a /'}</span><span>Vence {activeTarget.expiresAt ? date(activeTarget.expiresAt) : 'sin fecha registrada'}</span></div>
      <span className={`customer-status ${targetCurrent ? 'customer-status-ready' : 'customer-status-pending'}`}>{targetCurrent ? 'Alcance activo' : 'Alcance vencido'}</span>
      {canManage && <div className="customer-target-actions">
        {activeTarget.status === 'authorized' && <button className="customer-link-button customer-danger-link" disabled={changeTarget.isPending} onClick={() => { setError(null); changeTarget.mutate(activeTarget.id); }}>Revocar alcance</button>}
      </div>}
    </div>}
    {revokedTargets.length > 0 && <details className="customer-revoked-targets"><summary>Alcances revocados ({revokedTargets.length})</summary>{revokedTargets.map(target => <div key={target.id}><span>{target.origin} · versión {target.version}</span><span>{date(target.requestedAt)}</span></div>)}</details>}
    {canManage && <form className="customer-form customer-enroll-form" onSubmit={event => { event.preventDefault(); setError(null); enroll.mutate(); }}>
      <label htmlFor="target-origin">Origen HTTPS</label><input id="target-origin" type="url" inputMode="url" placeholder="https://app.example.com" value={origin} onChange={event => setOrigin(event.target.value)} maxLength={300} required aria-describedby="target-origin-help" aria-invalid={origin.length > 0 && !originIsValid} />
      <p id="target-origin-help" className="customer-field-note">Origen HTTPS público sin ruta, consulta, fragmento ni puerto personalizado.</p>
      {origin.length > 0 && !originIsValid && <p className="customer-form-error">Usa un origen HTTPS público sin rutas, parámetros ni puerto personalizado.</p>}
      <label htmlFor="target-scan-profile">Perfil de evaluación</label>
      <select id="target-scan-profile" value={scanProfile} onChange={event => { const selected = customerScanProfileSchema.safeParse(event.target.value); if (selected.success) setScanProfile(selected.data); }}>
        <option value="root">Raíz del sitio · una solicitud GET a /</option>
        <option value="public_surface">Superficie pública limitada · hasta 10 solicitudes GET, sólo a este origen</option>
        <option value="api_checks">Web y API · hasta 16 GET/HEAD/OPTIONS, sólo a este origen</option>
      </select>
      <p className="customer-field-note">El perfil elegido limita las rutas, métodos y solicitudes. El alcance no incluye otros dominios.</p>
      <button className="customer-button customer-button-primary" disabled={enroll.isPending || !originIsValid}>{enroll.isPending ? 'Guardando alcance…' : activeTarget ? 'Renovar alcance' : 'Añadir origen'}</button>
    </form>}
    {!canManage && !activeTarget && <div className="customer-empty-inline">Una persona propietaria u operadora puede añadir un origen HTTPS.</div>}
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
  const [revision, setRevision] = useState('main');
  const [selected, setSelected] = useState<SourceFile[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const included = selected.filter(item => item.validPath);
  const excludedCount = selected.length - included.length;
  const includedBytes = included.reduce((total, item) => total + item.file.size, 0);
  const preview = included.slice(0, 6);
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

  function chooseFiles(list: File[]) {
    const items = list.map(file => {
      const path = file.webkitRelativePath || file.name;
      return { file, path, validPath: customerSourceFileSchema.shape.path.safeParse(path).success };
    });
    setSelected(items);
    setAuthorized(false);
    setError(null);
  }

  return <section className="customer-card">
    <div className="customer-card-heading"><div><h2>Código fuente</h2></div></div>
    <p className="customer-card-copy">Para buscar avisos, solo se envían nombres y versiones de paquetes npm.</p>
    {sources.length > 0 && <div className="customer-source-list"><strong>Instantáneas disponibles</strong>{sources.map(source => <div key={source.id}><span><code>{source.revision}</code> · {source.fileCount} archivos · SHA-256 <code>{source.digest.slice(0, 12)}…</code><small>{date(source.createdAt)}</small></span>{canManage && <button className="customer-link-button customer-danger-link" disabled={remove.isPending} onClick={() => { if (window.confirm(`¿Eliminar la instantánea «${source.revision}»? Esta acción no se puede deshacer.`)) { setError(null); remove.mutate(source.id); } }}>Eliminar instantánea</button>}</div>)}</div>}
    {canManage && <form className="customer-form customer-source-form" onSubmit={event => { event.preventDefault(); setError(null); upload.mutate(); }}>
      <label htmlFor="source-revision">Versión</label><input id="source-revision" value={revision} onChange={event => setRevision(event.target.value)} maxLength={200} required placeholder="main, release/1.2, commit…" />
      <FilePicker id="source-files" directory buttonLabel="Elegir carpeta" summary={selected.length ? `${included.length} archivos compatibles` : 'Ninguna carpeta elegida'} onFiles={chooseFiles} />
      {selected.length > 0 && <div className="customer-source-preview" aria-live="polite"><div><strong>{included.length} archivos seleccionados</strong><span>{(includedBytes / (1024 * 1024)).toFixed(2)} MiB{excludedCount > 0 ? ` · ${excludedCount} excluidos por ruta o formato` : ''}</span></div>{preview.map(item => <code key={`${item.path}:${item.file.size}`}>{item.validPath ? item.path : `${item.path} · no admitido`}</code>)}{included.length > preview.length && <small>y {included.length - preview.length} archivos más</small>}{selectionError && <p className="customer-form-error" role="alert">{selectionError}</p>}</div>}
      <label className="customer-checkbox"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} required /><span>Tengo derecho a compartir este código para evaluarlo.</span></label>
      {error && <p className="customer-form-error" role="alert">{error}</p>}
      <button className="customer-button customer-button-primary" disabled={upload.isPending || !authorized || !included.length || Boolean(selectionError)}>{upload.isPending ? 'Validando y subiendo…' : 'Guardar instantánea'}</button>
    </form>}
    {!canManage && <div className="customer-empty-inline">Solo una persona propietaria u operadora puede subir código.</div>}
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
    <div className="customer-card-heading"><div><h2>Imagen de contenedor</h2></div></div>
    {images.length > 0 && <div className="customer-source-list"><strong>Archivos de imagen disponibles</strong>{images.map(image => <div key={image.id}><span>{image.label} · {(image.size / (1024 * 1024)).toFixed(2)} MiB · SHA-256 <code>{image.digest.slice(0, 12)}…</code><small>{date(image.createdAt)}</small></span>{canManage && <button className="customer-link-button customer-danger-link" disabled={remove.isPending} onClick={() => { if (window.confirm(`¿Eliminar el archivo de imagen «${image.label}»? Esta acción no se puede deshacer.`)) remove.mutate(image.id); }}>Eliminar archivo de imagen</button>}</div>)}</div>}
    {canManage ? <form className="customer-form customer-source-form" onSubmit={event => { event.preventDefault(); setError(null); upload.mutate(); }}>
      <FilePicker id="container-image-file" buttonLabel="Elegir archivo .tar" accept=".tar,application/x-tar,application/octet-stream" summary={file ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(2)} MiB` : 'Ninguna imagen seleccionada · máx. 8 MiB'} onFiles={files => { setFile(files[0] ?? null); setAuthorized(false); setError(null); }} />
      {fileError && <p className="customer-form-error" role="alert">{fileError}</p>}
      <label className="customer-checkbox"><input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} required /><span>Tengo derecho a compartir esta imagen para evaluarla.</span></label>
      {error && <p className="customer-form-error" role="alert">{error}</p>}
      <button className="customer-button customer-button-primary" disabled={!file || !authorized || Boolean(fileError) || upload.isPending}>{upload.isPending ? 'Validando y subiendo…' : 'Guardar imagen'}</button>
    </form> : <div className="customer-empty-inline">Solo una persona propietaria u operadora puede subir imágenes.</div>}
  </section>;
}

function ReportView({ report, summary, userId, organizationId, applicationId, canManage, isOwner, archived, activeReportTab, onReportTabChange, onCorrectionQueued }: {
  report: CustomerAssessmentReport;
  summary?: CustomerReportSummary;
  userId: string;
  organizationId: string;
  applicationId: string;
  canManage: boolean;
  isOwner: boolean;
  archived: boolean;
  activeReportTab: 'findings' | 'dependencies';
  onReportTabChange: (tab: 'findings' | 'dependencies') => void;
  onCorrectionQueued: (jobId: string) => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadingSbom, setDownloadingSbom] = useState(false);
  const [sbomError, setSbomError] = useState<string | null>(null);
  const entries = [...report.internal?.findings ?? [], ...report.external?.findings ?? []];
  const evidence = [...report.internal?.evidence ?? [], ...report.external?.evidence ?? []];
  const byId = new Map(entries.map(finding => [finding.id, finding]));
  const findingTitles = new Map(entries.map(finding => [finding.id, finding.title]));
  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  const originSections = (['internal', 'external'] as const).map(origin => ({ origin, analysis: report[origin] }));
  // Queue and validation timings live on the job; the report carries its own analysis timings.
  const reportJob = useQuery({ queryKey: ['customer-data', userId, 'job', organizationId, applicationId, report.jobId], queryFn: () => customerApi.job(organizationId, applicationId, report.jobId), retry: false, staleTime: Infinity });

  return <div className="customer-report-detail">
    <div className="customer-report-title"><div><h2>{report.applicationName}</h2><p>{reportInputLabel(report)} · {date(report.finishedAt)}</p></div><button className="customer-button" disabled={downloading} onClick={async () => {
      setDownloading(true); setDownloadError(null);
      try { await customerApi.recordReportDownload(organizationId, applicationId, report.id); downloadReport(report); }
      catch (error) { setDownloadError(readableError(error)); }
      finally { setDownloading(false); }
    }}>{downloading ? 'Registrando descarga…' : 'Descargar JSON'}</button></div>
    {downloadError && <p className="customer-form-error" role="alert">{downloadError}</p>}
    <div className="customer-report-subject">
      {report.subject.sourceSnapshotId && <div><span>Instantánea de código</span><strong>{summary?.subject.sourceDigest?.slice(0, 16) ?? report.subject.sourceDigest?.slice(0, 16)}…</strong></div>}
      {report.subject.containerImageDigest && <div><span>Digest de imagen {report.subject.containerImageReference ? 'pública' : 'subida'}</span><strong>{report.subject.containerImageDigest.slice(0, 24)}…</strong>{report.subject.containerImageReference && <small>{report.subject.containerImageReference}</small>}</div>}
      {report.subject.origin && <div><span>Origen HTTPS solicitado</span><strong>{report.subject.origin}</strong></div>}
      {report.subject.targetVersion !== null && <div><span>Versión del alcance</span><strong>{report.subject.targetVersion}</strong></div>}
    </div>
    <ReportProgress report={report} job={reportJob.data} />
    <div className="customer-report-callout"><strong>{count(entries.length, 'observación registrada', 'observaciones registradas')}</strong><p>La cobertura parcial o no solicitada no confirma seguridad. No se hicieron cambios en el proyecto.</p></div>
    <ComparisonSummary comparisons={report.comparison} internal={report.internal} external={report.external} />
    <ExternalHttpsEvidence analysis={report.external} />
    <InvestigationsTimeline key={`${organizationId}:${applicationId}:${report.id}`} organizationId={organizationId} applicationId={applicationId} reportId={report.id} canManage={canManage && !archived} />
    <div className="customer-report-tabs" role="tablist" aria-label="Contenido del informe" onKeyDown={event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        onReportTabChange(event.key === 'Home' || event.key === 'ArrowLeft' ? 'findings' : 'dependencies');
      }
    }}>
      <button type="button" className="customer-report-tab" id="report-findings-tab" role="tab" aria-controls="report-findings-panel" aria-selected={activeReportTab === 'findings'} tabIndex={activeReportTab === 'findings' ? 0 : -1} onClick={() => onReportTabChange('findings')}>Hallazgos</button>
      <button type="button" className="customer-report-tab" id="report-dependencies-tab" role="tab" aria-controls="report-dependencies-panel" aria-selected={activeReportTab === 'dependencies'} tabIndex={activeReportTab === 'dependencies' ? 0 : -1} onClick={() => onReportTabChange('dependencies')}>Dependencias y licencias</button>
    </div>
    {activeReportTab === 'dependencies' && <div id="report-dependencies-panel" className="customer-report-tabpanel" role="tabpanel" aria-labelledby="report-dependencies-tab" tabIndex={0}><DependencyInventoryPanel inventory={report.internal?.dependencyInventory} findings={report.internal?.findings ?? []} busy={downloadingSbom} error={sbomError} onDownload={async () => {
      setDownloadingSbom(true); setSbomError(null);
      try { const blob = await customerApi.downloadSbom(organizationId, applicationId, report.id); downloadBlob(blob, `gotchu-${report.id}.cdx.json`); }
      catch (error) { setSbomError(readableError(error)); }
      finally { setDownloadingSbom(false); }
    }} /></div>}
    {activeReportTab === 'findings' && <div id="report-findings-panel" className="customer-report-tabpanel" role="tabpanel" aria-labelledby="report-findings-tab" tabIndex={0}>
    <section className="customer-report-section"><div className="customer-section-heading"><div><h3>Observaciones y contraste</h3></div></div>
      {report.comparison.length === 0 ? <div className="customer-empty-inline">Este informe no registra observaciones. Consulta «Qué se evaluó» para ver la cobertura.</div> : <div className="customer-findings">{report.comparison.map(item => {
        const linked = [...item.internalFindingIds, ...item.externalFindingIds].map(id => byId.get(id)).filter((finding): finding is NonNullable<typeof finding> => finding !== undefined);
        return <details className="customer-finding" key={item.key}><summary><span><strong>{linked[0]?.title ?? 'Aspecto no verificable'}</strong><small>{linked[0]?.location ?? item.explanation}</small></span><span className="customer-finding-badges"><ComparisonPresence item={item} /><ComparisonVerification item={item} />{linked.map(finding => <span className="customer-finding-risk" key={finding.id}><span className={`customer-severity customer-severity-${finding.severity}`}>{severityLabels[finding.severity]}</span><span className="customer-status customer-status-muted">Confianza: {confidenceLabels[finding.confidence]}</span><span className="customer-status customer-status-muted">Explotabilidad: {exploitabilityLabel(finding.exploitability)}</span></span>)}</span></summary>
          <p>{item.explanation}</p>
          {linked.map(finding => <section className="customer-finding-body" key={finding.id}><div className="customer-tag-row"><span className="customer-status customer-status-muted">{sourceLabels[finding.origin]}</span><span className={`customer-severity customer-severity-${finding.severity}`}>{severityLabels[finding.severity]}</span><span className="customer-status customer-status-muted">Confianza: {confidenceLabels[finding.confidence]}</span><span className="customer-status customer-status-muted">Explotabilidad: {exploitabilityLabel(finding.exploitability)}</span></div><p>{finding.description}</p><InvestigationActionButton organizationId={organizationId} applicationId={applicationId} subject={{ kind: 'finding', subjectId: finding.id, reportId: report.id }} canManage={canManage && !archived && ['medium', 'high', 'critical'].includes(finding.severity)} />{finding.origin === 'internal' && report.subject.sourceSnapshotId && report.subject.sourceDigest && <AiCorrectionPanel organizationId={organizationId} applicationId={applicationId} reportId={report.id} findingId={finding.id} expectedSourceDigest={report.subject.sourceDigest} canManage={canManage && !archived} />}<h4>Impacto posible</h4><p>{finding.impact}</p><h4>Recomendación</h4><p>{finding.recommendation}</p>{finding.limitations.length > 0 && <><h4>Límites de esta observación</h4><ul>{finding.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></>}{finding.evidenceIds.map(id => {
            const itemEvidence = evidenceById.get(id);
            return itemEvidence ? <details className="customer-evidence" key={id}><summary>{itemEvidence.locator}</summary><p>{itemEvidence.tool.name} · v{itemEvidence.tool.version} · {date(itemEvidence.collectedAt)}</p><pre>{itemEvidence.excerpt}</pre><p className="customer-evidence-meta">SHA-256: {itemEvidence.checksum}</p><p className="customer-evidence-meta">Instantánea: {itemEvidence.snapshotRef}</p></details> : null;
          })}</section>)}
        </details>;
      })}</div>}
    </section>
    {report.subject.containerImageDigest ? <section className="customer-report-section"><div className="customer-section-heading"><div><h3>Cómo corregir las CVE de la imagen</h3></div></div><p>Actualiza los paquetes en el Dockerfile o manifiestos de construcción, crea una nueva imagen y vuelve a evaluarla.</p></section> : <ReportRecommendations
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
    <ApprovalPanel userId={userId} organizationId={organizationId} applicationId={applicationId} canManage={canManage && !archived} isOwner={isOwner} />
    </div>}
    <section className="customer-report-section customer-coverage"><div className="customer-section-heading"><div><h3>Qué se evaluó</h3></div></div>
      <div className="customer-analysis-grid">{originSections.map(({ origin, analysis }) => <article className="customer-analysis-card" key={origin}><div className="customer-card-heading"><h4>{report.subject.containerImageDigest && origin === 'internal' ? 'Imagen' : sourceLabels[origin]}</h4><span className="customer-status customer-status-muted">{analysis ? analysisLabels[analysis.status] : 'No solicitado'}</span></div>{analysis ? <><p>{analysis.tool.name} · v{analysis.tool.version}</p><ul>{groupCoverage(analysis.coverage).map(item => <li key={`${item.state}:${item.detail}`}><span><strong>{coverageCapabilitiesLabel(item.capabilities)}</strong><small>{item.detail}</small></span><span className="customer-status customer-status-muted">{coverageLabels[item.state]}</span></li>)}</ul>{analysis.limitations.length > 0 && <details className="customer-analysis-limits"><summary>Límites del perfil ({analysis.limitations.length})</summary><ul>{analysis.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></details>}</> : <p>Esta perspectiva no se solicitó para este informe.</p>}</article>)}</div>
    </section>
    {report.limitations.length > 0 && <section className="customer-report-section"><div className="customer-section-heading"><div><h3>Límites del informe</h3></div></div><ul className="customer-report-limitations">{report.limitations.map(limit => <li key={limit}>{limit}</li>)}</ul></section>}
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

function AssessmentForm({ organizationId, applicationId, sources, images, targets, canManage, archived, onQueued, onAddSource }: { organizationId: string; applicationId: string; sources: CustomerSourceSummary[]; images: CustomerContainerImageSummary[]; targets: CustomerTarget[]; canManage: boolean; archived: boolean; onQueued: (jobId: string) => void; onAddSource: () => void }) {
  const hasActiveTarget = targets.some(target => target.status === 'authorized' && target.expiresAt && Date.parse(target.expiresAt) > Date.now());
  const [mode, setMode] = useState<AssessmentMode>(sources.length === 0 && images.length === 0 && hasActiveTarget ? 'external' : 'internal');
  const [inputKind, setInputKind] = useState<'source_snapshot' | 'container_image'>(sources.length === 0 && images.length > 0 ? 'container_image' : 'source_snapshot');
  const [sourceSnapshotId, setSourceSnapshotId] = useState(sources[0]?.id ?? '');
  const [imageSource, setImageSource] = useState<'archive' | 'registry'>('archive');
  const [imageId, setImageId] = useState('');
  const [registryReference, setRegistryReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const availableTargets = targets.filter(target => target.status === 'authorized' && target.expiresAt && Date.parse(target.expiresAt) > Date.now());
  const [targetId, setTargetId] = useState(availableTargets[0]?.id ?? '');
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
  const hasTarget = availableTargets.some(target => target.id === targetId);
  const ready = (!needsSource || hasSource) && (!needsTarget || hasTarget) && (!usesImage || hasImage);
  const nothingToAssess = sources.length === 0 && images.length === 0 && !hasActiveTarget;

  if (nothingToAssess) return <section className="customer-card customer-assessment-card">
    <div className="customer-card-heading"><div><h2>Nueva evaluación</h2></div></div>
    <button className="customer-button customer-button-primary" onClick={onAddSource} disabled={!canManage || archived}>Añadir fuente</button>
  </section>;

  return <section className="customer-card customer-assessment-card">
    <div className="customer-card-heading"><div><h2>Nueva evaluación</h2></div></div>
    <form className="customer-form customer-assessment-form" onSubmit={event => { event.preventDefault(); setError(null); queue.mutate(); }}>
      <label htmlFor="assessment-mode">Perspectiva</label><select id="assessment-mode" value={mode} onChange={event => { const nextMode = event.target.value as AssessmentMode; setMode(nextMode); if (nextMode !== 'internal') setInputKind('source_snapshot'); setError(null); }} disabled={queue.isPending}><option value="internal">Código o imagen</option><option value="external">Dominio HTTPS</option><option value="both">Código + dominio HTTPS</option></select>
      {mode === 'internal' && images.length > 0 && <><label htmlFor="assessment-input-kind">Qué analizar</label><select id="assessment-input-kind" value={inputKind} onChange={event => setInputKind(event.target.value as 'source_snapshot' | 'container_image')} disabled={queue.isPending}><option value="source_snapshot">Código fuente</option><option value="container_image">Imagen de contenedor</option></select></>}
      {usesImage && <><label htmlFor="assessment-image-source">Origen de la imagen</label><select id="assessment-image-source" value={imageSource} onChange={event => setImageSource(event.target.value as 'archive' | 'registry')} disabled={queue.isPending}><option value="archive">Archivo Docker/OCI guardado</option><option value="registry">Referencia de registro público</option></select>{imageSource === 'archive' ? <><label htmlFor="assessment-image-archive">Archivo guardado</label><select id="assessment-image-archive" value={imageId} onChange={event => setImageId(event.target.value)} disabled={queue.isPending}><option value="">Selecciona una imagen subida</option>{images.map(image => <option key={image.id} value={image.id}>{image.label} · {image.digest.slice(0, 12)}…</option>)}</select></> : <><label htmlFor="assessment-image-reference">Referencia pública con digest</label><input id="assessment-image-reference" value={registryReference} onChange={event => setRegistryReference(event.target.value)} disabled={queue.isPending} maxLength={512} placeholder="docker.io/library/alpine@sha256:…" /><p className="customer-field-note">docker.io, ghcr.io, quay.io, public.ecr.aws o gcr.io, fijada con digest SHA-256.</p>{registryReference && !parsedRegistryReference.success && <p className="customer-form-error" role="alert">Usa un registro público admitido y una referencia completa fijada por digest.</p>}</>}</>}
      {needsSource && <><label htmlFor="assessment-source">Instantánea de código</label><select id="assessment-source" value={sourceSnapshotId} onChange={event => setSourceSnapshotId(event.target.value)} disabled={queue.isPending}><option value="">Selecciona una instantánea</option>{sources.map(source => <option key={source.id} value={source.id}>{source.revision} · {source.fileCount} archivos · {date(source.createdAt)}</option>)}</select></>}
      {needsTarget && <><label htmlFor="assessment-target">Origen HTTPS disponible</label><select id="assessment-target" value={targetId} onChange={event => setTargetId(event.target.value)} disabled={queue.isPending}><option value="">Selecciona un origen HTTPS</option>{availableTargets.map(target => <option key={target.id} value={target.id}>{target.origin} · {scanProfileLabels[target.scanProfile ?? 'root']}{(target.scanProfile ?? 'root') === 'public_surface' ? ' · máx. 10 GET' : ''} · vence {target.expiresAt ? date(target.expiresAt) : '—'}</option>)}</select></>}
      {!ready && <p className="customer-field-note">{needsTarget && !hasTarget ? (availableTargets.length ? 'Elige un origen HTTPS. ' : 'Añade o renueva un origen HTTPS desde Fuentes. ') : ''}{needsSource && !hasSource ? (sources.length ? 'Elige una instantánea. ' : 'Sube primero código. ') : ''}{usesImage && !hasImage ? imageSource === 'archive' ? 'Sube primero un archivo de imagen.' : 'Escribe una referencia pública fijada por digest.' : ''}</p>}
      {error && <p className="customer-form-error" role="alert">{error}</p>}
      <button className="customer-button customer-button-primary" disabled={!canManage || archived || !ready || queue.isPending}>{queue.isPending ? 'Guardando evaluación…' : 'Iniciar evaluación'}</button>
      {archived && <p className="customer-field-note">Reactiva este proyecto antes de iniciar otra evaluación.</p>}
    </form>
  </section>;
}

function CustomerWorkspace({ session, userId, acceptedInvitationId, invitationMessage, routePage, routeOrganizationId, routeApplicationId, routeReportId, routeReportTab, routeEntry = true }: { session: CustomerSession; userId: string; acceptedInvitationId: string | null; invitationMessage: string | null; routePage?: Page; routeOrganizationId?: string; routeApplicationId?: string; routeReportId?: string; routeReportTab?: 'dependencias'; routeEntry?: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Keep the form in the committed outlet; a pending destination can otherwise show it twice and lose input.
  const location = useRouterState({ select: state => state.resolvedLocation ?? state.location });
  const locationRoute = routePageFromPath(location.pathname);
  const page = routePage ?? locationRoute.page;
  const currentApplicationId = routeApplicationId ?? locationRoute.applicationId;
  const currentReportId = routeReportId ?? locationRoute.reportId;
  const currentReportTab = routeReportTab ?? (new URLSearchParams(location.searchStr).get('pestana') === 'dependencias' ? 'dependencias' : undefined);
  const activeJobKey = ['customer-data', userId, 'active-job'] as const;
  const [activeJob, setActiveJobState] = useState<ActiveJob | null>(() => {
    const cached = queryClient.getQueryData<ActiveJob | null>(activeJobKey);
    if (cached) return cached;
    if (typeof window === 'undefined') return null;
    try {
      const saved: unknown = JSON.parse(window.localStorage.getItem(`gotchu.active-job.${userId}`) ?? 'null');
      const parsed = z.object({ organizationId: z.uuid(), applicationId: z.uuid(), jobId: z.uuid(), purpose: z.enum(['assessment', 'correction']) }).strict().safeParse(saved);
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  });
  const [lastFinishedJob, setLastFinishedJob] = useState<(ActiveJob & { job: CustomerJob }) | null>(null);
  const setActiveJob = (value: typeof activeJob) => {
    if (value) setLastFinishedJob(null);
    setActiveJobState(value);
    queryClient.setQueryData(activeJobKey, value);
    if (typeof window !== 'undefined') {
      if (value) window.localStorage.setItem(`gotchu.active-job.${userId}`, JSON.stringify(value));
      else window.localStorage.removeItem(`gotchu.active-job.${userId}`);
    }
  };
  const setPage = (next: Page) => {
    if (!organizationId) return;
    if (next === 'members') void navigate({ to: '/w/$workspaceId/equipo', params: { workspaceId: organizationId } });
    else if (next === 'decision-records') void navigate({ to: '/w/$workspaceId/decisiones', params: { workspaceId: organizationId } });
    else if (next === 'license-policy') void navigate({ to: '/w/$workspaceId/licencias', params: { workspaceId: organizationId } });
    else if (next === 'retention-policy') void navigate({ to: '/w/$workspaceId/retencion', params: { workspaceId: organizationId } });
    else if (applicationId && next === 'overview') void navigate({ to: '/w/$workspaceId/p/$projectId', params: { workspaceId: organizationId, projectId: applicationId } });
    else if (applicationId && next === 'applications') void navigate({ to: '/w/$workspaceId/p/$projectId/fuentes', params: { workspaceId: organizationId, projectId: applicationId } });
    else if (applicationId && next === 'https-audit') void navigate({ to: '/w/$workspaceId/p/$projectId/https', params: { workspaceId: organizationId, projectId: applicationId } });
    else if (applicationId && next === 'operations') void navigate({ to: '/w/$workspaceId/p/$projectId/vigilancia', params: { workspaceId: organizationId, projectId: applicationId } });
    else if (applicationId && next === 'reports') void navigate({ to: '/w/$workspaceId/p/$projectId/informes', params: { workspaceId: organizationId, projectId: applicationId } });
  };
  const setReportTab = (tab: 'findings' | 'dependencies') => {
    if (!organizationId || !applicationId) return;
    const search = tab === 'dependencies' ? { pestana: 'dependencias' as const } : {};
    if (currentReportId) void navigate({ to: '/w/$workspaceId/p/$projectId/informes/$reportId', params: { workspaceId: organizationId, projectId: applicationId, reportId: currentReportId }, search });
    else void navigate({ to: '/w/$workspaceId/p/$projectId/informes', params: { workspaceId: organizationId, projectId: applicationId }, search });
  };
  const [notice, setNotice] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const pendingGithubNavigation = useRef<string | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [menuOpen]);
  useEffect(() => {
    if (!acceptedInvitationId) return;
    void navigate({ to: '/w/$workspaceId', params: { workspaceId: acceptedInvitationId } });
    queryClient.invalidateQueries({ queryKey: ['customer-data', userId, 'workspaces'] }).catch(caught => setPageError(readableError(caught)));
  }, [acceptedInvitationId, navigate, queryClient, userId]);

  const workspaces = useQuery({ queryKey: ['customer-data', userId, 'workspaces'], queryFn: customerApi.workspaces, retry: false });
  const rememberedWorkspaceId = location.pathname === '/dashboard' ? readLastProjectPath()?.match(/^\/w\/([0-9a-f-]+)\/p\//i)?.[1] : undefined;
  const rememberedWorkspace = rememberedWorkspaceId ? workspaces.data?.find(item => item.id === rememberedWorkspaceId) : undefined;
  const organizationId = routeOrganizationId ?? rememberedWorkspace?.id ?? workspaces.data?.[0]?.id ?? null;
  const workspace = workspaces.data?.find(item => item.id === organizationId) ?? null;
  const applications = useQuery({ queryKey: ['customer-data', userId, 'applications', organizationId], enabled: organizationId !== null, queryFn: () => {
    if (!organizationId) throw new Error('Selecciona un espacio de trabajo.');
    return customerApi.applications(organizationId);
  }, retry: false });
  const selectedApplication = applications.data?.find(item => item.applicationId === currentApplicationId)
    ?? applications.data?.find(item => !item.archived)
    ?? applications.data?.[0]
    ?? null;
  const applicationId = selectedApplication?.applicationId ?? null;
  useEffect(() => {
    if (!routeEntry) return;
    const pendingGithubScope = readSavedCustomerScope(sessionStorage, 'gotchu-pending-github-scope', userId);
    if (location.pathname !== '/dashboard') {
      if (pendingGithubScope && location.pathname === `/w/${pendingGithubScope.organizationId}/p/${pendingGithubScope.applicationId}/fuentes`) {
        sessionStorage.removeItem('gotchu-pending-github-scope');
        pendingGithubNavigation.current = null;
      }
      return;
    }
    const onboardingScope = readSavedCustomerScope(sessionStorage, 'gotchu-onboarding-scope', userId);
    if (onboardingScope) {
      void navigate({ to: '/primeros-pasos', search: { espacio: onboardingScope.organizationId, fuente: 'github' } });
      return;
    }
    if (pendingGithubScope) {
      const destination = `/w/${pendingGithubScope.organizationId}/p/${pendingGithubScope.applicationId}/fuentes`;
      if (pendingGithubNavigation.current !== destination) {
        pendingGithubNavigation.current = destination;
        // Keep the validated scope until navigation commits so github=connected cannot race to the default project.
        void navigate({ to: '/w/$workspaceId/p/$projectId/fuentes', params: { workspaceId: pendingGithubScope.organizationId, projectId: pendingGithubScope.applicationId } });
      }
      return;
    }
    pendingGithubNavigation.current = null;
    const params = new URLSearchParams(window.location.search);
    const legacyScope = customerScopeSchema.safeParse({ organizationId: params.get('organizationId'), applicationId: params.get('applicationId') });
    if (legacyScope.success) {
      void navigate({ to: '/w/$workspaceId/p/$projectId', params: { workspaceId: legacyScope.data.organizationId, projectId: legacyScope.data.applicationId } });
      return;
    }
    if (params.get('github') === 'connected' && organizationId && applicationId) {
      void navigate({ to: '/w/$workspaceId/p/$projectId/fuentes', params: { workspaceId: organizationId, projectId: applicationId } });
      return;
    }
    if (params.has('organizationId') && organizationId && applicationId) {
      void navigate({ to: '/w/$workspaceId/p/$projectId', params: { workspaceId: organizationId, projectId: applicationId } });
      return;
    }
    if (workspaces.isPending || workspaces.error) return;
    const requestedWorkspace = workspaces.data?.find(item => item.id === organizationId);
    if (!requestedWorkspace) {
      if (!workspaces.data?.length) {
        if (localStorage.getItem(`gotchu.onboarding-skipped.${userId}`) !== 'true') void navigate({ to: '/primeros-pasos' });
        return;
      }
    }
    if (!organizationId || applications.isPending || applications.error) return;
    if (!applications.data?.length) {
      if (localStorage.getItem(`gotchu.onboarding-skipped.${userId}`) !== 'true') void navigate({ to: '/primeros-pasos', search: { espacio: organizationId } });
      else void navigate({ to: '/w/$workspaceId', params: { workspaceId: organizationId } });
      return;
    }
    const requestedProject = applications.data.find(item => item.applicationId === currentApplicationId);
    if (!requestedProject) {
      const remembered = readLastProjectPath();
      const rememberedScope = remembered?.match(/^\/w\/([0-9a-f-]+)\/p\/([0-9a-f-]+)/i);
      const rememberedWorkspace = rememberedScope?.[1];
      const rememberedProject = rememberedScope?.[2];
      const lastApplication = rememberedWorkspace === organizationId ? applications.data.find(item => item.applicationId === rememberedProject) : undefined;
      const nextApplication = lastApplication ?? applications.data.find(item => !item.archived) ?? applications.data[0];
      if (!nextApplication) return;
      if (lastApplication && remembered) {
        if (remembered.includes('/https')) void navigate({ to: '/w/$workspaceId/p/$projectId/https', params: { workspaceId: organizationId, projectId: nextApplication.applicationId } });
        else if (remembered.includes('/fuentes')) void navigate({ to: '/w/$workspaceId/p/$projectId/fuentes', params: { workspaceId: organizationId, projectId: nextApplication.applicationId } });
        else if (remembered.includes('/vigilancia')) void navigate({ to: '/w/$workspaceId/p/$projectId/vigilancia', params: { workspaceId: organizationId, projectId: nextApplication.applicationId } });
        else if (remembered.includes('/informes/') && z.uuid().safeParse(remembered.split('/informes/')[1]?.split(/[?#]/)[0]).success) {
          const reportId = remembered.split('/informes/')[1]?.split(/[?#]/)[0];
          const search = remembered.includes('pestana=dependencias') ? { pestana: 'dependencias' as const } : {};
          if (reportId) void navigate({ to: '/w/$workspaceId/p/$projectId/informes/$reportId', params: { workspaceId: organizationId, projectId: nextApplication.applicationId, reportId }, search });
        } else if (remembered.includes('/informes')) {
          const search = remembered.includes('pestana=dependencias') ? { pestana: 'dependencias' as const } : {};
          void navigate({ to: '/w/$workspaceId/p/$projectId/informes', params: { workspaceId: organizationId, projectId: nextApplication.applicationId }, search });
        }
        else void navigate({ to: '/w/$workspaceId/p/$projectId', params: { workspaceId: organizationId, projectId: nextApplication.applicationId } });
        return;
      }
      void navigate({ to: '/w/$workspaceId/p/$projectId', params: { workspaceId: organizationId, projectId: nextApplication.applicationId } });
    }
  }, [applications.data, applications.error, applications.isPending, currentApplicationId, location.pathname, navigate, organizationId, routeEntry, routeOrganizationId, userId, workspaces.data, workspaces.error, workspaces.isPending]);
  useEffect(() => {
    if (!routeEntry || location.pathname === '/dashboard' || location.pathname === '/primeros-pasos' || location.pathname === '/entrar' || location.pathname === '/registro') return;
    try { localStorage.setItem('gotchu.last-project-path', `${location.pathname}${location.search}`); } catch { /* Remembering a route is optional. */ }
  }, [location.pathname, location.search, routeEntry]);
  const canManage = workspace !== null && (workspace.role === 'owner' || workspace.role === 'operator');
  const targets = useQuery({ queryKey: ['customer-data', userId, 'targets', organizationId, applicationId], enabled: organizationId !== null && applicationId !== null, queryFn: () => {
    if (!organizationId || !applicationId) throw new Error('Selecciona un proyecto.');
    return customerApi.targets(organizationId, applicationId);
  }, retry: false });
  const needsSourceData = page !== 'https-audit';
  const sources = useQuery({ queryKey: ['customer-data', userId, 'sources', organizationId, applicationId], enabled: needsSourceData && organizationId !== null && applicationId !== null, queryFn: () => {
    if (!organizationId || !applicationId) throw new Error('Selecciona un proyecto.');
    return customerApi.sources(organizationId, applicationId);
  }, retry: false });
  const images = useQuery({ queryKey: ['customer-data', userId, 'container-images', organizationId, applicationId], enabled: needsSourceData && organizationId !== null && applicationId !== null, queryFn: () => {
    if (!organizationId || !applicationId) throw new Error('Selecciona un proyecto.');
    return customerApi.containerImages(organizationId, applicationId);
  }, retry: false });
  const reports = useQuery({ queryKey: ['customer-data', userId, 'reports', organizationId, applicationId], enabled: organizationId !== null && applicationId !== null, queryFn: () => {
    if (!organizationId || !applicationId) throw new Error('Selecciona un proyecto.');
    return customerApi.reports(organizationId, applicationId);
  }, retry: false });
  const visibleReportId = currentReportId ?? reports.data?.[0]?.id ?? null;
  useEffect(() => {
    if (!routeEntry || !organizationId || applications.isPending || applications.error) return;
    const projects = applications.data ?? [];
    if (location.pathname === `/w/${organizationId}` && projects.length) {
      const remembered = window.localStorage.getItem('gotchu.last-project-path');
      const rememberedMatch = remembered?.match(/^\/w\/([0-9a-f-]+)\/p\/([0-9a-f-]+)/i);
      const lastProject = rememberedMatch?.[1] === organizationId
        ? projects.find(project => project.applicationId === rememberedMatch[2])
        : undefined;
      const nextProject = lastProject ?? projects.find(project => !project.archived) ?? projects[0];
      if (nextProject) void navigate({ to: '/w/$workspaceId/p/$projectId', params: { workspaceId: organizationId, projectId: nextProject.applicationId } });
      return;
    }
    if (currentApplicationId && !projects.some(project => project.applicationId === currentApplicationId)) {
      void navigate({ to: '/w/$workspaceId', params: { workspaceId: organizationId } });
      return;
    }
    if (currentReportId && !reports.data?.some(item => item.id === currentReportId) && !reports.isPending && applicationId) {
      void navigate({ to: '/w/$workspaceId/p/$projectId/informes', params: { workspaceId: organizationId, projectId: applicationId } });
    }
  }, [applicationId, applications.data, applications.error, applications.isPending, currentApplicationId, currentReportId, location.pathname, navigate, organizationId, reports.data, reports.isPending, routeEntry]);
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
  // Runs once the finished job has been shown: the phase graph reports it after its last transition.
  const settleJob = useCallback((jobResult: CustomerJob) => {
    if (!activeJob) return;
    const scope = activeJob;
    if (jobResult.state === 'succeeded') {
      setLastFinishedJob({ ...scope, job: jobResult });
      // Refresh the report list first: the report route returns to the list for ids it does not know yet.
      queryClient.refetchQueries({ queryKey: ['customer-data', userId, 'reports', scope.organizationId, scope.applicationId], type: 'all' })
        .catch(caught => setPageError(readableError(caught)))
        .finally(() => {
          setActiveJob(null);
          if (jobResult.reportId) {
            // Only the project overview opens the report; other pages keep the person where they are.
            if (page === 'overview' && organizationId === scope.organizationId && applicationId === scope.applicationId) void navigate({ to: '/w/$workspaceId/p/$projectId/informes/$reportId', params: { workspaceId: scope.organizationId, projectId: scope.applicationId, reportId: jobResult.reportId } });
            setNotice(scope.purpose === 'correction' ? 'El análisis interno independiente terminó y su informe ya está disponible.' : 'La evaluación terminó y su informe ya está disponible.');
          } else {
            setPageError(scope.purpose === 'correction'
              ? 'El análisis interno terminó, pero el nuevo informe todavía no está disponible. La instantánea privada se conserva; actualiza el historial para comprobarlo.'
              : 'La evaluación terminó, pero el informe todavía no está disponible. Actualiza el historial para comprobarlo.');
          }
        });
    } else if (jobResult.state === 'failed') {
      setLastFinishedJob({ ...scope, job: jobResult });
      setActiveJob(null);
      setPageError(jobFailureMessage(scope.purpose, jobResult));
    }
  }, [activeJob, applicationId, navigate, organizationId, page, queryClient, userId]);
  // The HTTPS audit page draws its own graph of the same job, so the shared one stays hidden there.
  const progressVisible = activeJob !== null && activeJob.organizationId === organizationId && page !== 'https-audit';
  useEffect(() => {
    if (!progressVisible && (jobResult?.state === 'succeeded' || jobResult?.state === 'failed')) settleJob(jobResult);
  }, [jobResult, progressVisible, settleJob]);
  // A visible failure stays on the graph, at the phase where it stopped, until it is dismissed.
  const settleVisibleJob = useCallback((jobResult: CustomerJob) => { if (jobResult.state === 'succeeded') settleJob(jobResult); }, [settleJob]);

  const operationError = pageError;
  const pageTitle = pages.find(item => item.id === page)?.label ?? 'Inicio';
  const applicationReports = reports.data ?? [];
  const selectedSummary = applicationReports.find(item => item.id === visibleReportId);
  const needsReportData = page === 'overview' || page === 'reports' || page === 'https-audit';
  const workspacePage = isWorkspacePage(page);
  if (workspaces.isPending) return <main className="gl customer-app-shell"><Loading label="Cargando tus espacios de trabajo…" /></main>;
  if (workspaces.error) return <main className="gl customer-app-shell"><ErrorNotice message={readableError(workspaces.error)} retry={() => { workspaces.refetch().catch(caught => setPageError(readableError(caught))); }} /></main>;

  const renderRouteSection = () => <>
    {invitationMessage && <div className="customer-success" role="status">{invitationMessage}</div>}
    {notice && <div className="customer-success" role="status"><span>{notice}</span><button className="customer-icon-button" aria-label="Descartar aviso" onClick={() => setNotice(null)}><XIcon aria-hidden="true" /></button></div>}
    {progressVisible && activeJob && <AssessmentProgress key={activeJob.jobId} purpose={activeJob.purpose} job={jobResult} failure={jobResult?.state === 'failed' ? jobFailureMessage(activeJob.purpose, jobResult) : null} error={job.error ? readableError(job.error) : null} retry={() => { job.refetch().catch(caught => setPageError(readableError(caught))); }} onSettled={settleVisibleJob} onDismiss={() => setActiveJob(null)} />}
    {operationError && <ErrorNotice message={operationError} retry={() => { setPageError(null); refreshApplicationData(); workspaces.refetch().catch(caught => setPageError(readableError(caught))); }} />}
    {workspacePage && organizationId && workspace ? <WorkspacePages page={page} userId={userId} organizationId={organizationId} role={workspace.role} canManage={canManage} />
    : organizationId && applications.isPending ? <Loading label="Cargando proyectos…" />
    : organizationId && applications.error ? <ErrorNotice message={readableError(applications.error)} retry={() => { applications.refetch().catch(caught => setPageError(readableError(caught))); }} />
    : !organizationId || !selectedApplication ? <FirstProjectEmptyState canManage={canManage || !organizationId} onCreateProject={() => { void navigate({ to: '/primeros-pasos', search: organizationId ? { espacio: organizationId } : {} }); }} onAnalyzeWeb={() => { void navigate({ to: '/primeros-pasos', search: organizationId ? { espacio: organizationId, fuente: 'web' } : { fuente: 'web' } }); }} />
    : <>
      <div className="customer-page-heading"><div><h1>{page === 'overview' ? selectedApplication.name : pageTitle}</h1></div>{selectedApplication.archived && <span className="customer-status customer-status-muted">Proyecto archivado</span>}</div>
      {targets.isPending || (needsSourceData && (sources.isPending || images.isPending)) || (needsReportData && reports.isPending) ? <Loading label="Cargando el alcance del proyecto…" /> : (targets.error || (needsSourceData && (sources.error || images.error)) || (needsReportData && reports.error)) ? <ErrorNotice message={readableError(targets.error ?? sources.error ?? images.error ?? reports.error)} retry={() => refreshApplicationData()} /> : <>
        {page === 'overview' && <ProjectOverview
          snapshotCount={sources.data?.length ?? 0}
          activeDomainCount={targets.data?.filter(target => target.status === 'authorized').length ?? 0}
          reportCount={applicationReports.length}
          onAddSource={() => setPage('applications')}
          onViewReports={() => setPage('reports')}
          assessmentForm={<AssessmentForm key={`${organizationId}:${selectedApplication.applicationId}`} organizationId={organizationId} applicationId={selectedApplication.applicationId} sources={sources.data ?? []} images={images.data ?? []} targets={targets.data ?? []} canManage={canManage} archived={selectedApplication.archived} onQueued={jobId => { setActiveJob({ organizationId, applicationId: selectedApplication.applicationId, jobId, purpose: 'assessment' }); setPageError(null); setNotice('La evaluación se guardó y se ejecutará en segundo plano.'); }} onAddSource={() => setPage('applications')} />}
          recentReports={applicationReports.length === 0 ? <div className="customer-empty-inline">Este proyecto aún no tiene informes.</div> : <ReportList reports={applicationReports.slice(0, 4)} selectedId={visibleReportId} organizationId={organizationId} applicationId={selectedApplication.applicationId} />}
        />}
        {page === 'applications' && <ProjectSources
          {...(workspace?.name ? { workspaceName: workspace.name } : {})}
          projects={applications.data ?? []}
          selectedProjectId={selectedApplication.applicationId}
          dateLabel={date}
          createControl={canManage && <ApplicationCreate organizationId={organizationId} disabled={false} onCreated={id => { applications.refetch().catch(caught => setPageError(readableError(caught))); void navigate({ to: '/w/$workspaceId/p/$projectId', params: { workspaceId: organizationId, projectId: id } }); }} />}
          onSelect={id => { void navigate({ to: '/w/$workspaceId/p/$projectId', params: { workspaceId: organizationId, projectId: id } }); }}
        >
          <div className="customer-asset-grid"><TargetEnrollment key={`${organizationId}:${selectedApplication.applicationId}`} organizationId={organizationId} applicationId={selectedApplication.applicationId} targets={targets.data ?? []} canManage={canManage && !selectedApplication.archived} onChanged={() => { setPageError(null); refreshApplicationData(); }} /><SourceEnrollment key={`${organizationId}:${selectedApplication.applicationId}`} organizationId={organizationId} applicationId={selectedApplication.applicationId} sources={sources.data ?? []} canManage={canManage && !selectedApplication.archived} onChanged={() => { setPageError(null); refreshApplicationData(); }} /><ContainerImageEnrollment key={`${organizationId}:${selectedApplication.applicationId}:images`} organizationId={organizationId} applicationId={selectedApplication.applicationId} images={images.data ?? []} canManage={canManage && !selectedApplication.archived} onChanged={() => { setPageError(null); refreshApplicationData(); }} /></div>
          <GitHubRepositoryPanel key={`${userId}:${organizationId}:${selectedApplication.applicationId}:github`} userId={userId} organizationId={organizationId} applicationId={selectedApplication.applicationId} canManage={canManage && !selectedApplication.archived} onScanQueued={jobId => { setActiveJob({ organizationId, applicationId: selectedApplication.applicationId, jobId, purpose: 'assessment' }); setPage('overview'); setNotice('La instantánea de GitHub está guardada y la primera evaluación se ejecuta en segundo plano.'); refreshApplicationData(); }} />
          <ContextPanel key={`${userId}:${organizationId}:${selectedApplication.applicationId}`} userId={userId} organizationId={organizationId} applicationId={selectedApplication.applicationId} canManage={canManage} isOwner={workspace?.role === 'owner'} archived={selectedApplication.archived} analyzedDigest={applicationReports[0]?.subject.sourceDigest ?? null} />
          <details><summary>Configuración avanzada de seguridad</summary><WorkflowExceptions userId={userId} organizationId={organizationId} applicationId={selectedApplication.applicationId} isOwner={workspace?.role === 'owner'} /></details>
          <ApplicationSettings key={`${organizationId}:${selectedApplication.applicationId}`} organizationId={organizationId} applicationId={selectedApplication.applicationId} name={selectedApplication.name} archived={selectedApplication.archived} canManage={canManage} onSaved={() => { refreshApplicationData(); setNotice('El proyecto se actualizó.'); }} />
        </ProjectSources>}
        {page === 'https-audit' && <ProjectHttpsAudit
          key={`${organizationId}:${selectedApplication.applicationId}:https`}
          organizationId={organizationId} applicationId={selectedApplication.applicationId} targets={targets.data ?? []} reports={applicationReports}
          canManage={canManage} archived={selectedApplication.archived}
          activeJob={activeJob?.organizationId === organizationId && activeJob.applicationId === selectedApplication.applicationId ? jobResult ?? null : null}
          lastJob={lastFinishedJob?.organizationId === organizationId && lastFinishedJob.applicationId === selectedApplication.applicationId ? lastFinishedJob.job : null}
          checkingJob={Boolean(activeJob?.organizationId === organizationId && activeJob.applicationId === selectedApplication.applicationId && job.isPending)}
          jobError={Boolean(activeJob?.organizationId === organizationId && activeJob.applicationId === selectedApplication.applicationId && job.error)}
          onRetryJob={() => { job.refetch().catch(caught => setPageError(readableError(caught))); }}
          onQueued={jobId => { setActiveJob({ organizationId, applicationId: selectedApplication.applicationId, jobId, purpose: 'assessment' }); setPageError(null); }}
          onChanged={refreshApplicationData}
          onViewReport={reportId => { void navigate({ to: '/w/$workspaceId/p/$projectId/informes/$reportId', params: { workspaceId: organizationId, projectId: selectedApplication.applicationId, reportId } }); }}
        />}
        {page === 'operations' && <ProjectVigilance userId={userId} organizationId={organizationId} projectId={selectedApplication.applicationId} sources={sources.data ?? []} targets={targets.data ?? []} canManage={canManage} archived={selectedApplication.archived} />}
        {page === 'reports' && <ProjectReports title="Detalle del informe" reportCount={count(applicationReports.length, 'informe', 'informes')} reportList={applicationReports.length === 0 ? <div className="customer-empty-inline">Este proyecto aún no tiene informes.</div> : <ReportList reports={applicationReports} selectedId={visibleReportId} organizationId={organizationId} applicationId={selectedApplication.applicationId} />} detail={report.isPending ? <Loading label="Cargando informe…" /> : report.error ? <ErrorNotice message={readableError(report.error)} retry={() => { report.refetch().catch(caught => setPageError(readableError(caught))); }} /> : report.data ? <ReportView key={`${userId}:${organizationId}:${selectedApplication.applicationId}:${report.data.id}`} report={report.data} {...(selectedSummary ? { summary: selectedSummary } : {})} userId={userId} organizationId={organizationId} applicationId={selectedApplication.applicationId} canManage={canManage} isOwner={workspace?.role === 'owner'} archived={selectedApplication.archived} activeReportTab={currentReportTab === 'dependencias' ? 'dependencies' : 'findings'} onReportTabChange={setReportTab} onCorrectionQueued={jobId => { setActiveJob({ organizationId, applicationId: selectedApplication.applicationId, jobId, purpose: 'correction' }); setPageError(null); }} /> : <div className="customer-empty-inline">Selecciona un informe para revisar sus observaciones y evidencias.</div>} />}
      </>}
    </>}
  </>;

  return <DashboardSectionContext.Provider value={renderRouteSection}><DashboardShell brand={<Brand />} menuOpen={menuOpen} onToggleMenu={() => setMenuOpen(value => !value)} onCloseMenu={() => setMenuOpen(false)} sidebar={
    <>
      <div className="customer-workspace-select"><label htmlFor="workspace-select">ESPACIO DE TRABAJO</label><ChoiceSelect id="workspace-select" value={organizationId ?? ''} options={[{ value: '', label: 'Selecciona un espacio', disabled: true }, ...(workspaces.data ?? []).map(item => ({ value: item.id, label: item.name }))]} onChange={value => { setNotice(null); void navigate({ to: '/w/$workspaceId', params: { workspaceId: value } }); }} />{workspace && <span>{workspace.role === 'owner' ? 'Propietario' : workspace.role === 'operator' ? 'Operador' : 'Sólo lectura'}</span>}{workspace && <WorkspaceSettings key={workspace.id} organizationId={workspace.id} name={workspace.name} canManage={canManage} onSaved={() => { workspaces.refetch().catch(caught => setPageError(readableError(caught))); setNotice('El espacio de trabajo se actualizó.'); }} />}</div>
      {workspace && <div className="customer-application-select"><label htmlFor="application-select">PROYECTO</label><ChoiceSelect id="application-select" value={applicationId ?? ''} options={[{ value: '', label: 'Selecciona un proyecto', disabled: true }, ...(applications.data ?? []).map(item => ({ value: item.applicationId, label: `${item.name}${item.archived ? ' · archivada' : ''}` }))]} onChange={value => { setNotice(null); void navigate({ to: '/w/$workspaceId/p/$projectId', params: { workspaceId: workspace.id, projectId: value } }); }} /></div>}
      <nav className="customer-nav" aria-label="Proyecto">{pages.slice(0, 5).map(item => <DashboardNavLink key={item.id} page={item.id} organizationId={organizationId} applicationId={applicationId} onNavigate={() => { setMenuOpen(false); setNotice(null); }} />)}</nav>
      <nav className="customer-nav" aria-label="Espacio de trabajo">{pages.slice(5).map(item => <DashboardNavLink key={item.id} page={item.id} organizationId={organizationId} applicationId={applicationId} onNavigate={() => { setMenuOpen(false); setNotice(null); }} />)}</nav>
      <div className="customer-sidebar-bottom">
        {Boolean(workspaces.data?.length) && <WorkspaceCreate disabled={false} onCreated={created => { queryClient.invalidateQueries({ queryKey: ['customer-data', userId, 'workspaces'] }).catch(caught => setPageError(readableError(caught))); setNotice(`Espacio «${created.name}» creado.`); void navigate({ to: '/w/$workspaceId', params: { workspaceId: created.id } }); }} />}
        <div className="customer-user-row"><span className="customer-user-avatar" aria-hidden="true">{(session.user?.displayName?.trim()[0] ?? 'U').toUpperCase()}</span><span title={session.user?.displayName}>{session.user?.displayName ?? 'Sesión activa'}</span><button className="customer-icon-button" aria-label="Cerrar sesión" title="Cerrar sesión" disabled={signOut.isPending} onClick={() => signOut.mutate()}><LogOutIcon aria-hidden="true" /></button></div>
        <ThemeSwitch />
      </div>
    </>
  }>
        <Outlet />
  </DashboardShell></DashboardSectionContext.Provider>;
}

function ReportList({ reports, selectedId, organizationId, applicationId }: { reports: CustomerReportSummary[]; selectedId: string | null; organizationId: string; applicationId: string }) {
  return <ul className="customer-report-list">{reports.map(report => <li key={report.id}><Link to="/w/$workspaceId/p/$projectId/informes/$reportId" params={{ workspaceId: organizationId, projectId: applicationId, reportId: report.id }} className={selectedId === report.id ? 'is-selected' : ''}><span className="customer-report-icon" aria-hidden="true" /><span className="customer-report-row-title"><strong>{report.subject.containerImageDigest ? 'Imagen de contenedor' : modeLabels[report.mode]}</strong><small>{date(report.finishedAt)} · {count(report.findingCount, 'observación', 'observaciones')}</small></span><ChevronRightIcon aria-hidden="true" /></Link></li>)}</ul>;
}

function jobFailureMessage(purpose: 'assessment' | 'correction', job: CustomerJob) {
  if (purpose === 'correction') return `El análisis independiente no finalizó${job.reasonCode ? ` (${job.reasonCode})` : ''}. La instantánea privada se preparó, pero no se validó.`;
  if (job.reasonCode === 'assessment_reconciliation_required') return 'No se pudo confirmar que el escáner haya terminado. Una persona operadora debe comprobarlo antes de revocar o renovar el origen. La autorización sigue activa y no se repetirá este trabajo automáticamente.';
  return job.reasonCode ? `La evaluación no finalizó (${job.reasonCode}). Los informes anteriores siguen disponibles.` : 'La evaluación no finalizó. Los informes anteriores siguen disponibles.';
}

export function CustomerDashboard({ routePage, routeOrganizationId, routeApplicationId, routeReportId, routeReportTab, authMode, routeEntry = true }: { routePage?: DashboardPage; routeOrganizationId?: string; routeApplicationId?: string; routeReportId?: string; routeReportTab?: 'dependencias'; authMode?: 'sign-in' | 'register'; routeEntry?: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const session = useQuery({ queryKey: ['customer-session'], queryFn: customerApi.session, retry: false, staleTime: 30_000 });
  useEffect(() => {
    if (authMode && session.data?.user) void navigate({ to: '/dashboard' });
    else if (!authMode && routeEntry && session.data && !session.data.user) void navigate({ to: '/entrar' });
  }, [authMode, navigate, routeEntry, session.data]);
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
  if (session.isPending) return <main className="gl customer-auth-page"><Loading label="Comprobando tu sesión…" /></main>;
  if (session.error) return <AuthShell>{invitationBanner}<ErrorNotice message={readableError(session.error)} retry={() => session.refetch()} /></AuthShell>;
  if (!session.data.user) return <>{invitationBanner}<AuthPanel session={session.data} initialRegistering={authMode === 'register'} onAuthenticated={value => { queryClient.setQueryData(['customer-session'], value); }} /></>;
  if (authMode) {
    return <main className="gl customer-auth-page"><Loading label="Abriendo tu espacio de trabajo…" /></main>;
  }
  return <><CustomerWorkspace key={session.data.user.id} session={session.data} userId={session.data.user.id} acceptedInvitationId={acceptedInvitation?.organizationId ?? null} invitationMessage={invitationMessage} {...(routePage ? { routePage } : {})} {...(routeOrganizationId ? { routeOrganizationId } : {})} {...(routeApplicationId ? { routeApplicationId } : {})} {...(routeReportId ? { routeReportId } : {})} {...(routeReportTab ? { routeReportTab } : {})} routeEntry={routeEntry} />{invitationBanner}</>;
}
