import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type CDPSession } from 'playwright';
import { setRecoveryState } from '@gotchu/database';
import { z } from 'zod';
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
  let authenticatorId: string;
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
    const authenticator = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    authenticatorId = authenticator.authenticatorId;
  }, 45_000);
  afterAll(async () => {
    await cdp?.detach().catch(() => undefined);
    await browser?.close();
    if (web?.pid && web.exitCode === null) { web.kill('SIGTERM'); await once(web, 'exit').catch(() => undefined); }
    await db?.close();
  });
  it('registers, enrolls, recovers, and asserts across workspaces', async () => {
    const failures: string[] = [];
    const stepUpRequests: string[] = [];
    page.on('request', request => { if (request.url().includes('/api/customer/step-up/')) stepUpRequests.push(`${request.method()} ${request.url()}`); });
    page.on('response', response => { if (response.url().includes('/api/customer/step-up/') && !response.ok()) failures.push(`${response.status()} ${response.url()}`); });
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
    const bootstrapWithoutPassword = await page.evaluate(async organizationId => {
      const response = await fetch('/api/customer/step-up/factors/enrollment-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId }) });
      return { status: response.status, payload: await response.json() as unknown };
    }, organizationId);
    expect(bootstrapWithoutPassword.status).toBe(403);
    expect(bootstrapWithoutPassword.payload).toMatchObject({ error: { code: 'step_up_password_required' } });
    const bootstrapWrongPassword = await page.evaluate(async ({ organizationId, password }) => {
      const response = await fetch('/api/customer/step-up/factors/enrollment-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId, password }) });
      return { status: response.status, payload: await response.json() as unknown };
    }, { organizationId, password: 'Wrong-password-for-step-up' });
    expect(bootstrapWrongPassword.status).toBe(403);
    expect(bootstrapWrongPassword.payload).toMatchObject({ error: { code: 'step_up_password_invalid' } });
    await page.getByLabel('Contraseña actual').fill(password);
    await page.getByRole('button', { name: 'Añadir factor' }).click();
    const recoveryHeading = page.getByRole('heading', { name: 'Guarda estos códigos de recuperación' });
    const enrollmentError = page.getByRole('alert').first();
    const enrollmentResult = await Promise.race([
      recoveryHeading.waitFor({ timeout: 30_000 }).then(() => 'success'),
      enrollmentError.waitFor({ timeout: 30_000 }).then(() => 'error'),
    ]);
    if (enrollmentResult === 'error') throw new Error(`WebAuthn enrollment failed: ${await enrollmentError.innerText()}\n${failures.join('\n')}`);
    const recoveryCode = await recoveryHeading.locator('..').getByRole('listitem').first().innerText();
    const factorList = await page.evaluate(async organizationId => {
      const response = await fetch(`/api/customer/step-up/factors?organizationId=${organizationId}`);
      return await response.json() as unknown;
    }, organizationId);
    const recoveryCodeForConcurrency = await recoveryHeading.locator('..').getByRole('listitem').nth(1).innerText();
    await page.getByRole('button', { name: 'Ya los guardé' }).click();
    const sessionOnlyEnrollment = await page.evaluate(async organizationId => {
      const response = await fetch('/api/customer/step-up/factors/enrollment-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId }) });
      return { status: response.status, payload: await response.json() as unknown };
    }, organizationId);
    expect(sessionOnlyEnrollment.status).toBe(403);
    expect(sessionOnlyEnrollment.payload).toMatchObject({ error: { code: 'step_up_required' } });
    let existingFactorProof: string | null = null;
    await page.route('**/api/customer/step-up/factors/enrollment-options', async route => {
      const payload: unknown = JSON.parse(route.request().postData() ?? 'null');
      if (isRecord(payload) && typeof payload.proof === 'string') {
        existingFactorProof = payload.proof;
        if (!cdp) throw new Error('CDP virtual authenticator session is unavailable.');
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
        const replacement = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
          protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
          isUserVerified: true, automaticPresenceSimulation: true,
        } });
        authenticatorId = replacement.authenticatorId;
      }
      await route.continue();
    });
    await page.getByLabel('Nombre del factor').last().fill('Factor añadido con prueba');
    const secondEnrollmentResponse = page.waitForResponse(response => response.url().endsWith('/api/customer/step-up/factors/enrollment') && response.request().method() === 'POST', { timeout: 10_000 });
    await page.getByRole('button', { name: 'Añadir factor' }).click();
    let enrolledSecondFactor: import('playwright').Response;
    try { enrolledSecondFactor = await secondEnrollmentResponse; }
    catch (error) { throw new Error(`Second-factor enrollment did not finish: ${String(error)}\nRequests: ${stepUpRequests.join('\n')}\nFailures: ${failures.join('\n')}\nAlerts: ${await page.getByRole('alert').allTextContents()}`); }
    if (enrolledSecondFactor.status() !== 201) throw new Error(`Proof-authorized enrollment failed: ${enrolledSecondFactor.status()} ${await enrolledSecondFactor.text()}`);
    await page.unroute('**/api/customer/step-up/factors/enrollment-options');
    if (!existingFactorProof) throw new Error('Second-factor enrollment did not include its step-up proof.');
    const existingProofReplay = await page.evaluate(async ({ organizationId, proof }) => {
      const response = await fetch('/api/customer/step-up/factors/enrollment-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId, proof }) });
      return { status: response.status, payload: await response.json() as unknown };
    }, { organizationId, proof: existingFactorProof });
    expect(existingProofReplay.status).toBe(403);
    expect(existingProofReplay.payload).toMatchObject({ error: { code: 'step_up_proof_invalid' } });
    await page.waitForFunction(async organizationId => {
      const response = await fetch(`/api/customer/step-up/factors?organizationId=${organizationId}`);
      const factors = await response.json() as unknown;
      return Array.isArray(factors) && factors.length === 2;
    }, organizationId, { timeout: 30_000 });
    expect((await db.admin.query('SELECT id FROM gotchu.step_up_user_factors WHERE user_id=$1 AND revoked_at IS NULL', [`credentials:${account}`])).rowCount).toBe(2);
    const concurrentRecovery = await page.evaluate(async ({ organizationId, recoveryCode }) => Promise.all([1, 2].map(async () => {
      const response = await fetch('/api/customer/step-up/factors/recovery-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId, recoveryCode }) });
      return { status: response.status, payload: await response.json() as unknown };
    })), { organizationId, recoveryCode: recoveryCodeForConcurrency });
    expect(concurrentRecovery.map(result => result.status).sort()).toEqual([201, 403]);
    await page.route('**/api/customer/step-up/factors/recovery-options', async route => {
      if (!cdp) throw new Error('CDP virtual authenticator session is unavailable.');
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      const replacement = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true,
      } });
      authenticatorId = replacement.authenticatorId;
      await route.continue();
    });
    await page.locator('section[aria-labelledby="step-up-heading"] summary').click();
    await page.getByLabel('Código de recuperación').fill(recoveryCode);
    await page.getByLabel('Nombre del nuevo factor').fill('Factor recuperado');
    const recoveryEnrollmentResponse = page.waitForResponse(response => response.url().endsWith('/api/customer/step-up/factors/enrollment') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Usar código y registrar factor' }).click();
    const recoveredFactor = await recoveryEnrollmentResponse;
    if (recoveredFactor.status() !== 201) throw new Error(`Recovery enrollment failed: ${recoveredFactor.status()} ${await recoveredFactor.text()}`);
    await page.unroute('**/api/customer/step-up/factors/recovery-options');
    await page.waitForFunction(async organizationId => {
      const response = await fetch(`/api/customer/step-up/factors?organizationId=${organizationId}`);
      const factors = await response.json() as unknown;
      return Array.isArray(factors) && factors.length === 3;
    }, organizationId, { timeout: 30_000 });
    expect((await db.admin.query('SELECT id FROM gotchu.step_up_user_factors WHERE user_id=$1 AND revoked_at IS NULL', [`credentials:${account}`])).rowCount).toBe(3);
    const recoveryReplay = await page.evaluate(async ({ organizationId, recoveryCode }) => {
      const response = await fetch('/api/customer/step-up/factors/recovery-options', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId, recoveryCode }) });
      return { status: response.status, payload: await response.json() as unknown };
    }, { organizationId, recoveryCode });
    expect(recoveryReplay.status).toBe(403);
    expect(recoveryReplay.payload).toMatchObject({ error: { code: 'recovery_code_invalid' } });
    await rejectAssertion(page, assertion => {
      const clientData = z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(assertion.response.response.clientDataJSON, 'base64url').toString('utf8')) as unknown);
      clientData.origin = 'https://evil.example';
      assertion.response.response.clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString('base64url');
    });
    await rejectAssertion(page, assertion => {
      const clientData = z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(assertion.response.response.clientDataJSON, 'base64url').toString('utf8')) as unknown);
      clientData.challenge = randomBytes(32).toString('base64url');
      assertion.response.response.clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString('base64url');
    });
    await rejectAssertion(page, assertion => {
      const authenticatorData = Buffer.from(assertion.response.response.authenticatorData, 'base64url');
      const firstByte = authenticatorData[0];
      if (firstByte === undefined) throw new Error('WebAuthn authenticator data was empty.');
      authenticatorData[0] = firstByte ^ 0xff;
      assertion.response.response.authenticatorData = authenticatorData.toString('base64url');
    });
    const factors = await page.evaluate(async organizationId => {
      const response = await fetch(`/api/customer/step-up/factors?organizationId=${organizationId}`);
      return await response.json() as unknown;
    }, organizationId);
    if (!Array.isArray(factors) || factors.length !== 3) throw new Error(`Expected three active factors after enrollment and recovery; got ${JSON.stringify(factors)}. Stored: ${JSON.stringify((await db.admin.query('SELECT id,user_id,revoked_at FROM gotchu.step_up_user_factors WHERE user_id=$1 ORDER BY created_at', [`credentials:${account}`])).rows)}. Failures: ${failures.join('\n')} Alerts: ${await page.getByRole('alert').allTextContents()}`);
    const workspaceB = await page.evaluate(async () => {
      const response = await fetch('/api/customer/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Cross-workspace step-up test' }) });
      return { status: response.status, payload: await response.json() as unknown };
    });
    expect(workspaceB.status).toBe(201);
    const organizationBId = zId(workspaceB.payload);
    const workspaceBProof = await page.evaluate(async organizationId => {
      const challengeResponse = await fetch('/api/customer/step-up/challenges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId, actionHash: 'c'.repeat(64) }) });
      if (!challengeResponse.ok) throw new Error(`Workspace B challenge failed: ${await challengeResponse.text()}`);
      const begun = await challengeResponse.json() as { challengeId: string; options: { challenge: string; allowCredentials?: Array<{ id: string; transports?: AuthenticatorTransport[] }>; [key: string]: unknown } };
      const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0)).buffer;
      const encode = (value: ArrayBuffer | null) => value ? btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '') : null;
      const publicKey: PublicKeyCredentialRequestOptions = {
        challenge: decode(begun.options.challenge),
        ...(typeof begun.options.rpId === 'string' ? { rpId: begun.options.rpId } : {}),
        ...(typeof begun.options.timeout === 'number' ? { timeout: begun.options.timeout } : {}),
        ...(typeof begun.options.userVerification === 'string' ? { userVerification: begun.options.userVerification as UserVerificationRequirement } : {}),
        ...(begun.options.allowCredentials ? { allowCredentials: begun.options.allowCredentials.map(item => ({ id: decode(item.id), type: 'public-key' as const, ...(item.transports ? { transports: item.transports } : {}) })) } : {}),
      };
      const credential = await navigator.credentials.get({ publicKey }) as PublicKeyCredential | null;
      if (!credential) throw new Error('Workspace B WebAuthn assertion was cancelled.');
      const assertion = credential.response as AuthenticatorAssertionResponse;
      const response = await fetch('/api/customer/step-up/assertions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId, challengeId: begun.challengeId, response: {
        id: credential.id, rawId: encode(credential.rawId), type: credential.type, response: { clientDataJSON: encode(assertion.clientDataJSON), authenticatorData: encode(assertion.authenticatorData), signature: encode(assertion.signature), userHandle: encode(assertion.userHandle) }, clientExtensionResults: credential.getClientExtensionResults(),
      } }) });
      return { status: response.status, payload: await response.json() as unknown };
    }, organizationBId);
    expect(workspaceBProof.status).toBe(200);
    expect(workspaceBProof.payload).toMatchObject({ proof: expect.any(String) });
    expect(account).toMatch(/^[0-9a-f-]{36}$/);
  }, 120_000);
});


