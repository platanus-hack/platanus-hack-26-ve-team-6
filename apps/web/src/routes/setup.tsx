import { useState, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { customerApi } from '../components/customer-client.js';

export const Route = createFileRoute('/setup')({
  head: () => ({ meta: [
    { name: 'referrer', content: 'no-referrer' },
    { name: 'robots', content: 'noindex,noarchive' },
  ] }),
  component: SetupPage,
});

function SetupPage() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/customer/setup', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: new URLSearchParams(window.location.search).get('token'), email: form.get('email'), password: form.get('password'), workspaceName: form.get('workspace') }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? 'El enlace ya se usó o caducó. Genera otro desde ./gotchu setup-link.' : 'No se pudo crear la cuenta. Revisa los datos e inténtalo de nuevo.');
      await customerApi.signIn(String(form.get('email')), String(form.get('password')));
      window.location.assign('/dashboard');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No se pudo completar la configuración.');
      setBusy(false);
    }
  }
  return <main className="gl self-host-setup">
    <section>
      <span>GOTCHU · PRIMER ARRANQUE</span>
      <h1>Crea tu espacio de trabajo</h1>
      <p>La primera cuenta tendrá el rol Owner. El enlace de configuración se usa una sola vez y caduca en una hora.</p>
      <p>Semgrep está fijado en 1.182.0; los informes muestran cobertura parcial y límites, por lo que un resultado sin hallazgos no demuestra que la aplicación sea segura.</p>
      <p>Validador VM no disponible: requiere Linux, /dev/kvm, bwrap y una sesión systemd de usuario. Executor y escrituras a proveedores no disponibles.</p>
      <form onSubmit={submit}>
        <label htmlFor="setup-email">Correo electrónico</label><input id="setup-email" name="email" type="email" autoComplete="email" maxLength={254} required />
        <label htmlFor="setup-password">Contraseña</label><input id="setup-password" name="password" type="password" autoComplete="new-password" minLength={15} maxLength={128} required /><small>Usa al menos 15 caracteres.</small>
        <label htmlFor="setup-workspace">Nombre del espacio</label><input id="setup-workspace" name="workspace" minLength={1} maxLength={200} required />
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear cuenta y espacio'}</button>
      </form>
    </section>
    <style>{`.self-host-setup{min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--background);color:var(--foreground);font:16px/1.6 'Gotchu Text',system-ui,sans-serif}.self-host-setup *{box-sizing:border-box}.self-host-setup section{width:min(100%,480px);padding:36px;background:var(--background);border:1px solid var(--border);border-top:2px solid var(--foreground);border-radius:12px}.self-host-setup section>span{font:500 12.5px/1.4 var(--mono);letter-spacing:.14em;color:var(--muted-foreground)}.self-host-setup h1{margin:18px 0 8px;font:700 30px/1.1 'Gotchu Display','Gotchu Text',sans-serif;letter-spacing:.03em;text-transform:uppercase}.self-host-setup p{color:var(--muted-foreground);max-width:62ch}.self-host-setup form{display:grid;gap:10px;margin-top:28px}.self-host-setup label{font-size:14px;font-weight:600}.self-host-setup input{width:100%;min-height:34px;padding:6px 12px;border:1px solid var(--input);border-radius:8px;background:var(--background);color:var(--foreground);font:inherit}.self-host-setup :where(input,button):focus-visible{outline:2px solid var(--ring);outline-offset:4px}.self-host-setup button{min-height:48px;margin-top:10px;padding:8px 22px;border:1px solid transparent;border-radius:8px;background:var(--primary);color:var(--primary-foreground);font:inherit;font-weight:600;cursor:pointer;transition:translate 160ms var(--ease),scale 160ms var(--ease),box-shadow 160ms var(--ease)}.self-host-setup button:hover:not(:disabled){translate:-2px -2px;box-shadow:4px 4px 0 var(--brand)}.self-host-setup button:active:not(:disabled){scale:.97}.self-host-setup button:disabled{opacity:.5;cursor:not-allowed}.self-host-setup small{color:var(--muted-foreground)}.self-host-setup [role=alert]{color:var(--destructive)}`}</style>
  </main>;
}
