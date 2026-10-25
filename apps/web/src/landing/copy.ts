import type { FormationName } from '../components/dot-field/engine';

/** The product walkthrough, in the order a person meets each feature. Every line describes shipped behaviour. */
export const CHAPTERS: readonly { id: string; title: string; text: string; tags?: readonly string[]; formation: FormationName }[] = [
  { id: 'gl-conecta', title: 'Conecta tu proyecto', text: 'Sube una carpeta, conecta GitHub o verifica tu dominio con un registro DNS TXT.', formation: 'both' },
  { id: 'gl-revisa', title: 'Revisa sin ejecutar nada', text: 'Seis revisiones sobre tu código, tu imagen y tu web. El código nunca se ejecuta.', tags: ['Código', 'Secretos', 'Dependencias', 'Infraestructura', 'Contenedor', 'Web'], formation: 'code' },
  { id: 'gl-informe', title: 'Entiende cada hallazgo', text: 'Cada hallazgo trae su evidencia, severidad y confianza, y el informe dice qué quedó sin revisar.', tags: ['JSON', 'SBOM CycloneDX'], formation: 'report' },
  { id: 'gl-corrige', title: 'Corrige con tu aprobación', text: 'Para algunos hallazgos, Gotchu prepara el cambio, lo vuelve a analizar y abre un PR en borrador cuando lo apruebas con tu llave de acceso.', formation: 'branch' },
  { id: 'gl-vigila', title: 'Vigila cada 1\u2060–\u206024\u00a0h', text: 'Programa revisiones periódicas y recibe avisos por correo o webhook. No es tiempo real.', formation: 'cycle' },
  { id: 'gl-detecta', title: 'Detecta en tu servidor', text: 'Con el SDK registras o bloqueas intentos en tu servidor. Los incidentes separan lo observado de lo que falta comprobar.', formation: 'mark' },
];

export const QUESTIONS = [
  ['¿Puedo revisar cualquier sitio?', 'Solo orígenes que tengas autorización para evaluar.'],
  ['¿Gotchu cambia algo en mi aplicación?', 'Puedes pedir correcciones en una copia privada; no cambia tu app ni producción.'],
  ['¿Gotchu evalúa en tiempo real?', 'No. Puedes activar evaluaciones periódicas cada 1–24 h.'],
  ['¿Sin hallazgos significa que estoy a salvo?', 'No. El informe cubre lo observado y deja claros sus límites.'],
] as const;
