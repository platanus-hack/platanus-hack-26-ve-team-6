import { readFileSync } from 'node:fs';

const compose = JSON.parse(readFileSync(0, 'utf8'));
const services = compose.services ?? {};
const fail = (message) => {
  process.stderr.write(`Compose policy validation failed: ${message}\n`);
  process.exit(1);
};
const requireValue = (condition, message) => {
  if (!condition) fail(message);
};
const hasLoopbackPort = (service, target) => (service.ports ?? []).some((port) =>
  port.target === target && port.host_ip === '127.0.0.1'
  && Number.isInteger(Number(port.published)) && Number(port.published) >= 1 && Number(port.published) <= 65535);
const logicalNetworkNames = ['data', 'local-data-host', 'control-plane', 'web-egress', 'agent-link', 'scanner-boundary'];
const normalizeNetworkName = (name) => logicalNetworkNames.find((logical) =>
  name === logical || name.endsWith(`_${logical}`) || name.endsWith(`-${logical}`)) ?? name;
const networkDefinition = (logicalName) => compose.networks?.[logicalName]
  ?? Object.entries(compose.networks ?? {}).find(([name]) => normalizeNetworkName(name) === logicalName)?.[1];

requireValue(services.postgres?.image?.startsWith('postgres:17.'), 'PostgreSQL must stay on supported major version 17.');
requireValue(services.redis?.image?.startsWith('redis:7.4.'), 'Redis must stay on maintained 7.4 extended support.');
requireValue(hasLoopbackPort(services.postgres, 5432), 'PostgreSQL must bind a valid published port to loopback only.');
requireValue(hasLoopbackPort(services.redis, 6379), 'Redis must bind a valid published port to loopback only.');
requireValue((services.postgres.volumes ?? []).some((volume) => volume.target === '/var/lib/postgresql/data'), 'PostgreSQL data must use persistent storage.');
requireValue((services.redis.volumes ?? []).some((volume) => volume.target === '/data'), 'Redis data must use persistent storage.');
requireValue(Object.keys(services.postgres.networks ?? {}).includes('data') && Object.keys(services.postgres.networks ?? {}).includes('local-data-host'), 'Postgres must stay on the internal data network and loopback-only host access network.');
requireValue(Object.keys(services.redis.networks ?? {}).includes('data') && Object.keys(services.redis.networks ?? {}).includes('local-data-host'), 'Redis must stay on the internal data network and loopback-only host access network.');

const expectedProfiles = {
  web: 'web',
  coordinator: 'coordinator',
  gateway: 'gateway',
  agent: 'agent',
  executor: 'executor',
  'scanner-boundary': 'scanner',
};
for (const [name, profile] of Object.entries(expectedProfiles)) {
  const service = services[name];
  requireValue(service, `missing planned service boundary: ${name}`);
  requireValue((service.profiles ?? []).includes(profile), `${name} must remain behind the ${profile} profile.`);
  requireValue(service.read_only === true, `${name} must use a read-only root filesystem.`);
  requireValue((service.cap_drop ?? []).includes('ALL'), `${name} must drop Linux capabilities.`);
  requireValue((service.security_opt ?? []).includes('no-new-privileges:true'), `${name} must prevent privilege gain.`);
}

const servicePortOwners = Object.entries(services)
  .filter(([, service]) => (service.ports ?? []).length > 0)
  .map(([name]) => name)
  .sort();
requireValue(JSON.stringify(servicePortOwners) === JSON.stringify(['coordinator', 'postgres', 'redis', 'web']), 'only local data ports and loopback web/coordinator profiles may be published.');
requireValue(hasLoopbackPort(services.web, 3000), 'web must bind a valid published port to loopback only.');
requireValue(hasLoopbackPort(services.coordinator, 3003), 'coordinator must bind a valid published port to loopback only.');

