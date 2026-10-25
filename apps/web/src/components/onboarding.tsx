import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CUSTOMER_MAX_SOURCE_BYTES, customerOriginSchema, customerSourceFileSchema, customerSourceSnapshotSchema, customerScanProfileSchema, type CustomerWorkspace } from '@gotchu/contracts';
import { customerApi, CustomerApiError } from './customer-client';
import { readSavedCustomerScope } from './customer-scope-storage';

type SourceFile = { file: File; path: string; valid: boolean };
type Scope = { organizationId: string; applicationId: string };
const onboardingStorageKey = 'gotchu-onboarding-scope';

async function readFiles(files: readonly SourceFile[]) {
  const contents = await Promise.all(files.filter(item => item.valid).map(async item => ({ path: item.path, content: new TextDecoder('utf-8', { fatal: true }).decode(await item.file.arrayBuffer()) })));
  return customerSourceSnapshotSchema.parse({ revision: 'upload', files: contents });
}

function suggestedName(displayName: string | undefined) {
  const value = displayName?.trim();
  if (!value) return undefined;
  const label = (value.includes('@') ? value.slice(0, value.indexOf('@')) : value).replace(/[._-]+/g, ' ').trim().slice(0, 120);
  return label || undefined;
}

export function Onboarding({ userId, displayName, initialOrganizationId, initialApplicationId, canManage = true, onWorkspaceCreated, onScanQueued }: {
  userId: string; displayName?: string; initialOrganizationId?: string; initialApplicationId?: string; onWorkspaceCreated: (workspace: CustomerWorkspace) => void;
  onScanQueued: (scope: Scope, jobId: string) => void; canManage?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const name = suggestedName(displayName);
  const [scope, setScope] = useState<Scope | null>(null);
  const [createdOrganizationId, setCreatedOrganizationId] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2>(1);
  const [workspaceName, setWorkspaceName] = useState(name ? `Espacio de ${name}` : 'Mi espacio de trabajo');
  const [applicationName, setApplicationName] = useState(name ? `Aplicación de ${name}` : 'Mi primera aplicación');
  const [applicationNameEdited, setApplicationNameEdited] = useState(false);
  const [autoNameApplication, setAutoNameApplication] = useState(false);
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [domain, setDomain] = useState('');
  const [domainScanProfile, setDomainScanProfile] = useState<'root' | 'public_surface'>('public_surface');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installationId, setInstallationId] = useState('');
  const needsWorkspace = !initialOrganizationId && !createdOrganizationId;

  useEffect(() => {
    let current = true;
    let hasSavedScope = false;
    let savedScope: Scope | null = null;
    let savedAutoNameApplication = false;
    const saved = readSavedCustomerScope(sessionStorage, onboardingStorageKey, userId);
    if (saved && (!initialOrganizationId || saved.organizationId === initialOrganizationId)) {
      hasSavedScope = true;
      savedScope = { organizationId: saved.organizationId, applicationId: saved.applicationId };
      savedAutoNameApplication = saved.autoNameApplication === true;
      setScope(savedScope);
      setAutoNameApplication(savedAutoNameApplication);
      setStep(2);
    }
    if (initialOrganizationId && initialApplicationId) {
      setScope({ organizationId: initialOrganizationId, applicationId: initialApplicationId });
      setAutoNameApplication(savedScope !== null && savedScope.organizationId === initialOrganizationId && savedScope.applicationId === initialApplicationId && savedAutoNameApplication);
      setStep(2);
    } else if (initialOrganizationId && !hasSavedScope) {
      void customerApi.applications(initialOrganizationId).then(apps => {
        if (!current) return;
        const application = apps.find(item => !item.archived);
        if (application) {
          setScope({ organizationId: initialOrganizationId, applicationId: application.applicationId });
          setAutoNameApplication(false);
          setStep(2);
        }
      }).catch(() => undefined);
    }
    return () => { current = false; };
  }, [initialApplicationId, initialOrganizationId, userId]);
  useEffect(() => { fileInput.current?.setAttribute('webkitdirectory', ''); }, [step]);
  useEffect(() => { stepHeading.current?.focus(); }, [step]);

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
    const organizationId = initialOrganizationId ?? createdOrganizationId;
    let workspace: CustomerWorkspace | null = null;
    if (!organizationId) {
      workspace = await customerApi.createWorkspace(workspaceName);
      setCreatedOrganizationId(workspace.id);
      onWorkspaceCreated(workspace);
    }
    const nextOrganizationId = organizationId ?? workspace?.id;
    if (!nextOrganizationId) throw new Error('No se pudo identificar el espacio de trabajo.');
    const existingApplication = initialOrganizationId
      ? (await customerApi.applications(nextOrganizationId)).find(item => !item.archived)
      : undefined;
    const application = existingApplication ?? await customerApi.createApplication(nextOrganizationId, applicationName);
    const next = { organizationId: nextOrganizationId, applicationId: application.applicationId };
    const autoName = !existingApplication && !applicationNameEdited;
    setScope(next);
    setAutoNameApplication(autoName);
    sessionStorage.setItem(onboardingStorageKey, JSON.stringify({ ...next, userId, autoNameApplication: autoName }));
    return next;
  }

  async function connectGitHub() {
    if (!canManage) return;
    setBusy(true); setError(null);
    try {
      const currentScope = await ensureScope();
      window.location.assign(await customerApi.githubConnect(currentScope.organizationId));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo conectar GitHub.'); setBusy(false); }
  }
  async function disconnectGitHub() {
    if (!scope || !installation || !canManage) return;
    setBusy(true); setError(null);
    try { await customerApi.githubDisconnect(scope.organizationId, installation.installationId); setInstallationId(''); await connections.refetch(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo desconectar GitHub.'); }
    finally { setBusy(false); }
  }
  async function uploadAndQueue() {
    if (!canManage) return;
    setBusy(true); setError(null);
    try {
      const currentScope = await ensureScope();
      const snapshot = await readFiles(files);
      const source = await customerApi.uploadSource({ ...currentScope, snapshot, authorized: true });
      const result = await customerApi.queue({ ...currentScope, mode: 'internal', sourceSnapshotId: source.id, targetId: null });
      sessionStorage.removeItem(onboardingStorageKey);
      onScanQueued(currentScope, result.jobId);
    } catch (caught) { setError(caught instanceof CustomerApiError ? caught.message : caught instanceof Error ? caught.message : 'No se pudo iniciar la evaluación de la carpeta.'); }
    finally { setBusy(false); }
  }
  async function enrollDomain() {
    if (!canManage) return;
    setBusy(true); setError(null);
    try {
      const currentScope = await ensureScope();
      const enrollment = await customerApi.enrollTarget({ ...currentScope, origin: domain, scanProfile: customerScanProfileSchema.parse(domainScanProfile) });
      const result = await customerApi.queue({ ...currentScope, mode: 'external', sourceSnapshotId: null, targetId: enrollment.target.id });
      sessionStorage.removeItem(onboardingStorageKey);
      onScanQueued(currentScope, result.jobId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo iniciar la evaluación HTTPS.'); }
    finally { setBusy(false); }
  }
  async function selectRepository(repository: NonNullable<typeof repositories.data>[number]) {
    if (!scope || !installation || !canManage || repository.archived) return;
    setBusy(true); setError(null);
    try {
      if (autoNameApplication) await customerApi.updateApplication({ ...scope, name: repository.fullName });
      const result = await customerApi.githubSelectRepository({ ...scope, installationId: installation.installationId, repositoryId: repository.id, fullName: repository.fullName, defaultBranch: repository.defaultBranch });
      sessionStorage.removeItem(onboardingStorageKey);
      onScanQueued(scope, result.jobId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo iniciar la primera evaluación.'); }
    finally { setBusy(false); }
  }

  const selectedFiles = files.filter(item => item.valid);
  const bytes = selectedFiles.reduce((total, item) => total + item.file.size, 0);
  const fileError = files.length > 0 && (!selectedFiles.length || bytes > CUSTOMER_MAX_SOURCE_BYTES || !customerSourceFileSchema.safeParse({ path: selectedFiles[0]?.path, content: '' }).success);
  const domainIsValid = customerOriginSchema.safeParse(domain.trim()).success;
  const githubSource = <div className="customer-onboarding-source-body">
    {!scope ? <><p>Concede acceso de lectura a los repositorios que autorices. Gotchu no ejecuta el proyecto ni escribe en GitHub.</p><button className="customer-button customer-button-primary" onClick={() => void connectGitHub()} disabled={busy || !canManage}>{busy ? 'Preparando y abriendo GitHub…' : 'Conectar GitHub'}</button></>
      : connections.isPending ? <p role="status">Comprobando conexiones…</p>
      : connections.error ? <p role="alert">{connections.error.message} <button className="customer-link-button" onClick={() => connections.refetch().catch(() => undefined)}>Reintentar</button></p>
      : !installation ? <>{connections.data?.some(item => item.state === 'revoked') && <p role="status">La conexión anterior fue revocada o perdió acceso. Puedes volver a conectar una instalación.</p>}<p>Concede acceso a la instalación y elige cada repositorio que quieras evaluar.</p><button className="customer-button customer-button-primary" onClick={() => void connectGitHub()} disabled={busy || !canManage}>{busy ? 'Abriendo GitHub…' : 'Conectar GitHub'}</button></>
      : <><p>Conectado a <strong>{installation.accountLogin}</strong>. Permisos de lectura solamente.</p>
        {repositories.error && <p role="alert">{repositories.error.message} <button className="customer-link-button" onClick={() => repositories.refetch().catch(() => undefined)}>Reintentar</button></p>}
        {repositories.isPending ? <p role="status">Cargando repositorios…</p> : repositories.data?.filter(repo => !repo.archived).length ? <ul className="customer-onboarding-repositories">{repositories.data.filter(repo => !repo.archived).map(repo => <li key={repo.id}><span><strong>{repo.fullName}</strong><small>Rama {repo.defaultBranch}</small></span><button className="customer-button customer-button-primary" aria-label={`Analizar ${repo.fullName}`} onClick={() => void selectRepository(repo)} disabled={busy || !canManage}>{busy ? 'Preparando…' : 'Analizar'}</button></li>)}</ul> : !repositories.error && <p role="status">La instalación no tiene repositorios disponibles. Puedes conceder acceso desde GitHub y volver a intentarlo.</p>}
        {canManage && <button className="customer-link-button" onClick={() => void disconnectGitHub()} disabled={busy}>Desconectar GitHub y revocar repositorios</button>}
      </>}
  </div>;
  const uploadSource = <div className="customer-onboarding-source-body"><label htmlFor="onboarding-folder">Carpeta del proyecto</label><input id="onboarding-folder" ref={fileInput} type="file" multiple disabled={!canManage || busy} onChange={event => { const selected = Array.from(event.target.files ?? []).map(file => { const path = file.webkitRelativePath.split('/').slice(1).join('/'); return { file, path, valid: customerSourceFileSchema.safeParse({ path, content: '' }).success }; }); setFiles(selected); }} />{files.length > 0 && <p role="status">{selectedFiles.length} archivos compatibles · {Math.ceil(bytes / 1024)} KiB</p>}{fileError && <p className="customer-form-error" role="alert">La carpeta no contiene archivos compatibles o supera el límite de tamaño.</p>}<p>Gotchu analizará los archivos compatibles que compartas, sin ejecutar código.</p><button className="customer-button customer-button-primary" onClick={() => void uploadAndQueue()} disabled={!canManage || busy || !selectedFiles.length || fileError}>{busy ? 'Guardando y encolando…' : 'Analizar carpeta'}</button></div>;

  return <section className="customer-onboarding" aria-labelledby="onboarding-title">
    <div className="customer-onboarding-header"><h1 id="onboarding-title">Empieza en dos pasos</h1><p>Elige una fuente para revisar y Gotchu preparará un informe con hallazgos, recomendaciones y aquello que todavía no pudo comprobar.</p></div>
    <ol className="customer-onboarding-steps" aria-label="Pasos de configuración">{['Conecta o comparte una fuente', 'Analiza y revisa el informe'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined} className={step >= index + 1 ? 'is-current' : ''}><span>{index + 1}</span>{label}</li>)}</ol>
    {step === 1 && <section className="customer-card customer-panel customer-onboarding-card"><h2 ref={stepHeading} tabIndex={-1}>¿Qué quieres revisar?</h2>{needsWorkspace && <><label htmlFor="onboarding-workspace">Espacio de trabajo</label><input id="onboarding-workspace" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} required maxLength={200} disabled={!canManage || busy} /></>}<label htmlFor="onboarding-application">Nombre de la aplicación</label><input id="onboarding-application" value={applicationName} onChange={event => { setApplicationName(event.target.value); setApplicationNameEdited(true); }} required maxLength={200} disabled={!canManage || busy} /><p>Podrás cambiar el nombre de la aplicación más adelante. Al analizar un repositorio nuevo, usaremos su nombre si no lo editas aquí.</p>{!canManage && <p>Un Owner u Operator debe crear la aplicación y solicitar evaluaciones.</p>}<h3>Conecta GitHub</h3>{githubSource}<h3>O elige una carpeta</h3>{uploadSource}<button className="customer-link-button" onClick={() => setStep(2)}>Evaluar un origen HTTPS</button></section>}
    {step === 2 && <section className="customer-card customer-panel customer-onboarding-card"><h2 ref={stepHeading} tabIndex={-1}>Define el alcance HTTPS</h2><h3>Conecta GitHub</h3>{githubSource}<h3>Sube una carpeta</h3>{uploadSource}<h3>Analiza una web</h3><div className="customer-onboarding-source-body"><label htmlFor="onboarding-domain">Origen HTTPS</label><input id="onboarding-domain" type="url" value={domain} onChange={event => setDomain(event.target.value)} placeholder="https://ejemplo.com" disabled={!canManage || busy} aria-invalid={domain.length > 0 && !domainIsValid} aria-describedby="onboarding-domain-help" />{domain.length > 0 && !domainIsValid && <p className="customer-form-error">Usa un origen HTTPS público sin rutas, parámetros ni puerto personalizado.</p>}<label htmlFor="onboarding-scan-profile">Perfil de evaluación</label><select id="onboarding-scan-profile" value={domainScanProfile} onChange={event => setDomainScanProfile(customerScanProfileSchema.parse(event.target.value))} disabled={!canManage || busy}><option value="root">Raíz del sitio · una solicitud GET a /</option><option value="public_surface">Superficie pública limitada · hasta 10 solicitudes GET</option></select><p id="onboarding-domain-help">La evaluación se limita al origen y al perfil elegido. No comparte el código fuente.</p><button className="customer-button customer-button-primary" onClick={() => void enrollDomain()} disabled={!canManage || busy || !domainIsValid}>{busy ? 'Encolando evaluación…' : 'Analizar origen'}</button></div></section>}
    {error && <p className="customer-inline-error" role="alert">{error}</p>}
    <p className="customer-onboarding-note">Puedes continuar con cobertura parcial y añadir otra fuente después.</p>
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
  return <section className="customer-card customer-panel customer-github-panel" aria-labelledby="github-panel-title"><div className="customer-card-heading"><div><h2 id="github-panel-title">GitHub</h2></div>{activeInstallation && <span className="customer-status customer-status-ready">Conectado</span>}</div>
    {connections.isPending ? <p role="status">Comprobando conexión…</p> : connections.error ? <p role="alert">{connections.error.message} <button className="customer-link-button" onClick={() => connections.refetch().catch(() => undefined)}>Reintentar</button></p> : !activeInstallation ? <><p>Conecta una GitHub App con permisos de lectura para iniciar evaluaciones desde una rama.</p>{connections.data?.some(item => item.state === 'revoked') && <p role="status">La conexión anterior fue revocada o perdió acceso. Sus enlaces de repositorio también están revocados.</p>}<button className="customer-button customer-button-primary" onClick={() => void connect()} disabled={!canManage || busy}>{busy ? 'Abriendo GitHub…' : 'Conectar GitHub'}</button>{!canManage && <p>Un Owner u Operator puede administrar conexiones y repositorios.</p>}</> : <><p><strong>{activeInstallation.accountLogin}</strong> · acceso de lectura · sin permisos de escritura.</p>{repositories.error && <p role="alert">{repositories.error.message} <button className="customer-link-button" onClick={() => repositories.refetch().catch(() => undefined)}>Reintentar</button></p>}{repositories.isPending ? <p role="status">Cargando repositorios…</p> : repositories.data?.filter(repo => !repo.archived).length ? <ul className="customer-onboarding-repositories">{repositories.data.filter(repo => !repo.archived).map(repo => <li key={repo.id}><span><strong>{repo.fullName}</strong><small>Rama {repo.defaultBranch}</small></span><button className="customer-button customer-button-primary" aria-label={`Analizar ${repo.fullName}`} onClick={() => void selectRepository(repo)} disabled={!canManage || busy}>Analizar</button></li>)}</ul> : !repositories.error && <p role="status">La instalación no tiene repositorios disponibles.</p>}<button className="customer-link-button customer-danger-link" onClick={() => void disconnect()} disabled={!canManage || busy}>Desconectar y revocar sus repositorios</button></>}
    {error && <p className="customer-form-error" role="alert">{error}</p>}
  </section>;
}
