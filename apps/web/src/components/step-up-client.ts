import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { stepUpFactorSchema, type StepUpFactor } from '@gotchu/contracts';
import { z } from 'zod';

const serverChallenge = z.object({ challengeId: z.uuid(), expiresAt: z.iso.datetime(), options: z.record(z.string(), z.unknown()) }).strict();
const proofResponse = z.object({ proof: z.string().min(32).max(128), expiresAt: z.iso.datetime() }).strict();
const factorList = z.array(stepUpFactorSchema).max(10);
async function call<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const payload: unknown = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    const problem = z.object({ error: z.object({ message: z.string() }).passthrough() }).safeParse(payload);
    throw new Error(problem.success ? problem.data.error.message : 'No se pudo completar la verificación.');
  }
  return schema.parse(payload);
}
const registrationOptionsSchema = z.object({ rp: z.object({ name: z.string(), id: z.string().optional() }).passthrough(), user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }).passthrough(), challenge: z.string().min(1), pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number() }).passthrough()).min(1) }).passthrough();
const authenticationOptionsSchema = z.object({ challenge: z.string().min(1), rpId: z.string().optional(), userVerification: z.enum(['required', 'preferred', 'discouraged']).optional(), allowCredentials: z.array(z.object({ id: z.string(), type: z.literal('public-key'), transports: z.array(z.string()).optional() }).passthrough()).optional() }).passthrough();

export async function listStepUpFactors(organizationId: string): Promise<StepUpFactor[]> {
  return call(`/api/customer/step-up/factors?organizationId=${encodeURIComponent(organizationId)}`, factorList);
}
export async function enrollStepUpFactor(organizationId: string, label: string, password?: string) {
  const authorization = password === undefined
    ? { proof: await requestStepUp(organizationId, await sha256(`gotchu:step-up:enroll:v1:${await currentUserId()}`)) }
    : { password };
  const begun = serverChallenge.parse(await call('/api/customer/step-up/factors/enrollment-options', serverChallenge, 'POST', { organizationId, ...authorization }));
  const response = await startRegistration({ optionsJSON: registrationOptionsSchema.parse(begun.options) as PublicKeyCredentialCreationOptionsJSON });
  return call('/api/customer/step-up/factors/enrollment', z.object({ factor: stepUpFactorSchema, recoveryCodes: z.array(z.string()).max(10) }).strict(), 'POST', { organizationId, challengeId: begun.challengeId, response, label });
}
export async function enrollStepUpFactorWithRecovery(organizationId: string, recoveryCode: string, label: string) {
  const begun = serverChallenge.parse(await call('/api/customer/step-up/factors/recovery-options', serverChallenge, 'POST', { organizationId, recoveryCode }));
  const response = await startRegistration({ optionsJSON: registrationOptionsSchema.parse(begun.options) as PublicKeyCredentialCreationOptionsJSON });
  return call('/api/customer/step-up/factors/enrollment', z.object({ factor: stepUpFactorSchema, recoveryCodes: z.array(z.string()).max(10) }).strict(), 'POST', { organizationId, challengeId: begun.challengeId, response, label });
}
export async function renameStepUpFactor(organizationId: string, factorId: string, label: string) {
  await call(`/api/customer/step-up/factors/${encodeURIComponent(factorId)}`, z.object({ renamed: z.literal(true) }), 'PATCH', { organizationId, label });
}
async function sha256(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function currentUserId() {
  const response = await fetch('/api/customer/session');
  if (!response.ok) throw new Error('No se pudo leer la sesión actual.');
  const payload: unknown = await response.json();
  const user = z.object({ user: z.object({ id: z.string().min(1).max(256) }).nullable() }).passthrough().parse(payload).user;
  if (!user) throw new Error('No hay una sesión activa.');
  return user.id;
}
export async function revokeStepUpFactor(organizationId: string, factorId: string) {
  const actionHash = await sha256(`gotchu:step-up:revoke:v1:${organizationId}:${factorId}`);
  const begun = serverChallenge.parse(await call('/api/customer/step-up/challenges', serverChallenge, 'POST', { organizationId, actionHash }));
  const response = await startAuthentication({ optionsJSON: authenticationOptionsSchema.parse(begun.options) as PublicKeyCredentialRequestOptionsJSON });
  const proof = proofResponse.parse(await call('/api/customer/step-up/assertions', proofResponse, 'POST', { organizationId, challengeId: begun.challengeId, response }));
  await call(`/api/customer/step-up/factors/${encodeURIComponent(factorId)}`, z.object({ revoked: z.literal(true) }), 'DELETE', { organizationId, actionHash, proof: proof.proof });
}
export async function revokeStepUpFactorWithRecovery(organizationId: string, factorId: string, recoveryCode: string) {
  await call(`/api/customer/step-up/factors/${encodeURIComponent(factorId)}`, z.object({ revoked: z.literal(true) }), 'DELETE', { organizationId, recoveryCode });
}

/** Runs a fresh WebAuthn ceremony and returns a one-use proof bound to this exact action. */
export async function requestStepUp(organizationId: string, actionHash: string): Promise<string> {
  const begun = serverChallenge.parse(await call('/api/customer/step-up/challenges', serverChallenge, 'POST', { organizationId, actionHash }));
  const response = await startAuthentication({ optionsJSON: authenticationOptionsSchema.parse(begun.options) as PublicKeyCredentialRequestOptionsJSON });
  return proofResponse.parse(await call('/api/customer/step-up/assertions', proofResponse, 'POST', { organizationId, challengeId: begun.challengeId, response })).proof;
}