const normalizedNetworkNames = (service) => Object.keys(service.networks ?? {}).map(normalizeNetworkName);
const scannerNetworks = normalizedNetworkNames(services['scanner-boundary']);
requireValue(scannerNetworks.length === 1 && scannerNetworks[0] === 'scanner-boundary', 'scanner boundary must not join control-plane or data networks.');
requireValue((services['scanner-boundary'].volumes ?? []).length === 0, 'scanner boundary must not mount host paths or the Docker socket.');
requireValue(!Object.keys(services['scanner-boundary'].environment ?? {}).some((key) => /DATABASE|REDIS|TOKEN|SECRET|CREDENTIAL/i.test(key)), 'scanner boundary must receive no database, Redis, or credential environment.');
const agentNetworks = normalizedNetworkNames(services.agent);
requireValue(!agentNetworks.includes('data'), 'agent must not join the database/Redis network.');
requireValue(!Object.keys(services.agent.environment ?? {}).some((key) => /DATABASE|REDIS|TOKEN|SECRET|CREDENTIAL/i.test(key)), 'agent must receive no database, Redis, or credential environment.');
requireValue(Object.keys(services.web.environment ?? {}).includes('GOTCHU_API_DATABASE_URL'), 'web must use the gotchu_api runtime login.');
requireValue(Object.keys(services.web.environment ?? {}).includes('GOTCHU_INGEST_DATABASE_URL'), 'event ingestion must use the distinct gotchu_ingest runtime login.');
requireValue(Object.keys(services.web.environment ?? {}).includes('GOTCHU_EVENT_SIGNING_KEYS_JSON'), 'web must accept the optional local event-signing credential map.');
requireValue(Object.keys(services.web.environment ?? {}).includes('GOTCHU_GITHUB_READER_APP_FILE'), 'web must accept the optional GitHub reader app file path.');
const githubCredentialsMount = (services.web.volumes ?? []).find((volume) => volume.target === '/run/secrets/github');
requireValue(githubCredentialsMount?.type === 'bind' && githubCredentialsMount.read_only === true && githubCredentialsMount.source.endsWith('/github'), 'web may mount only the private GitHub credential directory, read-only.');
requireValue(Object.keys(services.coordinator.environment ?? {}).includes('GOTCHU_COORDINATOR_DATABASE_URL'), 'coordinator must use the gotchu_coordinator runtime login.');
requireValue(Object.keys(services.coordinator.environment ?? {}).includes('GOTCHU_REDIS_URL'), 'only the trusted coordinator may receive Redis access.');
requireValue(Object.keys(services.gateway.environment ?? {}).includes('GOTCHU_GATEWAY_DATABASE_URL'), 'gateway must use its own gotchu_coordinator runtime login.');
requireValue(Object.keys(services.gateway.environment ?? {}).includes('GOTCHU_RUN_CAPABILITY_PUBLIC_KEY'), 'gateway must receive the run capability verification key.');
requireValue(!Object.keys(services.gateway.environment ?? {}).some((key) => /PRIVATE_KEY|REDIS|PROVIDER.*(TOKEN|SECRET|CREDENTIAL)/i.test(key)), 'gateway must not receive a signing private key, Redis login, or provider credential.');
requireValue(!Object.keys(services.coordinator.environment ?? {}).includes('GOTCHU_EVENT_SIGNING_KEYS_JSON'), 'event-signing credential material must not be passed to the coordinator.');
requireValue(!Object.keys(services.agent.environment ?? {}).includes('GOTCHU_EVENT_SIGNING_KEYS_JSON'), 'event-signing credential material must not be passed to the agent.');
const gatewayNetworks = normalizedNetworkNames(services.gateway).sort();
requireValue(JSON.stringify(gatewayNetworks) === JSON.stringify(['agent-link', 'data']), 'gateway must only join its agent link and database network.');
requireValue(!Object.keys(services.executor.environment ?? {}).some((key) => /REDIS|PRIVATE_KEY|PROVIDER.*(TOKEN|SECRET|CREDENTIAL)/i.test(key)), 'executor gets no Redis, signing private key, or provider credentials until write execution is wired.');
requireValue(Object.keys(services.executor.environment ?? {}).includes('GOTCHU_EXECUTOR_DATABASE_URL'), 'executor must use the gotchu_executor runtime login.');
requireValue((services.executor.command ?? []).some((part) => String(part).includes('process.exit(78)')), 'Compose must keep the executor disabled; the self-host installer manages its loopback process.');
requireValue((services.executor.ports ?? []).length === 0 && (services.executor.volumes ?? []).length === 0, 'Compose must not publish the executor or mount its Writer App credentials.');
requireValue((services.executor.command ?? []).some((part) => String(part).includes('process.exit(78)')), 'Compose must keep the executor disabled; the self-host installer manages its loopback process.');
requireValue((services.executor.ports ?? []).length === 0 && (services.executor.volumes ?? []).length === 0, 'Compose must not publish the executor or mount its Writer App credentials.');
requireValue(normalizedNetworkNames(services.agent).length === 1 && normalizedNetworkNames(services.agent)[0] === 'agent-link', 'apps/worker agent must use only the agent link.');
const webNetworks = normalizedNetworkNames(services.web).sort();
requireValue(JSON.stringify(webNetworks) === JSON.stringify(['control-plane', 'data', 'web-egress']), 'web must use control-plane/data plus its dedicated outbound network.');
const coordinatorNetworks = normalizedNetworkNames(services.coordinator).sort();
requireValue(JSON.stringify(coordinatorNetworks) === JSON.stringify(['agent-link', 'control-plane', 'data', 'local-app-host']), 'coordinator must use internal app/data networks plus its host-only publishing bridge.');
requireValue(Object.keys(services.coordinator.environment ?? {}).includes('GOTCHU_COORDINATOR_HOST'), 'coordinator must bind through GOTCHU_COORDINATOR_HOST.');
requireValue(!Object.keys(services.coordinator.environment ?? {}).includes('HOST'), 'coordinator must not use the unrelated HOST setting.');
const appUser = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(services.web.user ?? '');
requireValue(appUser && services.coordinator.user === services.web.user, 'built applications must run as the same unprivileged host user for private bind-mounted credentials.');
requireValue(services.web.build?.target === 'web' && services.coordinator.build?.target === 'coordinator', 'web and coordinator must build their real multi-stage application targets.');
requireValue(!String(services.web.command ?? []).includes('process.exit(78)') && !String(services.coordinator.command ?? []).includes('process.exit(78)'), 'web and coordinator must not use placeholder exit commands.');
const healthcheckText = (service) => JSON.stringify(service.healthcheck?.test ?? []);
requireValue(healthcheckText(services.web).includes('/api/ready'), 'web health must use its actual readiness route.');
requireValue(healthcheckText(services.web).includes('body.ready'), 'web health must follow the web readiness contract.');
requireValue(healthcheckText(services.coordinator).includes('/health/ready'), 'coordinator health must use its actual readiness route.');
requireValue(healthcheckText(services.coordinator).includes("body.status === 'ready'"), 'coordinator health must follow the coordinator readiness contract.');
for (const name of ['agent', 'gateway', 'executor', 'scanner-boundary']) {
  requireValue(services[name].image?.startsWith('node:24.'), `${name} must retain its explicit disabled Node boundary.`);
  requireValue((services[name].command ?? []).some((part) => String(part).includes('process.exit(78)')), `${name} must fail closed with status 78 until its deployment gate passes.`);
}
const egressUsers = Object.entries(services)
  .filter(([, service]) => Object.keys(service.networks ?? {}).some((name) => normalizeNetworkName(name) === 'web-egress'))
  .map(([name]) => name);
