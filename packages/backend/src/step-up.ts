import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from '@simplewebauthn/server';
import type { BaseDependencies, Identity } from './core.js';
import type { Transaction } from '@gotchu/database';
import { audit, authorize, BackendError, parse, sha256, systemClock } from './core.js';
import { STEP_UP_MAX_AGE_MS, type StepUpVerifier } from './proposals.js';
import { z } from 'zod';

const idSchema = z.uuid();
const actionSchema = z.object({ organizationId: idSchema, actionHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const credentialId = z.string().min(1).max(1024);
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/).max(16_384);
const transportsSchema = z.array(z.enum(['ble', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])).max(8);
const credentialBase = { id: credentialId, rawId: base64url, type: z.literal('public-key'), clientExtensionResults: z.record(z.string(), z.unknown()).optional(), authenticatorAttachment: z.string().optional() };
const registrationResponseSchema = z.object({ ...credentialBase, response: z.object({ clientDataJSON: base64url, attestationObject: base64url, transports: transportsSchema.optional() }).passthrough() }).passthrough();
const assertionResponseSchema = z.object({ ...credentialBase, response: z.object({ clientDataJSON: base64url, authenticatorData: base64url, signature: base64url, userHandle: base64url.nullable().optional() }).passthrough() }).passthrough();
const labelSchema = z.string().trim().min(1).max(80);
const STEP_UP_SIGNOUT_FALLBACK_MS = 2 * 60_000;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const opaque = (size = 32) => randomBytes(size).toString('base64url');
const scryptCode = (code: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => scrypt(code, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, value) => error ? reject(error) : resolve(value)));

