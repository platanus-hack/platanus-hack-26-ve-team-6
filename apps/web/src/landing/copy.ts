/** Landing copy that renders as lists. Every line describes a feature the product implements today. */

export const DOMAIN_RECORD = '_gotchu.<dominio>';

export const CODE_LOOKS = ['Patrones de código riesgosos', 'Posibles secretos expuestos', 'Avisos de dependencias, si los hay'] as const;

export const DOMAIN_FACTS = ['Propiedad verificada por DNS', 'Sin cookies', 'Sin seguir redirecciones', 'Sin compartir el código fuente'] as const;

export const GLOSSARY = [
  ['Hallazgo', 'Qué es y dónde está'],
  ['Severidad', 'De informativa a crítica'],
  ['Confianza', 'Observada, inferida o incierta'],
  ['Evidencia', 'El fragmento que lo demuestra'],
  ['Cobertura', 'Lo que se revisó y lo que quedó fuera'],
] as const;

export const SCOPES = [
  { name: 'Código', title: 'Mira lo que hay en el código.', text: 'Sube una copia del código, ponle versión y revisa posibles riesgos sin ejecutarlo ni instalar paquetes.', facts: CODE_LOOKS, action: 'Revisar mi código' },
  { name: 'HTTPS', title: 'Mira cómo responde tu web.', text: 'Revisa cómo responde el origen HTTPS de tu dominio, sin compartir el código fuente.', facts: ['Propiedad verificada por DNS', 'Sin cookies', 'Sin seguir redirecciones'], action: 'Revisar mi web' },
  { name: 'Ambas', title: 'Haz que las dos miradas se crucen.', text: 'Cruza las dos revisiones y distingue qué apareció en ambas, solo en el código o solo en la web.', facts: ['Comparación de hallazgos', 'Evidencia de cada revisión', 'Cobertura y límites explícitos'], action: 'Revisar ambas' },
] as const;

export const TEAM = [
  'Organiza tus aplicaciones en espacios de trabajo y define quién puede hacer qué mediante roles.',
  'Consulta el historial de reportes para volver a lo que se revisó y a lo que se encontró.',
  'Descarga el reporte en JSON para trabajar con sus datos fuera de Gotchu.',
] as const;

export const REPORT_JSON = `{
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
  "actionsPerformed": []
}`.split('\n');

export const QUESTIONS = [
  ['¿Tengo que compartir mi código?', 'No. Puedes revisar el origen HTTPS de un dominio que controles sin compartir código. Tú eliges código, web o ambas opciones.'],
  ['¿Puedo revisar cualquier sitio?', 'Solo dominios que controles. Debes demostrar la propiedad con un registro DNS TXT en _gotchu.<dominio> y dar tu consentimiento.'],
  ['¿Gotchu cambia algo en mi aplicación?', 'No. Gotchu solo observa: no modifica tu código, no aplica correcciones ni bloquea tráfico. Tampoco monitorea de forma continua ni confirma ataques.'],
  ['¿Sin hallazgos significa que estoy a salvo?', 'No. Significa que esa revisión no produjo hallazgos dentro de su alcance. Consulta la cobertura y las limitaciones: no es una garantía de seguridad.'],
] as const;
