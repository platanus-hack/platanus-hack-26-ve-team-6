import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { enrollStepUpFactor, enrollStepUpFactorWithRecovery, listStepUpFactors, renameStepUpFactor, revokeStepUpFactor, revokeStepUpFactorWithRecovery } from './step-up-client';

export function StepUpPanel({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('Mi llave de acceso');
  const [password, setPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const factors = useQuery({ queryKey: ['step-up-factors', organizationId], queryFn: () => listStepUpFactors(organizationId), retry: false });
  const enroll = useMutation({ mutationFn: () => enrollStepUpFactor(organizationId, label, factors.data?.length === 0 ? password : undefined), onSuccess: async result => { setPassword(''); setRecoveryCodes(result.recoveryCodes); await queryClient.invalidateQueries({ queryKey: ['step-up-factors', organizationId] }); } });
  const issue = (error: unknown) => error instanceof Error ? error.message : 'No se pudo completar el cambio.';
  return <section className="customer-card" aria-labelledby="step-up-heading">
    <div className="customer-card-heading"><div><span className="customer-eyebrow">SEGURIDAD DE LA CUENTA</span><h2 id="step-up-heading">Verificación en dos pasos</h2></div></div>
    <p>Protege aprobaciones exactas con una llave de acceso o autenticador del dispositivo. Es una verificación separada del inicio de sesión.</p>
    {factors.isPending ? <p role="status">Cargando factores…</p> : factors.error ? <p role="alert">{issue(factors.error)}</p> : factors.data?.length ? <ul>{factors.data.map(factor => <Factor key={factor.id} organizationId={organizationId} factorId={factor.id} initialLabel={factor.label} onChanged={() => queryClient.invalidateQueries({ queryKey: ['step-up-factors', organizationId] })} />)}</ul> : <p>No hay factores registrados. Añade uno antes de poder verificar una aprobación.</p>}
    {factors.data && factors.data.length < 10 && <form onSubmit={event => { event.preventDefault(); enroll.mutate(); }}>
      <label>Nombre del factor<input value={label} maxLength={80} onChange={event => setLabel(event.target.value)} /></label>
      {factors.data.length === 0 && <label>Contraseña actual<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>}
      <button type="submit" disabled={enroll.isPending || (factors.data.length === 0 && !password)}>{enroll.isPending ? 'Verificando y esperando al autenticador…' : 'Añadir factor'}</button>
    </form>}
    {enroll.error && <p role="alert">{issue(enroll.error)}</p>}
    {factors.data && <RecoveryEnrollment organizationId={organizationId} onSuccess={async result => { setRecoveryCodes(result.recoveryCodes); await queryClient.invalidateQueries({ queryKey: ['step-up-factors', organizationId] }); }} />}
    {recoveryCodes?.length ? <div role="status"><h3>Guarda estos códigos de recuperación</h3><p>Se muestran una sola vez. Cada código permite registrar un factor nuevo, pero nunca aprobar una acción.</p><ul>{recoveryCodes.map(code => <li key={code}><code>{code}</code></li>)}</ul><button onClick={() => setRecoveryCodes(null)}>Ya los guardé</button></div> : null}
  </section>;
}
function RecoveryEnrollment({ organizationId, onSuccess }: { organizationId: string; onSuccess(result: { recoveryCodes: string[] }): void }) {
  const [code, setCode] = useState(''); const [label, setLabel] = useState('Factor nuevo');
  const recover = useMutation({ mutationFn: () => enrollStepUpFactorWithRecovery(organizationId, code, label), onSuccess });
  return <form onSubmit={event => { event.preventDefault(); recover.mutate(); }}><details><summary>¿Has perdido tu factor?</summary><p>Un código usado una sola vez permite registrar otro factor. No autoriza aprobaciones.</p><label>Código de recuperación<input value={code} onChange={event => setCode(event.target.value)} autoComplete="off" /></label><label>Nombre del nuevo factor<input value={label} onChange={event => setLabel(event.target.value)} /></label><button disabled={recover.isPending || !code}>{recover.isPending ? 'Esperando al autenticador…' : 'Usar código y registrar factor'}</button>{recover.error && <p role="alert">{recover.error instanceof Error ? recover.error.message : 'No se pudo recuperar el factor.'}</p>}</details></form>;
}
function Factor({ organizationId, factorId, initialLabel, onChanged }: { organizationId: string; factorId: string; initialLabel: string; onChanged(): void }) {
  const [label, setLabel] = useState(initialLabel);
  const rename = useMutation({ mutationFn: () => renameStepUpFactor(organizationId, factorId, label), onSuccess: onChanged });
  const revoke = useMutation({ mutationFn: () => revokeStepUpFactor(organizationId, factorId), onSuccess: onChanged });
  const revokeRecovery = useMutation({ mutationFn: () => { const recoveryCode = window.prompt('Introduce un código de recuperación de un solo uso.'); if (!recoveryCode) throw new Error('Se canceló la revocación.'); return revokeStepUpFactorWithRecovery(organizationId, factorId, recoveryCode); }, onSuccess: onChanged });
  const error = rename.error ?? revoke.error;
  return <li><label>Nombre<input value={label} maxLength={80} onChange={event => setLabel(event.target.value)} /></label><button disabled={rename.isPending || label.trim() === initialLabel} onClick={() => rename.mutate()}>{rename.isPending ? 'Guardando…' : 'Renombrar'}</button><button disabled={revoke.isPending || revokeRecovery.isPending} onClick={() => revoke.mutate()}>{revoke.isPending ? 'Verificando…' : 'Revocar'}</button><button disabled={revoke.isPending || revokeRecovery.isPending} onClick={() => revokeRecovery.mutate()}>Revocar con recuperación</button>{(error ?? revokeRecovery.error) && <p role="alert">{issue(error ?? revokeRecovery.error)}</p>}</li>;
}
function issue(error: unknown) { return error instanceof Error ? error.message : 'No se pudo completar el cambio.'; }
