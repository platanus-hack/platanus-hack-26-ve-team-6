import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { CustomerApiError, customerApi } from './customer-client';
import { contextClient } from './context-client';

const stateLabels: Record<string, string> = {
  proposed: 'Propuesta recibida', eligible: 'Lista para autorización', ineligible: 'Bloqueada', approved: 'Autorizada · en espera del ejecutor', expired: 'Autorización caducada', invalidated: 'Propuesta invalidada',
  executing: 'Solicitud aceptada', succeeded: 'PR publicada y verificada', failed: 'Ejecución fallida', uncertain: 'Resultado incierto', reconciliation_required: 'Revisión necesaria', claimed: 'Ejecución reclamada',
};
const buttonLabels: Record<string, string> = {
  source_patch_pull_request: 'Aprobar PR de código', dependency_pull_request: 'Aprobar PR de dependencias', merge_pull_request: 'Aprobación de merge no disponible', deploy_release: 'Aprobación de despliegue no disponible',
};
const stepLabels: Record<string, string> = { claim:'autorización reclamada',publish_branch:'publicación de rama',open_pr:'apertura de PR',verify:'verificación en GitHub' };
const attemptStateLabels: Record<string, string> = { claimed:'iniciado',branch_published:'rama publicada',pr_opened:'PR abierta',verified:'verificado',failed:'fallido',uncertain:'incierto',reconciliation_required:'requiere revisión' };

