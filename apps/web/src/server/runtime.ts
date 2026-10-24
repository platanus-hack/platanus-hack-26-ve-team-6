import { createActionVerifier, createBackend, createValidationService, readPinnedRootfsDigest, type Backend, type CredentialStore } from '@gotchu/backend';
import { createDatabase } from '@gotchu/database';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createGitHubAppAdapter } from '@gotchu/git-adapters';
import { createApi, type ApiOperation } from './api.js';
import { authSettings, createAuthService, publicAuthProviders, type AuthService } from './auth.js';
import { HttpError } from './http.js';
import { bindDemoAssessmentServices, createDemoAssessmentApi } from './demo.js';
import { createLocalAccounts } from './local-accounts.js';
import { createCustomerApi } from './customer-api.js';
import { createCustomerDnsVerifier } from './customer-dns.js';
import { createFileEventCredentials } from './event-credentials.js';
import { createNotificationWebhookValidator } from './notification-dns.js';
import { createFileModelSecretStore, createFileNotificationSecretStore } from '@gotchu/backend';
import { resolve } from 'node:path';
import { createGitHubRepositoryReader, createLocalGitRepositoryReader, loadMonitoringRepositoryCatalog } from '@gotchu/monitoring';
import { isIP } from 'node:net';

function credentialStore(value: string | undefined): CredentialStore | undefined {
  if (!value) return undefined;
  const entries = z.record(z.string().min(1).max(128), z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/)).parse(JSON.parse(value));
  const keys = new Map(Object.entries(entries).map(([reference, encoded]) => {
    const secret = Buffer.from(encoded, 'base64');
    if (secret.length < 32) throw new Error('Event signing keys must contain at least 32 bytes');
    return [reference, secret] as const;
  }));
  return { getSigningSecret: async (reference) => {
    const key = keys.get(reference);
    if (!key) throw new HttpError(503, 'credential_unavailable', 'Integration signing credential is unavailable');
    return key;
  } };
}

function githubReaderApp(env: NodeJS.ProcessEnv) {
  const path = env.GOTCHU_GITHUB_READER_APP_CREDENTIALS_FILE;
  if (!path) return null;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const parsed = z.object({
    id: z.union([z.string(), z.number()]).optional(),
    appId: z.union([z.string(), z.number()]).optional(),
    app_id: z.union([z.string(), z.number()]).optional(),
    installationId: z.union([z.string(), z.number()]).optional(),
    installation_id: z.union([z.string(), z.number()]).optional(),
    privateKeyPem: z.string().optional(),
    privateKey: z.string().optional(),
    private_key: z.string().optional(),
  }).passthrough().parse(raw);
  const appId = String(parsed.id ?? parsed.appId ?? parsed.app_id ?? '');
  const installationId = String(parsed.installationId ?? parsed.installation_id ?? env.GOTCHU_GITHUB_READER_INSTALLATION_ID ?? '');
  const privateKeyPem = parsed.privateKeyPem ?? parsed.privateKey ?? parsed.private_key;
  if (!appId || !installationId || !privateKeyPem) throw new Error('github_reader_app_configuration_invalid');
  return { appId, installationId, privateKeyPem };
}

async function githubReaderAdapter(env: NodeJS.ProcessEnv, credentials: ReturnType<typeof githubReaderApp>, scope: { organizationId:string; applicationId:string; repositoryKey:string }) {
  if (!credentials || !env.GOTCHU_MONITORING_CONFIG_FILE) throw new Error('repository_reader_unavailable');
  const catalog = await loadMonitoringRepositoryCatalog(env.GOTCHU_MONITORING_CONFIG_FILE);
  const entry = catalog.resolve(scope, scope.repositoryKey);
  if (entry.provider !== 'github') throw new Error('repository_provider_mismatch');
  return createGitHubAppAdapter({ appId: credentials.appId, installationId: credentials.installationId, privateKeyPem: credentials.privateKeyPem, owner: entry.owner, repository: entry.repository });
}

