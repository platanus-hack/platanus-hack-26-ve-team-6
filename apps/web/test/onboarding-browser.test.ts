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
import { customerApplicationSchema, customerTargetSchema, customerWorkspaceSchema } from '@gotchu/contracts';
import { fixture, liveUrl } from '../../../packages/database/test/support.js';

const enabled = process.env.GOTCHU_TEST_BROWSER === '1' && Boolean(liveUrl);
const browserSuite = enabled ? describe : describe.skip;
const root = new URL('../../../', import.meta.url).pathname;
const buildEntry = join(root, 'apps/web/.output/server/index.mjs');

async function freePort() {
  const start = Math.floor(Math.random() * 100);
  for (let offset = 0; offset < 100; offset++) {
    const port = 4600 + ((start + offset) % 100);
    const server = createServer();
    try {
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      return port;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('Could not allocate an onboarding browser port between 4600 and 4699.');
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
    if (url.pathname === '/user') return Response.json({ id: 101 });
    if (url.pathname === '/user/installations') return Response.json({ installations: [{ id: 174788349, account: { id: 101, login: 'fixture-owner', type: 'User' } }] });
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
    await page.getByRole('heading', { name: 'Tu primera revisión' }).waitFor();
    await startClickCounter(page);
    await page.getByLabel('Nombre del proyecto').fill('Upload-only project');
    uploadedFolder = await mkdtemp(join(tmpdir(), 'gotchu-onboarding-source-'));
    await mkdir(join(uploadedFolder, 'src'));
    await writeFile(join(uploadedFolder, 'src', 'index.ts'), 'export const ready = true;\n');
    await page.waitForFunction(() => document.querySelector('#onboarding-folder')?.hasAttribute('webkitdirectory'));
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('label[for="onboarding-folder"]').click();
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
    expect(workspace.name).toMatch(/^Espacio de Onboarding /);
    const applications = await page.evaluate(async (organizationId) => await (await fetch(`/api/customer/workspaces/${organizationId}/applications`)).json(), workspace.id);
    const application = customerApplicationSchema.parse(Array.isArray(applications) ? applications[0] : null);
    expect(application.name).toBe('Upload-only project');
    const counts = await db.admin.query<{ sources: number; jobs: number }>(`SELECT
      (SELECT count(*)::int FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2) AS sources,
      (SELECT count(*)::int FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='audit') AS jobs`, [workspace.id, application.applicationId]);
    expect(counts.rows[0]).toEqual({ sources: 1, jobs: 1 });
  }, 60_000);

  it('analyzes a requested HTTPS scope from the first workspace and rejects it after expiry', async () => {
    await page.context().clearCookies();
    await page.goto(origin);
    await page.evaluate(() => sessionStorage.clear());
    await signIn(page, origin, `onboarding-https-${randomUUID()}@example.test`);
    await page.getByRole('heading', { name: 'Tu primera revisión' }).waitFor();
    await page.getByLabel('Nombre del proyecto').fill('HTTPS-only application');
    await page.locator('.customer-source-card').filter({ has: page.getByRole('radio', { name: 'Web por URL' }) }).click();
    await page.getByLabel('URL de la web').fill('example.com');
    await page.getByLabel('Perfil de evaluación').selectOption('root');
    expect(await page.locator('.customer-source-option-body input[type="checkbox"]').count()).toBe(0);
    expect(await page.locator('body').innerText()).not.toMatch(/TXT|confirma que controlas el dominio|confirmo que tengo autorización/i);

    const enrollmentResponse = page.waitForResponse(response => response.url().endsWith('/targets') && response.request().method() === 'POST');
    const assessmentResponse = page.waitForResponse(response => response.url().endsWith('/assessments') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Analizar origen' }).click();
    const enrolled = await enrollmentResponse;
    expect(enrolled.status()).toBe(201);
    const enrollmentPayload: unknown = await enrolled.json();
    const target = customerTargetSchema.parse(
      enrollmentPayload && typeof enrollmentPayload === 'object' && 'target' in enrollmentPayload
        ? enrollmentPayload.target
        : null,
    );
    expect(target).toMatchObject({ origin: 'https://example.com', status: 'authorized', scanProfile: 'root' });
    expect(target.requestedAt).toBeTruthy();
    expect(target.authorizedAt).toBeTruthy();
    const queued = await assessmentResponse;
    expect(queued.status()).toBe(202);
    const assessmentPayload: unknown = await queued.json();
    expect(assessmentPayload).toMatchObject({ jobId: expect.any(String) });
    await page.locator('.customer-job-banner').waitFor({ timeout: 10_000 });

    const workspacePayload: unknown = await page.evaluate(async () => await (await fetch('/api/customer/workspaces')).json());
    const workspace = customerWorkspaceSchema.parse(Array.isArray(workspacePayload) ? workspacePayload[0] : null);
    const applicationPayload: unknown = await page.evaluate(async organizationId => await (await fetch(`/api/customer/workspaces/${organizationId}/applications`)).json(), workspace.id);
    const application = customerApplicationSchema.parse(Array.isArray(applicationPayload) ? applicationPayload[0] : null);
    const persisted = await db.admin.query<{ status: string; requested_by: string; authorized_at: Date; expires_at: Date; jobs: number }>(`SELECT
      t.status, t.requested_by, t.authorized_at, t.expires_at,
      (SELECT count(*)::int FROM gotchu.jobs j WHERE j.organization_id=t.organization_id AND j.application_id=t.application_id AND j.kind='audit') AS jobs
      FROM gotchu.customer_targets t WHERE t.organization_id=$1 AND t.application_id=$2 AND t.id=$3`, [workspace.id, application.applicationId, target.id]);
    expect(persisted.rows[0]).toMatchObject({ status: 'authorized', requested_by: expect.any(String), jobs: 1 });
    expect(persisted.rows[0]?.expires_at.getTime()).toBeGreaterThan(Date.now());

    await page.reload();
    await page.getByRole('heading', { name: 'Nueva evaluación' }).waitFor();
    await page.getByLabel('Origen HTTPS disponible').selectOption(target.id);

    const viewerPage = await browser?.newPage();
    if (!viewerPage) throw new Error('Browser fixture is not running.');
    await signIn(viewerPage, origin, `onboarding-https-viewer-${randomUUID()}@example.test`);
    const viewerSession: unknown = await viewerPage.evaluate(async () => await (await fetch('/api/customer/session')).json());
    if (!viewerSession || typeof viewerSession !== 'object' || !('user' in viewerSession) || !viewerSession.user || typeof viewerSession.user !== 'object' || !('id' in viewerSession.user) || typeof viewerSession.user.id !== 'string') throw new Error('Viewer session did not include its account ID.');
    await db.admin.query("INSERT INTO gotchu.memberships(organization_id,user_id,role) VALUES($1,$2,'viewer')", [workspace.id, viewerSession.user.id]);
    await viewerPage.reload();
    await viewerPage.getByRole('heading', { name: 'Nueva evaluación' }).waitFor();
    await viewerPage.getByRole('button', { name: 'Iniciar evaluación' }).waitFor();
    expect(await viewerPage.getByRole('button', { name: 'Iniciar evaluación' }).isDisabled()).toBe(true);
    const deniedEnrollment = await viewerPage.evaluate(async ({ organizationId, applicationId }) => {
      const response = await fetch(`/api/customer/workspaces/${organizationId}/applications/${applicationId}/targets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'https://other.example.com', scanProfile: 'root' }) });
      return { status: response.status, body: await response.text() };
    }, { organizationId: workspace.id, applicationId: application.applicationId });
    expect(deniedEnrollment, deniedEnrollment.body).toMatchObject({ status: 403 });
    await viewerPage.close();

    await db.admin.query("UPDATE gotchu.customer_targets SET expires_at=authorized_at+interval '1 second' WHERE organization_id=$1 AND application_id=$2 AND id=$3", [workspace.id, application.applicationId, target.id]);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    const expired = page.waitForResponse(response => response.url().endsWith('/assessments') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Iniciar evaluación' }).click();
    expect((await expired).status()).toBe(409);
    await page.getByRole('alert').filter({ hasText: /alcance HTTPS venció/i }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Nueva evaluación' }).waitFor();
    await page.getByRole('link', { name: 'Fuentes', exact: true }).click();
    await page.getByText('Alcance vencido').waitFor();
  }, 60_000);

  it('renews and revokes the existing application-panel HTTPS scope without TXT steps', async () => {
    await page.context().clearCookies();
    await page.goto(origin);
    await page.evaluate(() => sessionStorage.clear());
    await signIn(page, origin, `target-panel-${randomUUID()}@example.test`);
    const scope = await page.evaluate(async () => {
      const workspaceResponse = await fetch('/api/customer/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Target panel fixture' }) });
      const workspace: unknown = await workspaceResponse.json();
      if (!workspaceResponse.ok || !workspace || typeof workspace !== 'object' || !('id' in workspace) || typeof workspace.id !== 'string') throw new Error('Could not create the target panel workspace.');
      const applicationResponse = await fetch(`/api/customer/workspaces/${workspace.id}/applications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Target panel app' }) });
      const application: unknown = await applicationResponse.json();
      if (!applicationResponse.ok || !application || typeof application !== 'object' || !('applicationId' in application) || typeof application.applicationId !== 'string') throw new Error('Could not create the target panel application.');
      return { organizationId: workspace.id, applicationId: application.applicationId };
    });
    await page.reload();
    await page.getByRole('link', { name: 'Fuentes', exact: true }).click();
    await page.getByLabel('Origen HTTPS').fill('https://example.com');
    await page.getByLabel('Perfil de evaluación').selectOption('public_surface');
    expect(await page.getByLabel('Origen HTTPS').inputValue()).toBe('https://example.com');
    expect(await page.locator('.customer-enroll-form input[type="checkbox"]').count()).toBe(0);
    const [enrolled] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/targets') && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Añadir origen' }).click(),
    ]);
    expect(enrolled.status()).toBe(201);
    const payload: unknown = await enrolled.json();
    const target = customerTargetSchema.parse(payload && typeof payload === 'object' && 'target' in payload ? payload.target : null);
    expect(target).toMatchObject({ origin: 'https://example.com', status: 'authorized', scanProfile: 'public_surface' });
    const jobsBeforeRenewal = await db.admin.query<{ jobs: number }>("SELECT count(*)::int AS jobs FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='audit'", [scope.organizationId, scope.applicationId]);
    expect(jobsBeforeRenewal.rows[0]?.jobs).toBe(0);

    await db.admin.query("UPDATE gotchu.customer_targets SET expires_at=authorized_at+interval '1 second' WHERE organization_id=$1 AND application_id=$2 AND id=$3", [scope.organizationId, scope.applicationId, target.id]);
    await new Promise(resolve => setTimeout(resolve, 1_200));
    await page.reload();
    await page.getByRole('link', { name: 'Fuentes', exact: true }).click();
    await page.getByText('Alcance vencido').waitFor();
    const renewal = page.waitForResponse(response => response.url().endsWith('/targets') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Renovar alcance' }).click();
    expect((await renewal).status()).toBe(201);
    await page.getByText('Alcance activo').waitFor();
    const revoke = page.waitForResponse(response => response.url().endsWith('/revoke') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Revocar alcance' }).click();
    expect((await revoke).status()).toBe(200);
    await page.getByText('Alcances revocados (1)').waitFor();
  }, 60_000);

  it('creates the first workspace and scans a selected repository after explicit GitHub owner consent', async () => {
    await page.context().clearCookies();
    await page.goto(origin);
    await page.evaluate(() => sessionStorage.clear());
    await signIn(page, origin, `onboarding-github-${randomUUID()}@example.test`);
    await page.getByRole('heading', { name: 'Tu primera revisión' }).waitFor();
    await startClickCounter(page);
    await page.locator('.customer-source-card').filter({ has: page.getByRole('radio', { name: 'GitHub' }) }).click();
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
    // Browser routing cannot intercept a later hop of a server redirect chain.
    // Exercise the real form POST, then replace only its external provider redirect.
    await page.route(`${origin}/api/customer/github/choose`, async route => {
      const response = await route.fetch({ maxRedirects: 0 });
      expect(response.status()).toBe(303);
      const authorization = new URL(response.headers()['location'] ?? '');
      expect(authorization.origin).toBe('https://github.com');
      expect(authorization.pathname).toBe('/login/oauth/authorize');
      expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
      const state = authorization.searchParams.get('state');
      if (!state) throw new Error('Missing selected-installation OAuth state');
      const callback = new URL('/api/customer/github/callback', origin);
      callback.search = new URLSearchParams({ code: 'fixture-code', state }).toString();
      await route.fulfill({ status: 303, headers: { location: callback.href } });
    });
    await page.getByRole('button', { name: 'Conectar GitHub' }).click();
    await page.getByRole('button', { name: 'Compartir fixture-owner con este espacio' }).click();
    try { await page.getByText('Conectado a fixture-owner').waitFor({ timeout: 15_000 }); }
    catch {
      const onboarding = await page.locator('.customer-onboarding').innerText().catch(() => 'Onboarding is not visible.');
      const hasSavedScope = await page.evaluate(() => window.sessionStorage.getItem('gotchu-onboarding-scope') !== null);
      throw new Error(JSON.stringify({ onboarding, hasSavedScope, customerApiFailures, location: new URL(page.url()).origin + new URL(page.url()).pathname, visibleText: (await page.locator('body').innerText()).slice(0, 2000) }));
    }
    const scan = page.waitForResponse(response => response.url().includes('/github/installations/174788349/repositories/42/select') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Analizar fixture-owner/vulnerable-app' }).click();
    expect((await scan).status()).toBe(201);
    await page.locator('.customer-job-banner').waitFor({ timeout: 10_000 });
    expect(await page.evaluate(() => window.sessionStorage.getItem('onboarding-click-count'))).toBe('4');
    const workspaces = await page.evaluate(async () => await (await fetch('/api/customer/workspaces')).json());
    const workspace = customerWorkspaceSchema.parse(Array.isArray(workspaces) ? workspaces[0] : null);
    const applications = await page.evaluate(async (organizationId) => await (await fetch(`/api/customer/workspaces/${organizationId}/applications`)).json(), workspace.id);
    const application = customerApplicationSchema.parse(Array.isArray(applications) ? applications[0] : null);
    expect(application.name).toBe('fixture-owner/vulnerable-app');
    expect(workspace.name).toMatch(/^Espacio de Onboarding github /i);
    const counts = await db.admin.query<{ sources: number; jobs: number }>(`SELECT
      (SELECT count(*)::int FROM gotchu.customer_sources WHERE organization_id=$1 AND application_id=$2) AS sources,
      (SELECT count(*)::int FROM gotchu.jobs WHERE organization_id=$1 AND application_id=$2 AND kind='audit') AS jobs`, [workspace.id, application.applicationId]);
    expect(counts.rows[0]).toEqual({ sources: 1, jobs: 1 });
    await page.unroute(`${origin}/api/customer/github/choose`);
  }, 60_000);

  it('does not reuse a previous identity\'s onboarding scope after signing out', async () => {
    await page.context().clearCookies();
    await page.goto(origin);
    await page.evaluate(() => sessionStorage.clear());
    await signIn(page, origin, `scope-owner-${randomUUID()}@example.test`);
    await page.locator('.customer-source-card').filter({ has: page.getByRole('radio', { name: 'GitHub' }) }).click();
    await page.route(`${origin}/api/customer/github/connect`, route => route.fulfill({ json: { installUrl: `${origin}/dashboard` } }));
    await page.getByRole('button', { name: 'Conectar GitHub' }).click();
    await page.getByRole('heading', { name: 'Tu primera revisión' }).waitFor();
    await page.evaluate(async () => {
      const payload: unknown = await (await fetch('/api/auth/csrf')).json();
      if (!payload || typeof payload !== 'object' || !('csrfToken' in payload) || typeof payload.csrfToken !== 'string') throw new Error('Missing sign-out CSRF token.');
      const response = await fetch('/api/auth/signout', { method: 'POST', headers: { 'X-Auth-Return-Redirect': '1' }, body: new URLSearchParams({ csrfToken: payload.csrfToken, callbackUrl: '/entrar', json: 'true' }) });
      if (!response.ok) throw new Error('Local fixture sign-out failed.');
    });
    const failuresBefore = customerApiFailures.length;
    await signIn(page, origin, `scope-new-user-${randomUUID()}@example.test`);
    await page.getByRole('heading', { name: 'Tu primera revisión' }).waitFor({ timeout: 5_000 });
    expect(customerApiFailures.slice(failuresBefore)).toEqual([]);
    await page.unroute(`${origin}/api/customer/github/connect`);
  }, 45_000);
});
