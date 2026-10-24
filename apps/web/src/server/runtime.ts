import { createBackend, type Backend, type CredentialStore } from '@gotchu/backend';
import { createDatabase } from '@gotchu/database';
import { z } from 'zod';
import { createApi, type ApiOperation } from './api.js';
import { authSettings, createAuthService, publicAuthProviders, type AuthService } from './auth.js';
import { HttpError } from './http.js';
import { bindDemoAssessmentServices, createDemoAssessmentApi } from './demo.js';
import { createLocalAccounts } from './local-accounts.js';
import { createCustomerApi } from './customer-api.js';
import { createCustomerDnsVerifier } from './customer-dns.js';
import { createFileEventCredentials } from './event-credentials.js';

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
    execute: async (identity, operation) => {
      if (!options.web) throw new HttpError(503, 'database_not_configured', 'Customer data access is unavailable');
      return execute(options.web, identity, operation);
    },
  });
}

export function createWebRuntime(env: NodeJS.ProcessEnv = process.env) {
  const origin = new URL(env.PUBLIC_APP_URL ?? 'http://localhost:3000').origin;
  const apiDatabase = env.GOTCHU_API_DATABASE_URL ? createDatabase({ connectionString: env.GOTCHU_API_DATABASE_URL, role: 'gotchu_api', max: 5 }) : null;
  const ingestDatabase = env.GOTCHU_INGEST_DATABASE_URL ? createDatabase({ connectionString: env.GOTCHU_INGEST_DATABASE_URL, role: 'gotchu_ingest', max: 5 }) : null;
  const accounts = apiDatabase && env.GOTCHU_LOCAL_AUTH_ENABLED === 'true' ? createLocalAccounts(apiDatabase) : undefined;
  const settings = authSettings(env, accounts);
  const auth = createAuthService(settings);
  const dnsServers = env.GOTCHU_DNS_SERVERS_JSON ? z.array(z.string().min(1).max(100)).max(5).parse(JSON.parse(env.GOTCHU_DNS_SERVERS_JSON)) : [];
  const eventCredentials = env.GOTCHU_EVENT_CREDENTIAL_DIRECTORY ? createFileEventCredentials(env.GOTCHU_EVENT_CREDENTIAL_DIRECTORY) : undefined;
  const web = apiDatabase ? createBackend({ database: apiDatabase, customerDnsVerifier: createCustomerDnsVerifier(dnsServers), ...(eventCredentials ? { eventCredentials } : {}) }) : null;
  const configuredCredentials = credentialStore(env.GOTCHU_EVENT_SIGNING_KEYS_JSON);
  const credentials: CredentialStore | undefined = eventCredentials || configuredCredentials ? { getSigningSecret: async reference => {
    if (reference.startsWith('local-event:') && eventCredentials) return eventCredentials.getSigningSecret(reference);
    if (configuredCredentials) return configuredCredentials.getSigningSecret(reference);
    throw new HttpError(503, 'credential_unavailable', 'Integration signing credential is unavailable');
  } } : undefined;
  const intake = ingestDatabase ? createBackend({ database: ingestDatabase, ...(credentials ? { credentials } : {}) }) : null;
  const handle = createBackendApi({ auth, origin, web, intake });
  const handleDemo = createDemoAssessmentApi({ enabled: env.GOTCHU_DEMO_ENABLED === 'true', origin, services: web ? bindDemoAssessmentServices(web) : null });
  const handleCustomer = createCustomerApi({ auth, origin, services: web ? { ...web.customers, telemetry: web.telemetry, job: (identity, value) => web.web.getJob(identity, value) } : null,
    ...(accounts ? { localAccounts: accounts } : {}),
    registrationEnabled: Boolean(accounts) && auth.enabled && env.NODE_ENV === 'development' && env.GOTCHU_ALLOW_LOCAL_REGISTRATION === 'true',
    providers: publicAuthProviders(settings),
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
        capabilities: { eventSigningKeys: Boolean(credentials), freshSecondFactorApproval: false, githubWrites: false, customerCodeExecution: false, deployedAwsCoverage: false },
      };
    },
    async close() { await Promise.all([apiDatabase?.close(), ingestDatabase?.close()]); },
  };
}

let runtime: ReturnType<typeof createWebRuntime> | undefined;
export function getWebRuntime() { return runtime ??= createWebRuntime(); }