const assertionRequestSchema = z.object({
  organizationId: z.uuid(), challengeId: z.uuid(),
  response: z.object({ response: z.object({ clientDataJSON: z.string(), authenticatorData: z.string() }).passthrough() }).passthrough(),
}).passthrough();
async function rejectAssertion(page: import('playwright').Page, tamper: (assertion: z.infer<typeof assertionRequestSchema>) => void) {
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/customer/step-up/assertions') && response.request().method() === 'POST');
  await page.route('**/api/customer/step-up/assertions', async route => {
    const parsed = assertionRequestSchema.safeParse(JSON.parse(route.request().postData() ?? 'null') as unknown);
    if (!parsed.success) throw new Error('The browser produced an invalid WebAuthn assertion request.');
    tamper(parsed.data);
    await route.continue({ postData: JSON.stringify(parsed.data) });
  });
  await page.locator('section[aria-labelledby="step-up-heading"] li').first().getByRole('button', { name: 'Revocar', exact: true }).click();
  const response = await responsePromise;
  await page.unroute('**/api/customer/step-up/assertions');
  expect(response.status()).toBe(403);
  const payload: unknown = await response.json();
  expect(payload).toMatchObject({ error: { code: 'step_up_assertion_invalid' } });
  await page.getByRole('alert').last().waitFor({ timeout: 10_000 });
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function zAccount(value: unknown) {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new Error('Registration returned an invalid account identity');
  return value.id;
}
function zId(value: unknown) {
  if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') throw new Error('Workspace response did not include an id');
  return value.id;
}
