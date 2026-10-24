import { createHash, createHmac } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, checkServerIdentity, type TLSSocket } from 'node:tls';
import { z } from 'zod';
import type { NotificationSecretStore } from '@gotchu/backend';
import { createPublicHttpsDestinationResolver } from '@gotchu/monitoring';
import type { NotificationDeliveryWork } from '@gotchu/backend';
import type { NotificationDeliverySender, NotificationSendResult } from './notification-delivery.js';

export interface SmtpSettings {
  host: string;
  port: number;
  tlsMode: 'implicit' | 'starttls' | 'none';
  fromEmail: string;
  username?: string;
  password?: string;
}

export function readSmtpSettings(env: NodeJS.ProcessEnv): SmtpSettings | null {
  const raw = env.GOTCHU_SMTP_URL;
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('invalid_gotchu_smtp_url'); }
  if (!['smtp:', 'smtps:'].includes(url.protocol) || !url.hostname || (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('invalid_gotchu_smtp_url');
  }
  const tlsMode = z.enum(['implicit', 'starttls', 'none']).parse(env.GOTCHU_SMTP_TLS_MODE ?? (url.protocol === 'smtps:' ? 'implicit' : 'starttls'));
  if (tlsMode === 'none' && env.NODE_ENV === 'production') throw new Error('smtp_tls_required_in_production');
  const username = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  if (Boolean(username) !== Boolean(password)) throw new Error('incomplete_gotchu_smtp_credentials');
  const fromEmail = z.email().max(254).parse(env.GOTCHU_SMTP_FROM);
  return {
    host: url.hostname,
    port: url.port ? z.coerce.number().int().min(1).max(65535).parse(url.port) : tlsMode === 'implicit' ? 465 : 587,
    tlsMode,
    fromEmail,
    ...(username && password ? { username, password } : {}),
  };
}

export function createNotificationDeliverySender(options: {
  secrets?: NotificationSecretStore;
  smtp?: SmtpSettings | null;
  lookup?: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;
  testWebhookTls?: { hostname: string; address: '127.0.0.1' | '::1'; port: number; ca: string };
} = {}): NotificationDeliverySender {
  const destinationResolver = createPublicHttpsDestinationResolver({
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.testWebhookTls ? { testFixture: { hostname: options.testWebhookTls.hostname, address: options.testWebhookTls.address } } : {}),
  });

  return {
    async send(work, parentSignal) {
      if (work.channelKind === 'webhook' && work.destination.kind === 'webhook') {
        return sendWebhook(work, parentSignal, destinationResolver, options.secrets, options.testWebhookTls);
      }
      if (work.channelKind === 'email' && work.destination.kind === 'email') {
        if (!options.smtp) return { outcome: 'permanent', reason: 'smtp_not_configured' };
        return sendEmail(work, parentSignal, options.smtp);
      }
      return { outcome: 'permanent', reason: 'channel_destination_mismatch' };
    },
  };
}

