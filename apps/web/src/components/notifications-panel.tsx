import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type NotificationChannel, type NotificationDelivery, type OperationCoverage } from '@gotchu/contracts';
import { CustomerApiError } from './customer-client';
import { operationsApi } from './operations-client';
import { notificationsApi } from './notifications-client';

const severityNames={info:'Información',low:'Baja',medium:'Media',high:'Alta',critical:'Crítica'} as const;
const deliveryNames:Record<NotificationDelivery['state'],string>={queued:'En cola',sending:'Enviando',sent:'Aceptado por el proveedor',dead_letter:'Falló y quedó en revisión'};
const channelNames:Record<NotificationChannel['state'],string>={active:'Activo',disabled:'Desactivado'};
const eventNames:Record<NotificationDelivery['eventKind'],string>={monitoring_stopped:'Vigilancia detenida',monitoring_recovered:'Vigilancia reanudada',finding:'Hallazgo programado',runtime_alert:'Alerta del detector',test:'Prueba de canal'};

function friendlyError(error:unknown){
  if(error instanceof CustomerApiError){
    if(error.code==='webhook_address_rejected')return 'La URL resuelve a una dirección privada o reservada. Utiliza un destino HTTPS público.';
    if(error.code==='webhook_dns_unavailable')return 'No se pudo validar el DNS del destino. Revisa la URL e inténtalo de nuevo.';
    if(error.code==='notification_channel_limit')return 'El espacio ya alcanzó el máximo de canales.';
    return error.message;
  }
  return 'No se pudo completar la operación. Inténtalo de nuevo.';
}

