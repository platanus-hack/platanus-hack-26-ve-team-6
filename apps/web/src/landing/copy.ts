/** Short descriptions of the current assessment path. */
export const HOW_STEPS = [
  ['Sube código o elige HTTPS', 'Carpeta, GitHub o un origen HTTPS público.'],
  ['Gotchu evalúa código y web', 'El código nunca se ejecuta.'],
  ['Recibe un informe con evidencia', 'Incluye confianza y cobertura.'],
] as const;

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
