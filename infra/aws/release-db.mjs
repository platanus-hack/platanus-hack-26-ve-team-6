// Root-only operator boundary: never pass database credentials in command arguments or logs.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const [mode, release] = process.argv.slice(2);
if (!['snapshot', 'migrate'].includes(mode) || !release?.startsWith('/opt/gotchu/releases/')) {
  throw new Error('Invalid database release operation');
}
const configuration = new Map((await readFile('/var/lib/gotchu-admin/state/.env', 'utf8')).split('\n')
  .filter(line => line && !line.startsWith('#')).map(line => {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Invalid operator configuration');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
function required(name) {
  const value = configuration.get(name);
  if (!value) throw new Error(`Missing operator setting ${name}`);
  return value;
}
const url = new URL(`postgresql://127.0.0.1:${required('POSTGRES_HOST_PORT')}/${required('POSTGRES_DB')}`);
url.username = required('POSTGRES_USER');
url.password = required('POSTGRES_PASSWORD');
const connectionString = url.href;
if (mode === 'migrate') {
  const { migrate } = await import(pathToFileURL(`${release}/packages/database/dist/migrate.js`).href);
  await migrate({ connectionString });
} else {
  const require = createRequire(`${release}/packages/database/package.json`);
  const pg = require('pg');
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
  await client.connect();
  try {
    const result = await client.query('SELECT name, checksum FROM gotchu.schema_migrations ORDER BY name');
    process.stdout.write(JSON.stringify(result.rows));
  } finally { await client.end(); }
}
