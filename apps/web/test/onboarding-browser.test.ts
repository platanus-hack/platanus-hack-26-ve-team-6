import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { fixture, liveUrl } from '../../../packages/database/test/support.js';

const enabled = process.env.GOTCHU_TEST_BROWSER === '1' && Boolean(liveUrl);
const browserSuite = enabled ? describe : describe.skip;
const root = new URL('../../../', import.meta.url).pathname;
const buildEntry = join(root, 'apps/web/.output/server/index.mjs');

async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate an onboarding browser port.');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function waitForWeb(origin: string, child: ChildProcess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Built web app exited with status ${child.exitCode}.`);
    try { if ((await fetch(`${origin}/api/customer/session`, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* owned local server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Built web app did not become ready.');
}

browserSuite('opt-in upload-source onboarding browser fixture', () => {
  let db: Awaited<ReturnType<typeof fixture>>;
  let web: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page;
  let origin: string;
  let uploadedFolder: string | undefined;
  beforeAll(async () => {
    await access(buildEntry);
    db = await fixture({ max: 4 });
    const port = await freePort(); origin = `http://localhost:${port}`;
    web = spawn(process.execPath, [buildEntry], { cwd: root, stdio: 'ignore', env: {
      ...process.env, NODE_ENV: 'development', PUBLIC_APP_URL: origin, PORT: String(port), NITRO_PORT: String(port), HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1',
      AUTH_SECRET: randomBytes(32).toString('base64url'), GOTCHU_API_DATABASE_URL: db.runtimeConnectionString('gotchu_api'),
      GOTCHU_LOCAL_AUTH_ENABLED: 'true', GOTCHU_ALLOW_LOCAL_REGISTRATION: 'true',
    } });
    await waitForWeb(origin, web);
    browser = await chromium.launch({ headless: true, ...(process.env.GOTCHU_CHROMIUM_PATH ? { executablePath: process.env.GOTCHU_CHROMIUM_PATH } : {}) });
    page = await (await browser.newContext()).newPage();
  }, 45_000);
  afterAll(async () => {
    await browser?.close();
    if (web?.pid && web.exitCode === null) { web.kill('SIGTERM'); await once(web, 'exit').catch(() => undefined); }
    if (uploadedFolder) await rm(uploadedFolder, { recursive: true, force: true });
    await db?.close();
  });
  it('creates a workspace, uploads source, and queues an internal assessment from the wizard', async () => {
    const email = `onboarding-${randomUUID()}@example.test`;
    const password = `Passphrase-${randomBytes(16).toString('hex')}`;
    await page.goto(origin);
    const registration = await page.evaluate(async ({ email, password }) => {
      const response = await fetch('/api/customer/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      return response.status;
    }, { email, password });
    expect(registration).toBe(201);
    await page.evaluate(async ({ email, password }) => {
      const csrfPayload: unknown = await (await fetch('/api/auth/csrf')).json();
      if (!csrfPayload || typeof csrfPayload !== 'object' || !('csrfToken' in csrfPayload) || typeof csrfPayload.csrfToken !== 'string') throw new Error('Auth.js CSRF token was missing.');
      const response = await fetch('/api/auth/callback/credentials', { method: 'POST', headers: { 'X-Auth-Return-Redirect': '1' }, redirect: 'error', body: new URLSearchParams({ csrfToken: csrfPayload.csrfToken, email, password, callbackUrl: '/dashboard', json: 'true' }) });
      if (!response.ok) throw new Error('Local fixture sign-in failed.');
    }, { email, password });
    await page.goto(`${origin}/dashboard`);
    await page.getByRole('heading', { name: 'Empieza en tres pasos' }).waitFor();
    let productClicks = 0;
    await page.evaluate(() => { document.addEventListener('click', event => { if ((event.target as HTMLElement).closest('button, input[type="radio"]')) window.sessionStorage.setItem('onboarding-click-count', String(Number(window.sessionStorage.getItem('onboarding-click-count') ?? 0) + 1)); }, true); });
    await page.getByRole('textbox', { name: 'Espacio de trabajo' }).fill('Onboarding browser fixture');
    await page.getByLabel('Nombre de la aplicación').fill('Upload-only application');
    await page.getByRole('button', { name: 'Continuar' }).click(); productClicks += 1;
    await page.getByRole('radio', { name: /Subir una carpeta/ }).check(); productClicks += 1;
    uploadedFolder = await mkdtemp(join(tmpdir(), 'gotchu-onboarding-source-'));
    await mkdir(join(uploadedFolder, 'src'));
    await writeFile(join(uploadedFolder, 'src', 'index.ts'), 'export const ready = true;\n');
    await page.waitForFunction(() => document.querySelector('#onboarding-folder')?.hasAttribute('webkitdirectory'));
    await page.getByLabel('Carpeta del proyecto').setInputFiles(uploadedFolder);
    await page.getByRole('button', { name: 'Continuar con esta carpeta' }).click(); productClicks += 1;
    await page.getByRole('heading', { name: 'La cobertura dependerá de la fuente' }).waitFor();
    const queued = page.waitForResponse(response => response.url().endsWith('/assessments') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Analizar ahora' }).click(); productClicks += 1;
    expect((await queued).status()).toBe(202);
    await page.getByText(/Evaluación guardada|Evaluación en curso/i).waitFor({ timeout: 10_000 });
    expect(productClicks).toBe(4);
    expect(await page.evaluate(() => window.sessionStorage.getItem('onboarding-click-count'))).toBe('4');
  }, 60_000);

  it('lets an existing empty workspace add its first application', async () => {
    await page.context().clearCookies();
    await page.goto(origin);
    await page.evaluate(() => sessionStorage.clear());
    const email = `onboarding-empty-${randomUUID()}@example.test`;
    const password = `Passphrase-${randomBytes(16).toString('hex')}`;
    const registration = await page.evaluate(async ({ email, password }) => {
      const response = await fetch('/api/customer/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      return response.status;
    }, { email, password });
    expect(registration).toBe(201);
    await page.evaluate(async ({ email, password }) => {
      const csrfPayload: unknown = await (await fetch('/api/auth/csrf')).json();
      if (!csrfPayload || typeof csrfPayload !== 'object' || !('csrfToken' in csrfPayload) || typeof csrfPayload.csrfToken !== 'string') throw new Error('Auth.js CSRF token was missing.');
      const response = await fetch('/api/auth/callback/credentials', { method: 'POST', headers: { 'X-Auth-Return-Redirect': '1' }, redirect: 'error', body: new URLSearchParams({ csrfToken: csrfPayload.csrfToken, email, password, callbackUrl: '/dashboard', json: 'true' }) });
      if (!response.ok) throw new Error('Local fixture sign-in failed.');
    }, { email, password });
    await page.evaluate(async () => {
      const response = await fetch('/api/customer/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Existing empty workspace' }) });
      if (response.status !== 201) throw new Error('Could not create the empty workspace fixture.');
    });
    await page.goto(`${origin}/dashboard`);
    await page.getByRole('heading', { name: 'Empieza en tres pasos' }).waitFor();
    await page.getByText('Se usará el espacio de trabajo seleccionado.').waitFor();
    expect(await page.locator('#onboarding-workspace').count()).toBe(0);
    await page.getByLabel('Nombre de la aplicación').fill('First application');
    const created = page.waitForResponse(response => response.url().endsWith('/applications') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Continuar' }).click();
    expect((await created).status()).toBe(201);
    await page.getByRole('heading', { name: 'Elige cómo empezar' }).waitFor();
  }, 60_000);
});
