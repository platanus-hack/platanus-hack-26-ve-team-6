import type { AssessmentEvidence, AssessmentFinding } from '@gotchu/contracts';

const MAX_EXCERPT = 600;
const severity: Record<AssessmentFinding['severity'], string> = { unknown: 'sin evaluar', critical: 'crítica', high: 'alta', medium: 'media', low: 'baja', informational: 'informativa' };

/** An AI investigation's proposed change; shaped like the investigation run's candidate suggestion. */
export interface FindingSuggestion {
  summary: string;
  path: string | null;
  implications?: readonly string[] | undefined;
  risks?: readonly string[] | undefined;
  validationPlan?: readonly string[] | undefined;
}

/**
 * Instruction a person can paste into Claude Code or any coding assistant to fix one finding.
 * Evidence excerpts are already redacted by the scanner, so no secret value reaches the prompt.
 */
export function findingPrompt(input: { applicationName: string; origin: string | null; finding: AssessmentFinding; evidence: readonly Pick<AssessmentEvidence, 'locator' | 'excerpt'>[]; suggestion?: FindingSuggestion }) {
  const { finding } = input;
  const external = finding.origin === 'external';
  const dependency = finding.dependencyAssessment;
  const evidence = input.evidence.map(item => {
    const excerpt = item.excerpt.length > MAX_EXCERPT ? `${item.excerpt.slice(0, MAX_EXCERPT)}…` : item.excerpt;
    return `- ${item.locator}\n${excerpt.split('\n').map(line => `  ${line}`).join('\n')}`;
  });
  const steps = external
    ? [
      `Busca en el repositorio la configuración que produce esta respuesta HTTPS${input.origin ? ` de ${input.origin}` : ''} (servidor, framework, proxy o cabeceras).`,
      'Confirma si el problema sigue presente antes de cambiar nada.',
      'Corrígelo con el cambio mínimo y explica cómo comprobarlo con una petición real después del despliegue.',
    ]
    : dependency
      ? [
        `Confirma que ${dependency.name}@${dependency.version} sigue en el lockfile y qué la usa.`,
        'Actualízala a la versión corregida más cercana que no rompa la API y regenera el lockfile con el gestor de paquetes del proyecto.',
        'Ejecuta las pruebas existentes y revisa los cambios de la versión nueva.',
      ]
      : [
        'Abre la ubicación indicada y confirma si el problema existe en el código actual.',
        'Corrígelo con el cambio mínimo, siguiendo las convenciones del proyecto.',
        'Añade o ajusta una prueba que falle sin la corrección.',
      ];
  return [
    `Trabaja en el repositorio de «${input.applicationName}». Gotchu encontró este problema en un análisis ${external ? 'externo HTTPS' : 'del código'}:`,
    '',
    `Título: ${finding.title}`,
    `Ubicación: ${finding.location}`,
    `Regla: ${finding.ruleId}`,
    `Gravedad: ${severity[finding.severity]} · confianza: ${finding.confidence} · explotabilidad: ${finding.exploitability}`,
    ...(dependency ? [`Dependencia: ${dependency.name}@${dependency.version} (${dependency.purl})`] : []),
    '',
    `Descripción: ${finding.description}`,
    `Impacto: ${finding.impact}`,
    `Recomendación: ${finding.recommendation}`,
    ...(finding.limitations.length ? ['', 'Límites del hallazgo:', ...finding.limitations.map(item => `- ${item}`)] : []),
    ...(evidence.length ? ['', 'Evidencia (los valores secretos están ocultos):', ...evidence] : []),
    ...suggestionLines(input.suggestion),
    '',
    'Qué hacer:',
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    `${steps.length + 1}. No copies ni reutilices credenciales. Si el hallazgo es una credencial real, dime que hay que revocarla y rotarla.`,
    `${steps.length + 2}. Resume el cambio y cómo lo verificaste. Si no puedes confirmar el problema, explica por qué en lugar de cambiar código.`,
  ].join('\n');
}

// The investigation is a model's unverified proposal, so it is labelled as a starting point to check.
function suggestionLines(suggestion: FindingSuggestion | undefined) {
  if (!suggestion) return [];
  const list = (title: string, items: readonly string[] | undefined) => items?.length ? [title, ...items.map(item => `- ${item}`)] : [];
  return [
    '', 'Propuesta de una investigación previa (sin verificar; compruébala antes de aplicarla):',
    `- ${suggestion.summary}${suggestion.path ? ` (${suggestion.path})` : ''}`,
    ...list('Implicaciones:', suggestion.implications),
    ...list('Riesgos:', suggestion.risks),
    ...list('Cómo validarla:', suggestion.validationPlan),
  ];
}
