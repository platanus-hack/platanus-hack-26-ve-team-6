import { z } from 'zod';
import {
  createEmailChannelSchema,
  createWebhookChannelSchema,
  createWebhookChannelResponseSchema,
  notificationChannelSchema,
  notificationDeliverySchema,
  notificationTestQueuedSchema,
} from '@gotchu/contracts';
import { customerRequest } from './customer-client';

const channelListSchema=z.array(notificationChannelSchema).max(20);
const deliveryListSchema=z.array(notificationDeliverySchema).max(100);
const disabledSchema=z.object({disabled:z.literal(true)}).strict();
const workspacePath=(organizationId:string)=>`/api/customer/workspaces/${encodeURIComponent(organizationId)}/notifications`;
const body=(value:unknown):Pick<RequestInit,'headers'|'body'>=>({headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
type WorkspaceScope={organizationId:string};

export const notificationsApi={
  channels(scope:WorkspaceScope){return customerRequest(workspacePath(scope.organizationId),channelListSchema);},
  deliveries(scope:WorkspaceScope){return customerRequest(`${workspacePath(scope.organizationId)}/deliveries`,deliveryListSchema);},
  createEmail(scope:WorkspaceScope,input:z.input<typeof createEmailChannelSchema>){
    const value=createEmailChannelSchema.parse(input);
    return customerRequest(`${workspacePath(scope.organizationId)}/channels`,notificationChannelSchema,{method:'POST',...body({kind:'email',...value})},201);
  },
  createWebhook(scope:WorkspaceScope,input:z.input<typeof createWebhookChannelSchema>){
    const value=createWebhookChannelSchema.parse(input);
    return customerRequest(`${workspacePath(scope.organizationId)}/channels`,createWebhookChannelResponseSchema,{method:'POST',...body({kind:'webhook',...value})},201);
  },
  test(scope:WorkspaceScope,channelId:string){
    const id=z.uuid().parse(channelId);
    return customerRequest(`${workspacePath(scope.organizationId)}/channels/${encodeURIComponent(id)}/test`,notificationTestQueuedSchema,{method:'POST',...body({})},202);
  },
  disable(scope:WorkspaceScope,channelId:string){
    const id=z.uuid().parse(channelId);
    return customerRequest(`${workspacePath(scope.organizationId)}/channels/${encodeURIComponent(id)}`,disabledSchema,{method:'DELETE'});
  },
};