export function createWebAuthnStepUpVerifier(deps: Pick<BaseDependencies, 'database' | 'clock'>): StepUpVerifier {
  const clock = deps.clock ?? systemClock;
  return {
    async verify(input) {
      const value = parse(z.object({ proof: z.string().min(32).max(128), userId: z.string().min(1).max(256), organizationId: idSchema, actionHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), input);
      const result = await deps.database.tenant(value.organizationId, async tx => {
        const consumed = await tx.query<{ id: string; user_id: string; action_hash: string; recovery_epoch: string; authenticated_at: Date; expires_at: Date; factor_id: string }>(
          `UPDATE gotchu.step_up_proofs SET consumed_at=$4 WHERE organization_id=$1 AND proof_hash=$2 AND user_id=$3 AND action_hash=$5 AND consumed_at IS NULL AND expires_at>$4 RETURNING id,user_id,action_hash,recovery_epoch,authenticated_at,expires_at,factor_id`,
          [value.organizationId, digest(value.proof), value.userId, clock.now(), value.actionHash]);
        const proof = consumed.rows[0];
        if (!proof) throw new BackendError('step_up_proof_invalid', 'La verificación venció, ya se utilizó o no corresponde a esta acción.', 403);
        const role = await tx.query('SELECT gotchu.lock_membership($1,$2) AS role', [value.organizationId, value.userId]);
        if (!['owner', 'operator'].includes(String(role.rows[0]?.role))) return new BackendError('forbidden', 'El permiso de organización ya no permite esta acción.', 403);
        const epoch = await tx.query('SELECT * FROM gotchu.lock_authorization_state()');
        if (String(epoch.rows[0]?.recovery_epoch) !== String(proof.recovery_epoch)) return new BackendError('stale_epoch', 'La autorización cambió desde la verificación.', 409);
        await tx.query("SELECT set_config('gotchu.step_up_user',$1,true)", [value.userId]);
        const factor = await tx.query('SELECT 1 FROM gotchu.step_up_user_factors WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL', [value.userId, proof.factor_id]);
        if (!factor.rowCount) return new BackendError('step_up_factor_revoked', 'El factor de seguridad fue revocado.', 403);
        return proof;
      });
      if (result instanceof BackendError) throw result;
      return { proofId: result.id, userId: result.user_id, organizationId: value.organizationId, actionHash: result.action_hash, authenticatedAt: result.authenticated_at, expiresAt: result.expires_at, method: 'webauthn' };
    },
  };
}

export interface StepUpOptions { rpID: string; origin: string; rpName?: string; verifyPassword?: (userId: string, password: string) => Promise<boolean | null> }
export function createWebAuthnStepUpService(deps: BaseDependencies & { webAuthn: StepUpOptions }) {
  if (deps.database.role !== 'gotchu_api') throw new Error('WebAuthn step-up requires the restricted API database role');
  const clock = deps.clock ?? systemClock;
  const config = { rpID: z.string().min(1).max(253).parse(deps.webAuthn.rpID), origin: z.url().parse(deps.webAuthn.origin), rpName: deps.webAuthn.rpName ?? 'Gotchu' };
  const expires = () => new Date(clock.now().getTime() + 120_000);
  async function setUser(tx: Transaction, userId: string) {
    await tx.query("SELECT set_config('gotchu.step_up_user',$1,true)", [userId]);
  }

  async function consumeChallenge(organizationId: string, challengeId: string, userId: string, purpose: 'enroll' | 'assert') {
    return deps.database.tenant(organizationId, async tx => {
      await authorize(tx, organizationId, { userId }, ['owner', 'operator']);
      const result = await tx.query<{ challenge: string; action_hash: string | null; recovery_epoch: string; enrollment_authorization: 'existing_factor' | 'recovery_code' | 'bootstrap' | null; authorization_factor_id: string | null; enrollment_factor_count: number | null; enrollment_factor_ids: string[] }>(
        `UPDATE gotchu.step_up_challenges SET consumed_at=$4 WHERE organization_id=$1 AND id=$2 AND user_id=$3 AND purpose=$5 AND consumed_at IS NULL AND expires_at>$4 RETURNING challenge,action_hash,recovery_epoch,enrollment_authorization,authorization_factor_id,enrollment_factor_count,enrollment_factor_ids`,
        [organizationId, challengeId, userId, clock.now(), purpose]);
      const row = result.rows[0];
      if (!row) throw new BackendError('step_up_challenge_invalid', 'El desafío venció o ya fue utilizado.', 409);
      return row;
    });
  }
  async function saveChallenge(identity: Identity, organizationId: string, purpose: 'enroll' | 'assert', actionHash: string | null, challenge: string, enrollment?: { authorization: 'existing_factor' | 'recovery_code' | 'bootstrap'; factorId: string | null; factorCount: number; factorIds: string[] }) {
    const challengeId = randomUUID(); const expiresAt = expires();
    const outcome = await deps.database.tenant(organizationId, async tx => {
      await authorize(tx, organizationId, identity, ['owner', 'operator']);
      await setUser(tx, identity.userId);
      if (enrollment) {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`step-up-factor:${identity.userId}`]);
        const current = await tx.query<{ count: number; ids: string[] }>("SELECT count(*)::int AS count,coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) AS ids FROM gotchu.step_up_user_factors WHERE user_id=$1 AND revoked_at IS NULL", [identity.userId]);
        if ((current.rows[0]?.count ?? 0) !== enrollment.factorCount || JSON.stringify(current.rows[0]?.ids ?? []) !== JSON.stringify(enrollment.factorIds)) throw new BackendError('step_up_enrollment_stale', 'Otro cambio de seguridad modificó los factores. Inicia una nueva verificación.', 409);
      }
      const bucket = `step-up:${sha256(`${organizationId}:${identity.userId}`)}`;
      const admission = await tx.query<{ allowed: boolean }>('SELECT gotchu.auth_admit($1,30,3600) AS allowed', [bucket]);
      if (admission.rows[0]?.allowed !== true) return new BackendError('step_up_rate_limited', 'Has iniciado demasiadas verificaciones. Inténtalo más tarde.', 429);
      const state = await tx.query<{ recovery_epoch: string }>('SELECT * FROM gotchu.lock_authorization_state()');
      const epoch = state.rows[0]?.recovery_epoch;
      if (!epoch) throw new BackendError('step_up_unavailable', 'El estado de autorización no está disponible.', 503);
      await tx.query('DELETE FROM gotchu.step_up_challenges WHERE organization_id=$1 AND expires_at < $2::timestamptz - interval \'1 day\'', [organizationId, clock.now()]);
      await tx.query('DELETE FROM gotchu.step_up_proofs WHERE organization_id=$1 AND expires_at < $2::timestamptz - interval \'1 day\'', [organizationId, clock.now()]);
      await tx.query('INSERT INTO gotchu.step_up_challenges(organization_id,id,user_id,purpose,action_hash,challenge,recovery_epoch,enrollment_authorization,authorization_factor_id,enrollment_factor_count,enrollment_factor_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [organizationId, challengeId, identity.userId, purpose, actionHash, challenge, epoch, enrollment?.authorization ?? null, enrollment?.factorId ?? null, enrollment?.factorCount ?? null, enrollment?.factorIds ?? [], expiresAt]);
      return { challengeId, expiresAt };
    });
    if (outcome instanceof BackendError) throw outcome;
    return outcome;
  }
  async function consumeRecoveryCode(identity: Identity, organizationId: string, codeInput: string) {
    const code = z.string().min(10).max(128).parse(codeInput);
    const bucket = `step-up-recovery:${sha256(identity.userId)}`;
    const admission = await deps.database.tenant(organizationId, async tx => tx.query<{ allowed: boolean }>('SELECT gotchu.auth_admit($1,5,900) AS allowed', [bucket]));
    if (admission.rows[0]?.allowed !== true) throw new BackendError('recovery_rate_limited', 'Se han realizado demasiados intentos de recuperación. Inténtalo más tarde.', 429);
    return deps.database.tenant(organizationId, async tx => {
      await authorize(tx, organizationId, identity, ['owner', 'operator']);
      await setUser(tx, identity.userId);
      const rows = await tx.query<{ id: string; salt: Buffer; code_hash: Buffer }>('SELECT id,salt,code_hash FROM gotchu.step_up_user_recovery_codes WHERE user_id=$1 AND consumed_at IS NULL FOR UPDATE', [identity.userId]);
      let matchedId: string | null = null;
      for (const row of rows.rows) {
        const actual = await scryptCode(code, row.salt);
        if (timingSafeEqual(actual, row.code_hash)) matchedId = row.id;
      }
      if (!matchedId) throw new BackendError('recovery_code_invalid', 'El código de recuperación no es válido o ya se utilizó.', 403);
      const consumed = await tx.query('UPDATE gotchu.step_up_user_recovery_codes SET consumed_at=$3 WHERE user_id=$1 AND id=$2 AND consumed_at IS NULL', [identity.userId, matchedId, clock.now()]);
      if (consumed.rowCount !== 1) throw new BackendError('recovery_code_invalid', 'El código de recuperación ya se utilizó.', 403);
      const factors = await tx.query<{ count: number; ids: string[] }>("SELECT count(*)::int AS count,coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) AS ids FROM gotchu.step_up_user_factors WHERE user_id=$1 AND revoked_at IS NULL", [identity.userId]);
      return { count: factors.rows[0]?.count ?? 0, ids: factors.rows[0]?.ids ?? [] };
    });
  }
  const verifier = createWebAuthnStepUpVerifier(deps);

  return {
    verifier,
    async invalidateSession(userId: string) {
      const safeUserId = parse(z.string().min(1).max(256), userId);
      await deps.database.tenant('00000000-0000-4000-8000-000000000000', async tx => {
        await tx.query('SELECT gotchu.step_up_invalidate_user($1)', [safeUserId]);
      });
    },
    async list(identity: Identity, organizationId: string) {
      return deps.database.tenant(organizationId, async tx => {
        await authorize(tx, organizationId, identity, ['owner', 'operator']);
        await setUser(tx, identity.userId);
        const result = await tx.query<{ id: string; credential_id: string; label: string; created_at: Date; last_used_at: Date | null }>('SELECT id,credential_id,label,created_at,last_used_at FROM gotchu.step_up_user_factors WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at', [identity.userId]);
        return result.rows.map(row => ({ id: row.id, credentialId: row.credential_id, label: row.label, createdAt: row.created_at.toISOString(), lastUsedAt: row.last_used_at?.toISOString() ?? null }));
      });
    },
    async beginEnrollment(identity: Identity, organizationId: string, authorization?: { proof?: string; password?: string }) {
      const existing = await this.list(identity, organizationId);
      if (existing.length >= 10) throw new BackendError('step_up_factor_limit', 'Se permiten hasta 10 factores por usuario.', 409);
      let enrollment: { authorization: 'existing_factor' | 'bootstrap'; factorId: string | null; factorCount: number; factorIds: string[] };
      if (existing.length === 0) {
        if (!authorization?.password) throw new BackendError('step_up_password_required', 'Confirma la contraseña de tu cuenta para registrar el primer factor.', 403);
        if (!deps.webAuthn.verifyPassword) throw new BackendError('step_up_password_unavailable', 'Esta cuenta no tiene una contraseña local que pueda volver a verificarse. Configura un proveedor de identidad compatible.', 403);
        const validPassword = await deps.webAuthn.verifyPassword(identity.userId, authorization.password);
        if (validPassword === null) throw new BackendError('step_up_password_unavailable', 'Esta cuenta no tiene una contraseña local que pueda volver a verificarse. Configura un proveedor de identidad compatible.', 403);
        if (!validPassword) throw new BackendError('step_up_password_invalid', 'La contraseña no es correcta.', 403);
        enrollment = { authorization: 'bootstrap', factorId: null, factorCount: 0, factorIds: [] };
      } else {
        if (!authorization?.proof) throw new BackendError('step_up_required', 'Verifica con un factor activo o utiliza un código de recuperación antes de añadir otro factor.', 403);
        const expectedHash = sha256(`gotchu:step-up:enroll:v1:${identity.userId}`);
        const verified = await verifier.verify({ proof: authorization.proof, userId: identity.userId, organizationId, actionHash: expectedHash });
        const authorized = await deps.database.tenant(organizationId, async tx => {
          await authorize(tx, organizationId, identity, ['owner', 'operator']);
          await setUser(tx, identity.userId);
          const proof = await tx.query<{ factor_id: string; factor_count: number; factor_ids: string[] }>('SELECT factor_id,factor_count,factor_ids FROM gotchu.step_up_proofs WHERE organization_id=$1 AND id=$2 AND user_id=$3 AND action_hash=$4', [organizationId, verified.proofId, identity.userId, expectedHash]);
          const current = await tx.query<{ count: number; ids: string[] }>("SELECT count(*)::int AS count,coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) AS ids FROM gotchu.step_up_user_factors WHERE user_id=$1 AND revoked_at IS NULL", [identity.userId]);
          return { proof: proof.rows[0], count: current.rows[0]?.count ?? 0, ids: current.rows[0]?.ids ?? [] };
        });
        if (!authorized.proof || authorized.count !== authorized.proof.factor_count || JSON.stringify(authorized.ids) !== JSON.stringify(authorized.proof.factor_ids)) throw new BackendError('step_up_enrollment_stale', 'Otro cambio de seguridad modificó los factores. Inicia una nueva verificación.', 409);
        enrollment = { authorization: 'existing_factor', factorId: authorized.proof.factor_id, factorCount: authorized.count, factorIds: authorized.ids };
      }
      const options = await generateRegistrationOptions({ rpName: config.rpName, rpID: config.rpID, userName: identity.userId, userID: createHash('sha256').update(identity.userId).digest(), userDisplayName: 'Usuario Gotchu', timeout: 120_000, attestationType: 'none', authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' }, excludeCredentials: existing.map(factor => ({ id: factor.credentialId })) });
      const row = await saveChallenge(identity, organizationId, 'enroll', null, options.challenge, enrollment);
      return { ...row, options };
    },
    async beginRecoveryEnrollment(identity: Identity, input: { organizationId: string; recoveryCode: string }) {
      const value = parse(z.object({ organizationId: idSchema, recoveryCode: z.string().min(10).max(128) }).strict(), input);
      const existing = await this.list(identity, value.organizationId);
      if (existing.length >= 10) throw new BackendError('step_up_factor_limit', 'Se permiten hasta 10 factores por usuario.', 409);
      const factorCount = await consumeRecoveryCode(identity, value.organizationId, value.recoveryCode);
      if (factorCount.count < 1 || factorCount.count !== existing.length || JSON.stringify(factorCount.ids) !== JSON.stringify(existing.map(factor => factor.id).sort())) throw new BackendError('step_up_enrollment_stale', 'El estado de los factores cambió. Inicia una nueva solicitud.', 409);
      const options = await generateRegistrationOptions({ rpName: config.rpName, rpID: config.rpID, userName: identity.userId, userID: createHash('sha256').update(identity.userId).digest(), userDisplayName: 'Usuario Gotchu', timeout: 120_000, attestationType: 'none', authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' }, excludeCredentials: existing.map(factor => ({ id: factor.credentialId })) });
      const row = await saveChallenge(identity, value.organizationId, 'enroll', null, options.challenge, { authorization: 'recovery_code', factorId: null, factorCount: factorCount.count, factorIds: factorCount.ids });
      return { ...row, options };
    },
    async finishEnrollment(identity: Identity, input: { organizationId: string; challengeId: string; response: unknown; label: string }) {
      const value = parse(z.object({ organizationId: idSchema, challengeId: idSchema, response: registrationResponseSchema, label: labelSchema }).strict(), input);
      const challenge = await consumeChallenge(value.organizationId, value.challengeId, identity.userId, 'enroll');
      let checked: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
      try { checked = await verifyRegistrationResponse({ response: value.response as unknown as RegistrationResponseJSON, expectedChallenge: challenge.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, requireUserVerification: true }); }
      catch { throw new BackendError('step_up_attestation_invalid', 'No se pudo verificar el nuevo factor.', 403); }
      if (!checked.verified || !checked.registrationInfo.userVerified) throw new BackendError('step_up_attestation_invalid', 'No se pudo verificar el nuevo factor.', 403);
      const info = checked.registrationInfo;
      const factorId = randomUUID();
      const recoveryCodes = Array.from({ length: 10 }, () => `${opaque(8)}-${opaque(8)}`);
      let showRecoveryCodes = false;
      await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator']);
        await setUser(tx, identity.userId);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`step-up-factor:${identity.userId}`]);
        if (!challenge.enrollment_authorization || challenge.enrollment_factor_count === null) throw new BackendError('step_up_challenge_invalid', 'El desafío no contiene una autorización de registro válida.', 409);
        const count = await tx.query<{ count: number; ids: string[] }>("SELECT count(*)::int AS count,coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) AS ids FROM gotchu.step_up_user_factors WHERE user_id=$1 AND revoked_at IS NULL", [identity.userId]);
        if (count.rows[0]?.count !== challenge.enrollment_factor_count || JSON.stringify(count.rows[0]?.ids ?? []) !== JSON.stringify(challenge.enrollment_factor_ids)) throw new BackendError('step_up_enrollment_stale', 'Otro cambio de seguridad modificó los factores. Inicia una nueva verificación.', 409);
        if (challenge.enrollment_authorization === 'existing_factor') {
          const factor = await tx.query('SELECT 1 FROM gotchu.step_up_user_factors WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL', [identity.userId, challenge.authorization_factor_id]);
          if (!factor.rowCount) throw new BackendError('step_up_factor_revoked', 'El factor usado para autorizar el registro fue revocado.', 403);
        }
        if (challenge.enrollment_authorization === 'bootstrap' && challenge.enrollment_factor_count !== 0) throw new BackendError('step_up_enrollment_stale', 'El primer registro ya no está disponible.', 409);
        if (challenge.enrollment_authorization === 'recovery_code' && challenge.enrollment_factor_count < 1) throw new BackendError('step_up_enrollment_stale', 'El estado de recuperación ya no es válido.', 409);
        if (challenge.enrollment_authorization === 'bootstrap') showRecoveryCodes = true;
        if (challenge.enrollment_authorization === 'bootstrap' && !deps.webAuthn.verifyPassword) throw new BackendError('step_up_password_unavailable', 'Esta cuenta no tiene una contraseña local que pueda volver a verificarse.', 403);
        if (count.rows[0]?.count >= 10) throw new BackendError('step_up_factor_limit', 'Se permiten hasta 10 factores por usuario.', 409);
        const transports = value.response.response.transports ?? [];
        await tx.query('INSERT INTO gotchu.step_up_user_factors(user_id,id,credential_id,public_key,sign_count,transports,label) VALUES($1,$2,$3,$4,$5,$6,$7)', [identity.userId, factorId, info.credential.id, Buffer.from(info.credential.publicKey), info.credential.counter, transports, value.label]);
        await audit(tx, value.organizationId, identity.userId, 'step_up.factor_enrolled', factorId);
        showRecoveryCodes ||= challenge.enrollment_authorization === 'bootstrap';
        for (const code of showRecoveryCodes ? recoveryCodes : []) {
          const salt = randomBytes(16); const hash = await scryptCode(code, salt);
          await tx.query('INSERT INTO gotchu.step_up_user_recovery_codes(user_id,id,salt,code_hash) VALUES($1,$2,$3,$4)', [identity.userId, randomUUID(), salt, hash]);
        }
      });
      return { factor: { id: factorId, credentialId: info.credential.id, label: value.label, createdAt: clock.now().toISOString(), lastUsedAt: null }, recoveryCodes: showRecoveryCodes ? recoveryCodes : [] };
    },
    async beginChallenge(identity: Identity, input: unknown) {
      const value = parse(actionSchema, input);
      const factors = await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator']);
        await setUser(tx, identity.userId);
        const rows = await tx.query<{ credential_id: string; transports: string[] }>('SELECT credential_id,transports FROM gotchu.step_up_user_factors WHERE user_id=$1 AND revoked_at IS NULL', [identity.userId]);
        if (!rows.rowCount) throw new BackendError('step_up_required', 'Añade un factor WebAuthn antes de verificar acciones.', 409);
        return rows.rows;
      });
      const options = await generateAuthenticationOptions({ rpID: config.rpID, timeout: 120_000, userVerification: 'required', allowCredentials: factors.map(factor => ({ id: factor.credential_id, transports: factor.transports as never[] })) });
      const row = await saveChallenge(identity, value.organizationId, 'assert', value.actionHash, options.challenge);
      return { ...row, options };
    },
    async finishAssertion(identity: Identity, input: { organizationId: string; challengeId: string; response: unknown }) {
      const value = parse(z.object({ organizationId: idSchema, challengeId: idSchema, response: assertionResponseSchema }).strict(), input);
      const challenge = await consumeChallenge(value.organizationId, value.challengeId, identity.userId, 'assert');
      const factorResult = await deps.database.tenant(value.organizationId, async tx => {
        await setUser(tx, identity.userId);
        const result = await tx.query<{ id: string; public_key: Buffer; sign_count: string; transports: string[] }>('SELECT id,public_key,sign_count,transports FROM gotchu.step_up_user_factors WHERE user_id=$1 AND credential_id=$2 AND revoked_at IS NULL', [identity.userId, value.response.id]);
        const factor = result.rows[0];
        if (!factor) throw new BackendError('step_up_factor_invalid', 'Este factor no está disponible en el espacio.', 403);
        return factor;
      });
      const credential: WebAuthnCredential = { id: value.response.id, publicKey: new Uint8Array(factorResult.public_key), counter: Number(factorResult.sign_count), transports: factorResult.transports as never[] };
      let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
      try { verified = await verifyAuthenticationResponse({ response: value.response as unknown as AuthenticationResponseJSON, expectedChallenge: challenge.challenge, expectedOrigin: config.origin, expectedRPID: config.rpID, credential, requireUserVerification: true }); }
      catch { throw new BackendError('step_up_assertion_invalid', 'La respuesta WebAuthn no es válida o el contador retrocedió.', 403); }
      if (!verified.verified || !verified.authenticationInfo.userVerified || (credential.counter > 0 && verified.authenticationInfo.newCounter <= credential.counter)) throw new BackendError('step_up_assertion_invalid', 'La respuesta WebAuthn no es válida o el contador retrocedió.', 403);
      const proof = opaque(); const proofId = randomUUID(); const now = clock.now(); const expiresAt = new Date(now.getTime() + Math.min(STEP_UP_MAX_AGE_MS, STEP_UP_SIGNOUT_FALLBACK_MS));
      await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity, ['owner', 'operator']);
        await setUser(tx, identity.userId);
        const counterUpdate = await tx.query('UPDATE gotchu.step_up_user_factors SET sign_count=$3,last_used_at=$4 WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL AND sign_count=$5', [identity.userId, factorResult.id, verified.authenticationInfo.newCounter, now, factorResult.sign_count]);
        if (counterUpdate.rowCount !== 1) throw new BackendError('step_up_counter_race', 'El factor se utilizó de forma concurrente. Inicia una nueva verificación.', 409);
        const count = await tx.query<{ count: number; ids: string[] }>("SELECT count(*)::int AS count,coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) AS ids FROM gotchu.step_up_user_factors WHERE user_id=$1 AND revoked_at IS NULL", [identity.userId]);
        await tx.query('INSERT INTO gotchu.step_up_proofs(organization_id,id,user_id,proof_hash,action_hash,recovery_epoch,authenticated_at,expires_at,factor_id,factor_count,factor_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [value.organizationId, proofId, identity.userId, digest(proof), challenge.action_hash, challenge.recovery_epoch, now, expiresAt, factorResult.id, count.rows[0]?.count ?? 0, count.rows[0]?.ids ?? []]);
      });
      return { proof, expiresAt };
    },
    async rename(identity: Identity, input: { organizationId: string; factorId: string; label: string }) {
      const value = parse(z.object({ organizationId: idSchema, factorId: idSchema, label: labelSchema }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => { await authorize(tx, value.organizationId, identity, ['owner', 'operator']); await setUser(tx, identity.userId); const result = await tx.query('UPDATE gotchu.step_up_user_factors SET label=$3 WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL', [identity.userId, value.factorId, value.label]); if (!result.rowCount) throw new BackendError('not_found', 'Factor no encontrado.', 404); });
    },
    async revoke(identity: Identity, input: { organizationId: string; factorId: string }) {
      const value = parse(z.object({ organizationId: idSchema, factorId: idSchema }).strict(), input);
      await deps.database.tenant(value.organizationId, async tx => { await authorize(tx, value.organizationId, identity, ['owner', 'operator']); await setUser(tx, identity.userId); const result = await tx.query('UPDATE gotchu.step_up_user_factors SET revoked_at=$3 WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL', [identity.userId, value.factorId, clock.now()]); if (!result.rowCount) throw new BackendError('not_found', 'Factor no encontrado.', 404); await tx.query('UPDATE gotchu.step_up_proofs SET consumed_at=$4 WHERE organization_id=$1 AND user_id=$2 AND factor_id=$3 AND consumed_at IS NULL', [value.organizationId, identity.userId, value.factorId, clock.now()]); await audit(tx, value.organizationId, identity.userId, 'step_up.factor_revoked', value.factorId); });
    },
    async revokeWithRecovery(identity: Identity, input: { organizationId: string; factorId: string; recoveryCode: string }) {
      const value = parse(z.object({ organizationId: idSchema, factorId: idSchema, recoveryCode: z.string().min(10).max(128) }).strict(), input);
      await consumeRecoveryCode(identity, value.organizationId, value.recoveryCode);
      await this.revoke(identity, { organizationId: value.organizationId, factorId: value.factorId });
    },
  };
}
