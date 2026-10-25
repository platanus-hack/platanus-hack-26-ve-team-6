import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderIcon, GlobeIcon, GitBranchIcon } from 'lucide-react';
import { CUSTOMER_MAX_SOURCE_BYTES, customerOriginSchema, customerSourceFileSchema, customerSourceSnapshotSchema, customerScanProfileSchema, type CustomerWorkspace } from '@gotchu/contracts';
import { customerApi, CustomerApiError } from './customer-client';
import { readSavedCustomerScope } from './customer-scope-storage';
import { FilePicker } from './file-picker';
import './onboarding.css';

type SourceFile = { file: File; path: string; valid: boolean };
type Scope = { organizationId: string; applicationId: string };
type Source = 'github' | 'carpeta' | 'web';
/** The one action in flight; every control is disabled while it runs, but only its own button changes label. */
type BusyAction = 'github' | 'folder' | 'domain' | 'verify' | 'queue-domain' | `repository:${number}`;
const onboardingStorageKey = 'gotchu-onboarding-scope';

async function readFiles(files: readonly SourceFile[]) {
  const contents = await Promise.all(files.filter(item => item.valid).map(async item => ({ path: item.path, content: new TextDecoder('utf-8', { fatal: true }).decode(await item.file.arrayBuffer()) })));
  return customerSourceSnapshotSchema.parse({ revision: 'upload', files: contents });
}

function suggestedName(displayName: string | undefined) {
  const value = displayName?.trim();
  if (!value) return undefined;
  const label = (value.includes('@') ? value.slice(0, value.indexOf('@')) : value).replace(/[._-]+/g, ' ').trim().slice(0, 120);
  return label ? label.replace(/(^|\s)\p{Ll}/gu, letter => letter.toUpperCase()) : undefined;
}

function message(caught: unknown, fallback: string) {
  if (caught instanceof CustomerApiError) return caught.message;
  // Schema errors carry English developer text; the fallback is the user-facing message.
  return caught instanceof Error && caught.name !== 'ZodError' ? caught.message : fallback;
}