function execute(backend: Backend, identity: { userId: string }, operation: ApiOperation) {
  switch (operation.kind) {
    case 'applications.list': return backend.web.listApplications(identity, { organizationId: operation.organizationId });
    case 'incidents.list': return backend.web.listIncidents(identity, { organizationId: operation.organizationId, applicationId: operation.applicationId });
    case 'coverage.get': return backend.web.getCoverage(identity, { organizationId: operation.organizationId, applicationId: operation.applicationId });
    case 'proposals.list': return backend.web.listProposals(identity, { organizationId: operation.organizationId, applicationId: operation.applicationId });
    case 'job.get': return backend.web.getJob(identity, { organizationId: operation.organizationId, jobId: operation.jobId });
    case 'proposal.approve': return backend.proposals.approve(identity, { organizationId: operation.organizationId, proposalId: operation.proposalId, actionHash: operation.actionHash, stepUpProof: operation.stepUpProof });
    default: { const exhaustive: never = operation; throw new Error(`Unsupported operation: ${String(exhaustive)}`); }
  }
}

export function createBackendApi(options: { auth: AuthService; origin: string; web: Backend | null; intake: Backend | null }) {
  return createApi({
    auth: options.auth, origin: options.origin,
    ingest: async (input) => {
      if (!options.intake) throw new HttpError(503, 'database_not_configured', 'Event ingestion is unavailable');
      return options.intake.events.ingest(input);
    },
    signedPolicy: async (input) => {
      if (!options.intake) throw new HttpError(503, 'database_not_configured', 'Runtime protection policy is unavailable');
      return options.intake.protection.signedPolicy(input);
    },
    execute: async (identity, operation) => {
      if (!options.web) throw new HttpError(503, 'database_not_configured', 'Customer data access is unavailable');
      return execute(options.web, identity, operation);
    },
  });
}

export function resolveWebAuthnConfiguration(configuredOrigin: URL, configuredRpID: string | undefined) {
  const defaultRpID = ['127.0.0.1', '[::1]'].includes(configuredOrigin.hostname) ? 'localhost' : configuredOrigin.hostname;
  const rpID = z.string().min(1).max(253).parse(configuredRpID ?? defaultRpID).toLowerCase();
  const matchesOrigin = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(rpID)
    && isIP(rpID) === 0
    && (configuredOrigin.hostname === rpID || configuredOrigin.hostname.endsWith(`.${rpID}`));
  if (configuredRpID !== undefined && !matchesOrigin) throw new Error('GOTCHU_WEBAUTHN_RP_ID must match the configured application origin');
  if (!matchesOrigin) return undefined;
  return { rpID, origin: configuredOrigin.origin, rpName: 'Gotchu' };
}