requireValue(JSON.stringify(egressUsers) === JSON.stringify(['web']), 'only web may join the outbound web-egress bridge for GitHub OAuth.');
requireValue(networkDefinition('web-egress')?.internal !== true, 'web-egress must retain outbound connectivity for the GitHub OAuth flow.');
requireValue(networkDefinition('web-egress')?.driver_opts?.['com.docker.network.bridge.enable_ip_masquerade'] === 'true', 'web-egress must provide the explicit bridge NAT route required for OAuth.');
const webEgressAttachment = Object.entries(services.web.networks ?? {}).find(([name]) => normalizeNetworkName(name) === 'web-egress')?.[1];
requireValue(Number(webEgressAttachment?.gw_priority) >= 1, 'web-egress must be the preferred default route across the attached networks.');
requireValue(networkDefinition('data')?.internal === true, 'data network must be internal.');
requireValue(networkDefinition('local-data-host')?.driver_opts?.['com.docker.network.bridge.enable_ip_masquerade'] === 'false', 'host-only data access must not enable outbound masquerading.');
requireValue(networkDefinition('local-data-host')?.driver_opts?.['com.docker.network.bridge.enable_icc'] === 'false', 'host-only data access must isolate data containers from one another.');
requireValue(networkDefinition('local-app-host')?.driver_opts?.['com.docker.network.bridge.enable_ip_masquerade'] === 'false', 'coordinator host publishing must not enable outbound masquerading.');
requireValue(networkDefinition('local-app-host')?.driver_opts?.['com.docker.network.bridge.enable_icc'] === 'false', 'coordinator host publishing bridge must isolate peer containers.');
requireValue(networkDefinition('scanner-boundary')?.internal === true, 'scanner network must be internal.');
requireValue(services.postgres.read_only === true && services.redis.read_only === true, 'local data services must use read-only container roots.');
for (const name of ['postgres', 'redis']) {
  requireValue(services[name].user === '999:999', `${name} must run as its image's unprivileged service UID.`);
  requireValue((services[name].cap_drop ?? []).includes('ALL'), `${name} must drop Linux capabilities.`);
  requireValue((services[name].security_opt ?? []).includes('no-new-privileges:true'), `${name} must prevent privilege gain.`);
}
requireValue((services.redis.command ?? []).some((part) => String(part).includes('--appendonly yes')), 'Redis must enable persistent AOF writes.');

process.stdout.write('Compose configuration and boundary policy validated.\n');
