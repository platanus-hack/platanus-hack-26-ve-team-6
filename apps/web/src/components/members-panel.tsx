import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { inviteRoleSchema, workspaceRoleSchema, type WorkspaceRole } from '@gotchu/contracts';
import { CustomerApiError } from './customer-client.js';
import { membersApi } from './members-client.js';

const roleLabels: Record<WorkspaceRole, string> = { owner: 'Propietario', operator: 'Operador', viewer: 'Lector' };
function errorMessage(error: unknown) {
  return error instanceof CustomerApiError ? error.message : 'No se pudo completar la operación. Inténtalo de nuevo.';
}
function friendlyDate(value: string) { return new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(value)); }

export function MembersPanel({ organizationId, userId, role }: { organizationId: string; userId: string; role: WorkspaceRole }) {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'operator' | 'viewer'>('viewer');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [action, setAction] = useState<{ kind: 'remove'; userId: string } | { kind: 'leave' } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['workspace-members', organizationId] }),
      client.invalidateQueries({ queryKey: ['workspace-invitations', organizationId] }),
      client.invalidateQueries({ queryKey: ['customer-data'] }),
    ]);
  };
  const members = useQuery({ queryKey: ['workspace-members', organizationId], queryFn: () => membersApi.list(organizationId), retry: false });
  const invitations = useQuery({ queryKey: ['workspace-invitations', organizationId], queryFn: () => membersApi.invitations(organizationId), enabled: role === 'owner', retry: false });
  const invite = useMutation({
    mutationFn: () => membersApi.invite(organizationId, email, inviteRole),
    onSuccess: async result => { setEmail(''); setInviteLink(result.invitationUrl); setCopied(false); setMessage('Enlace creado. Compártelo con la persona invitada.'); await invalidate(); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => membersApi.revokeInvitation(organizationId, id), onSuccess: invalidate });
  const changeRole = useMutation({ mutationFn: ({ userId: target, role: next }: { userId: string; role: WorkspaceRole }) => membersApi.changeRole(organizationId, target, next), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (target: string) => membersApi.remove(organizationId, target), onSuccess: async () => { setAction(null); setMessage('La persona salió del espacio. Sus verificaciones y aprobaciones pendientes quedaron invalidadas.'); await invalidate(); } });
  const leave = useMutation({ mutationFn: () => membersApi.leave(organizationId), onSuccess: async () => { setAction(null); setMessage('Saliste del espacio. Tus verificaciones y aprobaciones pendientes quedaron invalidadas.'); await invalidate(); } });
  const busy = invite.isPending || revoke.isPending || changeRole.isPending || remove.isPending || leave.isPending;

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null); setInviteLink(null); invite.mutate();
  }
  async function copyLink() {
    if (!inviteLink) return;
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true); }
    catch { setMessage('No se pudo copiar automáticamente. Selecciona y copia el enlace.'); }
  }
  function confirmAction() {
    if (!action) return;
    if (action.kind === 'leave') leave.mutate(); else remove.mutate(action.userId);
  }

  return <section className="customer-card customer-panel" aria-label="Miembros y roles">
    {message && <p role="status" className="customer-success">{message}</p>}
    {members.isPending ? <div role="status" className="customer-loading">Cargando miembros…</div>
      : members.error ? <div role="alert" className="customer-form-error">{errorMessage(members.error)} <button type="button" className="customer-link-button" onClick={() => { members.refetch().catch(() => undefined); }}>Reintentar</button></div>
      : members.data?.length === 0 ? <p className="customer-empty-inline">Todavía no hay miembros en este espacio.</p>
      : <ul className="customer-ruled-list">{members.data?.map(member => <li key={member.userId}>
        <div className="customer-member-row"><span className="customer-ruled-title"><strong>{member.email ?? member.userId}</strong><small>{member.userId === userId ? 'Tú · ' : ''}Se unió {friendlyDate(member.joinedAt)}</small></span>
          <span className="customer-status customer-status-muted">{roleLabels[member.role]}</span>
          {role === 'owner' && member.userId !== userId && <label className="customer-member-role"> <span className="sr-only">Rol de {member.email ?? member.userId}</span><select value={member.role} disabled={busy} onChange={event => { const nextRole = workspaceRoleSchema.safeParse(event.target.value); if (nextRole.success) changeRole.mutate({ userId: member.userId, role: nextRole.data }); }}><option value="owner">Propietario</option><option value="operator">Operador</option><option value="viewer">Lector</option></select></label>}
          {role === 'owner' && member.userId !== userId && <button type="button" className="customer-link-button" disabled={busy} onClick={() => setAction({ kind: 'remove', userId: member.userId })}>Quitar</button>}
        </div></li>)}</ul>}

    {role === 'owner' && <>
      <form className="customer-form" onSubmit={submitInvite}>
        <h3>Invitar a una persona</h3><label htmlFor="workspace-invite-email">Correo electrónico</label><input id="workspace-invite-email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} />
        <label htmlFor="workspace-invite-role">Rol inicial</label><select id="workspace-invite-role" value={inviteRole} onChange={event => { const nextRole = inviteRoleSchema.safeParse(event.target.value); if (nextRole.success) setInviteRole(nextRole.data); }}><option value="viewer">Lector</option><option value="operator">Operador</option></select>
        <p className="customer-field-note">El enlace sirve una sola vez y vence en 7 días. Gotchu no lo envía por correo: compártelo tú.</p>
        {invite.error && <p role="alert" className="customer-form-error">{errorMessage(invite.error)}</p>}
        <button className="customer-button customer-button-primary" disabled={busy || !email.trim()}>Crear enlace de invitación</button>
      </form>
      {inviteLink && <div className="customer-invite-link"><label htmlFor="invite-link">Enlace de invitación de un solo uso</label><div className="customer-inline-control"><input id="invite-link" readOnly value={inviteLink} onFocus={event => event.currentTarget.select()} /><button type="button" className="customer-button customer-button-small" onClick={copyLink}>{copied ? 'Copiado' : 'Copiar enlace'}</button></div></div>}
      <section aria-labelledby="pending-invites-title"><h3 id="pending-invites-title">Invitaciones pendientes</h3>
        {invitations.isPending ? <div role="status" className="customer-loading">Cargando invitaciones…</div>
          : invitations.error ? <div role="alert" className="customer-form-error">{errorMessage(invitations.error)} <button type="button" className="customer-link-button" onClick={() => { invitations.refetch().catch(() => undefined); }}>Reintentar</button></div>
          : invitations.data?.length === 0 ? <p className="customer-empty-inline">No hay invitaciones pendientes.</p>
          : <ul className="customer-ruled-list">{invitations.data?.map(item => <li key={item.id}><div className="customer-member-row"><span className="customer-ruled-title"><strong>{item.email}</strong><small>{roleLabels[item.role]} · vence {friendlyDate(item.expiresAt)}</small></span><button type="button" className="customer-link-button" disabled={busy} onClick={() => revoke.mutate(item.id)}>Revocar</button></div></li>)}</ul>}
        {revoke.error && <p role="alert" className="customer-form-error">{errorMessage(revoke.error)}</p>}
      </section>
    </>}
    {role !== 'owner' && <button type="button" className="customer-button customer-button-secondary" disabled={busy} onClick={() => setAction({ kind: 'leave' })}>Salir del espacio</button>}
    {(remove.error || leave.error || changeRole.error) && <p role="alert" className="customer-form-error">{errorMessage(remove.error ?? leave.error ?? changeRole.error)}</p>}
    {action && <div role="alertdialog" aria-modal="true" aria-labelledby="member-confirm-title" aria-describedby="member-confirm-copy" className="customer-confirm-dialog" tabIndex={-1}>
      <h3 id="member-confirm-title">{action.kind === 'leave' ? '¿Salir de este espacio?' : '¿Quitar a esta persona?'}</h3>
      <p id="member-confirm-copy">Perderá acceso al espacio. Se invalidarán sus verificaciones en dos pasos y aprobaciones pendientes.</p>
      <div className="customer-dialog-actions"><button type="button" className="customer-button customer-button-secondary" disabled={busy} onClick={() => setAction(null)}>Cancelar</button><button type="button" className="customer-button customer-button-danger" disabled={busy} onClick={confirmAction}>{busy ? 'Actualizando…' : action.kind === 'leave' ? 'Salir del espacio' : 'Quitar miembro'}</button></div>
    </div>}
  </section>;
}
