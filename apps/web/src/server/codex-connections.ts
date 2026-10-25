import { randomUUID } from 'node:crypto';
import type { Backend, Identity } from '@gotchu/backend';
import { codexConnectionSchema, type CodexConnection } from '@gotchu/contracts';
import { HttpError } from './http.js';
import { startCodexDeviceLogin, type DeviceLogin } from './codex-device-login.js';

type Models = Pick<Backend['investigationModels'], 'authorizeCodexConnection' | 'connectCodex'>;
interface Session {
  organizationId: string; userId: string; version: string; expiresAt: number;
  status: CodexConnection['status']; login?: DeviceLogin; credential?: string;
  importing?: Promise<void>;
}

/** Transient authorization ceremonies, bounded to this self-host process and ten minutes. */
export function createCodexConnections(models: Models, start: () => Promise<DeviceLogin> = startCodexDeviceLogin) {
  const sessions = new Map<string, Session>();
  const project = (id: string, session: Session): CodexConnection => {
    if (session.status === 'pending' && session.login) return codexConnectionSchema.parse({ id, status: 'pending',
      verificationUrl: session.login.verificationUrl, userCode: session.login.userCode, expiresAt: new Date(session.expiresAt).toISOString() });
    return codexConnectionSchema.parse({ id, status: session.status });
  };
  const dispose = async (session: Session, status: 'cancelled' | 'expired' | 'failed') => {
    session.status = status; delete session.credential;
    await session.login?.cancel();
  };
  return {
    async start(identity: Identity, organizationId: string) {
      const version = await models.authorizeCodexConnection(identity, { organizationId });
      for (const [id, session] of sessions) {
        if (session.expiresAt <= Date.now()) { await dispose(session, 'expired'); sessions.delete(id); }
        else if (session.organizationId === organizationId && session.userId === identity.userId) { await dispose(session, 'cancelled'); sessions.delete(id); }
      }
      if (sessions.size >= 8) throw new HttpError(429, 'codex_login_limit', 'Hay demasiadas conexiones pendientes. Espera unos minutos.');
      const id = randomUUID();
      const session: Session = { organizationId, userId: identity.userId, version, expiresAt: Date.now() + 10 * 60_000, status: 'pending' };
      sessions.set(id, session);
      try {
        session.login = await start();
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
    async get(identity: Identity, organizationId: string, id: string, cancel = false) {
      // Recheck membership even when polling an existing ceremony or cancelling it.
      await models.authorizeCodexConnection(identity, { organizationId });
      const session = sessions.get(id);
      if (!session || session.organizationId !== organizationId || session.userId !== identity.userId) throw new HttpError(404, 'codex_login_not_found', 'La conexión caducó. Vuelve a conectar ChatGPT.');
      if (cancel) {
        if (session.importing) await session.importing;
        if (session.status !== 'connected') await dispose(session, 'cancelled');
      } else if (session.expiresAt <= Date.now()) await dispose(session, 'expired');
      else if (session.status === 'pending' && session.credential) {
        const credential = session.credential;
        session.importing ??= models.connectCodex(identity, { organizationId, version: session.version, credential }).then(() => {
          session.status = 'connected';
        }).catch(error => { session.status = 'failed'; throw error; }).finally(() => { delete session.credential; });
        await session.importing;
      }
      return project(id, session);
    },
  };
}
