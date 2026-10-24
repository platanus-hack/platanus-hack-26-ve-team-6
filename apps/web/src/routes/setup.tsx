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
    <style>{`.self-host-setup{min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f6f3;color:#1b2921;font:16px system-ui}.self-host-setup section{width:min(100%,480px);padding:36px;background:white;border:1px solid #dce5dd;border-radius:16px;box-shadow:0 16px 50px #14271d12}.self-host-setup section>span{font-size:12px;letter-spacing:.12em;color:#52715a}.self-host-setup h1{margin:18px 0 8px;font-size:30px}.self-host-setup form{display:grid;gap:10px;margin-top:28px}.self-host-setup input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #b9c6bb;border-radius:7px;font:inherit}.self-host-setup button{margin-top:10px;padding:13px;border:0;border-radius:7px;background:#244f35;color:white;font:inherit;font-weight:650;cursor:pointer}.self-host-setup button:disabled{opacity:.6}.self-host-setup small{color:#68776c}.self-host-setup [role=alert]{color:#9d2828}`}</style>
  </main>;
}
