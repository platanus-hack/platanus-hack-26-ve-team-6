import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database, Transaction } from '@gotchu/database';
import { DEMO_ASSESSMENT_SCOPE } from './demo.js';

export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
export interface CredentialStore { getSigningSecret(reference: string): Promise<Uint8Array> }
export interface Identity { userId: string }
export const identitySchema = z.object({ userId: z.string().min(1).max(256) }).strict();
export const roleSchema = z.enum(['owner', 'operator', 'viewer']);
export type MembershipRole = z.infer<typeof roleSchema>;
export class BackendError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, options?: ErrorOptions) { super(message, options); this.name = 'BackendError'; }
}
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BackendError('invalid_input', 'Input does not match the required contract');
  return result.data;
}
export function canonicalJson(input: unknown): string {
  if (input === null || typeof input === 'boolean' || typeof input === 'string') return JSON.stringify(input);
  if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
  if (Array.isArray(input)) return '[' + input.map(canonicalJson).join(',') + ']';
  if (input && typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype) {
    return '{' + Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => JSON.stringify(key) + ':' + canonicalJson(value)).join(',') + '}';
  }
  throw new BackendError('invalid_json', 'Canonical values must be finite JSON data');
}
export const sha256 = (input: string | Uint8Array): string => createHash('sha256').update(input).digest('hex');
export async function audit(tx: Transaction, organizationId: string, actorId: string, action: string, subjectId: string | null, detail: unknown = {}): Promise<void> {
  await tx.query('INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id,detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [organizationId, randomUUID(), actorId, action, subjectId, JSON.stringify(detail)]);
}
export async function authorize(tx: Transaction, organizationId: string, identity: Identity, allowed: readonly MembershipRole[] = ['owner', 'operator', 'viewer'], demoApplicationId?: string): Promise<MembershipRole> {
  const { userId } = parse(identitySchema, identity);
  // Only assessment methods and their job polling opt in to the fixed public demo scope.
  if (userId === DEMO_ASSESSMENT_SCOPE.userId && (organizationId.toLowerCase() !== DEMO_ASSESSMENT_SCOPE.organizationId || demoApplicationId?.toLowerCase() !== DEMO_ASSESSMENT_SCOPE.applicationId)) {
    throw new BackendError('forbidden', 'The controlled demo principal cannot access this operation or scope', 403);
  }
  // Row lock makes role revocation and a privileged operation serialize.
  const result = await tx.query<{ role: MembershipRole }>('SELECT gotchu.lock_membership($1,$2) AS role', [organizationId, userId]);
  const role = result.rows[0]?.role;
  if (!role || !allowed.includes(role)) throw new BackendError('forbidden', 'Organization membership does not authorize this operation', 403);
  return role;
}
export interface BaseDependencies { database: Database; clock?: Clock }
export const organizationIdSchema = z.uuid();
export const scopedIdSchema = z.object({ organizationId: z.uuid(), applicationId: z.uuid() }).strict();
