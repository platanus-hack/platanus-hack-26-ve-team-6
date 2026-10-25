import { randomUUID } from 'node:crypto';
import type { Backend, Identity } from '@gotchu/backend';
import { subscriptionConnectionSchema, type SubscriptionConnection } from '@gotchu/contracts';
import { HttpError } from './http.js';
import { startCodexDeviceLogin, type DeviceLogin } from './codex-device-login.js';

type Models = Pick<Backend['investigationModels'], 'authorizeConnection' | 'connectCredential'>;
interface Session {
  organizationId: string; userId: string; providerPresetId: 'codex' | 'claude_code'; version: string; expiresAt: number;
  status: SubscriptionConnection['status']; login?: DeviceLogin; credential?: string;
  importing?: Promise<void>;
}

/** Transient authorization ceremonies, bounded to this self-host process and ten minutes. */
export function createSubscriptionConnections(models: Models, start: (provider: 'codex' | 'claude_code') => Promise<DeviceLogin> = () => startCodexDeviceLogin()) {
  const sessions = new Map<string, Session>();
  const project = (id: string, session: Session): SubscriptionConnection => {
    if (session.status === 'pending' && session.login) return subscriptionConnectionSchema.parse({ id, status: 'pending',
      verificationUrl: session.login.verificationUrl, userCode: session.login.userCode, acceptsCode: Boolean(session.login.submitCode), expiresAt: new Date(session.expiresAt).toISOString() });
    return subscriptionConnectionSchema.parse({ id, status: session.status });
  };
  const dispose = async (session: Session, status: 'cancelled' | 'expired' | 'failed') => {
    session.status = status; delete session.credential;
    await session.login?.cancel();
  };
  return {
    async start(identity: Identity, organizationId: string, providerPresetId: 'codex' | 'claude_code' = 'codex') {
      const version = await models.authorizeConnection(identity, { organizationId, providerPresetId });
      for (const [id, session] of sessions) {
        if (session.expiresAt <= Date.now()) { await dispose(session, 'expired'); sessions.delete(id); }
        else if (session.organizationId === organizationId && session.userId === identity.userId) { await dispose(session, 'cancelled'); sessions.delete(id); }
      }
      if (sessions.size >= 8) throw new HttpError(429, 'codex_login_limit', 'Hay demasiadas conexiones pendientes. Espera unos minutos.');
      const id = randomUUID();
      const session: Session = { organizationId, userId: identity.userId, providerPresetId, version, expiresAt: Date.now() + 10 * 60_000, status: 'pending' };
      sessions.set(id, session);
      try {
        session.login = await start(providerPresetId);
        if (session.status !== 'pending') { await session.login.cancel(); throw new HttpError(409, 'codex_login_cancelled', 'La conexión se canceló.'); }
        session.login.credential.then(credential => {
          if (session.status !== 'pending') return;
          if (credential) session.credential = credential; else session.status = 'failed';
        }).catch(() => { session.status = 'failed'; });
        const timer = setTimeout(() => {
          void dispose(session, 'expired').catch(() => undefined).finally(() => sessions.delete(id));
        }, 10 * 60_000);
        timer.unref();
        return project(id, session);
      } catch (error) { sessions.delete(id); throw error; }
    },
    async get(identity: Identity, organizationId: string, id: string, cancel = false, providerPresetId: 'codex' | 'claude_code' = 'codex', authorizationCode?: string) {
      // Recheck membership even when polling an existing ceremony or cancelling it.
      await models.authorizeConnection(identity, { organizationId, providerPresetId });
      const session = sessions.get(id);
      if (!session || session.organizationId !== organizationId || session.userId !== identity.userId || session.providerPresetId !== providerPresetId) throw new HttpError(404, 'codex_login_not_found', 'La conexión caducó. Vuelve a conectar ChatGPT.');
      if (authorizationCode !== undefined) {
        if (session.status !== 'pending' || !session.login?.submitCode) throw new HttpError(409, 'provider_code_unexpected', 'La conexión no espera un código.');
        session.login.submitCode(authorizationCode);
      }
      if (cancel) {
        if (session.importing) await session.importing;
        if (session.status !== 'connected') await dispose(session, 'cancelled');
      } else if (session.expiresAt <= Date.now()) await dispose(session, 'expired');
      else if (session.status === 'pending' && session.credential) {
        const credential = session.credential;
        session.importing ??= models.connectCredential(identity, { organizationId, providerPresetId, version: session.version, credential }).then(() => {
          session.status = 'connected';
        }).catch(error => { session.status = 'failed'; throw error; }).finally(() => { delete session.credential; });
        await session.importing;
      }
      return project(id, session);
    },
  };
}
