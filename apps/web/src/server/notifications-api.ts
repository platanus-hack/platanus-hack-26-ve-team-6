import {
  createEmailChannelSchema,
  createWebhookChannelSchema,
  createWebhookChannelResponseSchema,
  notificationChannelSchema,
  notificationDeliverySchema,
  notificationTestQueuedSchema,
} from '@gotchu/contracts';
import type { Backend, Identity } from '@gotchu/backend';
import { errorResponse, HttpError, json, readBoundedBody, requireSameOrigin } from './http.js';
import { z } from 'zod';

type Service = Backend['notifications'];

async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new HttpError(415,'content_type','Utiliza application/json.');
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(request,8_192))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400,'invalid_json','El cuerpo no contiene JSON válido.'); }
}

const uuid = (value: string) => {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new HttpError(400,'invalid_input','El identificador no es válido.');
  return parsed.data.toLowerCase();
};

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400,'invalid_input','La solicitud no coincide con el contrato permitido.');
  return parsed.data;
}

/** Handles only the exact workspace notification routes. */
export async function handleNotificationsApi(request: Request, identity: Identity, service: Service, origin: string): Promise<Response | null> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 5 || parts[0] !== 'api' || parts[1] !== 'customer' || parts[2] !== 'workspaces' || parts[4] !== 'notifications') return null;
  try {
    if (url.origin !== origin) throw new HttpError(400,'untrusted_host','El origen del servicio no coincide con su configuración.');
    if (request.method !== 'GET' && request.method !== 'HEAD') requireSameOrigin(request,origin);
    const organizationId=uuid(parts[3]??'');
    if(parts.length===5&&request.method==='GET') {
      return json(z.array(notificationChannelSchema).max(20).parse(await service.listChannels(identity,{organizationId})));
    }
    if(parts.length===6&&parts[5]==='channels'&&request.method==='POST') {
      const raw=await readBody(request);
      const value=parseInput(z.discriminatedUnion('kind',[
        createEmailChannelSchema.extend({kind:z.literal('email')}),
        createWebhookChannelSchema.extend({kind:z.literal('webhook')}),
      ]),raw);
      if(value.kind==='email') return json(notificationChannelSchema.parse(await service.createEmail(identity,{organizationId,label:value.label,email:value.email,minimumSeverity:value.minimumSeverity})),201);
      return json(createWebhookChannelResponseSchema.parse(await service.createWebhook(identity,{organizationId,label:value.label,url:value.url,minimumSeverity:value.minimumSeverity})),201);
    }
    if(parts.length===6&&parts[5]==='deliveries'&&request.method==='GET') {
      return json(z.array(notificationDeliverySchema).max(100).parse(await service.listDeliveries(identity,{organizationId,limit:100})));
    }
    if(parts.length===8&&parts[5]==='channels'&&parts[7]==='test'&&request.method==='POST') {
      parseInput(z.object({}).strict(),await readBody(request));
      return json(notificationTestQueuedSchema.parse(await service.sendTest(identity,{organizationId,channelId:uuid(parts[6]??'')})),202);
    }
    if(parts.length===7&&parts[5]==='channels'&&request.method==='DELETE') {
      await service.disable(identity,{organizationId,channelId:uuid(parts[6]??'')});
      return json({disabled:true});
    }
    throw new HttpError(404,'not_found','Ruta de notificaciones no encontrada.');
  } catch(error) { return errorResponse(error); }
}
