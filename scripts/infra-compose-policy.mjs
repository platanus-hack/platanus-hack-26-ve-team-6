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
const hasLoopbackPort = (service, target, published) => (service.ports ?? []).some((port) =>
  port.target === target && port.published === String(published) && port.host_ip === '127.0.0.1');

requireValue(services.postgres?.image?.startsWith('postgres:17.'), 'PostgreSQL must stay on supported major version 17.');
requireValue(services.redis?.image?.startsWith('redis:7.4.'), 'Redis must stay on maintained 7.4 extended support.');
requireValue(hasLoopbackPort(services.postgres, 5432, '55432'), 'PostgreSQL must bind to loopback port 55432 only.');
requireValue(hasLoopbackPort(services.redis, 6379, '56379'), 'Redis must bind to loopback port 56379 only.');
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
requireValue(hasLoopbackPort(services.web, 3000, '3000'), 'web must bind to loopback port 3000.');
requireValue(hasLoopbackPort(services.coordinator, 3003, '3003'), 'coordinator must bind to loopback port 3003.');

const normalizedNetworkNames = (service) => Object.keys(service.networks ?? {}).map((name) => name.replace(/^gotchu[-_]/, ''));
const scannerNetworks = normalizedNetworkNames(services['scanner-boundary']);
requireValue(scannerNetworks.length === 1 && scannerNetworks[0] === 'scanner-boundary', 'scanner boundary must not join control-plane or data networks.');
requireValue((services['scanner-boundary'].volumes ?? []).length === 0, 'scanner boundary must not mount host paths or the Docker socket.');
requireValue(!Object.keys(services['scanner-boundary'].environment ?? {}).some((key) => /DATABASE|REDIS|TOKEN|SECRET|CREDENTIAL/i.test(key)), 'scanner boundary must receive no database, Redis, or credential environment.');
const agentNetworks = normalizedNetworkNames(services.agent);
requireValue(!agentNetworks.includes('data'), 'agent must not join the database/Redis network.');
requireValue(!Object.keys(services.agent.environment ?? {}).some((key) => /DATABASE|REDIS|TOKEN|SECRET|CREDENTIAL/i.test(key)), 'agent must receive no database, Redis, or credential environment.');
requireValue(Object.keys(services.web.environment ?? {}).includes('GOTCHU_API_DATABASE_URL'), 'web must use the gotchu_api runtime login.');
requireValue(Object.keys(services.web.environment ?? {}).includes('GOTCHU_INGEST_DATABASE_URL'), 'event ingestion must use the distinct gotchu_ingest runtime login.');
requireValue(Object.keys(services.coordinator.environment ?? {}).includes('GOTCHU_COORDINATOR_DATABASE_URL'), 'coordinator must use the gotchu_coordinator runtime login.');
requireValue(Object.keys(services.coordinator.environment ?? {}).includes('GOTCHU_REDIS_URL'), 'only the trusted coordinator may receive Redis access.');
requireValue(Object.keys(services.gateway.environment ?? {}).includes('GOTCHU_GATEWAY_DATABASE_URL'), 'gateway must use its own gotchu_coordinator runtime login.');
requireValue(Object.keys(services.gateway.environment ?? {}).includes('GOTCHU_RUN_CAPABILITY_PUBLIC_KEY'), 'gateway must receive the run capability verification key.');
requireValue(!Object.keys(services.gateway.environment ?? {}).some((key) => /PRIVATE_KEY|REDIS|PROVIDER.*(TOKEN|SECRET|CREDENTIAL)/i.test(key)), 'gateway must not receive a signing private key, Redis login, or provider credential.');
const gatewayNetworks = normalizedNetworkNames(services.gateway).sort();
requireValue(JSON.stringify(gatewayNetworks) === JSON.stringify(['agent-link', 'data']), 'gateway must only join its agent link and database network.');
requireValue(!Object.keys(services.executor.environment ?? {}).some((key) => /REDIS|PRIVATE_KEY|PROVIDER.*(TOKEN|SECRET|CREDENTIAL)/i.test(key)), 'executor gets no Redis, signing private key, or provider credentials until write execution is wired.');
requireValue(Object.keys(services.executor.environment ?? {}).includes('GOTCHU_EXECUTOR_DATABASE_URL'), 'executor must use the gotchu_executor runtime login.');
requireValue(normalizedNetworkNames(services.agent).length === 1 && normalizedNetworkNames(services.agent)[0] === 'agent-link', 'apps/worker agent must use only the agent link.');
requireValue(compose.networks?.data?.internal === true, 'data network must be internal.');
requireValue(compose.networks?.['local-data-host']?.driver_opts?.['com.docker.network.bridge.enable_ip_masquerade'] === 'false', 'host-only data access must not enable outbound masquerading.');
requireValue(compose.networks?.['local-data-host']?.driver_opts?.['com.docker.network.bridge.enable_icc'] === 'false', 'host-only data access must isolate data containers from one another.');
requireValue(compose.networks?.['scanner-boundary']?.internal === true, 'scanner network must be internal.');
requireValue(services.postgres.read_only === true && services.redis.read_only === true, 'local data services must use read-only container roots.');
for (const name of ['postgres', 'redis']) {
  requireValue(services[name].user === '999:999', `${name} must run as its image's unprivileged service UID.`);
  requireValue((services[name].cap_drop ?? []).includes('ALL'), `${name} must drop Linux capabilities.`);
  requireValue((services[name].security_opt ?? []).includes('no-new-privileges:true'), `${name} must prevent privilege gain.`);
}
requireValue((services.redis.command ?? []).some((part) => String(part).includes('--appendonly yes')), 'Redis must enable persistent AOF writes.');

process.stdout.write('Compose configuration and boundary policy validated.\n');