export function createWebRuntime(env: NodeJS.ProcessEnv = process.env) {
  const configuredOrigin = new URL(env.PUBLIC_APP_URL ?? 'http://localhost:3000');
  if (configuredOrigin.username || configuredOrigin.password || configuredOrigin.pathname !== '/' || configuredOrigin.search || configuredOrigin.hash
    || (configuredOrigin.protocol !== 'https:' && !(configuredOrigin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(configuredOrigin.hostname)))) throw new Error('PUBLIC_APP_URL must be an HTTPS origin (localhost is allowed for development)');
  const origin = configuredOrigin.origin;
  const webAuthn = resolveWebAuthnConfiguration(configuredOrigin, env.GOTCHU_WEBAUTHN_RP_ID);
  const apiDatabase = env.GOTCHU_API_DATABASE_URL ? createDatabase({ connectionString: env.GOTCHU_API_DATABASE_URL, role: 'gotchu_api', max: 5 }) : null;
  const ingestDatabase = env.GOTCHU_INGEST_DATABASE_URL ? createDatabase({ connectionString: env.GOTCHU_INGEST_DATABASE_URL, role: 'gotchu_ingest', max: 5 }) : null;
  const selfHostMode = env.GOTCHU_AUTH_MODE === 'self_host';
  const accounts = apiDatabase && (selfHostMode || env.GOTCHU_LOCAL_AUTH_ENABLED === 'true') ? createLocalAccounts(apiDatabase) : undefined;
  const dnsServers = env.GOTCHU_DNS_SERVERS_JSON ? z.array(z.string().min(1).max(100)).max(5).parse(JSON.parse(env.GOTCHU_DNS_SERVERS_JSON)) : [];
  const eventCredentials = env.GOTCHU_EVENT_CREDENTIAL_DIRECTORY ? createFileEventCredentials(env.GOTCHU_EVENT_CREDENTIAL_DIRECTORY) : undefined;
  const readerApp = githubReaderApp(env);
  const notificationSecretDirectory=env.GOTCHU_NOTIFICATION_SECRET_DIRECTORY??(env.NODE_ENV==='production'?undefined:resolve('.local/dev/notification-secrets'));
  const notificationSecrets=notificationSecretDirectory?createFileNotificationSecretStore(notificationSecretDirectory):undefined;
  const modelSecretDirectory=env.GOTCHU_MODEL_SECRET_DIRECTORY??(env.NODE_ENV==='production'?undefined:resolve('.local/dev/model-secrets'));
  const modelSecrets=modelSecretDirectory?createFileModelSecretStore(modelSecretDirectory):undefined;
  const validationService = apiDatabase ? createValidationService({ database: apiDatabase }) : undefined;
  const actionVerifier = apiDatabase ? createActionVerifier({ database: apiDatabase, pinnedRootfsDigest: readPinnedRootfsDigest(), repository: {
    async readHead(scope) {
      if (!env.GOTCHU_MONITORING_CONFIG_FILE) throw new Error('repository_reader_unavailable');
      const catalog = await loadMonitoringRepositoryCatalog(env.GOTCHU_MONITORING_CONFIG_FILE);
      const entry = catalog.resolve(scope, scope.repositoryKey);
      if (entry.provider === 'github') {
        if (entry.ref && entry.ref !== scope.branch) throw new Error('repository_branch_mismatch');
        if (readerApp) return await (await githubReaderAdapter(env, readerApp, { ...scope, repositoryKey: scope.repositoryKey })).readHead(scope.branch);
        const reader = createGitHubRepositoryReader(catalog);
        return (await reader.read({ ...scope, previousRevision: null })).commit.sha;
      }
      if (entry.ref !== scope.branch) throw new Error('repository_branch_mismatch');
      const reader = createLocalGitRepositoryReader(catalog);
      return (await reader.read({ ...scope, previousRevision: null })).commit.sha;
    },
    async readTree(scope) {
      const adapter = await githubReaderAdapter(env, readerApp, { ...scope, repositoryKey: scope.repositoryKey });
      return adapter.readTree(scope.commitSha);
    },
    // A matching version string is not a policy registry; keep action eligibility closed until one is wired.
    async isPolicyCurrent() { return false; },
    async inspectAutomation(scope) {
      const adapter = await githubReaderAdapter(env, readerApp, { ...scope, repositoryKey: scope.repositoryKey });
      return adapter.inspectAutomation(scope.baseCommit);
    },
  }, validationFacts: {
    getFacts: input => validationService?.getValidationFacts(input) ?? Promise.resolve(null),
  } }) : undefined;
  const web = apiDatabase ? createBackend({ database: apiDatabase, ...(webAuthn ? { webAuthn: { ...webAuthn, ...(accounts ? { verifyPassword: (userId: string, password: string) => accounts.reauthenticate(userId, password) } : {}) } } : {}), customerDnsVerifier: createCustomerDnsVerifier(dnsServers), webhookValidator: createNotificationWebhookValidator(dnsServers), ...(notificationSecrets ? { notificationSecrets } : {}), ...(modelSecrets ? { modelSecrets } : {}), ...(actionVerifier ? { actionVerifier } : {}), ...(eventCredentials ? { eventCredentials } : {}) }) : null;
  const stepUp = web?.stepUp;
  const settings = authSettings(env, accounts, stepUp ? userId => stepUp.invalidateSession(userId) : undefined);
  const auth = createAuthService(settings);
  const configuredCredentials = credentialStore(env.GOTCHU_EVENT_SIGNING_KEYS_JSON);
  const credentials: CredentialStore | undefined = eventCredentials || configuredCredentials ? { getSigningSecret: async reference => {
    if (reference.startsWith('local-event:') && eventCredentials) return eventCredentials.getSigningSecret(reference);
    if (configuredCredentials) return configuredCredentials.getSigningSecret(reference);
    throw new HttpError(503, 'credential_unavailable', 'Integration signing credential is unavailable');
  } } : undefined;
  const intake = ingestDatabase ? createBackend({ database: ingestDatabase, ...(credentials ? { credentials } : {}) }) : null;
  const handle = createBackendApi({ auth, origin, web, intake });
  const handleDemo = createDemoAssessmentApi({ enabled: env.GOTCHU_DEMO_ENABLED === 'true', origin, services: web ? bindDemoAssessmentServices(web) : null });
  const handleCustomer = createCustomerApi({ auth, origin, services: web ? { ...web.customers, ...(web.stepUp ? { stepUp: web.stepUp } : {}), telemetry: web.telemetry, protection: web.protection, operations: web.operations, decisionRecords: web.decisionRecords, corrections: web.corrections, context: web.context, triage: web.triage, investigationModels: web.investigationModels, investigations: web.investigations,
    members: web.members,
    github: web.github,
    notifications: web.notifications,
    retention: web.retention,
    actions: web.actions,
    workflowExceptions: web.workflowExceptions,
    validations: web.validations,
    repositoryCatalog: async (identity, scope) => {
      await web.operations.getConfig(identity, scope);
      if (!env.GOTCHU_MONITORING_CONFIG_FILE) return [];
      const catalog = await loadMonitoringRepositoryCatalog(env.GOTCHU_MONITORING_CONFIG_FILE);
      return catalog.listAllowedRepositoryOptions(scope).map(entry => ({ key: entry.repositoryKey, label: entry.displayName }));
    },
    job: (identity, value) => web.web.getJob(identity, value) } : null,
    ...(accounts ? { localAccounts: accounts } : {}),
    registrationEnabled: !selfHostMode && Boolean(accounts) && auth.enabled && env.NODE_ENV === 'development' && env.GOTCHU_ALLOW_LOCAL_REGISTRATION === 'true',
    selfHostSetup: selfHostMode,
    providers: publicAuthProviders(settings),
    ...(env.GOTCHU_GITHUB_READER_APP_FILE ? { githubAppFile: env.GOTCHU_GITHUB_READER_APP_FILE } : {}),
    ...(env.GOTCHU_GITHUB_APP_SLUG ? { githubAppSlug: env.GOTCHU_GITHUB_APP_SLUG } : {}),
  });
  return {
    handle,
    handleAuth: auth.handle,
    handleCustomer,
    handleDemo,
    async readiness() {
      const check = async (database: typeof apiDatabase) => {
        if (!database) return false;
        try { await database.checkHealth(); return true; } catch { return false; }
      };
      const [apiDatabaseReady, intakeDatabaseReady] = await Promise.all([check(apiDatabase), check(ingestDatabase)]);
      const ready = apiDatabaseReady && intakeDatabaseReady && auth.enabled;
      return {
        ready,
        dependencies: { apiDatabase: apiDatabaseReady, intakeDatabase: intakeDatabaseReady, signIn: auth.enabled },
        capabilities: { eventSigningKeys: Boolean(credentials), notificationWebhookSecrets:Boolean(notificationSecrets), modelCredentialStore: Boolean(modelSecrets), freshSecondFactorApproval: Boolean(web?.stepUp), githubWrites: false, customerCodeExecution: false, deployedAwsCoverage: false },
      };
    },
    async close() { await Promise.all([apiDatabase?.close(), ingestDatabase?.close()]); },
  };
}

let runtime: ReturnType<typeof createWebRuntime> | undefined;
export function getWebRuntime() { return runtime ??= createWebRuntime(); }
