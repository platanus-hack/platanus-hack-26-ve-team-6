import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { Database } from '@gotchu/database';
import { z } from 'zod';
import { HttpError } from './http.js';

const systemScope = '00000000-0000-4000-8000-000000000000';
export const localRegistrationSchema = z.object({ email: z.email().max(254).transform(email => email.toLowerCase()), password: z.string().min(15).max(128) }).strict();
const loginSchema = localRegistrationSchema.safeExtend({ password: z.string().min(1).max(128) });
const storedSchema = z.object({ id: z.uuid(), password_hash: z.string(), epoch: z.number().int().positive() });
const hashPattern = /^scrypt-v1\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$/;
async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  // OWASP's 32 MiB scrypt profile; bounded concurrency limits authentication memory.
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, derived) => error ? reject(error) : resolve(derived));
  });
  return `scrypt-v1$32768$8$3$${salt}$${key.toString('hex')}`;
}
async function verifyPassword(password: string, encoded: string) {
  const match = hashPattern.exec(encoded);
  if (!match?.[1] || !match[2]) return false;
  const actual = await hashPassword(password, match[1]);
  return timingSafeEqual(Buffer.from(actual), Buffer.from(encoded));
}
export interface LocalAccounts {
  register(input: unknown): Promise<{ id: string }>;
  authenticate(input: unknown): Promise<{ id: string; email: string; credentialEpoch: number } | null>;
  accountEmail(userId: string): Promise<string | null>;
  reauthenticate(userId: string, password: string): Promise<boolean | null>;
  epoch(id: string): Promise<number | null>;
}

export function createLocalAccounts(database: Database): LocalAccounts {
  if (database.role !== 'gotchu_api') throw new Error('Local authentication requires the restricted API login');
  let activeDerivations = 0;
  async function bounded<T>(work: () => Promise<T>) {
    if (activeDerivations >= 2) throw new HttpError(429, 'authentication_busy', 'La autenticación está ocupada. Inténtalo en unos segundos.');
    activeDerivations++;
    try { return await work(); } finally { activeDerivations--; }
  }
  async function admit(email: string) {
    const bucket = createHash('sha256').update(email).digest('hex');
    // Commit rejected attempts too; rolling back a denial would erase the limiter.
    const permitted = await database.tenant(systemScope, async tx => {
      const global = await tx.query<{ allowed: boolean }>("SELECT gotchu.auth_admit('login:global',60,60) AS allowed");
      const account = await tx.query<{ allowed: boolean }>('SELECT gotchu.auth_admit($1,5,900) AS allowed', [`login:${bucket}`]);
      return global.rows[0]?.allowed === true && account.rows[0]?.allowed === true;
    });
    if (!permitted) throw new HttpError(429, 'authentication_rate_limit', 'Demasiados intentos. Espera antes de volver a entrar.');
  }
  return {
    register: async input => {
      const value = localRegistrationSchema.parse(input);
      const admitted = await database.tenant(systemScope, async tx => {
        const result = await tx.query<{ allowed: boolean }>("SELECT gotchu.auth_admit('register:global',10,3600) AS allowed");
        return result.rows[0]?.allowed === true;
      });
      if (!admitted) throw new HttpError(429, 'registration_rate_limit', 'Se ha alcanzado el límite temporal de registro.');
      return bounded(async () => {
        const encoded = await hashPassword(value.password);
        const id = await database.tenant(systemScope, async tx => {
          const result = await tx.query<{ id: string | null }>('SELECT gotchu.auth_create_account($1,$2,$3) AS id', [randomUUID(), value.email, encoded]);
          return result.rows[0]?.id;
        });
        if (!id) throw new HttpError(409, 'registration_unavailable', 'No se pudo crear la cuenta. Puede existir o haberse alcanzado el límite de registro.');
        return { id };
      });
    },
    authenticate: async input => {
      const parsed = loginSchema.safeParse(input);
      if (!parsed.success) return null;
      const value = parsed.data;
      await admit(value.email);
      return bounded(async () => {
        const rows = await database.tenant(systemScope, tx => tx.query('SELECT * FROM gotchu.auth_lookup($1)', [value.email]));
        const record = rows.rows[0] ? storedSchema.parse(rows.rows[0]) : null;
        // Equal work for missing accounts; no reusable password or provider token is persisted.
        const encoded = record?.password_hash ?? 'scrypt-v1$32768$8$3$00000000000000000000000000000000$' + '0'.repeat(128);
        const valid = await verifyPassword(value.password, encoded);
        return valid && record ? { id: record.id, email: value.email, credentialEpoch: record.epoch } : null;
      });
    },
    accountEmail: async userId => {
      const subject = /^credentials:([0-9a-f-]{36})$/.exec(userId)?.[1];
      if (!subject || !z.uuid().safeParse(subject).success) return null;
      const result = await database.tenant(systemScope, tx => tx.query<{ email: string | null }>('SELECT gotchu.auth_lookup_email($1) AS email', [subject]));
      const email = result.rows[0]?.email;
      return email ? z.email().parse(email).toLowerCase() : null;
    },
    reauthenticate: async (userId, password) => {
      const subject = /^credentials:([0-9a-f-]{36})$/.exec(userId)?.[1];
      if (!subject || !z.uuid().safeParse(subject).success) return null;
      const parsed = z.string().min(1).max(128).safeParse(password);
      if (!parsed.success) return false;
      const bucket = createHash('sha256').update(subject).digest('hex');
      const admitted = await database.tenant(systemScope, async tx => {
        const global = await tx.query<{ allowed: boolean }>("SELECT gotchu.auth_admit('login:global',60,60) AS allowed");
        const account = await tx.query<{ allowed: boolean }>('SELECT gotchu.auth_admit($1,5,900) AS allowed', [`login:${bucket}`]);
        return global.rows[0]?.allowed === true && account.rows[0]?.allowed === true;
      });
      if (!admitted) throw new HttpError(429, 'authentication_rate_limit', 'Demasiados intentos. Espera antes de volver a entrar.');
      return bounded(async () => {
        const rows = await database.tenant(systemScope, tx => tx.query('SELECT * FROM gotchu.auth_lookup_id($1)', [subject]));
        const record = rows.rows[0] ? storedSchema.parse(rows.rows[0]) : null;
        const encoded = record?.password_hash ?? 'scrypt-v1$32768$8$3$00000000000000000000000000000000$' + '0'.repeat(128);
        const valid = await verifyPassword(parsed.data, encoded);
        return record ? valid : null;
      });
    },
    epoch: async id => {
      if (!z.uuid().safeParse(id).success) return null;
      return database.tenant(systemScope, async tx => {
        const result = await tx.query<{ epoch: number | null }>('SELECT gotchu.auth_epoch($1) AS epoch', [id]);
        return result.rows[0]?.epoch ?? null;
      });
    },
  };
}
