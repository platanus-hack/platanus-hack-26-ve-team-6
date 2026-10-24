import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { customerApplicationSchema, customerWorkspaceSchema } from '@gotchu/contracts';
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
async function signIn(page: Page, origin: string, email: string) {
  const password = `Passphrase-${randomBytes(16).toString('hex')}`;
  await page.goto(origin);
  expect(await page.getByRole('link', { name: 'Continuar con GitHub' }).count()).toBe(0);
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
}
async function startClickCounter(page: Page) {
  const install = () => {
    if (Reflect.get(window, '__gotchuOnboardingClickCounterInstalled') === true) return;
    Reflect.set(window, '__gotchuOnboardingClickCounterInstalled', true);
    document.addEventListener('click', event => {
      const target = event.target;
      if (target instanceof Element && target.closest('button, input[type="file"], input[type="radio"]')) {
        window.sessionStorage.setItem('onboarding-click-count', String(Number(window.sessionStorage.getItem('onboarding-click-count') ?? 0) + 1));
      }
    }, true);
  };
  await page.context().addInitScript(install);
  await page.evaluate(() => window.sessionStorage.removeItem('onboarding-click-count'));
  await page.evaluate(install);
}

browserSuite('customer onboarding browser flow with local Postgres', () => {
  let db: Awaited<ReturnType<typeof fixture>>;
  let web: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page;
  let origin: string;
  let uploadedFolder: string | undefined;
  let githubFixtureDirectory: string | undefined;
  const customerApiFailures: string[] = [];
  beforeAll(async () => {
    await access(buildEntry);
    db = await fixture({ max: 4 });
    githubFixtureDirectory = await mkdtemp(join(tmpdir(), 'gotchu-onboarding-github-'));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const githubAppFile = join(githubFixtureDirectory, 'app.json');
    await writeFile(githubAppFile, JSON.stringify({ id: '5454279', slug: 'fixture-app', clientId: 'fixture-client', clientSecret: 'fixture-secret', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), webhookSecret: 'fixture-webhook' }), { mode: 0o600 });
    const fetchMock = join(githubFixtureDirectory, 'github-fetch.mjs');
    await writeFile(fetchMock, `
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') {
    return Response.json({ access_token: 'fixture-user-token', token_type: 'bearer', scope: 'read:user' });
  }
  if (url.origin === 'https://api.github.com') {
    if (url.pathname === '/user/installations') return Response.json({ installations: [{ id: 174788349, account: { login: 'fixture-owner' } }] });
    if (url.pathname === '/app/installations/174788349/access_tokens') return Response.json({ token: 'fixture-installation-token', expires_at: '2099-01-01T00:00:00.000Z' });
    if (url.pathname === '/installation/repositories') return Response.json({ total_count: 1, repositories: [{ id: 42, full_name: 'fixture-owner/vulnerable-app', default_branch: 'main', private: true, archived: false }] });
    if (url.pathname === '/repos/fixture-owner/vulnerable-app') return Response.json({ default_branch: 'main' });
    if (url.pathname === '/repos/fixture-owner/vulnerable-app/commits/main') return Response.json({ sha: '${'a'.repeat(40)}', commit: { committer: { date: '2026-01-01T00:00:00.000Z' }, tree: { sha: '${'b'.repeat(40)}' } } });
    if (url.pathname === '/repos/fixture-owner/vulnerable-app/git/trees/${'b'.repeat(40)}') return Response.json({ sha: '${'b'.repeat(40)}', truncated: false, tree: [{ path: 'src/index.js', mode: '100644', type: 'blob', sha: '${'c'.repeat(40)}', size: 29 }] });
    if (url.pathname === '/repos/fixture-owner/vulnerable-app/git/blobs/${'c'.repeat(40)}') return Response.json({ sha: '${'c'.repeat(40)}', size: 29, encoding: 'base64', content: Buffer.from('export const fixture = true;\\n').toString('base64') });
    return Response.json({ message: 'unexpected fixture request' }, { status: 500 });
  }
  return originalFetch(input, init);
};
`, { mode: 0o600 });
    const port = await freePort(); origin = `http://localhost:${port}`;
    web = spawn(process.execPath, [buildEntry], { cwd: root, stdio: 'ignore', env: {
      ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(fetchMock).href}`,
      NODE_ENV: 'development', PUBLIC_APP_URL: origin, PORT: String(port), NITRO_PORT: String(port), HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1',
      AUTH_SECRET: randomBytes(32).toString('base64url'), GOTCHU_API_DATABASE_URL: db.runtimeConnectionString('gotchu_api'),
      GOTCHU_LOCAL_AUTH_ENABLED: 'true', GOTCHU_ALLOW_LOCAL_REGISTRATION: 'true', GOTCHU_GITHUB_READER_APP_FILE: githubAppFile, GOTCHU_GITHUB_APP_SLUG: 'fixture-app',
    } });
    await waitForWeb(origin, web);
    browser = await chromium.launch({ headless: true, ...(process.env.GOTCHU_CHROMIUM_PATH ? { executablePath: process.env.GOTCHU_CHROMIUM_PATH } : {}) });
    page = await (await browser.newContext()).newPage();
    page.on('response', response => {
      if (response.url().includes('/api/customer') && response.status() >= 400) customerApiFailures.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
  }, 45_000);
  afterAll(async () => {
    await browser?.close();
    if (web?.pid && web.exitCode === null) { web.kill('SIGTERM'); await once(web, 'exit').catch(() => undefined); }
    if (uploadedFolder) await rm(uploadedFolder, { recursive: true, force: true });
    if (githubFixtureDirectory) await rm(githubFixtureDirectory, { recursive: true, force: true });
    await db?.close();
  });

  it('uploads a chosen folder and queues an internal assessment in two clicks', async () => {
    await signIn(page, origin, `onboarding-${randomUUID()}@example.test`);
    await page.getByRole('heading', { name: 'Empieza en dos pasos' }).waitFor();
    await startClickCounter(page);
    await page.getByRole('textbox', { name: 'Espacio de trabajo' }).fill('Onboarding browser fixture');
    await page.getByLabel('Nombre de la aplicación').fill('Upload-only application');
    uploadedFolder = await mkdtemp(join(tmpdir(), 'gotchu-onboarding-source-'));
    await mkdir(join(uploadedFolder, 'src'));
    await writeFile(join(uploadedFolder, 'src', 'index.ts'), 'export const ready = true;\n');
    await page.waitForFunction(() => document.querySelector('#onboarding-folder')?.hasAttribute('webkitdirectory'));
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByLabel('Carpeta del proyecto').click();
    await (await chooserPromise).setFiles(uploadedFolder);
    const queued = page.waitForResponse(response => response.url().endsWith('/assessments') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Analizar carpeta' }).click();
    expect((await queued).status()).toBe(202);
    try { await page.locator('.customer-job-banner').waitFor({ timeout: 10_000 }); }
    catch {
      const dashboard = await page.locator('.customer-main').innerText().catch(() => 'Customer dashboard is not visible.');
      const alerts = await page.locator('[role="alert"]').allTextContents();
      const hasSavedScope = await page.evaluate(() => window.sessionStorage.getItem('gotchu-onboarding-scope') !== null);
      throw new Error(JSON.stringify({ dashboard: dashboard.slice(0, 1600), alerts, hasSavedScope, customerApiFailures }));
    }
    expect(await page.evaluate(() => window.sessionStorage.getItem('onboarding-click-count'))).toBe('2');
    const workspaces = await page.evaluate(async () => await (await fetch('/api/customer/workspaces')).json());
    const workspace = customerWorkspaceSchema.parse(Array.isArray(workspaces) ? workspaces[0] : null);
    expect(workspace.name).toBe('Onboarding browser fixture');
    const applications = await page.evaluate(async (organizationId) => await (await fetch(`/api/customer/workspaces/${organizationId}/applications`)).json(), workspace.id);
    const application = customerApplicationSchema.parse(Array.isArray(applications) ? applications[0] : null);
    expect(application.name).toBe('Upload-only application');
    const counts = await db.admin.query<{ sources: number; jobs: number }>(`SELECT
      (SELECT count(*)::int FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2) AS sources,
      (SELECT count(*)::int FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='audit') AS jobs`, [workspace.id, application.applicationId]);
    expect(counts.rows[0]).toEqual({ sources: 1, jobs: 1 });
  }, 60_000);

  it('creates the first workspace and scans a selected GitHub repository in two clicks', async () => {
    await page.context().clearCookies();
    await page.goto(origin);
    await page.evaluate(() => sessionStorage.clear());
    await signIn(page, origin, `onboarding-github-${randomUUID()}@example.test`);
    await page.getByRole('heading', { name: 'Empieza en dos pasos' }).waitFor();
    await startClickCounter(page);
    await page.route(`${origin}/api/customer/github/connect`, async route => {
      const response = await route.fetch();
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== 'object' || !('installUrl' in payload) || typeof payload.installUrl !== 'string') throw new Error('GitHub connect endpoint did not return its installation URL.');
      const state = new URL(payload.installUrl).searchParams.get('state');
      if (!state) throw new Error('GitHub connect endpoint did not return its state token.');
      const callback = new URL('/api/customer/github/callback', origin);
      callback.search = new URLSearchParams({ code: 'fixture-code', installation_id: '174788349', setup_action: 'install', state }).toString();
      await route.fulfill({ json: { installUrl: callback.href } });
    });
    await page.getByRole('button', { name: 'Conectar GitHub' }).click();
    try { await page.getByText('Conectado a fixture-owner').waitFor({ timeout: 15_000 }); }
    catch {
      const onboarding = await page.locator('.customer-onboarding').innerText().catch(() => 'Onboarding is not visible.');
      const hasSavedScope = await page.evaluate(() => window.sessionStorage.getItem('gotchu-onboarding-scope') !== null);
      throw new Error(JSON.stringify({ onboarding, hasSavedScope, customerApiFailures }));
    }
    const scan = page.waitForResponse(response => response.url().includes('/github/installations/174788349/repositories/42/select') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Analizar fixture-owner/vulnerable-app' }).click();
    expect((await scan).status()).toBe(201);
    await page.locator('.customer-job-banner').waitFor({ timeout: 10_000 });
    expect(await page.evaluate(() => window.sessionStorage.getItem('onboarding-click-count'))).toBe('2');
    const workspaces = await page.evaluate(async () => await (await fetch('/api/customer/workspaces')).json());
    const workspace = customerWorkspaceSchema.parse(Array.isArray(workspaces) ? workspaces[0] : null);
    const applications = await page.evaluate(async (organizationId) => await (await fetch(`/api/customer/workspaces/${organizationId}/applications`)).json(), workspace.id);
    const application = customerApplicationSchema.parse(Array.isArray(applications) ? applications[0] : null);
    expect(application.name).toBe('fixture-owner/vulnerable-app');
    expect(workspace.name).toMatch(/^Espacio de onboarding github /);
    const counts = await db.admin.query<{ sources: number; jobs: number }>(`SELECT
      (SELECT count(*)::int FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2) AS sources,
      (SELECT count(*)::int FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='audit') AS jobs`, [workspace.id, application.applicationId]);
    expect(counts.rows[0]).toEqual({ sources: 1, jobs: 1 });
  }, 60_000);
});