async function sendWebhook(work: NotificationDeliveryWork, parentSignal: AbortSignal,
  resolver: ReturnType<typeof createPublicHttpsDestinationResolver>, secrets: NotificationSecretStore | undefined,
  testTls: { hostname: string; address: '127.0.0.1' | '::1'; port: number; ca: string } | undefined): Promise<NotificationSendResult> {
  if (work.destination.kind !== 'webhook') return { outcome: 'permanent', reason: 'channel_destination_mismatch' };
  if (!secrets || !work.secretRef) return { outcome: 'permanent', reason: 'webhook_secret_unavailable' };
  let secret: Uint8Array;
  try { secret = await secrets.get(work.secretRef); }
  catch { return { outcome: 'retryable', reason: 'secret_store_unavailable' }; }
  if (secret.byteLength !== 32) return { outcome: 'permanent', reason: 'webhook_secret_invalid' };

  let destination: Awaited<ReturnType<typeof resolver.resolve>>;
  try { destination = await resolver.resolve(work.destination.url); }
  catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'webhook_nonpublic_dns') return { outcome: 'permanent', reason: 'webhook_address_rejected' };
    if (code === 'webhook_https_required' || code === 'webhook_url_invalid') return { outcome: 'permanent', reason: 'webhook_url_invalid' };
    return { outcome: 'retryable', reason: code === 'webhook_dns_timeout' ? code : 'webhook_dns_unavailable' };
  }
  const selected = destination.addresses[0];
  if (!selected) return { outcome: 'permanent', reason: 'webhook_address_rejected' };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    id: work.eventId,
    idempotencyKey: work.idempotencyKey,
    organizationId: work.organizationId,
    applicationId: work.applicationId,
    type: work.event.kind,
    severity: work.event.severity,
    title: work.event.title,
    message: work.event.message,
    createdAt: work.event.createdAt,
  });
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(5_000)]);
  const fixture = testTls?.hostname === destination.url.hostname && process.env.NODE_ENV === 'test' ? testTls : undefined;
  try {
    const status = await postWebhook({
      url: destination.url,
      address: selected.address,
      family: selected.family,
      port: fixture?.port ?? (destination.url.port ? Number(destination.url.port) : 443),
      ...(fixture ? { ca: fixture.ca } : {}),
      body,
      timestamp,
      signature,
      idempotencyKey: work.idempotencyKey,
      signal,
    });
    if (status >= 200 && status < 300) return { outcome: 'accepted' };
    if (status === 408 || status === 425 || status === 429 || status >= 500) return { outcome: 'retryable', reason: `webhook_http_${status}` };
    if (status >= 300 && status < 400) return { outcome: 'permanent', reason: 'webhook_redirect_refused' };
    return { outcome: 'permanent', reason: `webhook_http_${status}` };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (signal.aborted) return { outcome: 'retryable', reason: 'webhook_timeout' };
    if (code.startsWith('CERT_') || code.startsWith('ERR_TLS_')) return { outcome: 'permanent', reason: 'webhook_tls_rejected' };
    return { outcome: 'retryable', reason: 'webhook_transport_failed' };
  }
}

function postWebhook(input: {
  url: URL; address: string; family: 4 | 6; port: number; ca?: string; body: string; timestamp: string; signature: string;
  idempotencyKey: string; signal: AbortSignal;
}): Promise<number> {
  const host = input.url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      input.signal.removeEventListener('abort', onAbort);
      work();
    };
    const onAbort = () => finish(() => { request.destroy(); reject(new Error('webhook_timeout')); });
    const request = httpsRequest({
      hostname: input.address,
      family: input.family,
      port: input.port,
      ...(isIpLiteral(host) ? {} : { servername: host }),
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(host, certificate),
      rejectUnauthorized: true,
      ...(input.ca ? { ca: input.ca } : {}),
      method: 'POST',
      path: input.url.pathname,
      agent: false,
      signal: input.signal,
      maxHeaderSize: 8_192,
      headers: {
        host: input.url.host,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(input.body),
        'x-gotchu-timestamp': input.timestamp,
        'x-gotchu-signature': `sha256=${input.signature}`,
        'x-gotchu-idempotency-key': input.idempotencyKey,
        'user-agent': 'Gotchu-Notifications/1',
      },
    }, response => {
      const status = response.statusCode ?? 0;
      finish(() => { response.destroy(); request.destroy(); resolve(status); });
    });
    request.on('error', error => finish(() => reject(error)));
    input.signal.addEventListener('abort', onAbort, { once: true });
    request.end(input.body);
  });
}

function isIpLiteral(value: string) { return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || value.includes(':'); }