/** Accepts a bare host such as "ejemplo.com" and returns the HTTPS origin, or null when it is not a valid public origin. */
function httpsOrigin(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  const parsed = customerOriginSchema.safeParse(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  return parsed.success ? parsed.data : null;
}

export function Onboarding({ userId, displayName, organizationId, initialSource = 'carpeta', canManage = true, onWorkspaceCreated, onDone, onSkip }: {
  userId: string; displayName?: string; organizationId?: string; initialSource?: 'github' | 'carpeta' | 'web'; canManage?: boolean;
  onWorkspaceCreated: (workspace: CustomerWorkspace) => void;
  onDone: (result: { organizationId: string; applicationId: string; jobId: string | null }) => void;
  onSkip: () => void;
}) {
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const name = suggestedName(displayName);
  const [scope, setScope] = useState<Scope | null>(null);
  const [createdOrganizationId, setCreatedOrganizationId] = useState<string | null>(null);
  const [step, setStep] = useState<'source' | 'dns'>('source');
  const [source, setSource] = useState<Source>(initialSource);
  const [projectName, setProjectName] = useState(name ? `Proyecto de ${name}` : 'Mi primer proyecto');
  const [projectNameEdited, setProjectNameEdited] = useState(false);
  const [autoNameApplication, setAutoNameApplication] = useState(false);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [domainVerified, setDomainVerified] = useState(false);
  const [domain, setDomain] = useState('');
  const [challenge, setChallenge] = useState<{ name: string; value: string } | null>(null);
  const [error, setError] = useState<{ source: Source; message: string } | null>(null);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [copied, setCopied] = useState(false);
  const [installationId, setInstallationId] = useState('');
  const locked = !canManage || busy !== null;

  useEffect(() => {
    let current = true;
    let hasSavedScope = false;
    let savedScope: Scope | null = null;
    let savedAutoNameApplication = false;
    const saved = readSavedCustomerScope(sessionStorage, onboardingStorageKey, userId);
    if (saved && (!organizationId || saved.organizationId === organizationId)) {
      hasSavedScope = true;
      savedScope = { organizationId: saved.organizationId, applicationId: saved.applicationId };
      savedAutoNameApplication = saved.autoNameApplication === true;
      setScope(savedScope);
      setAutoNameApplication(savedAutoNameApplication);
    }
    if (organizationId && !hasSavedScope) {
      void customerApi.applications(organizationId).then(apps => {
        if (!current) return;
        const application = apps.find(item => !item.archived);
        if (application) {
          setScope({ organizationId, applicationId: application.applicationId });
          setAutoNameApplication(false);
        }
      }).catch(() => undefined);
    }
    return () => { current = false; };
  }, [organizationId, userId]);
  useEffect(() => { if (step === 'dns') stepHeading.current?.focus(); }, [step]);

  const connections = useQuery({ queryKey: ['github-connections', userId, scope?.organizationId], enabled: Boolean(scope), queryFn: () => {
    if (!scope) throw new Error('Selecciona un espacio de trabajo.');
    return customerApi.githubConnections(scope.organizationId);
  }, refetchInterval: 300_000, retry: false });
  const repositories = useQuery({ queryKey: ['github-repositories', userId, scope?.organizationId, scope?.applicationId, installationId], enabled: Boolean(scope && installationId), queryFn: () => {
    if (!scope || !installationId) throw new Error('Selecciona una instalación de GitHub.');
    return customerApi.githubRepositories(scope.organizationId, scope.applicationId, installationId);
  }, retry: false });
  const installation = connections.data?.find(item => item.state === 'active');
  useEffect(() => { if (repositories.error) void connections.refetch(); }, [connections.refetch, repositories.error]);
  useEffect(() => { if (!installationId && installation) setInstallationId(installation.installationId); }, [installation, installationId]);

  async function ensureScope() {
    if (scope) {
      sessionStorage.setItem(onboardingStorageKey, JSON.stringify({ ...scope, userId, autoNameApplication }));
      return scope;
    }
    const nextOrganizationId = organizationId ?? createdOrganizationId;
    let workspace: CustomerWorkspace | null = null;
    if (!nextOrganizationId) {
      workspace = await customerApi.createWorkspace(name ? `Espacio de ${name}` : 'Mi espacio de trabajo');
      setCreatedOrganizationId(workspace.id);
      onWorkspaceCreated(workspace);
    }
    const resolvedOrganizationId = nextOrganizationId ?? workspace?.id;
    if (!resolvedOrganizationId) throw new Error('No se pudo identificar el espacio de trabajo.');
    const existingApplication = organizationId
      ? (await customerApi.applications(resolvedOrganizationId)).find(item => !item.archived)
      : undefined;
    const application = existingApplication ?? await customerApi.createApplication(resolvedOrganizationId, projectName);
    const next = { organizationId: resolvedOrganizationId, applicationId: application.applicationId };
    const autoName = !existingApplication && !projectNameEdited;
    setScope(next);
    setAutoNameApplication(autoName);
    sessionStorage.setItem(onboardingStorageKey, JSON.stringify({ ...next, userId, autoNameApplication: autoName }));
    return next;
  }

  /** Runs one action with a single busy marker and reports its failure next to the source that started it. */
  async function run(action: BusyAction, source: Source, fallback: string, work: () => Promise<'leaving' | void>) {
    if (!canManage) return;
    setBusy(action); setError(null);
    let leaving = false;
    try { leaving = await work() === 'leaving'; }
    catch (caught) { setError({ source, message: message(caught, fallback) }); }
    // A page leaving for GitHub keeps its button busy until the browser navigates.
    finally { if (!leaving) setBusy(null); }
  }

  const connectGitHub = () => run('github', 'github', 'No se pudo conectar GitHub.', async () => {
    const currentScope = await ensureScope();
    window.location.assign(await customerApi.githubConnect(currentScope.organizationId));
    return 'leaving';
  });
  const disconnectGitHub = () => run('github', 'github', 'No se pudo desconectar GitHub.', async () => {
    if (!scope || !installation) return;
    await customerApi.githubDisconnect(scope.organizationId, installation.installationId);
    setInstallationId('');
    await connections.refetch();
  });
  const uploadAndQueue = () => run('folder', 'carpeta', 'No se pudo analizar la carpeta.', async () => {
    const currentScope = await ensureScope();
    const snapshot = await readFiles(files);
    const source = await customerApi.uploadSource({ ...currentScope, snapshot, authorized: true });
    const result = await customerApi.queue({ ...currentScope, mode: 'internal', sourceSnapshotId: source.id, targetId: null });
    sessionStorage.removeItem(onboardingStorageKey);
    onDone({ ...currentScope, jobId: result.jobId });
  });
  const enrollDomain = () => run('domain', 'web', 'No se pudo preparar la verificación del dominio.', async () => {
    const origin = httpsOrigin(domain);
    if (!origin) throw new Error('Escribe un dominio HTTPS público, sin ruta ni puerto. Por ejemplo: https://ejemplo.com');
    setDomain(origin);
    const currentScope = await ensureScope();
    const enrollment = await customerApi.enrollTarget({ ...currentScope, origin, authorized: true, scanProfile: customerScanProfileSchema.parse('public_surface') });
    setChallenge({ name: enrollment.challenge.name, value: enrollment.challenge.value });
    setTargetId(enrollment.target.id);
    setDomainVerified(false);
    setStep('dns');
  });
  const verifyDomain = () => run('verify', 'web', 'Todavía no encontramos el registro DNS. Espera a que se propague e inténtalo de nuevo.', async () => {
    if (!scope || !targetId) return;
    await customerApi.verifyTarget(scope.organizationId, scope.applicationId, targetId);
    setDomainVerified(true);
  });
  const queueDomainAssessment = () => run('queue-domain', 'web', 'No se pudo iniciar el análisis de la web.', async () => {
    if (!scope || !targetId || !domainVerified) return;
    const result = await customerApi.queue({ ...scope, mode: 'external', sourceSnapshotId: null, targetId });
    sessionStorage.removeItem(onboardingStorageKey);
    onDone({ ...scope, jobId: result.jobId });
  });
  const selectRepository = (repository: NonNullable<typeof repositories.data>[number]) => run(`repository:${repository.id}`, 'github', 'No se pudo analizar el repositorio.', async () => {
    if (!scope || !installation || repository.archived) return;
    if (autoNameApplication) await customerApi.updateApplication({ ...scope, name: repository.fullName });
    const result = await customerApi.githubSelectRepository({ ...scope, installationId: installation.installationId, repositoryId: repository.id, fullName: repository.fullName, defaultBranch: repository.defaultBranch });
    sessionStorage.removeItem(onboardingStorageKey);
    onDone({ ...scope, jobId: result.jobId });
  });

  const selectedFiles = files.filter(item => item.valid);
  const bytes = selectedFiles.reduce((total, item) => total + item.file.size, 0);
  const fileError = files.length > 0 && (!selectedFiles.length || bytes > CUSTOMER_MAX_SOURCE_BYTES || !customerSourceFileSchema.safeParse({ path: selectedFiles[0]?.path, content: '' }).success);
  const sourceError = (source: Source) => error?.source === source ? error.message : null;
  const activeRepositories = repositories.data?.filter(repo => !repo.archived) ?? [];

  const githubBody = !scope || !installation
    ? <>{connections.data?.some(item => item.state === 'revoked') && <p role="status">La conexión anterior perdió acceso. Vuelve a conectar GitHub.</p>}
      {scope && connections.isPending ? <p role="status">Comprobando conexión…</p>
        : scope && connections.error ? <p role="alert">{connections.error.message} <button className="customer-link-button" onClick={() => connections.refetch().catch(() => undefined)}>Reintentar</button></p>
        : <button className="customer-button customer-button-primary" onClick={() => void connectGitHub()} disabled={locked}>{busy === 'github' ? 'Abriendo GitHub…' : 'Conectar GitHub'}</button>}</>
    : <><p>Conectado a <strong>{installation.accountLogin}</strong></p>
      {repositories.error && <p role="alert">{repositories.error.message} <button className="customer-link-button" onClick={() => repositories.refetch().catch(() => undefined)}>Reintentar</button></p>}
      {repositories.isPending ? <p role="status">Cargando repositorios…</p>
        : activeRepositories.length ? <ul className="customer-onboarding-repositories">{activeRepositories.map(repo => <li key={repo.id}><span><strong>{repo.fullName}</strong><small>Rama {repo.defaultBranch}</small></span><button className="customer-button customer-button-primary customer-button-small" aria-label={`Analizar ${repo.fullName}`} onClick={() => void selectRepository(repo)} disabled={locked}>{busy === `repository:${repo.id}` ? 'Preparando…' : 'Analizar'}</button></li>)}</ul>
        : !repositories.error && <p role="status">No hay repositorios disponibles. Concede acceso desde GitHub y vuelve a intentarlo.</p>}
      {canManage && <button className="customer-link-button customer-danger-link" onClick={() => void disconnectGitHub()} disabled={locked}>Desconectar GitHub</button>}</>;

  return <section className="customer-onboarding" aria-labelledby="onboarding-title">
    <div className="customer-onboarding-header"><h1 id="onboarding-title">Tu primera revisión</h1></div>
    {!canManage && <p className="customer-inline-error" role="status">Solo una persona propietaria u operadora puede añadir fuentes y lanzar revisiones.</p>}
    {step === 'source' ? <form className="customer-onboarding-card" onSubmit={event => { event.preventDefault(); if (source === 'web') void enrollDomain(); }}>
      <label className="customer-project-name"><span>Nombre del proyecto</span><input id="onboarding-project" value={projectName} onChange={event => { setProjectName(event.target.value); setProjectNameEdited(true); }} required maxLength={200} disabled={locked} /></label>
      <fieldset className="customer-source-choice" disabled={locked}>
        <legend>¿Desde dónde quieres revisarlo?</legend>
        <div className="customer-source-cards" role="radiogroup" aria-label="Fuente del proyecto">
          {([
            { id: 'github', title: 'GitHub', icon: <GitBranchIcon aria-hidden="true" /> },
            { id: 'carpeta', title: 'Carpeta', icon: <FolderIcon aria-hidden="true" /> },
            { id: 'web', title: 'Web por URL', icon: <GlobeIcon aria-hidden="true" /> },
          ] as const).map(option => <label className="customer-source-card" data-selected={source === option.id} key={option.id}>
            <input type="radio" name="onboarding-source" value={option.id} checked={source === option.id} onChange={() => { setSource(option.id); setError(null); }} />
            <span className="customer-source-option-icon">{option.icon}</span><span>{option.title}</span>
          </label>)}
        </div>
      </fieldset>
      <div className="customer-source-panel" aria-live="polite">
        {source === 'github' && <div className="customer-source-option-body">{githubBody}{sourceError('github') && <p className="customer-form-error" role="alert">{sourceError('github')}</p>}</div>}
        {source === 'carpeta' && <div className="customer-source-option-body">
          <FilePicker id="onboarding-folder" directory buttonLabel="Elegir carpeta" disabled={locked} summary={files.length === 0 ? 'Ninguna carpeta elegida' : `${selectedFiles.length} archivos compatibles · ${Math.ceil(bytes / 1024)} KiB`} onFiles={selected => setFiles(selected.map(file => { const path = file.webkitRelativePath.split('/').slice(1).join('/'); return { file, path, valid: customerSourceFileSchema.safeParse({ path, content: '' }).success }; }))} />
          {fileError && <p className="customer-form-error" role="alert">La carpeta no tiene archivos compatibles o supera el límite de tamaño.</p>}
          {sourceError('carpeta') && <p className="customer-form-error" role="alert">{sourceError('carpeta')}</p>}
          <button className="customer-button customer-button-primary" type="button" onClick={() => void uploadAndQueue()} disabled={locked || !selectedFiles.length || fileError}>{busy === 'folder' ? 'Subiendo…' : 'Analizar carpeta'}</button>
        </div>}
        {source === 'web' && <div className="customer-source-option-body">
          <label className="customer-web-url" htmlFor="onboarding-domain"><span>URL de la web</span><input id="onboarding-domain" type="text" inputMode="url" autoComplete="url" spellCheck={false} value={domain} onChange={event => setDomain(event.target.value)} placeholder="ejemplo.com" required disabled={locked} /></label>
          <p>Primero confirmarás que controlas el dominio con un registro DNS.</p>
          {sourceError('web') && <p className="customer-form-error" role="alert">{sourceError('web')}</p>}
          <button className="customer-button customer-button-primary" disabled={locked || !domain.trim()}>{busy === 'domain' ? 'Preparando registro TXT…' : 'Continuar'}</button>
        </div>}
      </div>
      <button className="customer-link-button customer-onboarding-skip" type="button" onClick={onSkip} disabled={busy !== null}>Saltar por ahora</button>
    </form>
    : <div className="customer-onboarding-card customer-onboarding-dns">
      <h2 ref={stepHeading} tabIndex={-1}>Confirma que controlas el dominio</h2>
      <p>Añade este registro TXT al DNS de {domain} para autorizar la revisión.</p>
      {challenge && <div className="customer-challenge"><dl><div><dt>Nombre</dt><dd>{challenge.name}</dd></div><div><dt>Valor</dt><dd><code>{challenge.value}</code></dd></div></dl>
        <button className="customer-link-button" onClick={() => navigator.clipboard.writeText(`${challenge.name}\t${challenge.value}`).then(() => setCopied(true), () => setError({ source: 'web', message: 'No se pudo copiar. Selecciona el registro para copiarlo.' }))}>{copied ? 'Copiado' : 'Copiar registro'}</button></div>}
      {sourceError('web') && <p className="customer-form-error" role="alert">{sourceError('web')}</p>}
      <div className="customer-onboarding-actions">
        {domainVerified
          ? <button className="customer-button customer-button-primary" onClick={() => void queueDomainAssessment()} disabled={locked}>{busy === 'queue-domain' ? 'Iniciando…' : 'Analizar web'}</button>
          : <button className="customer-button customer-button-primary" onClick={() => void verifyDomain()} disabled={locked}>{busy === 'verify' ? 'Comprobando DNS…' : 'Comprobar DNS'}</button>}
        <button className="customer-link-button" onClick={() => { setStep('source'); setError(null); }} disabled={busy !== null}>Usar otra fuente</button>
        {!domainVerified && <button className="customer-link-button" onClick={() => { if (!scope) return; sessionStorage.removeItem(onboardingStorageKey); onDone({ ...scope, jobId: null }); }} disabled={busy !== null}>Lo verificaré después</button>}
      </div>
    </div>}
  </section>;
}

export function GitHubRepositoryPanel({ userId, organizationId, applicationId, canManage, onScanQueued }: {
  userId: string; organizationId: string; applicationId: string; canManage: boolean; onScanQueued: (jobId: string) => void;
}) {
  const [installationId, setInstallationId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connections = useQuery({ queryKey: ['github-connections', userId, organizationId], queryFn: () => customerApi.githubConnections(organizationId), refetchInterval: 300_000, retry: false });
  const activeInstallation = connections.data?.find(connection => connection.state === 'active');
  useEffect(() => { if (!installationId && activeInstallation) setInstallationId(activeInstallation.installationId); }, [activeInstallation, installationId]);
  const repositories = useQuery({ queryKey: ['github-repositories', userId, organizationId, applicationId, installationId], enabled: Boolean(installationId), queryFn: () => customerApi.githubRepositories(organizationId, applicationId, installationId), retry: false });
  useEffect(() => { if (repositories.error) void connections.refetch(); }, [connections.refetch, repositories.error]);
  async function connect() {
    if (!canManage) return;
    setBusy(true); setError(null);
    try {
      sessionStorage.setItem('gotchu-pending-github-scope', JSON.stringify({ organizationId, applicationId, userId }));
      window.location.assign(await customerApi.githubConnect(organizationId));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo conectar GitHub.'); setBusy(false); }
  }
  async function disconnect() {
    if (!canManage || !activeInstallation) return;
    setBusy(true); setError(null);
    try { await customerApi.githubDisconnect(organizationId, activeInstallation.installationId); setInstallationId(''); await connections.refetch(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo desconectar GitHub.'); }
    finally { setBusy(false); }
  }
  async function selectRepository(repository: NonNullable<typeof repositories.data>[number]) {
    if (!canManage || !activeInstallation || repository.archived) return;
    setBusy(true); setError(null);
    try {
      const result = await customerApi.githubSelectRepository({ organizationId, applicationId, installationId: activeInstallation.installationId, repositoryId: repository.id, fullName: repository.fullName, defaultBranch: repository.defaultBranch });
      onScanQueued(result.jobId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo iniciar la evaluación del repositorio.'); }
    finally { setBusy(false); }
  }
  return <section className="customer-card customer-panel customer-github-panel" aria-labelledby="github-panel-title"><div className="customer-card-heading"><div><h2 id="github-panel-title">GitHub</h2></div>{activeInstallation && <span className="customer-status customer-status-ready">GitHub conectado</span>}</div>
    {connections.isPending ? <p role="status">Comprobando conexión…</p> : connections.error ? <p role="alert">{connections.error.message} <button className="customer-link-button" onClick={() => connections.refetch().catch(() => undefined)}>Reintentar</button></p> : !activeInstallation ? <><p>Conecta una GitHub App con permisos de lectura para iniciar evaluaciones desde una rama.</p>{connections.data?.some(item => item.state === 'revoked') && <p role="status">La conexión anterior fue revocada o perdió acceso. Sus enlaces de repositorio también están revocados.</p>}<button className="customer-button customer-button-primary" onClick={() => void connect()} disabled={!canManage || busy}>{busy ? 'Abriendo GitHub…' : 'Conectar GitHub'}</button>{!canManage && <p>Un Owner u Operator puede administrar conexiones y repositorios.</p>}</> : <><p><strong>{activeInstallation.accountLogin}</strong> · acceso de lectura · sin permisos de escritura.</p>{repositories.error && <p role="alert">{repositories.error.message} <button className="customer-link-button" onClick={() => repositories.refetch().catch(() => undefined)}>Reintentar</button></p>}{repositories.isPending ? <p role="status">Cargando repositorios…</p> : repositories.data?.filter(repo => !repo.archived).length ? <ul className="customer-onboarding-repositories">{repositories.data.filter(repo => !repo.archived).map(repo => <li key={repo.id}><span><strong>{repo.fullName}</strong><small>Rama {repo.defaultBranch}</small></span><button className="customer-button customer-button-primary" aria-label={`Analizar ${repo.fullName}`} onClick={() => void selectRepository(repo)} disabled={!canManage || busy}>Analizar</button></li>)}</ul> : !repositories.error && <p role="status">La instalación no tiene repositorios disponibles.</p>}<button className="customer-link-button customer-danger-link" onClick={() => void disconnect()} disabled={!canManage || busy}>Desconectar y revocar sus repositorios</button></>}
    {error && <p className="customer-form-error" role="alert">{error}</p>}
  </section>;
}
