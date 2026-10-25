import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSubscriptionCredential } from '@gotchu/contracts';
import { z } from 'zod';
import { HttpError } from './http.js';

const deviceSchema = z.object({ type: z.literal('chatgptDeviceCode'), loginId: z.string().min(1),
  verificationUrl: z.literal('https://auth.openai.com/codex/device'), userCode: z.string().regex(/^[A-Z0-9-]{6,32}$/) });
const envelopeSchema = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.unknown().optional(),
  method: z.string().optional(), params: z.unknown().optional() });
const completionSchema = z.object({ loginId: z.string(), success: z.boolean() });
export interface DeviceLogin {
  verificationUrl: string; userCode?: string;
  submitCode?(code: string): void;
  credential: Promise<string | null>;
  cancel(): Promise<void>;
}

/** Only auth RPCs are sent. No threads, prompts, model calls, or repository access. */
export async function startCodexDeviceLogin(binary = 'codex'): Promise<DeviceLogin> {
  const directory = await mkdtemp(join(tmpdir(), 'gotchu-codex-login-'));
  let finish: (credential: string | null) => void = () => undefined;
  const credential = new Promise<string | null>(resolve => { finish = resolve; });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let closed = false;
  let cleanup: Promise<void> | undefined;
  let earlyCompletion: unknown;
  let loginId: string | undefined;
  let remaining = '';
  let totalBytes = 0;
  let sequence = 0;
  // A new private home prevents reading or overwriting the operator's existing Codex session.
  await writeFile(join(directory, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    cwd: directory, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, CODEX_HOME: directory },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const failure = () => new HttpError(503, 'codex_login_unavailable', 'No se pudo iniciar la conexión con Codex. Comprueba que el servidor tiene instalado el CLI de Codex.');
  const cancel = (): Promise<void> => cleanup ??= (async () => {
    closed = true;
    clearTimeout(timeout);
    for (const waiter of pending.values()) waiter.reject(failure());
    pending.clear();
    const stopped = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) resolve();
      else child.once('close', () => resolve());
    });
    child.kill('SIGKILL');
    child.stdin.destroy();
    finish(null);
    await stopped;
    await rm(directory, { recursive: true, force: true });
  })();
  const timeout = setTimeout(() => { void cancel().catch(() => undefined); }, 10 * 60_000);
  timeout.unref();
  const rpc = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    if (closed) { reject(failure()); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  child.stdin.on('error', () => { void cancel().catch(() => undefined); });
  child.once('error', () => { void cancel().catch(() => undefined); });
  child.once('exit', () => { void cancel().catch(() => undefined); });
  child.stderr.resume(); // Provider diagnostics may contain authentication material; never log them.
  child.stdout.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    remaining += chunk.toString('utf8');
    if (totalBytes > 1_048_576 || remaining.length > 65_536) { void cancel().catch(() => undefined); return; }
    let newline: number;
    while ((newline = remaining.indexOf('\n')) !== -1) {
      const line = remaining.slice(0, newline); remaining = remaining.slice(newline + 1);
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { void cancel().catch(() => undefined); return; }
      const parsed = envelopeSchema.safeParse(raw);
      if (!parsed.success) { void cancel().catch(() => undefined); return; }
      const message = parsed.data;
      if (message.id !== undefined) {
        const waiter = pending.get(message.id); pending.delete(message.id);
        if (message.error !== undefined) waiter?.reject(failure()); else waiter?.resolve(message.result);
      } else if (message.method === 'account/login/completed') {
        if (loginId === undefined) earlyCompletion = message.params;
        else complete(message.params);
      }
    }
  });
  const complete = (params: unknown) => {
    const completed = completionSchema.safeParse(params);
    if (!completed.success || completed.data.loginId !== loginId || !completed.data.success) { void cancel().catch(() => undefined); return; }
    void readFile(join(directory, 'auth.json'), 'utf8').then(text => {
      if (!closed) finish(parseSubscriptionCredential('codex', text));
    }).catch(() => finish(null)).finally(() => cancel().catch(() => undefined));
  };
  const bounded = async (promise: Promise<unknown>, milliseconds: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(failure()), milliseconds); timer.unref(); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    await bounded(rpc('initialize', { clientInfo: { name: 'gotchu_local', title: 'Gotchu', version: '0.1.0' }, capabilities: {} }), 15_000);
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    const device = deviceSchema.parse(await bounded(rpc('account/login/start', { type: 'chatgptDeviceCode' }), 20_000));
    loginId = device.loginId;
    if (earlyCompletion !== undefined) complete(earlyCompletion);
    return { verificationUrl: device.verificationUrl, userCode: device.userCode, credential, cancel };
  } catch { await cancel(); throw failure(); }
}
