/** Short descriptions of the current assessment path. */
export const HOW_STEPS = [
  ['Sube código o verifica HTTPS', 'Carpeta, GitHub o dominio con DNS TXT.'],
  ['Gotchu evalúa código y web', 'El código nunca se ejecuta.'],
  ['Recibe un informe con evidencia', 'Incluye confianza y cobertura.'],
] as const;

/** Where each review can run. Every row is a scanner profile the assessment engine runs today. */
export const SOURCES = ['Carpeta', 'GitHub', 'Imagen', 'Dominio'] as const;
export type Source = (typeof SOURCES)[number];

export const REVIEWS: readonly { name: string; detail: string; sources: readonly Source[] }[] = [
  { name: 'Código', detail: 'Patrones de riesgo en JavaScript y TypeScript.', sources: ['Carpeta', 'GitHub'] },
  { name: 'Secretos', detail: 'Claves y tokens expuestos. El valor no se guarda.', sources: ['Carpeta', 'GitHub'] },
  { name: 'Dependencias', detail: 'npm, pnpm y Yarn contra avisos de OSV.', sources: ['Carpeta', 'GitHub'] },
  { name: 'Infraestructura', detail: 'Kubernetes, Terraform y Dockerfile.', sources: ['Carpeta', 'GitHub'] },
  { name: 'Contenedor', detail: 'Paquetes del sistema y del lenguaje.', sources: ['Imagen'] },
  { name: 'Web', detail: 'Certificado y respuesta del origen HTTPS.', sources: ['Dominio'] },
];

/** The private-fix path, in the order it runs. Only some findings have a correction. */
export const FIX_STEPS = [
  ['Hallazgo', 'Con su evidencia'],
  ['Copia corregida', 'Privada, aparte de tu código'],
  ['Reanálisis', 'Comprueba el cambio'],
  ['Tu aprobación', 'Con llave de acceso'],
  ['PR en borrador', 'En tu repositorio de GitHub'],
] as const;

/** Re-check intervals offered by the scheduler, in hours (it accepts any value from 1 to 24). */
export const INTERVALS = [1, 6, 12, 24] as const;

/** Report fields are abbreviated here as a visual outline, not a sample result. */
export const REPORT_JSON = [
  '{',
  '  "internal": {',
  '    "findings": […],',
  '    "evidence": […],',
  '    "coverage": […]',
  '  },',
  '  "external": {',
  '    "findings": […],',
  '    "evidence": […],',
  '    "coverage": […]',
  '  }',
  '}',
];

export const QUESTIONS = [
  ['¿Puedo revisar cualquier sitio?', 'Solo orígenes que tengas autorización para evaluar.'],
  ['¿Gotchu cambia algo en mi aplicación?', 'Puedes pedir correcciones en una copia privada; no cambia tu app ni producción.'],
  ['¿Gotchu evalúa en tiempo real?', 'No. Puedes activar evaluaciones periódicas cada 1–24 h.'],
  ['¿Sin hallazgos significa que estoy a salvo?', 'No. El informe cubre lo observado y deja claros sus límites.'],
] as const;
