import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type CDPSession } from 'playwright';
import { setRecoveryState } from '@gotchu/database';
import { fixture, liveUrl, present } from '../../../packages/database/test/support.js';

const enabled = process.env.GOTCHU_TEST_BROWSER === '1' && Boolean(liveUrl);
const browserSuite = enabled ? describe : describe.skip;
const root = new URL('../../../', import.meta.url).pathname;
const buildEntry = join(root, 'apps/web/.output/server/index.mjs');

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not choose a browser test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function waitForWeb(origin: string, process: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Built web app exited with status ${process.exitCode}`);
    try { if ((await fetch(`${origin}/api/customer/session`, { signal: AbortSignal.timeout(1_000) })).ok) return; } catch { /* Wait for the owned server process to listen. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Built web app did not become ready within 30 seconds');
}

browserSuite('opt-in real WebAuthn browser ceremony with CDP virtual authenticator and Postgres', () => {
  let db: Awaited<ReturnType<typeof fixture>>;
  let web: ChildProcess | undefined;
  let browser: Browser | undefined;
  let cdp: CDPSession | undefined;
  let page: import('playwright').Page;
  let origin: string;
  beforeAll(async () => {
    await access(buildEntry);
    db = await fixture({ max: 4 });
    await setRecoveryState({ connectionString: present(liveUrl), mode: 'reconciled', reconciliationReference: 'TEST ONLY: local WebAuthn browser test' });
    const port = await freePort();
    origin = `http://localhost:${port}`;
    web = spawn(process.execPath, [buildEntry], { cwd: root, stdio: 'ignore', env: {
      ...process.env,
      NODE_ENV: 'development', PUBLIC_APP_URL: origin, PORT: String(port), NITRO_PORT: String(port), HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1',
      AUTH_SECRET: randomBytes(32).toString('base64url'), GOTCHU_API_DATABASE_URL: db.runtimeConnectionString('gotchu_api'),
      GOTCHU_LOCAL_AUTH_ENABLED: 'true', GOTCHU_ALLOW_LOCAL_REGISTRATION: 'true',
    } });
    await waitForWeb(origin, web);
    browser = await chromium.launch({ headless: true, ...(process.env.GOTCHU_CHROMIUM_PATH ? { executablePath: process.env.GOTCHU_CHROMIUM_PATH } : {}) });
    const context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
  }, 45_000);
  afterAll(async () => {
    await cdp?.detach().catch(() => undefined);
    await browser?.close();
    if (web?.pid && web.exitCode === null) { web.kill('SIGTERM'); await once(web, 'exit').catch(() => undefined); }
    await db?.close();
  });
  it('registers, enrolls, asserts, and consumes the exact revocation proof', async () => {
    const failures: string[] = [];
    page.on('response', async response => { if (response.url().includes('/api/customer/step-up/')) failures.push(`${response.status()} ${response.url()} ${await response.text().catch(() => '')}`); });
    const email = `step-up-${randomUUID()}@example.test`;
    const password = `Passphrase-${randomBytes(16).toString('hex')}`;
    await page.goto(origin);
    const registered = await page.evaluate(async ({ email, password }) => {
      const response = await fetch('/api/customer/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      return { status: response.status, payload: await response.json() as unknown };
    }, { email, password });
    expect(registered.status).toBe(201);
    const account = zAccount(registered.payload);
    const signedIn = await page.evaluate(async ({ email, password }) => {
      const csrfResponse = await fetch('/api/auth/csrf');
      const csrf: unknown = await csrfResponse.json();
      if (!csrf || typeof csrf !== 'object' || !('csrfToken' in csrf) || typeof csrf.csrfToken !== 'string') return false;
      const response = await fetch('/api/auth/callback/credentials', { method: 'POST', headers: { 'X-Auth-Return-Redirect': '1' }, redirect: 'error', body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: '/dashboard', json: 'true' }) });
      return response.ok && Boolean((await (await fetch('/api/customer/session')).json() as { user?: unknown }).user);
    }, { email, password });
    expect(signedIn).toBe(true);
    const workspace = await page.evaluate(async () => {
      const response = await fetch('/api/customer/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Step-up browser test' }) });
      return { status: response.status, payload: await response.json() as unknown };
    });
    expect(workspace.status).toBe(201);
    const organizationId = zId(workspace.payload);
    const application = await page.evaluate(async organizationId => {
      const response = await fetch(`/api/customer/workspaces/${organizationId}/applications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'WebAuthn browser test' }) });
      return response.status;
    }, organizationId);
    expect(application).toBe(201);
    expect((await page.evaluate(async () => (await fetch('/api/customer/session')).status))).toBe(200);
    await page.goto(`${origin}/dashboard`);
    await page.getByRole('button', { name: 'Aplicaciones' }).click();
    await page.getByRole('heading', { name: 'Verificación en dos pasos' }).waitFor();
    await page.getByRole('button', { name: 'Añadir factor' }).click();
    const recoveryHeading = page.getByRole('heading', { name: 'Guarda estos códigos de recuperación' });
    const enrollmentError = page.getByRole('alert').first();
    const enrollmentResult = await Promise.race([
      recoveryHeading.waitFor({ timeout: 30_000 }).then(() => 'success'),
      enrollmentError.waitFor({ timeout: 30_000 }).then(() => 'error'),
    ]);
    if (enrollmentResult === 'error') throw new Error(`WebAuthn enrollment failed: ${await enrollmentError.innerText()}\n${failures.join('\n')}`);
    const recoveryCode = await recoveryHeading.locator('..').getByRole('listitem').first().innerText();
    await page.getByRole('button', { name: 'Ya los guardé' }).click();
    await page.getByRole('button', { name: 'Revocar', exact: true }).click();
    await page.getByText('No hay factores registrados.').waitFor({ timeout: 30_000 });
    await page.getByText('¿Has perdido tu factor?').click();
    await page.getByLabel('Código de recuperación').fill(recoveryCode);
    await page.getByLabel('Nombre del nuevo factor').fill('Factor recuperado');
    await page.getByRole('button', { name: 'Usar código y registrar factor' }).click();
    await page.waitForFunction(async organizationId => {
      const response = await fetch(`/api/customer/step-up/factors?organizationId=${organizationId}`);
      const factors = await response.json() as unknown;
      return Array.isArray(factors) && factors.length === 1;
    }, organizationId, { timeout: 30_000 });
    const replay = await page.evaluate(async ({ organizationId, recoveryCode }) => {
      const response = await fetch('/api/customer/step-up/factors/recovery-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId, recoveryCode }) });
      return { status: response.status, payload: await response.json() as unknown };
    }, { organizationId, recoveryCode });
    expect(replay.status).toBe(403);
    expect(replay.payload).toMatchObject({ error: { code: 'recovery_code_invalid' } });
    const factors = await page.evaluate(async organizationId => {
      const response = await fetch(`/api/customer/step-up/factors?organizationId=${organizationId}`);
      return await response.json() as unknown;
    }, organizationId);
    expect(factors).toHaveLength(1);
    expect(account).toMatch(/^[0-9a-f-]{36}$/);
  }, 120_000);
});

function zAccount(value: unknown) {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new Error('Registration returned an invalid account identity');
  return value.id;
}
function zId(value: unknown) {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new Error('Workspace response did not include an id');
  return value.id;
}
