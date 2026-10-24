import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@gotchu/database';
import { z } from 'zod';
import { audit, authorize, BackendError, canonicalJson, parse, type Identity } from './core.js';
import { assertStepUp, verifiedStepUpSchema, type StepUpVerifier } from './proposals.js';

const rule = z.enum(['invalid_yaml','invalid_document','pull_request_target','push_without_branch_filter','push_to_gotchu_branch','forbidden_pull_request_secret']);
const workflowPath = z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/);
const inputSchema = z.object({ organizationId:z.uuid(),applicationId:z.uuid(),repositoryLinkId:z.uuid(),workflowPath,rule,justification:z.string().trim().min(12).max(1000),stepUpProof:z.string().min(1).max(4096) }).strict();
export function workflowExceptionHash(value: Omit<z.infer<typeof inputSchema>,'stepUpProof'>): string {
  return createHash('sha256').update('gotchu-workflow-exception-v1\n').update(canonicalJson(value)).digest('hex');
}

export function createWorkflowExceptionService(input: { database:Database; stepUpVerifier?:StepUpVerifier }) {
  return {
    async getHash(identity:Identity,raw:unknown) {
      const value=parse(inputSchema.omit({stepUpProof:true}),raw);
      return input.database.tenant(value.organizationId,async tx=>{
        await authorize(tx,value.organizationId,identity,['owner'],value.applicationId);
        const link=await tx.query('SELECT 1 FROM gotchu.application_repository_links WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND NOT revoked',[value.organizationId,value.applicationId,value.repositoryLinkId]);
        if(!link.rowCount) throw new BackendError('repository_link_unavailable','An active repository link is required',409);
        return {actionHash:workflowExceptionHash(value)};
      });
    },
    async list(identity:Identity, scope:{organizationId:string;applicationId:string}) {
      const value=parse(z.object({organizationId:z.uuid(),applicationId:z.uuid()}).strict(),scope);
      return input.database.tenant(value.organizationId,async tx=>{
        await authorize(tx,value.organizationId,identity,undefined,value.applicationId);
        const repositories=await tx.query<{id:string;repository_key:string}>(`SELECT id,repository_key FROM gotchu.application_repository_links WHERE organization_id=$1 AND application_id=$2 AND NOT revoked ORDER BY repository_key`,[value.organizationId,value.applicationId]);
        const rows=await tx.query<{repository_link_id:string;exception_id:string;version:number;workflow_path:string;rule:string;justification:string;created_by:string;created_at:Date}>(`SELECT repository_link_id,exception_id,version,workflow_path,rule,justification,created_by,created_at FROM gotchu.workflow_policy_exceptions WHERE organization_id=$1 AND application_id=$2 AND removed_at IS NULL ORDER BY workflow_path,rule`,[value.organizationId,value.applicationId]);
        return {repositories:repositories.rows.map(row=>({id:row.id,repositoryKey:row.repository_key})),exceptions:rows.rows.map(row=>({repositoryLinkId:row.repository_link_id,id:row.exception_id,version:row.version,workflowPath:row.workflow_path,rule:row.rule,justification:row.justification,createdBy:row.created_by,createdAt:row.created_at.toISOString()}))};
      });
    },
    async create(identity:Identity,raw:unknown) {
      const value=parse(inputSchema,raw);
      const stepUpVerifier=input.stepUpVerifier;
      if(!stepUpVerifier) throw new BackendError('step_up_unavailable','A trusted WebAuthn verifier is required',503);
      const hash=workflowExceptionHash({organizationId:value.organizationId,applicationId:value.applicationId,repositoryLinkId:value.repositoryLinkId,workflowPath:value.workflowPath,rule:value.rule,justification:value.justification});
      return input.database.tenant(value.organizationId,async tx=>{
        await authorize(tx,value.organizationId,identity,['owner'],value.applicationId);
        const link=await tx.query('SELECT 1 FROM gotchu.application_repository_links WHERE organization_id=$1 AND application_id=$2 AND id=$3 AND NOT revoked',[value.organizationId,value.applicationId,value.repositoryLinkId]);
        if(!link.rowCount) throw new BackendError('repository_link_unavailable','An active repository link is required',409);
        const expected={userId:identity.userId,organizationId:value.organizationId,actionHash:hash};
        const proof=parse(verifiedStepUpSchema,await stepUpVerifier.verify({...expected,proof:value.stepUpProof}));
        assertStepUp(proof,expected,new Date());
        if(proof.method!=='webauthn') throw new BackendError('webauthn_step_up_required','A fresh WebAuthn proof bound to this exception is required',403);
        const prior=await tx.query<{exception_id:string;version:number;removed_at:Date|null}>(`SELECT exception_id,version,removed_at FROM gotchu.workflow_policy_exceptions WHERE organization_id=$1 AND application_id=$2 AND repository_link_id=$3 AND workflow_path=$4 AND rule=$5 ORDER BY version DESC LIMIT 1 FOR UPDATE`,[value.organizationId,value.applicationId,value.repositoryLinkId,value.workflowPath,value.rule]);
        if(prior.rows[0]?.removed_at===null) throw new BackendError('exception_already_active','Remove the active workflow exception before creating a new version',409);
        const id=prior.rows[0]?.exception_id??randomUUID(); const version=(prior.rows[0]?.version??0)+1;
        const inserted=await tx.query(`INSERT INTO gotchu.workflow_policy_exceptions(organization_id,application_id,repository_link_id,exception_id,version,workflow_path,rule,justification,exception_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[value.organizationId,value.applicationId,value.repositoryLinkId,id,version,value.workflowPath,value.rule,value.justification,hash,identity.userId]);
        if(inserted.rowCount!==1) throw new BackendError('exception_conflict','Workflow exception could not be recorded',409);
        await audit(tx,value.organizationId,identity.userId,'workflow.exception_created',id,{applicationId:value.applicationId,repositoryLinkId:value.repositoryLinkId,workflowPath:value.workflowPath,rule:value.rule,version,exceptionHash:hash,proofId:proof.proofId});
        return {id,version,workflowPath:value.workflowPath,rule:value.rule,justification:value.justification,createdBy:identity.userId,createdAt:new Date().toISOString()};
      });
    },
    async remove(identity:Identity,scope:{organizationId:string;applicationId:string;repositoryLinkId:string;exceptionId:string;version:number}) {
      const value=parse(z.object({organizationId:z.uuid(),applicationId:z.uuid(),repositoryLinkId:z.uuid(),exceptionId:z.uuid(),version:z.number().int().positive()}).strict(),scope);
      await input.database.tenant(value.organizationId,async tx=>{
        await authorize(tx,value.organizationId,identity,['owner'],value.applicationId);
        const result=await tx.query(`UPDATE gotchu.workflow_policy_exceptions SET removed_at=clock_timestamp(),removed_by=$6 WHERE organization_id=$1 AND application_id=$2 AND repository_link_id=$3 AND exception_id=$4 AND version=$5 AND removed_at IS NULL`,[value.organizationId,value.applicationId,value.repositoryLinkId,value.exceptionId,value.version,identity.userId]);
        if(!result.rowCount) throw new BackendError('exception_not_found','Active workflow exception not found',404);
        await audit(tx,value.organizationId,identity.userId,'workflow.exception_removed',value.exceptionId,{applicationId:value.applicationId,repositoryLinkId:value.repositoryLinkId,version:value.version});
      });
    },
  };
}
