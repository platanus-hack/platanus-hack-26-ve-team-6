/** One step of an audit diagram: what happens, in a few words. */
export type FlowStep = { title: string; text: string };

/** GitHub repository audit, in the order it runs. */
export const REPO_STEPS: readonly FlowStep[] = [
  { title: 'Conecta GitHub', text: 'Con permiso de solo lectura.' },
  { title: 'Copia con huella', text: 'Una copia de la rama y su SHA-256.' },
  { title: 'Cuatro revisiones', text: 'Aisladas, sin red y sin ejecutar tu código.' },
  { title: 'Informe', text: 'Cada hallazgo con su evidencia.' },
];

export const REPO_SCANS = ['Código', 'Secretos', 'Dependencias', 'Infraestructura'] as const;

/** External audit of an HTTPS origin, without source access. */
export const WEB_STEPS: readonly FlowStep[] = [
  { title: 'Publica un TXT', text: 'En _gotchu.tudominio.com.' },
  { title: 'Verificamos el DNS', text: 'Así sabemos que controlas el dominio.' },
  { title: 'Revisamos por HTTPS', text: 'Solo peticiones GET, con TLS verificado.' },
  { title: 'Informe', text: 'Lo observado y lo que quedó fuera.' },
];

export const QUESTIONS = [
  ['¿Puedo revisar cualquier sitio?', 'Solo orígenes que tengas autorización para evaluar.'],
  ['¿Gotchu cambia algo en mi aplicación?', 'Puedes pedir correcciones en una copia privada; no cambia tu app ni producción.'],
  ['¿Gotchu evalúa en tiempo real?', 'No. Puedes activar evaluaciones periódicas cada 1–24 h.'],
  ['¿Sin hallazgos significa que estoy a salvo?', 'No. El informe cubre lo observado y deja claros sus límites.'],
] as const;
