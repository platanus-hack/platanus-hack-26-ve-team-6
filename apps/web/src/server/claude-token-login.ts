import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSubscriptionCredential } from '@gotchu/contracts';
import { z } from 'zod';
import type { DeviceLogin } from './codex-device-login.js';
import { HttpError } from './http.js';

/** Runs only the official token setup ceremony, with an empty home and no project. */
export async function startClaudeTokenLogin(binary = 'claude'): Promise<DeviceLogin> {
  const directory = await mkdtemp(join(tmpdir(), 'gotchu-claude-login-'));
  const browser = join(directory, 'open-browser');
  const urlFile = join(directory, 'authorization-url');
  let finish: (credential: string | null) => void = () => undefined;
  const credential = new Promise<string | null>(resolve => { finish = resolve; });
  await writeFile(browser, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(urlFile)}, process.argv.at(-1), {mode:0o600});\n`, { mode: 0o700 });
  // setup-token uses an interactive terminal. script provides a private PTY, not a user shell.
  // The executable is server configuration; quote it even though users cannot supply it.
  const command = `'${binary.replaceAll("'", "'\\''")}' setup-token`;
  const child = spawn('script', ['--quiet', '--return', '--command', command, '/dev/null'], {
    cwd: directory, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory, CLAUDE_CONFIG_DIR: directory, BROWSER: browser, TERM: 'xterm-256color', NO_COLOR: '1' },
  });
  let closed = false;
  let cleanup: Promise<void> | undefined;
  let total = 0;
  let output = '';
  const cancel = (): Promise<void> => cleanup ??= (async () => {
    closed = true; clearTimeout(timer); finish(null);
    const stopped = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) resolve();
      else child.once('close', () => resolve());
    });
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
    child.stdin.destroy(); await stopped;
    await rm(directory, { recursive: true, force: true });
  })();
  const timer = setTimeout(() => { void cancel().catch(() => undefined); }, 10 * 60_000); timer.unref();
  child.once('error', () => { void cancel().catch(() => undefined); });
  child.once('exit', () => { void cancel().catch(() => undefined); });
  child.stdin.on('error', () => { void cancel().catch(() => undefined); });
  child.stderr.resume();
  child.stdout.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > 1_048_576) { void cancel().catch(() => undefined); return; }
    output = (output + chunk.toString('utf8')).slice(-65_536);
    const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const token = /sk-ant-oat\d{2}-[A-Za-z0-9_-]{20,}(?=[\s\x1b])/.exec(text)?.[0];
    if (token && parseSubscriptionCredential('claude_code', token)) { finish(token); void cancel().catch(() => undefined); }
  });
  try {
    const deadline = Date.now() + 25_000;
    while (!closed && Date.now() < deadline) {
      let value: string | undefined;
      try { value = await readFile(urlFile, 'utf8'); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      if (value) {
        const url = new URL(value);
        if (!((url.origin === 'https://claude.ai' && url.pathname === '/oauth/authorize') || (url.origin === 'https://claude.com' && url.pathname === '/cai/oauth/authorize')) || url.username || url.password) throw new Error('authorization_url_invalid');
        return { verificationUrl: url.href, credential, cancel, submitCode(code) {
          if (closed) throw new HttpError(409, 'provider_login_finished', 'La conexión ya terminó.');
          const checked = z.string().regex(/^[A-Za-z0-9_-]{16,256}(?:#[A-Za-z0-9_-]{16,256})?$/).safeParse(code);
          if (!checked.success) throw new HttpError(400, 'provider_code_invalid', 'Pega el código de autorización que muestra Claude.');
          child.stdin.write(checked.data + '\n');
        } };
      }
      await delay(100);
    }
  } catch { /* Authentication diagnostics remain private. */ }
  await cancel();
  throw new HttpError(503, 'claude_login_unavailable', 'No se pudo iniciar la conexión con Claude. Instala el CLI oficial de Claude Code y la utilidad script en el servidor, o utiliza la conexión manual.');
}
