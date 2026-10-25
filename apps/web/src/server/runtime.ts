import { createActionVerifier, createBackend, createModelEndpointValidator, createValidationService, issueModelProbeToken, readPinnedRootfsDigest, actionPolicyVersion, BackendError, loadSingleAppRepository, type Backend, type CredentialStore, type ModelProbeClient, createFileModelSecretStore, createFileNotificationSecretStore } from '@gotchu/backend';
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
import { createProviderConnections } from './provider-connections.js';
import { startCodexDeviceLogin } from './codex-device-login.js';
import { startClaudeTokenLogin } from './claude-token-login.js';
import { createOpenRouterLogins } from './openrouter-login.js';
import { createFileEventCredentials } from './event-credentials.js';
import { createNotificationWebhookValidator } from './notification-dns.js';
import { resolve } from 'node:path';
import { createGitHubRepositoryReader, createLocalGitRepositoryReader, loadMonitoringRepositoryCatalog } from '@gotchu/monitoring';
import { isIP } from 'node:net';
import { investigationModelProbeResultSchema, singleGitHubPublicAppSchema } from '@gotchu/contracts';
import { createSingleAppGitHubBroker } from './github-broker-client.js';
import type { SingleGitHubPublicApp } from './github-single-app.js';

function gatewayModelProbeClient(env: NodeJS.ProcessEnv): ModelProbeClient | undefined {
  const gatewayUrl = env.GOTCHU_GATEWAY_URL;
  const encodedSecret = env.GOTCHU_GATEWAY_MODEL_PROBE_SECRET;
  if (!gatewayUrl || !encodedSecret) return undefined;
  const endpoint = new URL(gatewayUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' ||
    (endpoint.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) {
    throw new Error('GOTCHU_GATEWAY_URL must be an HTTPS origin (loopback HTTP is allowed in development)');
  }
  const secret = Buffer.from(z.string().regex(/^[A-Za-z0-9_-]+$/).parse(encodedSecret), 'base64url');
  if (secret.byteLength < 32 || secret.toString('base64url') !== encodedSecret) throw new Error('GOTCHU_GATEWAY_MODEL_PROBE_SECRET must be at least 32 bytes encoded as unpadded base64url');
  const probeUrl = new URL('/internal/v1/model-probes', endpoint);
  return {
    async probe(input) {
      const issuedAt = Math.floor(Date.now() / 1_000);
      const token = issueModelProbeToken(secret, { version: 1, organizationId: input.organizationId,
        requestId: input.requestId, issuedAt, expiresAt: issuedAt + 30 });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 35_000);
      try {
        const response = await fetch(probeUrl, {
          method: 'POST', signal: controller.signal, redirect: 'error',
          headers: { authorization: `GatewayProbe ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(input), cache: 'no-store',
        });
        if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
          await response.body?.cancel();
          throw new Error('model_probe_gateway_unavailable');
        }
        const length = response.headers.get('content-length');
        if (length && Number(length) > 4_096) { await response.body?.cancel(); throw new Error('model_probe_response_invalid'); }
        if (!response.body) throw new Error('model_probe_response_invalid');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 4_096) { await reader.cancel(); throw new Error('model_probe_response_invalid'); }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        return investigationModelProbeResultSchema.parse(raw);
      } finally { clearTimeout(timeout); }
    },
  };
}

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

function singleAppGitHubPublicApp(env: NodeJS.ProcessEnv): SingleGitHubPublicApp {
  const path = env.GOTCHU_GITHUB_PUBLIC_APP_FILE;
  if (!path) throw new Error('single_app_github_public_configuration_invalid');
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return singleGitHubPublicAppSchema.parse(raw);
  } catch {
    throw new Error('single_app_github_public_configuration_invalid');
  }
}

function repositoryWriteAccessVerifier(env: NodeJS.ProcessEnv) {
  const internalUrl = env.GOTCHU_EXECUTOR_INTERNAL_URL;
  const token = env.GOTCHU_EXECUTOR_INTERNAL_TOKEN;
  if (!internalUrl && !token) return undefined;
  if (!internalUrl || !token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('executor_internal_authentication_invalid');
  const endpoint = new URL('/internal/repositories/verify-write-access', internalUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('executor_internal_url_invalid');
  }
  const responseSchema = z.object({ installationId:z.string().regex(/^[0-9]{1,20}$/),baseCommit:z.string().regex(/^[a-f0-9]{40,64}$/) }).strict();
  return async (input: { organizationId:string; applicationId:string; repositoryLinkId:string; repositoryKey:string; branch:string }) => {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method:'POST',headers:{ authorization:`Bearer ${token}`,'content-type':'application/json' },
        body:JSON.stringify(input),signal:AbortSignal.timeout(10_000),redirect:'error',
      });
    } catch (cause) {
      throw new BackendError('repository_writer_unavailable','The independent Writer App could not verify repository access',503,{cause});
    }
    if (!response.ok) throw new BackendError('repository_writer_unavailable','The independent Writer App could not verify repository access',503);
    const payload: unknown = await response.json();
    return responseSchema.parse(payload);
  };
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
  if (env.GOTCHU_GITHUB_CONNECTION_MODE !== undefined && env.GOTCHU_GITHUB_CONNECTION_MODE !== 'single_app') throw new Error('github_connection_mode_invalid');
  const singleAppMode = env.GOTCHU_GITHUB_CONNECTION_MODE === 'single_app';
  const singleAppPublicGitHubApp = singleAppMode ? singleAppGitHubPublicApp(env) : undefined;
  if (singleAppPublicGitHubApp && env.AUTH_GITHUB_ID === singleAppPublicGitHubApp.clientId) throw new Error('github_sign_in_app_must_be_separate');
  const singleAppGitHubBroker = singleAppMode
    ? createSingleAppGitHubBroker({
      internalUrl: env.GOTCHU_EXECUTOR_INTERNAL_URL ?? '',
      bearerToken: env.GOTCHU_EXECUTOR_INTERNAL_TOKEN ?? '',
    })
    : undefined;
  const webAuthn = resolveWebAuthnConfiguration(configuredOrigin, env.GOTCHU_WEBAUTHN_RP_ID);
  const apiDatabase = env.GOTCHU_API_DATABASE_URL ? createDatabase({ connectionString: env.GOTCHU_API_DATABASE_URL, role: 'gotchu_api', max: 5 }) : null;
  const ingestDatabase = env.GOTCHU_INGEST_DATABASE_URL ? createDatabase({ connectionString: env.GOTCHU_INGEST_DATABASE_URL, role: 'gotchu_ingest', max: 5 }) : null;
  const selfHostMode = env.GOTCHU_AUTH_MODE === 'self_host';
  const publicSignup = env.GOTCHU_AUTH_MODE === 'public';
  const accounts = apiDatabase && (selfHostMode || publicSignup || env.GOTCHU_LOCAL_AUTH_ENABLED === 'true') ? createLocalAccounts(apiDatabase) : undefined;
  const dnsServers = env.GOTCHU_DNS_SERVERS_JSON ? z.array(z.string().min(1).max(100)).max(5).parse(JSON.parse(env.GOTCHU_DNS_SERVERS_JSON)) : [];
  const eventCredentials = env.GOTCHU_EVENT_CREDENTIAL_DIRECTORY ? createFileEventCredentials(env.GOTCHU_EVENT_CREDENTIAL_DIRECTORY) : undefined;
  const readerApp = singleAppMode ? null : githubReaderApp(env);
  const verifyRepositoryWriteAccess = repositoryWriteAccessVerifier(env);
  const notificationSecretDirectory=env.GOTCHU_NOTIFICATION_SECRET_DIRECTORY??(env.NODE_ENV==='production'?undefined:resolve('.local/dev/notification-secrets'));
  const notificationSecrets=notificationSecretDirectory?createFileNotificationSecretStore(notificationSecretDirectory):undefined;
  const modelSecretDirectory=env.GOTCHU_MODEL_SECRET_DIRECTORY??(env.NODE_ENV==='production'?undefined:resolve('.local/dev/model-secrets'));
  const modelSecrets=modelSecretDirectory?createFileModelSecretStore(modelSecretDirectory):undefined;
  const modelProbeClient = gatewayModelProbeClient(env);
  const validationService = apiDatabase ? createValidationService({ database: apiDatabase }) : undefined;
  const loadBoundSingleAppRepository = singleAppPublicGitHubApp && apiDatabase ? async (scope: {
    organizationId: string; applicationId: string; repositoryLinkId: string; repositoryKey: string;
  }) => {
    const linked = await apiDatabase.tenant(scope.organizationId, tx => loadSingleAppRepository(tx, {
      organizationId: scope.organizationId,
      applicationId: scope.applicationId,
      repositoryLinkId: scope.repositoryLinkId,
    }, singleAppPublicGitHubApp.id));
    if (linked.repositoryKey !== scope.repositoryKey) throw new BackendError('repository_link_unavailable', 'The active GitHub repository link is unavailable', 409);
    return linked;
  } : undefined;
  const actionVerifier = apiDatabase ? createActionVerifier({ database: apiDatabase, pinnedRootfsDigest: readPinnedRootfsDigest(), repository: {
    ...(loadBoundSingleAppRepository ? { writerInstallationIdFor: async (scope: { organizationId:string; applicationId:string; repositoryLinkId:string; repositoryKey:string }) => (await loadBoundSingleAppRepository(scope)).installationId }
      : env.GOTCHU_GITHUB_WRITER_INSTALLATION_ID ? { writerInstallationId:env.GOTCHU_GITHUB_WRITER_INSTALLATION_ID } : {}),
    async readHead(scope) {
      if (loadBoundSingleAppRepository && singleAppGitHubBroker) {
        const linked = await loadBoundSingleAppRepository(scope);
        if (linked.defaultBranch !== scope.branch) throw new BackendError('repository_branch_mismatch', 'The requested branch is not the linked repository default branch', 409);
        const response = await singleAppGitHubBroker.readRepository({
          organizationId: scope.organizationId, applicationId: scope.applicationId,
          repositoryLinkId: scope.repositoryLinkId, read: 'head',
        });
        if (response.result.kind !== 'head') throw new BackendError('repository_reader_unavailable', 'The GitHub broker did not return a branch head', 503);
        return response.result.sha;
      }
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
      if (loadBoundSingleAppRepository && singleAppGitHubBroker) {
        await loadBoundSingleAppRepository(scope);
        const response = await singleAppGitHubBroker.readRepository({
          organizationId: scope.organizationId, applicationId: scope.applicationId,
          repositoryLinkId: scope.repositoryLinkId, read: 'tree', commitSha: scope.commitSha,
        });
        if (response.result.kind !== 'tree') throw new BackendError('repository_reader_unavailable', 'The GitHub broker did not return a repository tree', 503);
        return response.result.tree;
      }
      const adapter = await githubReaderAdapter(env, readerApp, { ...scope, repositoryKey: scope.repositoryKey });
      return adapter.readTree(scope.commitSha);
    },
    async isPolicyCurrent(input) {
      const codeVersion = actionPolicyVersion(input.capabilityId);
      if (!codeVersion || codeVersion !== input.policyVersion) return false;
      const result = await apiDatabase.tenant(input.organizationId, tx => tx.query<{ active_version: string }>(
        'SELECT active_version FROM gotchu.action_policy_registry WHERE capability_id=$1', [input.capabilityId],
      ));
      return result.rows[0]?.active_version === codeVersion;
    },
    async inspectAutomation(scope) {
      if (loadBoundSingleAppRepository && singleAppGitHubBroker) {
        await loadBoundSingleAppRepository(scope);
        const response = await singleAppGitHubBroker.readRepository({
          organizationId: scope.organizationId, applicationId: scope.applicationId,
          repositoryLinkId: scope.repositoryLinkId, read: 'automation', commitSha: scope.baseCommit,
        });
        if (response.result.kind !== 'automation') throw new BackendError('repository_reader_unavailable', 'The GitHub broker did not return automation findings', 503);
        return response.result.violations.map(({ path, rule }) => ({ path, rule }));
      }
      const adapter = await githubReaderAdapter(env, readerApp, { ...scope, repositoryKey: scope.repositoryKey });
      return adapter.inspectAutomation(scope.baseCommit);
    },
  }, validationFacts: {
    getFacts: input => validationService?.getValidationFacts(input) ?? Promise.resolve(null),
  } }) : undefined;
  const web = apiDatabase ? createBackend({ database: apiDatabase, ...(webAuthn ? { webAuthn: { ...webAuthn, ...(accounts ? { verifyPassword: (userId: string, password: string) => accounts.reauthenticate(userId, password) } : {}) } } : {}), webhookValidator: createNotificationWebhookValidator(dnsServers), modelEndpointValidator: createModelEndpointValidator({ allowSelfHostedEndpoints: env.GOTCHU_ALLOW_SELF_HOSTED_LLM_ENDPOINT === 'true' }), ...(notificationSecrets ? { notificationSecrets } : {}), ...(modelSecrets ? { modelSecrets } : {}), ...(modelProbeClient ? { modelProbeClient } : {}), ...(actionVerifier ? { actionVerifier } : {}), ...(verifyRepositoryWriteAccess ? { repositoryWriteAccessVerifier: verifyRepositoryWriteAccess } : {}), ...(eventCredentials ? { eventCredentials } : {}) }) : null;
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
  const openRouterLogins = web ? createOpenRouterLogins(origin, web.investigationModels) : undefined;
  const handleCustomer = createCustomerApi({ auth, origin, services: web ? { ...web.customers, ...(web.stepUp ? { stepUp: web.stepUp } : {}), telemetry: web.telemetry, protection: web.protection, operations: web.operations, decisionRecords: web.decisionRecords, corrections: web.corrections, aiCorrections: web.aiCorrections, context: web.context, triage: web.triage, investigationModels: web.investigationModels, investigations: web.investigations,
    members: web.members,
    github: web.github,
    notifications: web.notifications,
    retention: web.retention,
    actions: web.actions,
    workflowExceptions: web.workflowExceptions,
    validations: web.validations,
    repositoryCatalog: async (identity, scope) => {
      if (singleAppMode) return [];
      await web.operations.getConfig(identity, scope);
      if (!env.GOTCHU_MONITORING_CONFIG_FILE) return [];
      const catalog = await loadMonitoringRepositoryCatalog(env.GOTCHU_MONITORING_CONFIG_FILE);
      return catalog.listAllowedRepositoryOptions(scope).map(entry => ({ key: entry.repositoryKey, label: entry.displayName }));
    },
    job: (identity, value) => web.web.getJob(identity, value) } : null,
    ...(web && openRouterLogins && selfHostMode && ['localhost', '127.0.0.1', '[::1]'].includes(configuredOrigin.hostname) && modelSecrets
      ? { providerConnections: createProviderConnections(web.investigationModels, (provider, scope) => provider === 'codex' ? startCodexDeviceLogin(env.GOTCHU_CODEX_BIN || 'codex') : provider === 'claude_code' ? startClaudeTokenLogin(env.GOTCHU_CLAUDE_CODE_BIN || 'claude') : openRouterLogins.start(scope)), openRouterLogins } : {}),
    ...(accounts ? { localAccounts: accounts } : {}),
    registrationEnabled: Boolean(accounts) && auth.enabled && (publicSignup || (!selfHostMode && env.NODE_ENV === 'development' && env.GOTCHU_ALLOW_LOCAL_REGISTRATION === 'true')),
    selfHostSetup: selfHostMode,
    providers: publicAuthProviders(settings),
    ...(singleAppPublicGitHubApp && singleAppGitHubBroker ? { singleAppGitHub: { publicApp: singleAppPublicGitHubApp, broker: singleAppGitHubBroker } } : {}),
    ...(!singleAppMode && env.GOTCHU_GITHUB_READER_APP_FILE ? { githubAppFile: env.GOTCHU_GITHUB_READER_APP_FILE } : {}),
    ...(!singleAppMode && env.GOTCHU_GITHUB_APP_SLUG ? { githubAppSlug: env.GOTCHU_GITHUB_APP_SLUG } : {}),
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
