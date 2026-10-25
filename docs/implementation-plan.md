# Estado de implementación

Base revisada: `main` en `26162b7`, que integra el [PR 25](https://github.com/0bkevin/gotchu/pull/25). Este documento describe el producto que se mantiene. Las ampliaciones se concentran en [Roadmap](roadmap.md).

## Funcionalidades actuales

| Área | Comportamiento implementado | Condiciones y límites |
| --- | --- | --- |
| Identidad | Sesiones Auth.js, correo/contraseña y proveedores de inicio de sesión configurables. | El registro depende del modo de instalación. El correo local no está verificado. La aprobación del cliente usa sesión Owner, sin segundo factor. |
| Workspaces | Creación, miembros, invitaciones y roles Owner/Operator/Viewer; proyectos con cambio de nombre, archivado y restauración. | Autorización en servidor y RLS. Invitaciones de un uso con vencimiento de siete días; no hay envío de invitaciones por email. |
| Onboarding y fuentes | Alta desde web HTTPS, subida de carpeta y GitHub opcional; conexión con una App y compatibilidad con la integración Reader/Writer anterior. | Repositorios e instalaciones autorizados por workspace; lectura y permiso de publicación separados. Snapshots con digest; el commit se conserva cuando la fuente está vinculada a repositorio. |
| Análisis interno | Semgrep, Gitleaks, Trivy, inventario npm/pnpm/Yarn, OSV, licencias declaradas, SBOM CycloneDX 1.5 y entradas de imagen admitidas. | Perfiles finitos; no ejecutar código, instalar paquetes ni correr scripts durante el análisis estático. Versiones/formatos no cubiertos quedan desconocidos. |
| Análisis externo | Perfiles `root`, `public_surface` y `api_checks`; TLS, cabeceras, security.txt y observaciones HTTP/API. | Un origen HTTPS público autorizado, sin credenciales ni redirects. El alcance dura siete días. No hay desafío TXT ni prueba de propiedad. |
| Evaluación | Modos `internal`, `external` y `both`; trabajo durable en background y progreso por fases con ramas internas/externas. | Hasta tres evaluaciones sin terminar por aplicación y veinte por workspace/día. Un scanner sin noticias muestra un aviso; eso no demuestra que se detuvo. |
| Dashboard e informes | Resúmenes de observaciones, cobertura, historial y vigilancia; evidencia y límites por hallazgo; exportación JSON y prompt copiable para asistentes de código. | Los resúmenes proceden de informes guardados. Una cobertura parcial o ausencia de hallazgos no implica seguridad. Copiar el prompt no llama a un modelo ni aplica cambios. |
| Vigilancia | Revisiones periódicas de repositorio, dependencias y HTTPS seleccionado; estado detenido/recuperado y contexto público Cloudflare/Railway. | Intervalos de 1–24 horas, seis por defecto. Los feeds no prueban impacto en la aplicación; no es vigilancia por push ni garantía de tiempo real. |
| Runtime y triage | Eventos firmados, detectores, SDK Node optativo, alertas e incidentes con hipótesis, impacto y revisiones inmutables. | Instrumentación y reglas acotadas; la cola SDK es local y puede perder eventos antes de la aceptación durable. Una alerta no confirma ataque. |
| Notificaciones | Email SMTP y webhooks HTTPS firmados; canales, prueba en cola, severidad mínima, outbox, reintentos y estado de entrega. | Requieren configuración. Entrega al menos una vez; hasta cinco intentos. No confirma lectura humana. Una caída total del coordinator retrasa los envíos. |
| IA opcional | Configuración y prueba de modelos, conexiones con API o suscripción, investigación por hallazgo y correcciones privadas con diff y reanálisis. | Consentimiento de procesamiento/datos y presupuestos. Sin configuración, el escaneo determinista sigue disponible. La salida del modelo no verifica una corrección. |
| Correcciones y validación | Recetas TLS/Kubernetes, candidatos npm compatibles y candidatos de fuente; reanálisis y suites base/candidato con hechos firmados. | La corrección npm actual es acotada a dependencias directas patch/minor y package-lock raíz v2/v3. El runner debe estar configurado y pasar su gate. La suite seleccionada no equivale a la suite completa ni a explotación reproducida. |
| PR aprobados | Propuesta del cambio exacto, permiso de publicación por repositorio, elegibilidad, aprobación Owner y executor independiente que abre y verifica un PR draft. | Optativo por instalación. Revalida membresía, base, artefacto, suite, política y aprobación. Base cambiada invalida; resultados inciertos requieren reconciliación. |
| Historial y retención | Historial de decisiones paginado, políticas de retención y purga por coordinator; borrado de snapshots sin trabajo dependiente. | Solo las acciones auditadas aparecen. El borrado limpia contenido privado; los informes históricos conservan sus referencias. |
| Instalación y respaldo | `./gotchu` para autoalojamiento, launcher de desarrollo y backup/restore cifrado; runbook separado de la instalación AWS existente. | Restore deja servicios detenidos, incrementa epoch y congela escrituras. No es failover ni garantía de recuperación medida. |

## Cambios que aporta el PR 25

- Navegación por workspace/proyecto, cabeceras compartidas y páginas más simples de informes y alertas.
- Progreso interno y externo por separado a partir de eventos del scanner, correlación y aviso tras falta de novedades.
- Prompt por hallazgo para copiar a un asistente de código, con evidencia y límites.
- Integración del flujo de corrección de fuente, selección/reintento de validación y aprobación de PR desde la sesión Owner.

Las notificaciones y los PR aprobados son funcionalidades actuales. No deben reaparecer como tareas pendientes por reutilizar los planes anteriores.

## Evidencia y disponibilidad por instalación

Implementación en `main`, comprobación local y servicios habilitados en un host son hechos distintos. La instalación AWS tiene su propio [runbook de servicios y verificación](../infra/aws/README.md); no se presume que ejecute todos los componentes opcionales.

El recorrido local del 25 de octubre de 2026 publicó el [PR draft de dependencia #66](https://github.com/0bkevin/arena-criolla/pull/66) mediante captura autorizada, candidato npm determinista, reanálisis, compatibilidad seleccionada base/candidato, aprobación exacta Owner y verificación remota del executor. Se observaron 18 pruebas de base y 18 de candidato aprobadas; no se ejecutó la suite completa ni se reprodujo una explotación, y quedaron otros hallazgos y alcance estático desconocido. La investigación y corrección real con Codex se comprobó por separado sobre fuente sintética; su reanálisis no demuestra validación funcional del repositorio. Estos hechos históricos no sustituyen las regresiones ni acreditan toda instalación alojada.

Fuentes de regresión relevantes:

- `apps/web/test/assessment-progress-model.test.ts`, `assessment-progress.test.ts` y `finding-prompt.test.ts`: fases y prompts del cliente.
- `test/integration/customer-applications.test.ts` y `production-scanner.test.ts`: aislamiento y ruta de evaluación; algunos perfiles son opt-in.
- `apps/coordinator/test/notifications-live.test.ts`: entrega con servicios reales y receptores locales de prueba.
- `apps/executor/test/github-live.test.ts`: proveedor GitHub opt-in; separar hechos reales de attestations o adaptadores fixture.
- `apps/validator/test/`: validación de candidatos y perfiles; las pruebas VM requieren su entorno real.

La presencia de estas pruebas no afirma que se hayan ejecutado en esta revisión. La evidencia histórica conserva los límites anteriores; la comprobación actual se registra con sus comandos y entorno.

## Ejecutar y comprobar

Usa [desarrollo local](development.md) para `pnpm dev:start` o [self-hosting](self-hosting.md) para `./gotchu up`. No requieren cuentas ni datos demo precargados.

```sh
pnpm install --frozen-lockfile
pnpm build:packages
pnpm --filter @gotchu/web typecheck
pnpm --filter @gotchu/web test
pnpm --filter @gotchu/web build
```

La [arquitectura](architecture.md) describe los límites entre servicios; [operaciones](operations.md) explica vigilancia, notificaciones y correcciones. Las capacidades adicionales y verificaciones pendientes están en [Roadmap](roadmap.md).
