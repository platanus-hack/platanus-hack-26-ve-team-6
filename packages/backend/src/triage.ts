import { triageIncidentDetailSchema, triageIncidentSchema, triageRevisionSchema, updateIncidentStatusSchema, triageProbeRouteInputSchema, triageProbeRouteSettingsSchema, triageProbeRouteSchema } from '@gotchu/contracts';
import { audit, authorize, BackendError, parse, type BaseDependencies, type Identity } from './core.js';

const scopeSchema = triageIncidentSchema.pick({ organizationId: true, applicationId: true });
const statusSchema = updateIncidentStatusSchema.extend({ incidentId: triageIncidentSchema.shape.id });
export function createTriageService(deps: BaseDependencies) {
  return {
    async list(identity: Identity, input: unknown) {
      const scope = parse(scopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity);
        const rows = await tx.query<{ id: string; environment: string; status: string; window_started_at: Date; window_ended_at: Date; created_at: Date; updated_at: Date; body: unknown | null; created_revision_at: Date | null }>(`SELECT i.id,i.environment,i.status,i.window_started_at,i.window_ended_at,i.created_at,i.updated_at,r.body,r.created_at AS created_revision_at
          FROM gotchu.triage_incidents i LEFT JOIN LATERAL (SELECT body,created_at FROM gotchu.triage_revisions WHERE organization_id=i.organization_id AND application_id=i.application_id AND incident_id=i.id ORDER BY revision DESC LIMIT 1) r ON true
          WHERE i.organization_id=$1 AND i.application_id=$2 ORDER BY i.updated_at DESC,i.id LIMIT 500`, [scope.organizationId, scope.applicationId]);
        return rows.rows.map(row => triageIncidentSchema.parse({ ...scope, id: row.id, environment: row.environment, status: row.status,
          windowStartedAt: row.window_started_at.toISOString(), windowEndedAt: row.window_ended_at.toISOString(), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
          latest: row.body ? summary(triageRevisionSchema.parse(row.body), row.created_revision_at?.toISOString() ?? row.updated_at.toISOString()) : null }));
      });
    },
    async get(identity: Identity, input: unknown) {
      const value = parse(scopeSchema.extend({ incidentId: triageIncidentSchema.shape.id }), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx, value.organizationId, identity);
        const incident = await tx.query<{ id: string; environment: string; status: string; window_started_at: Date; window_ended_at: Date; created_at: Date; updated_at: Date }>('SELECT id,environment,status,window_started_at,window_ended_at,created_at,updated_at FROM gotchu.triage_incidents WHERE organization_id=$1 AND application_id=$2 AND id=$3', [value.organizationId,value.applicationId,value.incidentId]);
        const row = incident.rows[0]; if (!row) throw new BackendError('not_found','Incident not found',404);
        const history = await tx.query<{ body: unknown; created_at: Date }>('SELECT body,created_at FROM gotchu.triage_revisions WHERE organization_id=$1 AND application_id=$2 AND incident_id=$3 ORDER BY revision DESC LIMIT 200', [value.organizationId,value.applicationId,value.incidentId]);
        const monitor = await tx.query<{ target_id: string | null; providers: unknown }>(`SELECT target_id,providers FROM gotchu.operation_monitors m WHERE organization_id=$1 AND application_id=$2 AND enabled
          AND (source_id IS NULL OR EXISTS(SELECT 1 FROM gotchu.customer_sources s WHERE s.organization_id=m.organization_id AND s.application_id=m.application_id AND s.id=m.source_id AND s.deleted_at IS NULL))
          AND (target_id IS NULL OR EXISTS(SELECT 1 FROM gotchu.customer_targets t WHERE t.organization_id=m.organization_id AND t.application_id=m.application_id AND t.id=m.target_id AND t.version=m.target_version AND t.status='authorized' AND t.expires_at>clock_timestamp()))`,[value.organizationId,value.applicationId]);
        const configured = monitor.rows[0];
        const requestableEvidence = configured ? [...(configured.target_id ? ['https_health' as const] : []), ...(Array.isArray(configured.providers) && configured.providers.length ? ['provider_status' as const] : [])] : [];
        const revisions = history.rows.map(item => ({ revision: triageRevisionSchema.parse(item.body), createdAt: item.created_at.toISOString() }));
        const latest = revisions[0];
        return triageIncidentDetailSchema.parse({ incident: { organizationId:value.organizationId,applicationId:value.applicationId,id:row.id,environment:row.environment,status:row.status,windowStartedAt:row.window_started_at.toISOString(),windowEndedAt:row.window_ended_at.toISOString(),createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),latest:latest ? summary(latest.revision,latest.createdAt) : null }, revisions, requestableEvidence });
      });
    },
    async updateStatus(identity: Identity, input: unknown) {
      const value = parse(scopeSchema.extend(statusSchema.shape), input);
      await deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx,value.organizationId,identity,['owner','operator']);
        const updated = await tx.query<{ updated: boolean }>('SELECT gotchu.triage_update_status($1,$2,$3,$4,$5) AS updated', [value.organizationId,value.applicationId,identity.userId,value.incidentId,value.status]);
        if (!updated.rows[0]?.updated) throw new BackendError('not_found','Incident not found',404);
        await audit(tx,value.organizationId,identity.userId,'triage.status_changed',value.incidentId,{status:value.status,meaning:'user_triage_only'});
      });
      return this.get(identity,{organizationId:value.organizationId,applicationId:value.applicationId,incidentId:value.incidentId});
    },
    async requestEvidence(identity: Identity, input: unknown) {
      const value = parse(scopeSchema.extend({ incidentId: triageIncidentSchema.shape.id }), input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx,value.organizationId,identity,['owner','operator']);
        const found = await tx.query<{ id: string }>('SELECT id FROM gotchu.triage_incidents WHERE organization_id=$1 AND application_id=$2 AND id=$3',[value.organizationId,value.applicationId,value.incidentId]);
        if (!found.rowCount) throw new BackendError('not_found','Incident not found',404);
        const config = await tx.query<{ target_id: string | null; providers: unknown }>(`UPDATE gotchu.operation_monitors m SET next_due_at=clock_timestamp()
          WHERE organization_id=$1 AND application_id=$2 AND enabled AND next_due_at>clock_timestamp()-interval '5 minutes'
          AND (source_id IS NULL OR EXISTS(SELECT 1 FROM gotchu.customer_sources s WHERE s.organization_id=m.organization_id AND s.application_id=m.application_id AND s.id=m.source_id AND s.deleted_at IS NULL))
          AND (target_id IS NULL OR EXISTS(SELECT 1 FROM gotchu.customer_targets t WHERE t.organization_id=m.organization_id AND t.application_id=m.application_id AND t.id=m.target_id AND t.version=m.target_version AND t.status='authorized' AND t.expires_at>clock_timestamp()))
          RETURNING target_id,providers`,[value.organizationId,value.applicationId]);
        const row = config.rows[0]; const requested = row ? [...(row.target_id ? ['https_health' as const] : []), ...(Array.isArray(row.providers) && row.providers.length ? ['provider_status' as const] : [])] : [];
        await audit(tx,value.organizationId,identity.userId,'triage.evidence_requested',value.incidentId,{requested,scope:'existing_monitor_configuration_only'});
        return {requested,message:requested.length ? 'La comprobación se solicitará mediante la configuración de vigilancia existente.' : 'No hay comprobaciones consentidas configuradas para solicitar.'};
      });
    },
    async getProbeRoute(identity: Identity, input: unknown) {
      const scope = parse(scopeSchema, input);
      return deps.database.tenant(scope.organizationId, async tx => {
        await authorize(tx, scope.organizationId, identity);
        const configured = await tx.query<{route:'/'|'/\.well-known/security.txt'|'/security.txt'|'/robots.txt'|'/sitemap.xml';service_id:string;service:string;dependency_id:string|null;provider:string|null;role:'application'|'control';declared_by:string;declared_at:Date;component:string|null}>(`SELECT r.route,r.service_id,s.name AS service,r.dependency_id,d.provider,r.role,r.declared_by,r.declared_at,d.component
          FROM gotchu.triage_probe_routes r JOIN gotchu.application_services s ON s.organization_id=r.organization_id AND s.application_id=r.application_id AND s.id=r.service_id
          LEFT JOIN gotchu.application_dependencies d ON d.organization_id=r.organization_id AND d.application_id=r.application_id AND d.id=r.dependency_id
          WHERE r.organization_id=$1 AND r.application_id=$2 ORDER BY r.route`,[scope.organizationId,scope.applicationId]);
        const optionRows = await tx.query<{service_id:string;service:string;dependency_id:string|null;provider:string|null;component:string|null;state:'declared'|'verified'|'unknown'}>(`SELECT s.id AS service_id,s.name AS service,NULL::uuid AS dependency_id,NULL::text AS provider,NULL::text AS component,s.state
          FROM gotchu.application_services s JOIN gotchu.application_environments e ON e.organization_id=s.organization_id AND e.application_id=s.application_id AND e.id=s.environment_id
          WHERE s.organization_id=$1 AND s.application_id=$2 AND NOT e.archived
          UNION ALL SELECT s.id,s.name,d.id,d.provider,d.component,d.state FROM gotchu.application_services s JOIN gotchu.application_environments e
          ON e.organization_id=s.organization_id AND e.application_id=s.application_id AND e.id=s.environment_id JOIN gotchu.application_dependencies d
          ON d.organization_id=s.organization_id AND d.application_id=s.application_id AND d.service_id=s.id AND d.environment_id=s.environment_id
          WHERE s.organization_id=$1 AND s.application_id=$2 AND NOT e.archived ORDER BY service,provider,component`,[scope.organizationId,scope.applicationId]);
        const routes = configured.rows.map(value=>({route:value.route,serviceId:value.service_id,service:value.service,dependencyId:value.dependency_id,dependsOnProvider:value.provider,role:value.role,declared:true as const,declaredBy:value.declared_by,declaredAt:value.declared_at.toISOString()}));
        const options = optionRows.rows.map(value => ({ serviceId: value.service_id, service: value.service, dependencyId: value.dependency_id,
          provider: value.provider, component: value.component, state: value.state }));
        const profile = await tx.query<{scan_profile:'root'|'public_surface'}>(`SELECT t.scan_profile FROM gotchu.operation_monitors m JOIN gotchu.customer_targets t ON t.organization_id=m.organization_id AND t.application_id=m.application_id AND t.id=m.target_id
          WHERE m.organization_id=$1 AND m.application_id=$2 AND m.enabled AND t.status='authorized' AND t.expires_at>clock_timestamp()`,[scope.organizationId,scope.applicationId]);
        const allowedRoutes = profile.rows[0]?.scan_profile==='public_surface' ? ['/','/.well-known/security.txt','/security.txt','/robots.txt','/sitemap.xml'] : profile.rows[0] ? ['/'] : [];
        return triageProbeRouteSettingsSchema.parse({routes,allowedRoutes,options});
      });
    },
    async declareProbeRoute(identity: Identity, input: unknown) {
      const value = parse(triageProbeRouteInputSchema, input);
      return deps.database.tenant(value.organizationId, async tx => {
        await authorize(tx,value.organizationId,identity,['owner','operator']);
        const result = await tx.query<{declared:boolean}>('SELECT gotchu.triage_declare_probe_route($1,$2,$3,$4,$5,$6,$7) AS declared',[
          value.organizationId,value.applicationId,identity.userId,value.route,value.serviceId,value.dependencyId,value.role,
        ]);
        if (!result.rows[0]?.declared) throw new BackendError('invalid_probe_route_declaration','Route role and dependency must match application inventory and active HTTPS consent',409);
        await audit(tx,value.organizationId,identity.userId,'triage.probe_route_declared',null,{route:value.route,serviceId:value.serviceId,dependencyId:value.dependencyId,role:value.role,declared:true});
      });
    },
  };
}
function summary(revision: ReturnType<typeof triageRevisionSchema.parse>, createdAt: string) {
  return { id: revision.id, revision: revision.revision, rulesVersion: revision.rulesVersion, impact: revision.impact, hypothesisCount: revision.hypotheses.length, createdAt };
}