export function ApprovalPanel({ userId, organizationId, applicationId, canManage, isOwner }: { userId: string; organizationId: string; applicationId: string; canManage: boolean; isOwner: boolean }) {
  const client = useQueryClient();
  const key = ['customer-data', userId, 'action-proposals', organizationId, applicationId];
  const proposals = useQuery({
    queryKey: key, queryFn: () => customerApi.actionProposals(organizationId, applicationId), retry: false,
    refetchInterval: query => query.state.data?.some(proposal => ['approved','executing','uncertain','reconciliation_required'].includes(proposal.state)) ? 5_000 : false,
  });
  const contextKey = ['customer-data', userId, 'context', organizationId, applicationId];
  const context = useQuery({ queryKey: contextKey, queryFn: () => contextClient.list(organizationId, applicationId), enabled: isOwner && Boolean(proposals.data?.length), retry: false });
  const eligibility = useQueries({ queries: (proposals.data ?? []).map(proposal => ({
    queryKey: ['customer-data', userId, 'action-eligibility', organizationId, applicationId, proposal.id],
    queryFn: () => customerApi.getActionEligibility(organizationId, applicationId, proposal.id),
    enabled: isOwner && ['source_patch_pull_request','dependency_pull_request'].includes(proposal.kind) && proposal.state === 'eligible',
    refetchInterval: 30_000,
    retry: false,
  })) });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const approve = useMutation({
    mutationFn: (proposal: NonNullable<typeof proposals.data>[number]) => customerApi.approveAction({ organizationId, applicationId, proposalId: proposal.id, actionHash: proposal.actionHash }),
    onSettled: refresh,
  });
  const grantWriteAccess = useMutation({
    mutationFn: async (input: { proposalId: string; repositoryLinkId: string }) => {
      const scope = { organizationId, applicationId, repositoryLinkId: input.repositoryLinkId, grant: true };
      const confirmation = await contextClient.repositoryWriteAccessChallenge(scope);
      await contextClient.setRepositoryWriteAccess({ ...scope, actionHash: confirmation.actionHash });
      return customerApi.getActionEligibility(organizationId, applicationId, input.proposalId);
    },
    onSettled: () => Promise.all([refresh(), client.invalidateQueries({ queryKey: contextKey }), client.invalidateQueries({ queryKey: ['customer-data', userId, 'action-eligibility', organizationId, applicationId] })]),
  });
  const checkEligibility = useMutation({
    mutationFn: (proposalId: string) => customerApi.getActionEligibility(organizationId, applicationId, proposalId),
    onSuccess: refresh,
  });
  const cancel = useMutation({ mutationFn: (proposalId: string) => customerApi.cancelAction({ organizationId, applicationId, proposalId }), onSuccess: refresh });
  return <section className="customer-card customer-panel" aria-labelledby="action-approvals-title">
    <div className="customer-card-heading"><div><h2 id="action-approvals-title">Propuestas de cambio</h2></div></div>
    <p>Revisa el cambio y aprueba su publicación como PR borrador. Solo una persona propietaria puede autorizarla.</p>
    {proposals.isPending && <div className="customer-loading" role="status">Cargando propuestas…</div>}
    {proposals.error && <div className="customer-error" role="alert"><p>{errorMessage(proposals.error)}</p><button className="customer-link-button" onClick={() => { proposals.refetch().catch(() => undefined); }}>Reintentar</button></div>}
    {proposals.data?.length === 0 && <div className="customer-empty-inline">Todavía no hay propuestas para este proyecto.</div>}
    {proposals.data?.map((proposal, index) => {
      const serverEligibility = eligibility[index]?.data;
      const isPullRequestAction = proposal.kind === 'source_patch_pull_request' || proposal.kind === 'dependency_pull_request';
      const canApprovePr = isOwner && isPullRequestAction && proposal.state === 'eligible' && serverEligibility?.status === 'eligible';
      const eligibilityReasons = serverEligibility?.status === 'ineligible' ? serverEligibility.blockingReasons : proposal.blockingReasons;
      const targetId = repositoryLinkId(proposal.target);
      const repository = context.data?.repositoryLinks.find(item => item.id === targetId);
      const canGrant = isOwner && canManage && repository && !repository.revoked && repository.state === 'verified'
        && repository.readAccess === 'granted' && repository.writeAccess !== 'granted'
        && ['proposed', 'ineligible', 'eligible'].includes(proposal.state);
      return <article className="customer-approval" id={`action-${proposal.actionHash}`} key={proposal.id}>
      <div className="customer-approval-heading"><h3>{proposal.effect}</h3><span className="customer-status">{stateLabels[proposal.state] ?? proposal.state}</span></div>
      <p><strong>Alcance:</strong> {proposal.scope}</p>
      <p><strong>Destino:</strong> {targetLabel(proposal.target)}</p>
      <p><strong>Coste:</strong> Desconocido; no hay una estimación disponible.</p>
      {proposal.diff && <p><strong>Resumen:</strong> {proposal.diff.summary} <code>{proposal.diff.path}</code></p>}
      <h4>Comprobaciones</h4><ul>{proposal.validations.map(fact => <li key={fact.label}>{fact.label === 'reanálisis objetivo' ? 'reanálisis objetivo' : fact.label}: {fact.state === 'passed' ? 'pasó' : fact.state === 'failed' ? 'falló' : 'pendiente'}</li>)}</ul>
      <ul>{proposal.limits.map(limit => <li key={limit}>{limit}</li>)}</ul>
      {eligibilityReasons.length > 0 && <div className="customer-field-note"><strong>Qué falta</strong><ul>{eligibilityReasons.map(reason => <li key={reason}>{reason}</li>)}</ul></div>}
      {canGrant && <div><p>Permite publicar ramas y PR en este repositorio. Cada cambio seguirá necesitando tu aprobación; este permiso no autoriza fusionar ni desplegar.</p><button className="customer-button" type="button" disabled={grantWriteAccess.isPending} onClick={() => grantWriteAccess.mutate({ proposalId: proposal.id, repositoryLinkId: repository.id })}>{grantWriteAccess.isPending ? 'Confirmando permiso…' : 'Permitir publicación de PR'}</button></div>}
      {context.error && isOwner && <p className="customer-form-error" role="alert">No se pudo consultar el permiso del repositorio. <button className="customer-link-button" type="button" onClick={() => { void context.refetch(); }}>Reintentar</button></p>}
      <div className="customer-approval-actions">
        {canManage && isOwner && ['proposed','ineligible','expired'].includes(proposal.state) && isPullRequestAction && <button className="customer-link-button" type="button" disabled={checkEligibility.isPending} onClick={() => checkEligibility.mutate(proposal.id)}>{checkEligibility.isPending ? 'Comprobando requisitos…' : proposal.state === 'expired' ? 'Revisar para aprobar de nuevo' : 'Comprobar requisitos'}</button>}
        {canManage && proposal.state !== 'approved' && !['executing','succeeded','failed','uncertain','reconciliation_required','invalidated','expired'].includes(proposal.state) && <button className="customer-button" type="button" disabled={!canApprovePr || approve.isPending} title={!isOwner ? 'Solo una persona propietaria puede aprobar.' : eligibility[index]?.isPending ? 'Comprobando los requisitos actuales.' : eligibilityReasons[0] ?? (!isPullRequestAction ? 'Esta acción no está disponible en esta fase.' : 'La propuesta todavía no es elegible.')} onClick={() => approve.mutate(proposal)}>{approve.isPending ? 'Guardando aprobación…' : buttonLabels[proposal.kind] ?? 'Acción no disponible'}</button>}
        {canManage && ['proposed','eligible','ineligible'].includes(proposal.state) && <button className="customer-link-button" type="button" disabled={cancel.isPending} onClick={() => cancel.mutate(proposal.id)}>Cancelar propuesta</button>}
        {eligibility[index]?.error && <p className="customer-form-error" role="alert">{errorMessage(eligibility[index].error)}</p>}
        {checkEligibility.error && checkEligibility.variables === proposal.id && <p className="customer-form-error" role="alert">{errorMessage(checkEligibility.error)}</p>}
        {approve.error && approve.variables?.id === proposal.id && <p className="customer-form-error" role="alert">{errorMessage(approve.error)}</p>}
        {cancel.error && cancel.variables === proposal.id && <p className="customer-form-error" role="alert">{errorMessage(cancel.error)}</p>}
        {grantWriteAccess.error && grantWriteAccess.variables?.proposalId === proposal.id && <p className="customer-form-error" role="alert">{errorMessage(grantWriteAccess.error)}</p>}
      </div>
      <h4>Seguimiento del efecto</h4>
      <p>Estado del ejecutor: {proposal.execution.status ? stateLabels[proposal.execution.status] : 'sin ejecución registrada'}.</p>
      {proposal.execution.pullRequestUrl && <p><a href={proposal.execution.pullRequestUrl} target="_blank" rel="noreferrer">Abrir la solicitud de cambio en GitHub</a></p>}
      {proposal.execution.attempts.length > 0 && <><h4>Historial de intentos</h4><ol>{proposal.execution.attempts.map((attempt, attemptIndex) => <li key={`${attempt.attempt}:${attempt.step}:${attempt.state}:${attemptIndex}`}>
        Intento {attempt.attempt} · {stepLabel(attempt.step)}: {attemptStateLabel(attempt.state)} · {new Date(attempt.occurredAt).toLocaleString()}
        {attempt.branch && <> · rama <code>{attempt.branch}</code></>}{attempt.pullRequestNumber && <> · PR #{attempt.pullRequestNumber}</>}{attempt.reasonCode && <> · {attempt.reasonCode}</>}
      </li>)}</ol></>}
      {proposal.state === 'uncertain' || proposal.state === 'reconciliation_required' ? <p>El resultado no se puede confirmar. No se repetirá la escritura hasta completar la reconciliación.</p> : null}
    </article>;
    })}
  </section>;
}

function repositoryLinkId(target: unknown) {
  return target && typeof target === 'object' && 'repositoryLinkId' in target && typeof target.repositoryLinkId === 'string' ? target.repositoryLinkId : undefined;
}

function targetLabel(target: unknown) {
  if (target && typeof target === 'object' && 'repositoryKey' in target && typeof target.repositoryKey === 'string') return target.repositoryKey;
  if (target && typeof target === 'object' && 'name' in target && typeof target.name === 'string') return target.name;
  return 'Destino definido por el inventario de el proyecto';
}
function stepLabel(step: string) { return stepLabels[step] ?? step; }
function attemptStateLabel(state: string) { return attemptStateLabels[state] ?? state; }
function errorMessage(error: unknown) {
  if (error instanceof CustomerApiError) return error.message;
  if (error instanceof Error && error.name !== 'ZodError') return error.message;
  return 'No se pudo completar la operación.';
}
