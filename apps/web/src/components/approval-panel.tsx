import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CustomerApiError, customerApi } from './customer-client';
import { requestStepUp } from './step-up-client';

const stateLabels: Record<string, string> = {
  proposed: 'Propuesta recibida', eligible: 'Lista para autorización', ineligible: 'Bloqueada', approved: 'Aprobada', expired: 'Autorización caducada', invalidated: 'Propuesta invalidada',
  executing: 'Solicitud aceptada', succeeded: 'Cambio aplicado', failed: 'Ejecución fallida', uncertain: 'Resultado incierto', reconciliation_required: 'Revisión necesaria',
};
const buttonLabels: Record<string, string> = {
  dependency_pull_request: 'Aprobar PR', source_patch_pull_request: 'Aprobar PR', merge_pull_request: 'Aprobar merge', deploy_release: 'Aprobar despliegue',
};

export function ApprovalPanel({ userId, organizationId, applicationId, canManage, isOwner }: { userId: string; organizationId: string; applicationId: string; canManage: boolean; isOwner: boolean }) {
  const client = useQueryClient();
  const key = ['customer-data', userId, 'action-proposals', organizationId, applicationId];
  const proposals = useQuery({ queryKey: key, queryFn: () => customerApi.actionProposals(organizationId, applicationId), retry: false });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const approve = useMutation({
    mutationFn: async (proposal: NonNullable<typeof proposals.data>[number]) => {
      const stepUpProof = await requestStepUp(organizationId, proposal.actionHash);
      return customerApi.approveAction({ organizationId, applicationId, proposalId: proposal.id, actionHash: proposal.actionHash, stepUpProof });
    }, onSuccess: refresh,
  });
  const checkEligibility = useMutation({
    mutationFn: (proposalId: string) => customerApi.getActionEligibility(organizationId, applicationId, proposalId),
    onSuccess: refresh,
  });
  const cancel = useMutation({ mutationFn: (proposalId: string) => customerApi.cancelAction({ organizationId, applicationId, proposalId }), onSuccess: refresh });
  const error = approve.error ?? checkEligibility.error ?? cancel.error;
  return <section className="customer-card" aria-labelledby="action-approvals-title">
    <div className="customer-card-heading"><div><span className="customer-eyebrow">AUTORIZACIÓN</span><h2 id="action-approvals-title">Propuestas de cambio</h2></div></div>
    {proposals.isPending && <div className="customer-loading" role="status">Cargando propuestas…</div>}
    {proposals.error && <div className="customer-error" role="alert"><p>{errorMessage(proposals.error)}</p><button className="customer-link-button" onClick={() => { proposals.refetch().catch(() => undefined); }}>Reintentar</button></div>}
    {error && <div className="customer-error" role="alert">{errorMessage(error)}</div>}
    {proposals.data?.length === 0 && <div className="customer-empty-inline">Todavía no hay propuestas para esta aplicación.</div>}
    {proposals.data?.map(proposal => <article className="customer-recommendation-card" key={proposal.id}>
      <div className="customer-recommendation-heading"><div><span className="customer-eyebrow">{stateLabels[proposal.state] ?? proposal.state}</span><h3>{proposal.effect}</h3></div></div>
      <p><strong>Alcance:</strong> {proposal.scope}</p>
      <p><strong>Destino:</strong> {targetLabel(proposal.target)}</p>
      <p><strong>Coste:</strong> Desconocido; no hay una estimación disponible.</p>
      {proposal.diff && <p><strong>Resumen seguro:</strong> {proposal.diff.summary} <code>{proposal.diff.path}</code></p>}
      <h4>Comprobaciones</h4><ul>{proposal.validations.map(fact => <li key={fact.label}>{fact.label === 'reanálisis objetivo' ? 'reanálisis objetivo' : fact.label}: {fact.state === 'passed' ? 'pasó' : fact.state === 'failed' ? 'falló' : 'pendiente'}</li>)}</ul>
      <ul>{proposal.limits.map(limit => <li key={limit}>{limit}</li>)}</ul>
      {proposal.blockingReasons.length > 0 && <div className="customer-field-note"><strong>Qué falta</strong><ul>{proposal.blockingReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
      <div className="customer-recommendation-actions">
        {canManage && ['proposed','ineligible'].includes(proposal.state) && <button className="customer-link-button" type="button" disabled={checkEligibility.isPending} onClick={() => checkEligibility.mutate(proposal.id)}>{checkEligibility.isPending ? 'Revisando requisitos…' : 'Revisar requisitos'}</button>}
        {canManage && proposal.state !== 'approved' && !['executing','succeeded','failed','uncertain','reconciliation_required','invalidated','expired'].includes(proposal.state) && <button className="customer-button" type="button" disabled={!isOwner || proposal.state !== 'eligible' || approve.isPending || proposal.blockingReasons.length > 0} title={!isOwner ? 'Solo una persona propietaria puede aprobar.' : proposal.blockingReasons[0]} onClick={() => approve.mutate(proposal)}>{approve.isPending ? 'Solicitando verificación…' : buttonLabels[proposal.kind] ?? 'Aprobar acción'}</button>}
        {canManage && ['proposed','eligible','ineligible'].includes(proposal.state) && <button className="customer-link-button" type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(proposal.id)}>Cancelar propuesta</button>}
      </div>
      <h4>Seguimiento del efecto</h4>
      <ul>
        <li>Solicitud aceptada: {['approved','executing','succeeded','failed','uncertain','reconciliation_required'].includes(proposal.state) ? 'la autorización está registrada.' : 'todavía no hay una autorización vigente.'}</li>
        <li>API respondió: no hay una respuesta del proveedor registrada en esta vista.</li>
        <li>Cambio aplicado: {proposal.state === 'succeeded' ? 'el ledger registra una ejecución completada.' : 'sin confirmar.'}</li>
        <li>Resultado verificado: no hay un reanálisis posterior registrado.</li>
      </ul>
      {proposal.state === 'uncertain' || proposal.state === 'reconciliation_required' ? <p>El resultado no se puede confirmar. No se repetirá la escritura hasta completar la reconciliación.</p> : null}
    </article>)}
  </section>;
}

function targetLabel(target: unknown) {
  if (target && typeof target === 'object' && 'repositoryKey' in target && typeof target.repositoryKey === 'string') return target.repositoryKey;
  if (target && typeof target === 'object' && 'name' in target && typeof target.name === 'string') return target.name;
  return 'Destino definido por el inventario de la aplicación';
}
function errorMessage(error: unknown) {
  if (error instanceof CustomerApiError) return error.message;
  if (error instanceof Error && error.name !== 'ZodError') return error.message;
  return 'No se pudo completar la operación.';
}
