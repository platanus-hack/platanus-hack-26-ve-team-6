import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startCodexDeviceLogin } from '../src/server/codex-device-login.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture(mode: 'success' | 'pending' | 'unsafe-url' | 'rejected') {
  const directory = await mkdtemp(join(tmpdir(), 'gotchu-codex-protocol-test-'));
  directories.push(directory);
  const binary = join(directory, 'codex');
  const trace = join(directory, 'trace.json');
  await writeFile(binary, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { writeFileSync, statSync } from 'node:fs';
const home = process.env.CODEX_HOME;
writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ home, cwd: process.cwd(), privateHome: (statSync(home).mode & 0o777) === 0o700, inheritedKey: Boolean(process.env.OPENAI_API_KEY) }));
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
 const request = JSON.parse(line);
 if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'fixture' } });
 if (request.method === 'account/login/start') {
  if (request.params.type !== 'chatgptDeviceCode') process.exit(2);
  send({ id: request.id, result: { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: ${JSON.stringify(mode === 'unsafe-url' ? 'https://attacker.invalid/codex/device' : 'https://auth.openai.com/codex/device')}, userCode: 'ABCD-1234' } });
  if (${JSON.stringify(mode)} === 'success' || ${JSON.stringify(mode)} === 'rejected') setTimeout(() => {
   writeFileSync(home + '/auth.json', JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: 'synthetic-id', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh' } }), { mode: 0o600 });
   send({ method: 'account/login/completed', params: { loginId: 'login-1', success: ${mode === 'success'} } });
  }, 20);
 }
});
`, { mode: 0o700 });
  return { binary, trace };
}

describe('Codex device auth subprocess (synthetic protocol, no model calls)', () => {
  it('imports only a dedicated ChatGPT login and removes its private home after completion', async () => {
    const f = await fixture('success');
    const login = await startCodexDeviceLogin(f.binary);
    expect(login.verificationUrl).toBe('https://auth.openai.com/codex/device');
    expect(login.userCode).toBe('ABCD-1234');
    expect(JSON.parse(await login.credential ?? '{}')).toMatchObject({ auth_mode: 'chatgpt', tokens: { refresh_token: 'synthetic-refresh' } });
    await login.cancel();
    const trace: { home: string; cwd: string; privateHome: boolean; inheritedKey: boolean } = JSON.parse(await readFile(f.trace, 'utf8'));
    expect(trace).toMatchObject({ privateHome: true, inheritedKey: false });
    expect(trace.cwd).toBe(trace.home);
    await expect(stat(trace.home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels a pending login without credentials and removes the temporary home', async () => {
    const f = await fixture('pending');
    const login = await startCodexDeviceLogin(f.binary);
    await login.cancel();
    expect(await login.credential).toBeNull();
    const trace: { home: string } = JSON.parse(await readFile(f.trace, 'utf8'));
    await expect(stat(trace.home)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an authorization URL outside OpenAI and hides provider diagnostics', async () => {
    const f = await fixture('unsafe-url');
    await expect(startCodexDeviceLogin(f.binary)).rejects.toMatchObject({ code: 'codex_login_unavailable' });
  });

  it('does not import an auth file when OpenAI reports authorization failure', async () => {
    const f = await fixture('rejected');
    const login = await startCodexDeviceLogin(f.binary);
    expect(await login.credential).toBeNull();
    await login.cancel();
  });

  it('reports a missing CLI as an actionable error without exposing local paths', async () => {
    await expect(startCodexDeviceLogin('/not-a-real-codex-binary')).rejects.toMatchObject({ code: 'codex_login_unavailable' });
  });
});
