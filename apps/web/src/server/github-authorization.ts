import { z } from 'zod';
import { HttpError } from './http.js';

const idSchema = z.number().int().positive();
const installationSchema = z.object({ id: idSchema, account: z.object({ id: idSchema, login: z.string().min(1).max(100), type: z.enum(['User', 'Organization']) }) });
const installationListSchema = z.object({ installations: z.array(installationSchema).max(100) });
const userSchema = z.object({ id: idSchema });
const membershipSchema = z.object({ state: z.enum(['active', 'pending']), role: z.enum(['admin', 'member']), organization: userSchema, user: userSchema });

async function githubData<T>(path: string, token: string, schema: z.ZodType<T>, fetcher: typeof fetch) {
  const response = await fetcher(new URL(path, 'https://api.github.com'), { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10', 'user-agent': 'Gotchu/0.1.0' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new HttpError(response.status, 'github_authorization_failed', 'GitHub no pudo comprobar tu autorización. Vuelve a intentarlo.');
  const payload: unknown = await response.json();
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new HttpError(502, 'github_invalid_response', 'GitHub devolvió datos de autorización inesperados.');
  return parsed.data;
}

export async function githubUserInstallations(token: string, fetcher: typeof fetch) {
  const installations: z.infer<typeof installationSchema>[] = [];
  for (let page = 1; page <= 10; page++) {
    const result = await githubData(`/user/installations?per_page=100&page=${page}`, token, installationListSchema, fetcher);
    installations.push(...result.installations);
    if (result.installations.length < 100) return installations;
  }
  throw new HttpError(413, 'github_user_installation_limit', 'La cuenta supera el límite de 1000 instalaciones visibles.');
}

export async function requireGitHubInstallationOwner(token: string, installationId: string, fetcher: typeof fetch) {
  const [user, installations] = await Promise.all([githubData('/user', token, userSchema, fetcher), githubUserInstallations(token, fetcher)]);
  const installation = installations.find(item => String(item.id) === installationId);
  if (!installation) throw new HttpError(403, 'github_installation_not_accessible', 'La cuenta de GitHub no puede acceder a esta instalación.');
  let owner = installation.account.type === 'User' && installation.account.id === user.id;
  if (installation.account.type === 'Organization') {
    try {
      const membership = await githubData(`/user/memberships/orgs/${encodeURIComponent(installation.account.login)}`, token, membershipSchema, fetcher);
      owner = membership.state === 'active' && membership.role === 'admin'
        && membership.user.id === user.id && membership.organization.id === installation.account.id;
    } catch (error) {
      if (!(error instanceof HttpError) || ![403, 404].includes(error.status)) throw error;
    }
  }
  if (!owner) throw new HttpError(403, 'github_owner_required', 'Solo el propietario de la cuenta o un propietario de la organización en GitHub puede compartir esta instalación con el espacio. Comprueba también que la instalación tenga aprobado el permiso de lectura de miembros.');
  return { installation, githubUserId: String(user.id) };
}

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

export function githubConsentPage(workspaceName: string, state: string, installations: Awaited<ReturnType<typeof githubUserInstallations>>, headers: Headers, mode: 'legacy' | 'single-app' = 'legacy') {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  // no-referrer makes browser form POSTs send Origin: null. Keep same-origin
  // CSRF checks usable while suppressing callback queries on external requests.
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  // Chromium applies form-action to redirects too; consent redirects only to our fixed GitHub origin.
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'");
  const consentCopy = mode === 'single-app'
    ? '<p>Gotchu podrá leer los repositorios autorizados para esta GitHub App. Para evaluarlos, guarda solo los archivos compatibles de una instantánea; no es una copia completa del repositorio y el código no se ejecuta.</p><p>Un borrador de pull request solo podría prepararse después de una aprobación explícita y de conceder el permiso correspondiente.</p>'
    : '<p>El espacio podrá leer los repositorios autorizados a la GitHub App, incluidos los que añadas después. No podrá escribir en ellos. Este permiso permanece aunque cambien los administradores, hasta que desconectes GitHub aquí o retires la instalación en GitHub.</p>';
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar GitHub · Gotchu</title><style>
@font-face{font-family:Saira;src:url('/fonts/saira-latin.woff2') format('woff2');font-display:swap}*{box-sizing:border-box}body{margin:0;background:#fff;color:#191923;font:18px/1.6 Saira,system-ui,sans-serif}main{max-width:680px;margin:8vh auto;padding:24px}a{color:inherit}h1{font-size:clamp(26px,5vw,38px);line-height:1.2;margin-top:40px}p{max-width:60ch}form{display:grid;gap:12px;margin-top:28px}button{font:inherit;min-height:48px;padding:12px 18px;border:1px solid #646174;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer}button:hover{border-color:#c80c68}button:focus-visible,a:focus-visible{outline:3px solid #c80c68;outline-offset:4px}.brand{font-weight:700;letter-spacing:.12em;text-decoration:none}.install{color:#c80c68}footer{margin-top:32px;font-size:16px}@media(prefers-color-scheme:dark){body{background:#000;color:#fff}button{border-color:#b5b1bb}.install{color:#ff8fbe}}
</style></head><body><main><a class="brand" href="/dashboard">GOTCHU</a><h1>Conecta GitHub con ${escape(workspaceName)}</h1><p>Comparte una instalación con este espacio de trabajo. Debes ser propietario de la cuenta o de la organización en GitHub.</p>${consentCopy}<form action="/api/customer/github/choose" method="post"><input type="hidden" name="state" value="${escape(state)}">${installations.map(installation => `<button name="installationId" value="${installation.id}">Compartir ${escape(installation.account.login)} con este espacio</button>`).join('')}<button class="install" name="installationId" value="new">Instalar en otra cuenta de GitHub</button></form><footer><a href="/dashboard">Cancelar y volver al espacio</a></footer></main></body></html>`, { headers });
}