async function sendEmail(work: NotificationDeliveryWork, parentSignal: AbortSignal, settings: SmtpSettings): Promise<NotificationSendResult> {
  if (work.destination.kind !== 'email') return { outcome: 'permanent', reason: 'channel_destination_mismatch' };
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(8_000)]);
  try {
    await deliverSmtpMessage(settings, work, signal);
    return { outcome: 'accepted' };
  } catch (error) {
    if (error instanceof SmtpReplyError) return { outcome: error.retryable ? 'retryable' : 'permanent', reason: `smtp_${error.code}` };
    if (signal.aborted) return { outcome: 'retryable', reason: 'smtp_timeout' };
    return { outcome: 'retryable', reason: 'smtp_transport_unavailable' };
  }
}

class SmtpReplyError extends Error {
  constructor(readonly code: number, readonly retryable: boolean) { super('smtp_reply_rejected'); }
}

type SmtpSocket = Socket | TLSSocket;
type SmtpReply = { code: number; text: string };

async function deliverSmtpMessage(settings: SmtpSettings, work: NotificationDeliveryWork, signal: AbortSignal) {
  if (work.destination.kind !== 'email') throw new Error('channel_destination_mismatch');
  let socket: SmtpSocket;
  if (settings.tlsMode === 'implicit') {
    socket = tlsConnect({ host:settings.host,port:settings.port,servername:isIpLiteral(settings.host)?undefined:settings.host,rejectUnauthorized:true });
    await waitForSocket(socket, 'secureConnect', signal);
  } else {
    socket = netConnect({ host:settings.host,port:settings.port });
    await waitForSocket(socket, 'connect', signal);
  }
  let reader = createSmtpReader(socket);
  try {
    expectReply(await readSmtpReply(reader, signal), [220]);
    await smtpCommand(socket, reader, 'EHLO gotchu.local', [250], signal);
    if (settings.tlsMode === 'starttls') {
      await smtpCommand(socket, reader, 'STARTTLS', [220], signal);
      reader.close();
      socket = tlsConnect({ socket,servername:isIpLiteral(settings.host)?undefined:settings.host,rejectUnauthorized:true });
      await waitForSocket(socket, 'secureConnect', signal);
      reader = createSmtpReader(socket);
      await smtpCommand(socket, reader, 'EHLO gotchu.local', [250], signal);
    }
    if (settings.username && settings.password) {
      const auth = Buffer.from(`\0${settings.username}\0${settings.password}`).toString('base64');
      await smtpCommand(socket, reader, `AUTH PLAIN ${auth}`, [235], signal);
    }
    await smtpCommand(socket, reader, `MAIL FROM:<${settings.fromEmail}>`, [250], signal);
    await smtpCommand(socket, reader, `RCPT TO:<${work.destination.email}>`, [250, 251], signal);
    await smtpCommand(socket, reader, 'DATA', [354], signal);
    const message = smtpMessage(settings.fromEmail, work);
    await writeSocket(socket, `${message}\r\n.\r\n`, signal);
    expectReply(await readSmtpReply(reader, signal), [250]);
    socket.end('QUIT\r\n');
  } finally {
    reader.close();
    socket.destroy();
  }
}

