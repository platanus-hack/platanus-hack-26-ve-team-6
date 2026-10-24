import { migrateGateway } from './migrate.js';

try {
  const connectionString = process.env.GOTCHU_MIGRATION_DATABASE_URL;
  if (!connectionString) throw new Error('missing_operator_connection');
  await migrateGateway({ connectionString });
  process.stdout.write('Gateway migrations applied.\n');
} catch {
  process.stderr.write('Gateway migration failed; inspect operator configuration and migration state.\n');
  process.exitCode = 1;
}
