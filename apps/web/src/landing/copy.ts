import type { FormationName } from '../components/dot-field/engine';

/** The two sides of an audit and what each gives you. Every line describes shipped behaviour. */
export const SIDES: readonly {
  id: string; title: string; mark: string; lead: string; benefits: readonly (readonly [string, string])[]; formation: FormationName; action: string;
}[] = [
  {
    id: 'gl-dentro', title: 'Por dentro.', mark: 'Tu código.', formation: 'code', action: 'Audita tu repositorio',
    lead: 'Conecta GitHub o sube una carpeta. Revisamos una copia, sin ejecutar nada.',
    benefits: [
      ['Secretos a la vista', 'Claves y tokens expuestos en tu código. El valor nunca se guarda.'],
      ['Dependencias vulnerables', 'Avisos de OSV y si tu código importa lo afectado.'],
      ['Infraestructura revisada', 'Kubernetes, Terraform y Dockerfile.'],
      ['Correcciones listas', 'Para algunos hallazgos, un PR en borrador tras tu aprobación.'],
    ],
  },
  {
    id: 'gl-fuera', title: 'Por fuera.', mark: 'Tu web.', formation: 'globe', action: 'Audita tu web',
    lead: 'Sin acceso a tu código. Verificas tu dominio con un TXT y revisamos tu web como la ve cualquiera.',
    benefits: [
      ['Certificado TLS', 'Comprobamos la cadena y el nombre del certificado.'],
      ['Cabeceras de seguridad', 'Qué cabeceras faltan, como CSP o HSTS.'],
      ['security.txt', 'Si tu web publica cómo avisarte de un fallo.'],
      ['Sin tocar producción', 'Solo peticiones GET, sin cookies ni credenciales.'],
    ],
  },
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