function smtpMessage(from: string, work: NotificationDeliveryWork) {
  const subject = Buffer.from(`Alerta Gotchu: ${work.event.title}`).toString('base64');
  const text = [work.event.title, '', work.event.message, '', `Tipo: ${work.event.kind}`, `Severidad: ${work.event.severity}`].join('\n');
  const encodedText = Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  const messageId = createHash('sha256').update(work.idempotencyKey).digest('hex');
  return [
    `From: <${from}>`,
    `To: <${work.destination.kind === 'email' ? work.destination.email : ''}>`,
    `Subject: =?UTF-8?B?${subject}?=`,
    `Date: ${new Date(work.event.createdAt).toUTCString()}`,
    `Message-ID: <${messageId}@gotchu.local>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    `X-Gotchu-Idempotency-Key: ${work.idempotencyKey}`,
    '',
    encodedText,
  ].join('\r\n');
}

async function smtpCommand(socket: SmtpSocket, reader: SmtpReader, command: string, expected: readonly number[], signal: AbortSignal) {
  await writeSocket(socket, `${command}\r\n`, signal);
  expectReply(await readSmtpReply(reader, signal), expected);
}

function expectReply(reply: SmtpReply, expected: readonly number[]) {
  if (expected.includes(reply.code)) return;
  throw new SmtpReplyError(reply.code, reply.code >= 400 && reply.code < 500);
}

interface SmtpReader { nextLine(signal: AbortSignal): Promise<string>; close(): void }
function createSmtpReader(socket: SmtpSocket): SmtpReader {
  let buffer = '';
  let failure: Error | undefined;
  let resolveLine: ((line: string) => void) | undefined;
  let rejectLine: ((error: Error) => void) | undefined;
  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    if (buffer.length > 16_384) { fail(new Error('smtp_response_too_large')); return; }
    const boundary = buffer.indexOf('\n');
    if (boundary >= 0 && resolveLine) {
      const line = buffer.slice(0, boundary).replace(/\r$/, '');
      buffer = buffer.slice(boundary + 1);
      const resolve = resolveLine;
      resolveLine = undefined;
      rejectLine = undefined;
      resolve(line);
    }
  };
  const onError = (error: Error) => fail(error);
  const onClose = () => fail(new Error('smtp_connection_closed'));
  function fail(error: Error) {
    failure = error;
    rejectLine?.(error);
    resolveLine = undefined;
    rejectLine = undefined;
  }
  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  return {
    nextLine(signal) {
      if (signal.aborted) return Promise.reject(new Error('smtp_timeout'));
      if (failure) return Promise.reject(failure);
      const boundary = buffer.indexOf('\n');
      if (boundary >= 0) {
        const line = buffer.slice(0, boundary).replace(/\r$/, '');
        buffer = buffer.slice(boundary + 1);
        return Promise.resolve(line);
      }
      return new Promise((resolve, reject) => {
        resolveLine = resolve;
        rejectLine = reject;
        const onAbort = () => { resolveLine = undefined; rejectLine = undefined; reject(new Error('smtp_timeout')); };
        signal.addEventListener('abort', onAbort, { once: true });
        const originalResolve = resolveLine;
        resolveLine = line => { signal.removeEventListener('abort', onAbort); originalResolve?.(line); };
        const originalReject = rejectLine;
        rejectLine = error => { signal.removeEventListener('abort', onAbort); originalReject?.(error); };
      });
    },
    close() { socket.off('data',onData);socket.off('error',onError);socket.off('close',onClose); },
  };
}

async function readSmtpReply(reader: SmtpReader, signal: AbortSignal): Promise<SmtpReply> {
  const lines: string[] = [];
  let code: number | undefined;
  for (let count = 0; count < 20; count += 1) {
    const line = await reader.nextLine(signal);
    if (line.length > 2_000 || !/^\d{3}[ -]/.test(line)) throw new Error('smtp_invalid_reply');
    const current = Number(line.slice(0,3));
    if (code !== undefined && current !== code) throw new Error('smtp_invalid_reply');
    code = current;
    lines.push(line.slice(4));
    if (line[3] === ' ') return { code, text:lines.join('\n') };
  }
  throw new Error('smtp_reply_line_limit');
}

async function writeSocket(socket: SmtpSocket, data: string, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new Error('smtp_timeout'));
    signal.addEventListener('abort', onAbort, { once:true });
    socket.write(data, error => {
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    });
  });
}

async function waitForSocket(socket: SmtpSocket, event: 'connect' | 'secureConnect', signal: AbortSignal) {
  signal.throwIfAborted();
  if (event === 'connect' && !socket.connecting) return;
  await new Promise<void>((resolve, reject) => {
    const onConnect = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); socket.destroy(); reject(new Error('smtp_timeout')); };
    const cleanup = () => { socket.off(event,onConnect);socket.off('error',onError);signal.removeEventListener('abort',onAbort); };
    socket.once(event,onConnect);socket.once('error',onError);signal.addEventListener('abort',onAbort,{once:true});
  });
}
