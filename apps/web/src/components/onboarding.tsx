import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CUSTOMER_MAX_SOURCE_BYTES, customerScopeSchema, customerSourceFileSchema, customerSourceSnapshotSchema, customerScanProfileSchema, type CustomerWorkspace } from '@gotchu/contracts';
import { customerApi, CustomerApiError } from './customer-client';

type SourceFile = { file: File; path: string; valid: boolean };
type Scope = { organizationId: string; applicationId: string };
const onboardingStorageKey = 'gotchu-onboarding-scope';

async function readFiles(files: readonly SourceFile[]) {
  const contents = await Promise.all(files.filter(item => item.valid).map(async item => ({ path: item.path, content: new TextDecoder('utf-8', { fatal: true }).decode(await item.file.arrayBuffer()) })));
  return customerSourceSnapshotSchema.parse({ revision: 'upload', files: contents });
}

export function Onboarding({ userId, initialOrganizationId, initialApplicationId, canManage = true, onWorkspaceCreated, onScanQueued }: {
  userId: string; initialOrganizationId?: string; initialApplicationId?: string; onWorkspaceCreated: (workspace: CustomerWorkspace) => void;
  onScanQueued: (scope: Scope, jobId: string) => void; canManage?: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [createdOrganizationId, setCreatedOrganizationId] = useState<string | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [workspaceName, setWorkspaceName] = useState('Mi espacio de trabajo');
  const [applicationName, setApplicationName] = useState('Mi aplicación');
  const [sourceChoice, setSourceChoice] = useState<'github' | 'upload' | 'domain'>('github');
  const [files, setFiles] = useState<SourceFile[]>([]);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [domain, setDomain] = useState('');
  const [challenge, setChallenge] = useState<{ name: string; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installationId, setInstallationId] = useState('');
  const [repositoryId, setRepositoryId] = useState<number | null>(null);
  const needsWorkspace = !initialOrganizationId && !createdOrganizationId;

  useEffect(() => {
    let current = true;
    const saved = sessionStorage.getItem(onboardingStorageKey);
    let hasSavedScope = false;
    if (saved) {
      try {
        const parsed = customerScopeSchema.safeParse(JSON.parse(saved));
        if (parsed.success) { hasSavedScope = true; setScope(parsed.data); setStep(2); }
        else sessionStorage.removeItem(onboardingStorageKey);
      } catch { sessionStorage.removeItem(onboardingStorageKey); }
    }
    if (initialOrganizationId && initialApplicationId) {
      setScope({ organizationId: initialOrganizationId, applicationId: initialApplicationId }); setStep(2);
    } else if (initialOrganizationId && !hasSavedScope) {
      setWorkspaceName('');
      void customerApi.applications(initialOrganizationId).then(apps => {
        if (!current) return;
        const application = apps.find(item => !item.archived);
        if (application) { const next = { organizationId: initialOrganizationId, applicationId: application.applicationId }; setScope(next); setStep(2); }
      }).catch(() => undefined);
    }
    return () => { current = false; };
  }, [initialOrganizationId, userId]);
  useEffect(() => {
    if (sourceChoice === 'upload') fileInput.current?.setAttribute('webkitdirectory', '');
  }, [sourceChoice]);
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

  async function createScope(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canManage) return; setBusy(true); setError(null);
    try {
      const workspace = initialOrganizationId || createdOrganizationId ? null : await customerApi.createWorkspace(workspaceName);
      if (workspace) setCreatedOrganizationId(workspace.id);
      const organizationId = initialOrganizationId ?? createdOrganizationId ?? workspace?.id;
      if (!organizationId) throw new Error('No se pudo identificar el espacio de trabajo.');
      const application = await customerApi.createApplication(organizationId, applicationName);
      const next = { organizationId, applicationId: application.applicationId };
      if (workspace) onWorkspaceCreated(workspace);
      setScope(next); sessionStorage.setItem(onboardingStorageKey, JSON.stringify(next)); setStep(2);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo crear el espacio y la aplicación.'); }
    finally { setBusy(false); }
  }
  async function connectGitHub() {
    if (!scope || !canManage) return;
    setBusy(true); setError(null);
    try { window.location.assign(await customerApi.githubConnect(scope.organizationId)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo conectar GitHub.'); setBusy(false); }
  }
  async function disconnectGitHub() {
    if (!scope || !installation || !canManage) return;
    setBusy(true); setError(null);
    try { await customerApi.githubDisconnect(scope.organizationId, installation.installationId); setInstallationId(''); await connections.refetch(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo desconectar GitHub.'); }
    finally { setBusy(false); }
  }
  async function uploadSource() {
    if (!scope || !canManage) return;
    setBusy(true); setError(null);
    try {
      const snapshot = await readFiles(files);
      const source = await customerApi.uploadSource({ ...scope, snapshot, authorized: true });
      setSnapshotId(source.id); setStep(3);
    } catch (caught) { setError(caught instanceof CustomerApiError ? caught.message : 'No se pudo leer la carpeta seleccionada.'); }
    finally { setBusy(false); }
  }
  async function enrollDomain() {
    if (!scope || !canManage) return;
    setBusy(true); setError(null);
    try {
      const enrollment = await customerApi.enrollTarget({ ...scope, origin: domain, authorized: true, scanProfile: customerScanProfileSchema.parse('public_surface') });
      setChallenge({ name: enrollment.challenge.name, value: enrollment.challenge.value }); setTargetId(enrollment.target.id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo iniciar la verificación del dominio.'); }
    finally { setBusy(false); }
  }
  async function verifyDomain() {
    if (!scope || !targetId || !canManage) return;
    setBusy(true); setError(null);
    try { await customerApi.verifyTarget(scope.organizationId, scope.applicationId, targetId); setStep(3); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'El registro DNS todavía no se ha encontrado.'); }
    finally { setBusy(false); }
  }
  async function selectRepository() {
    if (!scope || !installation || repositoryId === null || !canManage) return;
    const repository = repositories.data?.find(item => item.id === repositoryId);
    if (!repository) return;
    setBusy(true); setError(null);
    try {
      const result = await customerApi.githubSelectRepository({ ...scope, installationId: installation.installationId, repositoryId: repository.id, fullName: repository.fullName, defaultBranch: repository.defaultBranch });
      sessionStorage.removeItem(onboardingStorageKey); onScanQueued(scope, result.jobId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo iniciar la primera evaluación.'); }
    finally { setBusy(false); }
  }
  async function queueAssessment() {
    if (!scope || !canManage) return;
    setBusy(true); setError(null);
    try {
      const result = await customerApi.queue({ ...scope, mode: snapshotId ? 'internal' : 'external', sourceSnapshotId: snapshotId, targetId });
      sessionStorage.removeItem(onboardingStorageKey); onScanQueued(scope, result.jobId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo iniciar la evaluación.'); }
    finally { setBusy(false); }
  }

  const selectedFiles = files.filter(item => item.valid);
  const bytes = selectedFiles.reduce((total, item) => total + item.file.size, 0);
  const fileError = files.length > 0 && (!selectedFiles.length || bytes > CUSTOMER_MAX_SOURCE_BYTES || !customerSourceFileSchema.safeParse({ path: selectedFiles[0]?.path, content: '' }).success);
  return <section className="customer-onboarding" aria-labelledby="onboarding-title">
    <div className="customer-onboarding-header"><span className="customer-eyebrow">PRIMER RESULTADO</span><h1 id="onboarding-title">Empieza en tres pasos</h1><p>Conecta una fuente autorizada y Gotchu preparará un informe con hallazgos, recomendaciones y aquello que todavía no pudo comprobar.</p></div>
    <ol className="customer-onboarding-steps" aria-label="Pasos de configuración">{['Espacio y aplicación', 'Elige una fuente', 'Primera evaluación'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined} className={step >= index + 1 ? 'is-current' : ''}><span>{index + 1}</span>{label}</li>)}</ol>
    {step === 1 && <form className="customer-card customer-onboarding-card customer-form" onSubmit={event => void createScope(event)}><h2 ref={stepHeading} tabIndex={-1}>¿Qué quieres proteger?</h2>{needsWorkspace ? <><label htmlFor="onboarding-workspace">Espacio de trabajo</label><input id="onboarding-workspace" value={workspaceName} onChange={event => setWorkspaceName(event.target.value)} required maxLength={200} disabled={!canManage} /></> : <p>Se usará el espacio de trabajo seleccionado.</p>}<label htmlFor="onboarding-application">Nombre de la aplicación</label><input id="onboarding-application" value={applicationName} onChange={event => setApplicationName(event.target.value)} required maxLength={200} disabled={!canManage} /><button className="customer-button customer-button-primary" disabled={!canManage || busy || (needsWorkspace && !workspaceName.trim()) || !applicationName.trim()}>{busy ? 'Creando…' : 'Continuar'}</button>{!canManage && <p>Un Owner u Operator debe crear una aplicación para continuar.</p>}</form>}
    {step === 2 && <section className="customer-card customer-onboarding-card"><h2 ref={stepHeading} tabIndex={-1}>Elige cómo empezar</h2><div className="customer-onboarding-source-options" role="radiogroup" aria-label="Fuente de evaluación">
      <label><input type="radio" name="onboarding-source" value="github" checked={sourceChoice === 'github'} onChange={() => setSourceChoice('github')} /><span><strong>Conectar GitHub</strong><small>Lectura del código seleccionado. No ejecutamos el proyecto ni escribimos en el repositorio.</small></span></label>
      <label><input type="radio" name="onboarding-source" value="upload" checked={sourceChoice === 'upload'} onChange={() => setSourceChoice('upload')} /><span><strong>Subir una carpeta</strong><small>Analiza los archivos compatibles que compartas; no se ejecuta código.</small></span></label>
      <label><input type="radio" name="onboarding-source" value="domain" checked={sourceChoice === 'domain'} onChange={() => setSourceChoice('domain')} /><span><strong>Verificar mi dominio</strong><small>Prueba una superficie HTTPS pública acotada. No inspecciona código privado.</small></span></label>
    </div>
    {sourceChoice === 'github' && <div className="customer-onboarding-source-body">{connections.isPending ? <p role="status">Comprobando conexiones…</p> : connections.error ? <p role="alert">{connections.error.message} <button className="customer-link-button" onClick={() => connections.refetch().catch(() => undefined)}>Reintentar</button></p> : !installation ? <>{connections.data?.some(item => item.state === 'revoked') && <p role="status">La conexión anterior fue revocada o perdió acceso. Puedes volver a conectar una instalación.</p>}<button className="customer-button customer-button-primary" onClick={() => void connectGitHub()} disabled={busy || !canManage}>{busy ? 'Abriendo GitHub…' : 'Conectar GitHub'}</button>{!canManage && <p>Un Owner u Operator debe conectar la instalación de GitHub.</p>}</> : <><p>Conectado a <strong>{installation.accountLogin}</strong>. Permisos de lectura solamente.</p>{repositories.error && <p role="alert">{repositories.error.message} <button className="customer-link-button" onClick={() => repositories.refetch().catch(() => undefined)}>Reintentar</button></p>}<label htmlFor="github-repository">Repositorio</label><select id="github-repository" value={repositoryId ?? ''} onChange={event => setRepositoryId(Number(event.target.value) || null)} disabled={repositories.isPending || !canManage}><option value="">{repositories.isPending ? 'Cargando repositorios…' : 'Selecciona un repositorio'}</option>{repositories.data?.filter(repo => !repo.archived).map(repo => <option value={repo.id} key={repo.id}>{repo.fullName} · rama {repo.defaultBranch}</option>)}</select><button className="customer-button customer-button-primary" onClick={() => void selectRepository()} disabled={busy || repositoryId === null || !canManage}>{busy ? 'Preparando la evaluación…' : 'Analizar repositorio'}</button>{canManage && <button className="customer-link-button" onClick={() => void disconnectGitHub()} disabled={busy}>Desconectar GitHub y revocar repositorios</button>}</>}</div>}
    {sourceChoice === 'upload' && <div className="customer-onboarding-source-body"><label htmlFor="onboarding-folder">Carpeta del proyecto</label><input id="onboarding-folder" ref={fileInput} type="file" multiple disabled={!canManage} onChange={event => { const selected = Array.from(event.target.files ?? []).map(file => { const path = file.webkitRelativePath.split('/').slice(1).join('/'); return { file, path, valid: customerSourceFileSchema.safeParse({ path, content: '' }).success }; }); setFiles(selected); }} />{files.length > 0 && <p role="status">{selectedFiles.length} archivos compatibles · {Math.ceil(bytes / 1024)} KiB</p>}{fileError && <p className="customer-form-error" role="alert">La carpeta no contiene archivos compatibles o supera el límite de tamaño.</p>}<button className="customer-button customer-button-primary" onClick={() => void uploadSource()} disabled={!canManage || busy || !selectedFiles.length || fileError}>{busy ? 'Guardando instantánea…' : 'Continuar con esta carpeta'}</button></div>}
    {sourceChoice === 'domain' && <div className="customer-onboarding-source-body"><label htmlFor="onboarding-domain">Dominio HTTPS</label><input id="onboarding-domain" type="url" value={domain} onChange={event => setDomain(event.target.value)} placeholder="https://ejemplo.com" disabled={!canManage} />{!challenge ? <button className="customer-button customer-button-primary" onClick={() => void enrollDomain()} disabled={!canManage || busy || !domain.trim()}>{busy ? 'Preparando verificación…' : 'Verificar dominio'}</button> : <><p>Publica este TXT en <code>{challenge.name}</code>: <code>{challenge.value}</code></p><button className="customer-button customer-button-primary" onClick={() => void verifyDomain()} disabled={!canManage || busy}>{busy ? 'Comprobando DNS…' : 'Ya publiqué el registro'}</button></>}</div>}
    </section>}
    {step === 3 && <section className="customer-card customer-onboarding-card"><span className="customer-eyebrow">LISTO PARA ANALIZAR</span><h2 ref={stepHeading} tabIndex={-1}>La cobertura dependerá de la fuente</h2><p>{snapshotId ? 'Se revisarán los archivos compatibles de la instantánea.' : 'Se probará únicamente la superficie HTTPS autorizada y verificada.'}</p><p><strong>No comprobado</strong> significa que Gotchu no tuvo evidencia suficiente; no significa que no haya problemas.</p><button className="customer-button customer-button-primary" onClick={() => void queueAssessment()} disabled={!canManage || busy}>{busy ? 'Encolando…' : 'Analizar ahora'}</button></section>}
    {error && <p className="customer-inline-error" role="alert">{error}</p>}
    <p className="customer-onboarding-note">Puedes continuar con cobertura parcial y añadir otra fuente después.</p>
  </section>;
}

export function GitHubRepositoryPanel({ userId, organizationId, applicationId, canManage, onScanQueued }: {
  userId: string; organizationId: string; applicationId: string; canManage: boolean; onScanQueued: (jobId: string) => void;
}) {
  const [installationId, setInstallationId] = useState('');
  const [repositoryId, setRepositoryId] = useState<number | null>(null);
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
      sessionStorage.setItem('gotchu-pending-github-scope', JSON.stringify({ organizationId, applicationId }));
      window.location.assign(await customerApi.githubConnect(organizationId));
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo conectar GitHub.'); setBusy(false); }
  }
  async function disconnect() {
    if (!canManage || !activeInstallation) return;
    setBusy(true); setError(null);
    try { await customerApi.githubDisconnect(organizationId, activeInstallation.installationId); setInstallationId(''); setRepositoryId(null); await connections.refetch(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo desconectar GitHub.'); }
    finally { setBusy(false); }
  }
  async function selectRepository() {
    const repository = repositories.data?.find(item => item.id === repositoryId);
    if (!canManage || !activeInstallation || !repository) return;
    setBusy(true); setError(null);
    try {
      const result = await customerApi.githubSelectRepository({ organizationId, applicationId, installationId: activeInstallation.installationId, repositoryId: repository.id, fullName: repository.fullName, defaultBranch: repository.defaultBranch });
      onScanQueued(result.jobId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'No se pudo iniciar la evaluación del repositorio.'); }
    finally { setBusy(false); }
  }
  return <section className="customer-card customer-github-panel" aria-labelledby="github-panel-title"><div className="customer-card-heading"><div><span className="customer-eyebrow">FUENTE DE CÓDIGO</span><h2 id="github-panel-title">GitHub</h2></div>{activeInstallation && <span className="customer-status customer-status-ready">Conectado</span>}</div>
    {connections.isPending ? <p role="status">Comprobando conexión…</p> : connections.error ? <p role="alert">{connections.error.message} <button className="customer-link-button" onClick={() => connections.refetch().catch(() => undefined)}>Reintentar</button></p> : !activeInstallation ? <><p>Conecta una GitHub App con permisos de lectura para iniciar evaluaciones desde una rama.</p>{connections.data?.some(item => item.state === 'revoked') && <p role="status">La conexión anterior fue revocada o perdió acceso. Sus enlaces de repositorio también están revocados.</p>}<button className="customer-button customer-button-primary" onClick={() => void connect()} disabled={!canManage || busy}>{busy ? 'Abriendo GitHub…' : 'Conectar GitHub'}</button>{!canManage && <p>Un Owner u Operator puede administrar conexiones y repositorios.</p>}</> : <><p><strong>{activeInstallation.accountLogin}</strong> · acceso de lectura · sin permisos de escritura.</p>{repositories.error && <p role="alert">{repositories.error.message} <button className="customer-link-button" onClick={() => repositories.refetch().catch(() => undefined)}>Reintentar</button></p>}<label htmlFor="github-panel-repository">Repositorio autorizado</label><select id="github-panel-repository" value={repositoryId ?? ''} onChange={event => setRepositoryId(Number(event.target.value) || null)} disabled={repositories.isPending || !canManage}><option value="">{repositories.isPending ? 'Cargando repositorios…' : 'Selecciona un repositorio'}</option>{repositories.data?.filter(repo => !repo.archived).map(repo => <option key={repo.id} value={repo.id}>{repo.fullName} · {repo.defaultBranch}</option>)}</select><button className="customer-button customer-button-primary" onClick={() => void selectRepository()} disabled={!canManage || busy || repositoryId === null}>{busy ? 'Preparando evaluación…' : 'Analizar repositorio'}</button><button className="customer-link-button customer-danger-link" onClick={() => void disconnect()} disabled={!canManage || busy}>Desconectar y revocar sus repositorios</button></>}
    {error && <p className="customer-form-error" role="alert">{error}</p>}
  </section>;
}