function formattedDate(value:string){return new Intl.DateTimeFormat('es',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}
function deliveryError(value:string|null){
  if(!value)return null;
  if(value==='channel_disabled')return 'Canal desactivado antes del envío.';
  if(value==='smtp_not_configured')return 'El servicio SMTP no está configurado.';
  if(value.includes('timeout'))return 'El destino no respondió dentro del tiempo permitido.';
  if(value.includes('http_'))return `El destino respondió con ${value.slice(value.lastIndexOf('_')+1)}.`;
  if(value==='webhook_address_rejected')return 'El destino dejó de resolver a una dirección pública.';
  return 'El proveedor no aceptó la notificación.';
}

type Props={userId:string;organizationId:string;applicationId:string;canManage:boolean};

export function NotificationsPanel({userId,organizationId,applicationId,canManage}:Props){
  const queryClient=useQueryClient();
  const scope={organizationId};
  const channelKey=['customer-data',userId,'notifications',organizationId,'channels'] as const;
  const deliveryKey=['customer-data',userId,'notifications',organizationId,'deliveries'] as const;
  const coverageKey=['customer-data',userId,'operations',organizationId,applicationId,'coverage'] as const;
  const channels=useQuery({queryKey:channelKey,queryFn:()=>notificationsApi.channels(scope),retry:false});
  const deliveries=useQuery({queryKey:deliveryKey,queryFn:()=>notificationsApi.deliveries(scope),retry:false,refetchInterval:5_000});
  const coverage=useQuery({queryKey:coverageKey,queryFn:()=>operationsApi.coverage({organizationId,applicationId}),retry:false,refetchInterval:10_000});
  const [kind,setKind]=useState<'email'|'webhook'>('email');
  const [label,setLabel]=useState('');
  const [email,setEmail]=useState('');
  const [webhookUrl,setWebhookUrl]=useState('');
  const [minimumSeverity,setMinimumSeverity]=useState<NotificationDelivery['severity']>('medium');
  const [notice,setNotice]=useState<string|null>(null);
  const [shownSecret,setShownSecret]=useState<{label:string;value:string}|null>(null);
  const invalidate=async()=>Promise.all([
    queryClient.invalidateQueries({queryKey:channelKey}),
    queryClient.invalidateQueries({queryKey:deliveryKey}),
  ]);
  const createEmail=useMutation({mutationFn:()=>notificationsApi.createEmail(scope,{label,email,minimumSeverity}),onSuccess:async()=>{
    setNotice('Canal de correo añadido. Las notificaciones se envían por el SMTP configurado para este servicio.');setLabel('');setEmail('');await invalidate();
  }});
  const createWebhook=useMutation({mutationFn:()=>notificationsApi.createWebhook(scope,{label,url:webhookUrl,minimumSeverity}),onSuccess:async result=>{
    setShownSecret({label:result.channel.label,value:result.signingSecret});setNotice('Canal webhook añadido. Guarda ahora el secreto de firma; no volverá a mostrarse.');setLabel('');setWebhookUrl('');await invalidate();
  }});
  const test=useMutation({mutationFn:(channelId:string)=>notificationsApi.test(scope,channelId),onSuccess:async()=>{setNotice('La prueba quedó en cola. El estado de entrega se actualizará aquí.');await invalidate();}});
  const disable=useMutation({mutationFn:(channelId:string)=>notificationsApi.disable(scope,channelId),onSuccess:async()=>{setNotice('Canal desactivado.');await invalidate();}});
  const busy=createEmail.isPending||createWebhook.isPending||test.isPending||disable.isPending;
  const latestByChannel=new Map<string,NotificationDelivery>();
  for(const item of deliveries.data??[])if(!latestByChannel.has(item.channelId))latestByChannel.set(item.channelId,item);

  function submit(event:FormEvent){
    event.preventDefault();setNotice(null);
    if(kind==='email')createEmail.mutate();
    else createWebhook.mutate();
  }
  async function copySecret(){
    if(!shownSecret)return;
    try{await navigator.clipboard.writeText(shownSecret.value);setNotice('Secreto copiado. Guárdalo en el sistema de secretos del receptor.');}
    catch{setNotice('No se pudo copiar automáticamente. Selecciona y copia el secreto antes de cerrar esta vista.');}
  }

  return <section className="customer-card customer-panel customer-notifications-card" aria-labelledby="notifications-title">
    <div className="customer-card-heading"><div><h2 id="notifications-title">Notificaciones</h2></div><span className="customer-status customer-status-muted">Correo · Webhook</span></div>
    <p className="customer-field-note">Las alertas externas informan sobre vigilancia detenida o reanudada, hallazgos altos o críticos de comprobaciones programadas y alertas de detectores en tiempo de ejecución.</p>

    {coverage.isPending?<div className="customer-loading" role="status">Cargando el estado de vigilancia…</div>
      :coverage.isError?<div className="customer-form-error" role="alert">No se pudo cargar el estado de vigilancia. <button type="button" className="customer-link-button" onClick={()=>{coverage.refetch().catch(()=>undefined);}}>Reintentar</button></div>
      :coverage.data?.liveness.state==='stopped'?<div className="customer-ops-status-warning customer-liveness-banner" role="alert"><strong>Vigilancia detenida</strong><p>{coverage.data.liveness.reason}</p>{coverage.data.liveness.since&&<small>Desde {formattedDate(coverage.data.liveness.since)}</small>}</div>
      :coverage.data?.liveness.state==='late'?<div className="customer-liveness-banner customer-liveness-banner-late" role="status"><strong>Vigilancia con retraso</strong><p>{coverage.data.liveness.reason}</p></div>
      :null}

    {notice&&<p className="customer-success" role="status">{notice}</p>}
    {shownSecret&&<div className="customer-notification-secret" role="alert"><strong>Secreto de firma de {shownSecret.label}</strong><p>Guárdalo ahora. Gotchu no lo devolverá otra vez.</p><code>{shownSecret.value}</code><div className="customer-inline-control"><button type="button" className="customer-button customer-button-small" onClick={()=>{void copySecret();}}>Copiar secreto</button><button type="button" className="customer-link-button" onClick={()=>setShownSecret(null)}>Ya lo guardé</button></div></div>}

    {canManage&&<form className="customer-form customer-notification-form" onSubmit={submit}>
      <h3>Añadir canal</h3>
      <label htmlFor={`notification-kind-${organizationId}`}>Tipo de canal</label><select id={`notification-kind-${organizationId}`} value={kind} onChange={event=>setKind(event.target.value==='webhook'?'webhook':'email')}><option value="email">Correo electrónico</option><option value="webhook">Webhook firmado</option></select>
      <label htmlFor={`notification-label-${organizationId}`}>Nombre</label><input id={`notification-label-${organizationId}`} required maxLength={120} value={label} onChange={event=>setLabel(event.target.value)} />
      {kind==='email'?<><label htmlFor={`notification-email-${organizationId}`}>Correo destinatario</label><input id={`notification-email-${organizationId}`} type="email" autoComplete="email" required maxLength={254} value={email} onChange={event=>setEmail(event.target.value)} /></>
        :<><label htmlFor={`notification-url-${organizationId}`}>URL HTTPS pública</label><input id={`notification-url-${organizationId}`} type="url" required maxLength={2048} placeholder="https://alertas.example.com/gotchu" value={webhookUrl} onChange={event=>setWebhookUrl(event.target.value)} /><p className="customer-field-note">Se rechazan destinos privados, locales, de enlace local y de metadatos, incluso si aparecen tras resolver DNS.</p></>}
      <label htmlFor={`notification-severity-${organizationId}`}>Severidad mínima</label><select id={`notification-severity-${organizationId}`} value={minimumSeverity} onChange={event=>setMinimumSeverity(event.target.value as NotificationDelivery['severity'])}>{Object.entries(severityNames).map(([value,labelText])=><option key={value} value={value}>{labelText}</option>)}</select>
      {(createEmail.error||createWebhook.error)&&<p className="customer-form-error" role="alert">{friendlyError(createEmail.error??createWebhook.error)}</p>}
      <button className="customer-button customer-button-primary" disabled={busy||!label.trim()||(kind==='email'?!email.trim():!webhookUrl.trim())}>{busy?'Guardando…':'Añadir canal'}</button>
    </form>}

    <div className="customer-notification-section"><h3>Canales</h3>
      {channels.isPending?<div className="customer-loading" role="status">Cargando canales…</div>
        :channels.isError?<div className="customer-form-error" role="alert">No se pudieron cargar los canales. <button type="button" className="customer-link-button" onClick={()=>{channels.refetch().catch(()=>undefined);}}>Reintentar</button></div>
        :channels.data?.length?<ul className="customer-ruled-list">{channels.data.map(channel=>{
          const destination=channel.destination.kind==='email'?channel.destination.email:channel.destination.url;
          const last=latestByChannel.get(channel.id);
          return <li key={channel.id}><div className="customer-notification-channel"><div><strong>{channel.label}</strong><small>{channel.kind==='email'?'Correo':'Webhook firmado'} · {destination}</small><small>{channelNames[channel.state]} · severidad mínima {severityNames[channel.minimumSeverity]}</small>{last&&<small>Última entrega: {deliveryNames[last.state]} · {formattedDate(last.updatedAt)}</small>}</div>
            <div className="customer-notification-actions">{canManage&&channel.state==='active'&&<button type="button" className="customer-button customer-button-small" disabled={busy} onClick={()=>test.mutate(channel.id)}>Enviar prueba</button>}{canManage&&channel.state==='active'&&<button type="button" className="customer-link-button" disabled={busy} onClick={()=>disable.mutate(channel.id)}>Desactivar</button>}</div>
          </div></li>;
        })}</ul>:<p className="customer-empty-inline">Todavía no hay canales. Añade un correo o un webhook para recibir alertas fuera de Gotchu.</p>}
    </div>

    <div className="customer-notification-section"><h3>Historial de entrega</h3>
      {deliveries.isPending?<div className="customer-loading" role="status">Cargando entregas…</div>
        :deliveries.isError?<div className="customer-form-error" role="alert">No se pudo cargar el historial. <button type="button" className="customer-link-button" onClick={()=>{deliveries.refetch().catch(()=>undefined);}}>Reintentar</button></div>
        :deliveries.data?.length?<ul className="customer-ruled-list">{deliveries.data.map(item=><li key={item.id}><div className="customer-notification-delivery"><div><strong>{item.title}</strong><small>{eventNames[item.eventKind]} · {item.channelLabel} · {severityNames[item.severity]}</small><small>{deliveryNames[item.state]} · {item.attempts} {item.attempts===1?'intento':'intentos'} · {formattedDate(item.updatedAt)}</small>{item.lastError&&<small>{deliveryError(item.lastError)}</small>}</div></div></li>)}</ul>
          :<p className="customer-empty-inline">Aún no hay entregas. Usa «Enviar prueba» para comprobar un canal.</p>}
      <p className="customer-field-note">«Aceptado por el proveedor» confirma que SMTP o el receptor webhook aceptó la solicitud; no confirma que una persona la haya leído. La clave de idempotencia se mantiene estable en los reintentos.</p>
    </div>
  </section>;
}
