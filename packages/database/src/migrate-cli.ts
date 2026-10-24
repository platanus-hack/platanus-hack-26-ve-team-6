import { migrate } from './migrate.js';
const connectionString = process.env.GOTCHU_MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('GOTCHU_MIGRATION_DATABASE_URL is required');
await migrate({ connectionString });
process.stdout.write('Gotchu migrations applied.\n');
