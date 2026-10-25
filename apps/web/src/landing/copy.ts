/** The two sides of an audit. Every line describes shipped behaviour. */
export const SIDES: readonly { id: string; name: string; text: string; tags: readonly string[]; action: string }[] = [
  { id: 'gl-dentro', name: 'Por dentro.', text: 'Conecta GitHub o sube una carpeta. Revisamos tu código sin ejecutarlo.', tags: ['Código', 'Secretos', 'Dependencias', 'Infraestructura'], action: 'Audita tu repositorio' },
  { id: 'gl-fuera', name: 'Por fuera.', text: 'Sin acceso a tu código. Verificas tu dominio con un TXT y revisamos tu web por HTTPS.', tags: ['Certificado TLS', 'Cabeceras de seguridad', 'security.txt'], action: 'Audita tu web' },
];

/** What every finding in the report carries. */
export const EVIDENCE = [
  ['Evidencia', 'El fragmento, la respuesta o el dato que lo sostiene.'],
  ['Severidad', 'De informativa a crítica, o sin evaluar.'],
  ['Confianza', 'Observada, inferida o incierta.'],
  ['Cobertura', 'Qué se revisó y qué quedó fuera.'],
] as const;

export const QUESTIONS = [
  ['¿Puedo revisar cualquier sitio?', 'Solo orígenes que tengas autorización para evaluar.'],
  ['¿Gotchu cambia algo en mi aplicación?', 'Puedes pedir correcciones en una copia privada; no cambia tu app ni producción.'],
  ['¿Gotchu evalúa en tiempo real?', 'No. Puedes activar evaluaciones periódicas cada 1–24 h.'],
  ['¿Sin hallazgos significa que estoy a salvo?', 'No. El informe cubre lo observado y deja claros sus límites.'],
] as const;
