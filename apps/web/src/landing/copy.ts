import type { FormationName } from '../components/dot-field/engine';

/** The two sides of an audit and what each gives you. Every line describes shipped behaviour. */
export const SIDES: readonly {
  id: string; title: string; mark: string; lead: string; benefits: readonly (readonly [string, string])[]; formation: FormationName; action: string;
}[] = [
  {
    id: 'gl-dentro', title: 'Por dentro.', mark: 'Tu código.', formation: 'code', action: 'Audita tu repositorio',
    lead: 'Conecta GitHub o sube una carpeta. La auditoría revisa una copia sin ejecutar tu código.',
    benefits: [
      ['Secretos a la vista', 'Claves y tokens expuestos. El informe oculta su valor.'],
      ['Dependencias vulnerables', 'Versiones exactas, avisos de OSV y señales de uso en tu código.'],
      ['Infraestructura revisada', 'Kubernetes, Terraform y Dockerfile.'],
      ['Correcciones revisables', 'Copia un prompt por hallazgo o prepara un cambio compatible para un PR aprobado.'],
    ],
  },
  {
    id: 'gl-fuera', title: 'Por fuera.', mark: 'Tu web.', formation: 'globe', action: 'Audita tu web',
    lead: 'Sin acceso a tu código. Indicas un origen HTTPS autorizado y eliges qué revisar.',
    benefits: [
      ['Certificado TLS', 'Comprobamos la cadena y el nombre del certificado.'],
      ['Cabeceras de seguridad', 'Qué cabeceras faltan, como CSP o HSTS.'],
      ['Web y API', 'security.txt, OpenAPI y escenarios HTTP según el perfil elegido.'],
      ['Peticiones acotadas', 'GET, HEAD y OPTIONS según el perfil, sin cookies ni credenciales.'],
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
