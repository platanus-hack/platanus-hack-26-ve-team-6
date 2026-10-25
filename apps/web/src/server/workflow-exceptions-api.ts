import type { Backend, Identity } from '@gotchu/backend';
import { z } from 'zod';
import { HttpError, json, readBoundedBody } from './http.js';

type Service = Backend['workflowExceptions'];
async function readJson(request:Request):Promise<unknown>{
  if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json') throw new HttpError(415,'content_type','Utiliza application/json.');
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(request,8192)));}
  catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'invalid_json','El cuerpo no contiene JSON válido.');}
}
const uuid=z.uuid();
export async function handleWorkflowExceptionsApi(request:Request,identity:Identity,service:Service,parts:string[]):Promise<Response|null>{
  const [organizationId,applicationId]=[parts[3],parts[5]];
  if(parts.length<7||parts[6]!=='workflow-exceptions'||!organizationId||!applicationId)return null;
  const scope={organizationId:uuid.parse(organizationId),applicationId:uuid.parse(applicationId)};
  if(parts.length===7&&request.method==='GET'){
    return json(await service.list(identity,scope));
  }
  if(parts.length===8&&parts[7]==='hash'&&request.method==='POST') {
    const value=await readJson(request);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'invalid_input','La solicitud no coincide con el contrato permitido.');
    if('organizationId' in value && value.organizationId!==scope.organizationId || 'applicationId' in value && value.applicationId!==scope.applicationId)throw new HttpError(400,'invalid_input','El alcance del cuerpo no coincide con la ruta.');
    return json(await service.getHash(identity,{...value,...scope}));
  }
  if(parts.length===7&&request.method==='POST'){
    const value=await readJson(request);
    if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'invalid_input','La solicitud no coincide con el contrato permitido.');
    if('organizationId' in value && value.organizationId!==scope.organizationId || 'applicationId' in value && value.applicationId!==scope.applicationId)throw new HttpError(400,'invalid_input','El alcance del cuerpo no coincide con la ruta.');
    return json(await service.create(identity,{...value,...scope}),201);
  }
  if(parts.length===8&&request.method==='DELETE'){
    const query=new URL(request.url).searchParams;
    await service.remove(identity,{...scope,repositoryLinkId:uuid.parse(query.get('repositoryLinkId')),exceptionId:uuid.parse(parts[7]),version:z.coerce.number().int().positive().parse(query.get('version'))});
    return json({removed:true});
  }
  return null;
}
