import type { FormationName } from './field';

export const NAV = [
  { href: '#vb-codigo', label: 'Cómo funciona' },
  { href: '#vb-alcance', label: 'Alcance' },
  { href: '#vb-preguntas', label: 'Preguntas' },
] as const;

type ScopeOption = {
  label: string;
  /** Formation the field morphs into while this option is selected. */
  formation: FormationName;
  title: string;
  text: string;
  facts: readonly string[];
};

export const SCOPES = [
  {
    label: 'Código', formation: 'code',
    title: 'Mira lo que hay en el código.',
    text: 'Sube una copia del código, ponle versión y revisa posibles riesgos sin ejecutarlo ni instalar paquetes.',
    facts: ['Patrones de código riesgosos', 'Posibles secretos expuestos', 'Avisos de dependencias, si los hay'],
  },
  {
    label: 'HTTPS', formation: 'globe',
    title: 'Mira cómo responde tu web.',
    text: 'Revisa cómo responde el origen HTTPS de tu dominio, sin compartir el código fuente.',
    facts: ['Propiedad verificada por DNS', 'Sin cookies', 'Sin seguir redirecciones'],
  },
  {
    label: 'Ambas', formation: 'both',
    title: 'Haz que las dos miradas se crucen.',
    text: 'Cruza las dos revisiones y distingue qué apareció en ambas, solo en el código o solo en la web.',
    facts: ['Comparación de hallazgos', 'Evidencia de cada revisión', 'Cobertura y límites explícitos'],
  },
] as const satisfies readonly ScopeOption[];

export const REPORT_TERMS = [
  { term: 'Hallazgo', text: 'Qué es y dónde está' },
  { term: 'Severidad', text: 'De informativa a crítica' },
  { term: 'Confianza', text: 'Observada, inferida o incierta' },
  { term: 'Evidencia', text: 'El fragmento que lo demuestra' },
  { term: 'Cobertura', text: 'Lo que se revisó y lo que quedó fuera' },
] as const;

export const TEAM = [
  { title: 'Espacios de trabajo', text: 'Organiza tus aplicaciones en espacios de trabajo y define quién puede hacer qué mediante roles.' },
  { title: 'Historial', text: 'Consulta el historial de reportes para volver a lo que se revisó y a lo que se encontró.' },
  { title: 'JSON', text: 'Descarga el reporte en JSON para trabajar con sus datos fuera de Gotchu.' },
] as const;

export const FAQ = [
  { q: '¿Tengo que compartir mi código?', a: 'No. Puedes revisar el origen HTTPS de un dominio que controles sin compartir código. Tú eliges código, web o ambas opciones.' },
  { q: '¿Puedo revisar cualquier sitio?', a: 'Solo dominios que controles. Debes demostrar la propiedad con un registro DNS TXT en _gotchu.<dominio> y dar tu consentimiento.' },
  { q: '¿Gotchu cambia algo en mi aplicación?', a: 'No. Gotchu solo observa: no modifica tu código, no aplica correcciones ni bloquea tráfico. Tampoco monitorea de forma continua ni confirma ataques.' },
  { q: '¿Sin hallazgos significa que estoy a salvo?', a: 'No. Significa que esa revisión no produjo hallazgos dentro de su alcance. Consulta la cobertura y las limitaciones: no es una garantía de seguridad.' },
] as const;
