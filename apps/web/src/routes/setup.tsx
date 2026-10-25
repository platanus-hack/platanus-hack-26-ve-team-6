import { useState, type FormEvent } from 'react';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { customerApi } from '../components/customer-client.js';
import { PublicTop } from '../components/public-top';
import '../components/public-legal.css';
import '../components/setup-page.css';

export const Route = createFileRoute('/setup')({
  head: () => ({ meta: [
    { name: 'referrer', content: 'no-referrer' },
    { name: 'robots', content: 'noindex,noarchive' },
  ] }),
  component: SetupPage,
});

function SetupPage() {
  const session = useQuery({ queryKey: ['customer-session'], queryFn: customerApi.session, retry: false });
  if (session.isPending) return <main className="gl pub-page setup-page"><p role="status">Cargando…</p></main>;
  if (session.isError) return <main className="gl pub-page setup-page"><p role="alert">No se pudo conectar con Gotchu.</p><a href="/dashboard">Ir a Gotchu</a></main>;
  if (session.data.registrationEnabled) return <Navigate to="/dashboard" replace />;
  return <SetupForm />;
}

function SetupForm() {
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
  return <main className="gl pub-page setup-page">
    <PublicTop />
    <div className="setup-grid">
      <section aria-labelledby="setup-title">
        <h1 id="setup-title">Crea tu espacio de trabajo</h1>
        <p className="setup-fact">La primera cuenta tendrá el rol Owner. El enlace de configuración se usa una sola vez y caduca en una hora.</p>
      </section>
      <form onSubmit={submit}>
        <label htmlFor="setup-email">Correo electrónico</label><input id="setup-email" name="email" type="email" autoComplete="email" maxLength={254} required />
        <label htmlFor="setup-password">Contraseña</label><input id="setup-password" name="password" type="password" autoComplete="new-password" minLength={15} maxLength={128} required /><small>Usa al menos 15 caracteres.</small>
        <label htmlFor="setup-workspace">Nombre del espacio</label><input id="setup-workspace" name="workspace" minLength={1} maxLength={200} required />
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear cuenta y espacio'}</button>
      </form>
    </div>
  </main>;
}
