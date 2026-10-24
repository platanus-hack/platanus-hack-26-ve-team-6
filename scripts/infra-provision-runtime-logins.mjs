const databasePackage = new URL('../packages/database/dist/index.js', import.meta.url);
const { provisionRuntimeLogin } = await import(databasePackage.href);

const connectionString = process.env.GOTCHU_MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('GOTCHU_MIGRATION_DATABASE_URL is required.');

const roleLogins = [
  ['gotchu_api', 'GOTCHU_API_DB_USERNAME', 'GOTCHU_API_DB_PASSWORD'],
  ['gotchu_ingest', 'GOTCHU_INGEST_DB_USERNAME', 'GOTCHU_INGEST_DB_PASSWORD'],
  ['gotchu_coordinator', 'GOTCHU_COORDINATOR_DB_USERNAME', 'GOTCHU_COORDINATOR_DB_PASSWORD'],
  ['gotchu_coordinator', 'GOTCHU_GATEWAY_DB_USERNAME', 'GOTCHU_GATEWAY_DB_PASSWORD'],
  ['gotchu_executor', 'GOTCHU_EXECUTOR_DB_USERNAME', 'GOTCHU_EXECUTOR_DB_PASSWORD'],
];

for (const [role, usernameKey, passwordKey] of roleLogins) {
  const username = process.env[usernameKey];
  const password = process.env[passwordKey];
  if (!username || !password) throw new Error(`Generated login configuration is missing for ${role}.`);
  await provisionRuntimeLogin({ connectionString, username, password, role });
}

process.stdout.write('Provisioned five local runtime logins through @gotchu/database.\n');
