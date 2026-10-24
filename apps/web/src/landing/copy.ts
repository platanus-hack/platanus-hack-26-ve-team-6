/** Landing copy that renders as lists. Every line describes a feature the product implements today. */

export const DOMAIN_RECORD = '_gotchu.<dominio>';

export const CODE_LOOKS = ['Riesgos en código JS y TS', 'Posibles secretos expuestos', 'Configuración de Kubernetes', 'Avisos de dependencias npm, si hay cobertura'] as const;

export const DOMAIN_FACTS = ['Perfil raíz: una petición GET a /', 'Perfil público: hasta 10 GET al origen', 'Certificado y nombre TLS verificados', 'Sin cookies, credenciales ni redirecciones', 'Sin compartir el código fuente'] as const;

export const VENN_LABELS = ['Señales del código', 'Señales compartidas', 'Señales de la web'] as const;

export const VIGILANCE_FACTS = [
  'Revisiones periódicas cada 1–24 h',
  'Instantánea o repositorio autorizado',
  'Origen HTTPS verificado',
  'Estado de Cloudflare y Railway',
  'Eventos firmados desde tu servidor',
  'Observaciones e incidentes con hipótesis',
  'Evidencia que todavía falta',
] as const;

export const GLOSSARY = [
  ['Hallazgo', 'Qué es y dónde está'],
  ['Severidad', 'Puede quedar sin evaluar'],
  ['Confianza', 'Observada, inferida o incierta'],
  ['Evidencia', 'Fragmento, respuesta o dato de herramienta'],
  ['Cobertura', 'Qué se revisó, quedó fuera o no se pidió'],
  ['Explotabilidad', 'Desconocida; no se intenta explotar'],
] as const;

export const SCOPES = [
  { name: 'Código', title: 'Mira lo que hay en el código.', text: 'Sube una copia, ponle versión y revisa archivos compatibles sin ejecutar el código ni instalar paquetes.', facts: CODE_LOOKS, action: 'Revisar mi código' },
  { name: 'HTTPS', title: 'Mira cómo responde tu web.', text: 'Revisa el origen HTTPS autorizado por DNS, sin compartir el código fuente.', facts: ['Control DNS probado por TXT', 'TLS verificado', 'Sin cookies ni redirecciones'], action: 'Revisar mi web' },
  { name: 'Ambas', title: 'Haz que las dos miradas se crucen.', text: 'Agrupa señales compartidas para comparar, sin dar por hecho que describen el mismo fallo.', facts: ['Coincidencias por señales compartidas', 'Evidencia de cada revisión', 'Cobertura y límites explícitos'], action: 'Revisar ambas' },
] as const;

export const TEAM = [
  'Espacios con roles de propietario, operador o lector; invita con enlaces de un solo uso.',
  'Historial por app, con cobertura y evidencia.',
  'Descarga el reporte completo en JSON.',
  'Para algunos hallazgos, una copia corregida privada y otro análisis; no se publica ni despliega.',
] as const;

export const REPORT_JSON = `{
  "id": "…",
  "organizationId": "…",
  "applicationId": "…",
  "jobId": "…",
  "applicationName": "…",
  "mode": "both",
  "startedAt": "…",
  "finishedAt": "…",
  "internal": {
    "findings": […],
    "coverage": […]
  },
  "external": {
    "findings": […],
    "coverage": […]
  },
  "comparison": […],
  "limitations": […],
  "responseMode": "observation",
  "actionsPerformed": [],
  "version": 1,
  "revision": "…"
}`.split('\n');

export const QUESTIONS = [
  ['¿Tengo que compartir mi código?', 'No. Puedes autorizar un origen HTTPS con control DNS y revisarlo sin subir código. También puedes elegir código, web o ambas opciones.'],
  ['¿Puedo revisar cualquier sitio?', 'Solo un origen que puedas autorizar. Publica un TXT en _gotchu.<dominio> para demostrar control DNS; no acredita titularidad legal.'],
  ['¿Gotchu cambia algo en mi aplicación?', 'No modifica tu repositorio ni producción y no bloquea tráfico. Para algunos hallazgos puede preparar una copia corregida privada y poner en cola un análisis independiente. No confirma ataques.'],
  ['¿Gotchu vigila mi app todo el tiempo?', 'No en tiempo real. Tú activas revisiones periódicas cada 1–24 h; las alertas se ven dentro de Gotchu.'],
  ['¿Sin hallazgos significa que estoy a salvo?', 'No. Solo indica que la revisión no encontró observaciones en lo que alcanzó a revisar. Lo parcial o no solicitado no descarta riesgos; no es una garantía de seguridad.'],
] as const;
