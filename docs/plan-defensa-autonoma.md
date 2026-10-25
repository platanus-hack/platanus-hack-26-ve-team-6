# Plan de defensa autónoma y diferenciación de Gotchu

> **Actualización (24 de octubre de 2026):** este plan conserva como línea base el último commit del archivo, `ce281c9`. Las afirmaciones de esa línea base sobre Semgrep 1.90.0 como perfil sólo de desarrollo/pruebas, el bloqueo de escaneo en producción y los gates equivalentes del scanner quedaron superadas para el alcance local Linux/amd64 validado por el pin Semgrep 1.182.0 y las pruebas finales del flujo scanner/coordinator TLS con persistencia durable. No se afirma despliegue cloud ni cobertura general. Las demás prioridades y análisis históricos no se reescribieron.

**Estado adicional (24 de octubre de 2026):** D06/D08/D09 incorporan la ejecución independiente de PR draft de código fuente y de candidatos npm del proyecto raíz. El Writer App sólo llega al executor; el Owner concede o revoca el permiso de escritura para cada repositorio tras una verificación de cobertura del Writer App y una prueba WebAuthn fresca. Las suites PostgreSQL/Redis pasan y la prueba live verificó un PR draft de código fuente, su árbol remoto y la entrega duplicada. El sandbox configurado no tiene `scripts.test`; por eso la prueba live de D06 se detiene antes de escanear dependencias y no acredita una publicación de PR npm. Esto no habilita merge, deploy ni ejecución general de código cliente.

Fecha: 24 de octubre de 2026. Base revisada: `68e19c5c6d099a1fc8b6c5feb5e823afd27cd895`.

Este documento convierte las nuevas direcciones del producto en trabajo verificable. Se revisaron implementación, contratos, consumidores, pruebas y límites documentados. **Es un plan pendiente de ejecución; su publicación no habilita estas capacidades.** La revisión fue de código y documentación: no se volvieron a ejecutar las suites de infraestructura ni se probaron productos competidores.

La aplicación real es el producto. Una empresa ficticia, repositorios controlados y fallos sembrados sirven para probar esa misma aplicación, sin introducir un flujo privilegiado que sustituya al de clientes. Seguimos en desarrollo local; crear recursos AWS o desplegar producción queda fuera del trabajo actual.

## 1. Resultado que queremos ofrecer

Un equipo conecta sus aplicaciones, repositorios y señales autorizadas. Gotchu explica qué está ocurriendo, a qué parte del negocio afecta, qué sabe y qué no pudo verificar. Presenta opciones concretas y permite preparar, probar y ejecutar correcciones admitidas desde la interfaz, con permisos independientes y comprobación posterior.

El público principal son empresas pequeñas con equipo técnico y sin un equipo dedicado de seguridad. Un Owner no técnico debe entender y autorizar una acción sin escribir comandos; el equipo técnico conserva revisión, controles del repositorio y decisiones de despliegue.

Queremos cubrir seguridad y errores operativos: una vulnerabilidad, un fallo de aplicación, una dependencia problemática, una regresión de despliegue, presión de capacidad o un incidente de proveedor. La respuesta debe corresponder a la evidencia: un pico de tráfico no prescribe un balanceador, una caída de proveedor no prescribe una migración y una CVE no demuestra explotación.

La ambición defensiva consiste en reducir el tiempo hasta una decisión y una reparación comprobables, manteniendo el control del usuario. Es compatible con la orientación de [d/acc hacia capacidades defensivas y poder distribuido](https://vitalik.eth.limo/general/2025/01/05/dacc2.html); esa afinidad no es una certificación ni demuestra por sí sola ventaja defensiva.

## 2. Qué incorporar de Snyk y Aikido, y cómo competir con honestidad

La comparación se basa en documentación oficial consultada en la fecha del documento. Describe capacidades anunciadas, no una evaluación independiente de calidad, disponibilidad contractual o resultados.

- **Monitoreo continuo y PR de dependencias:** Snyk ya documenta monitoreo de proyectos y PR de corrección o actualización. Reconsultar avisos sin cambiar el código es un requisito básico, no una novedad de Gotchu. Debemos incorporarlo bien y medirlo. Fuentes: [Snyk Monitor](https://docs.snyk.io/developer-tools/snyk-cli/commands/monitor), [integraciones de desarrollo](https://docs.snyk.io/developer-tools/overview).
- **Análisis interno y externo contextual:** Aikido ya combina SAST y DAST y describe relaciones entre dominios y repositorios. Tampoco basta con anunciar ambos escáneres. Nuestro objetivo es hacer trazable la relación entre fuente, versión desplegada y observación externa. Fuente: [SAST y DAST de Aikido](https://www.aikido.dev/use-cases/sast-dast).
- **Menos ruido, confianza y correcciones:** Aikido documenta AutoTriage, análisis de uso y AutoFix con PR; sus correcciones SAST ya llevan niveles de confianza. Debemos evaluar nuestra calibración y abstención, no afirmar que los demás carecen de ellas. Fuentes: [AutoTriage y AutoFix](https://help.aikido.dev/workflows-and-guides/resolve-dependency-vulnerabilities-with-autotriage-and-ai-autofix), [AutoFix SAST](https://help.aikido.dev/autofix-and-remediation/scope/ai-autofix-for-sast-and-iac-issues).
- **Verificación y entrega:** Aikido anuncia AutoShip con CI, staging, pruebas, vigilancia posterior y rollback; la página también ofrece acceso anticipado. Un circuito de corrección y reanálisis no es, por sí solo, exclusivo. En Gotchu cada promesa deberá corresponder a comprobaciones concretas visibles. Fuente: [AutoShip](https://www.aikido.dev/code/autoship).
- **Equipos pequeños:** Aikido también ofrece opciones para desarrolladores y equipos pequeños. El nicho debe validarse por necesidades y experiencia de uso, sin presentar a los competidores como exclusivamente enterprise. Fuente: [planes de Aikido](https://www.aikido.dev/pricing).

**Hipótesis de diferenciación a construir y validar:** una experiencia unificada que relaciona seguridad, cambios de código y fallos operativos con el impacto observado en una aplicación; muestra evidencia a favor y en contra; permite actuar con controles comprensibles; y vuelve a medir el resultado. Portabilidad, instalación privada y funcionamiento determinista sin proveedor de IA obligatorio completan la propuesta. No hemos demostrado exclusividad de esa combinación ni superioridad frente a otros productos.

Posicionamiento propuesto: **“Gotchu reúne la evidencia de tu aplicación, explica qué puede estar afectándola y te ayuda a aplicar y comprobar la siguiente acción.”** Evitar “sabemos de quién es la culpa” o “demostramos que cualquier arreglo es seguro”.

Cloudflare, Railway y PostgreSQL son un primer recorrido concreto para validar, no dependencias obligatorias de la plataforma. Los escáneres existentes pueden reutilizarse; reescribirlos para parecer originales no mejora la defensa.

## 3. Auditoría del estado actual

### Ya implementado, con alcance limitado

- Workspaces y aplicaciones autenticados, membresía en servidor, roles y aislamiento PostgreSQL con RLS. Fuente: [servicio de clientes](../packages/backend/src/customers.ts).
- Captura de snapshots, lecturas de Git local/GitHub mediante catálogo administrado por operador, monitoreo periódico y consulta OSV de versiones npm. No hay instalación autoservicio de repositorios ni auditoría completa de sus dependencias. Fuente: [adaptadores de monitoreo](../packages/monitoring/README.md).
- Semgrep, Gitleaks, Trivy y OSV con perfiles acotados; HTTPS con alcance solicitado y perfil público limitado, sin comprobación TXT. Semgrep 1.90.0 está restringido a desarrollo/pruebas; Docker no establece el aislamiento requerido para ejecutar código del cliente. Fuentes: [motor](../packages/customer-assessment/README.md), [scanner](../apps/scanner/README.md).
- Telemetría firmada, outbox, consumidores repetibles, detectores de autenticación, errores, latencia, recursos y ciertas señales de abuso. Estado Cloudflare/Railway, liveness durable de comprobaciones programadas y notificaciones por email/webhook con bandeja de salida y estado de entrega. Sin watchdog independiente, una caída total del coordinador retrasa alertas externas hasta que vuelva un worker. Fuentes: [detección](../apps/coordinator/src/operational-detectors.ts), [operación actual](operations.md).
- Historial de decisiones visible para miembros del espacio con rol de lectura: identidad del miembro mediante su correo cuando está disponible, etiqueta de sistema para actores automatizados, acción, categoría del asunto, fecha, resultado y resumen seguro. Incluye las mutaciones que hoy escriben auditoría, como reconocimiento/resolución de alertas, creación/preparación/declaraciones de planes, solicitudes de corrección y reanálisis, creación/solicitud de descarga de informes, cambios de miembros, factores de verificación, propuestas y seguimiento de incidentes. La solicitud de descarga de informe también deja un registro. La proyección omite detalle JSON, IDs de actor, credenciales e IP. No es todavía una cronología completa de ejecución por incidente ni un historial completo de acciones de proveedor; las escrituras de proveedor siguen deshabilitadas.
- Reportes internos/externos con procedencia, confianza y límites; recetas seleccionadas por evidencia. Dos familias de transformación preparan cambios privados exactos: verificación TLS en JS/TS y ciertos permisos de Kubernetes YAML. La preparación almacena una copia y encola un reanálisis; no cambia el repositorio. Fuentes: [recetas](../packages/scenarios/README.md), [correcciones](../packages/backend/src/corrections.ts).
- Ledger de propuesta, aprobación exacta y ejecución; recuperación y resultados inciertos. El executor independiente publica PR draft de fuente y npm en repositorios del catálogo, tras comprobar la acción aprobada y el Writer App grant del Owner. La disponibilidad local requiere configurar Writer App, WebAuthn, executor y validador VM; no hay merge/deploy. Fuentes: [propuestas](../packages/backend/src/proposals.ts), [executor](../apps/executor/README.md).
- LangGraph y gateway de lectura con límites y checkpoints. La ruta de modelo responde `503 model_not_configured`; no existe investigación de código mediante un modelo activo. Fuente: [gateway](../apps/gateway/src/service.ts).

### Brechas que impiden cumplir la visión

1. **No hay correlación explicativa proveedor–aplicación.** El estado del proveedor se conserva como impacto no verificado; falta unir dependencias, entorno, versión desplegada, rutas y ventanas de señales. Fuente: [contrato de observaciones](../packages/contracts/src/operations.ts).
2. **Comparar hallazgos internos y externos no prueba explotabilidad.** Falta vincular el commit analizado al despliegue y verificar condiciones relevantes. Ver un endpoint accesible no confirma que ejecute una función vulnerable. Fuente: [comparación actual](../packages/customer-assessment/src/common.ts).
3. **Las correcciones privadas y las aprobaciones están desconectadas.** La propuesta ejecutable v1 sólo admite `github.pull_request` con actualizaciones npm patch/minor, commits y artefactos. Las recetas TLS/Kubernetes no caben en ese contrato. No se puede conectar un botón sin evolucionar el modelo y sus verificadores.
4. **No existen pruebas funcionales de cliente en una VM desechable, artefactos de validación independientes ni MFA de acción real.** Un reanálisis estático no satisface esas condiciones.
5. **La escritura de repositorio está limitada a PR draft aprobados con exactitud.** No hay merge, deploy, contención ni migración. El worker local independiente publica tras aprobación WebAuthn y revalida base/artefacto; la respuesta operativa y recuperación siguen cerradas. Fuentes: [executor](../apps/executor/src/action-execution.ts), [planes](../packages/backend/src/operations.ts).
6. **El agente no investiga automáticamente todo hallazgo.** Las herramientas actuales de la investigación están centradas en evidencia y eventos de autenticación; faltan contexto de fuente, topología y contratos de nuevas investigaciones.
7. **La evaluación profunda de dependencias, phishing, deepfakes y campañas de influencia no está implementada.** Son capacidades distintas y necesitan entradas, pruebas y permisos propios.
8. **Quedan requisitos operativos:** notificaciones externas, miembros/invitaciones, borrado permanente, producción de identidad/TLS, actualización del scanner, restauración y capacidad medida. La infraestructura AWS está definida y probada con mocks, sin despliegue real.

## 4. Reglas de implementación y de producto

- Mantener TanStack Start, Auth.js, TypeScript, contratos de runtime y servicios fuera de rutas. Reutilizar Postgres/outbox/colas; no añadir otro motor de workflow sin necesidad demostrada.
- Ningún hallazgo, gravedad o texto del modelo amplía permisos. Observación, aprobación exacta y automatización previamente autorizada son modos distintos.
- Las recetas ejecutables son versionadas, tipadas y comprobables. El contexto selecciona recetas; un modelo puede proponer candidatos privados nuevos, pero no registrar comandos ejecutables ni concederse verificación.
- Mantener el flujo útil sin modelo externo ni servicio de pago obligatorio. Los adaptadores de repositorio, runner, modelo y despliegue son sustituibles. Un recurso abierto o gratuito sigue consumiendo cómputo, almacenamiento y operación.
- Las escrituras externas pertenecen al executor. El código no confiable se ejecuta sólo tras demostrar aislamiento VM por trabajo. No habrá fallback a ejecutarlo en el host o a relajar el gate.
- La UI debe permitir ver el avance, cancelar cuando sea seguro y comprender estados inciertos. “Solicitud aceptada”, “API respondió”, “cambio aplicado” y “resultado verificado” son hechos diferentes.
- No transformar datos ausentes en salud, una IP en una persona, una firma WAF en compromiso o un texto sospechoso en atribución a IA.

## 5. Orden de entregas y dependencias

Todas las tareas siguientes están pendientes. Las entregas se cierran con evidencia, no con una fecha estimada inventada.

1. **Entrega A — explicar impacto:** D01, D02, D03 y la evaluación D15. Escenario proveedor–aplicación con controles negativos, telemetría temporal y desconocidos visibles. No requiere escritura cloud ni un LLM.
2. **Entrega B — corregir y abrir un PR real autorizado:** D04, D05, D06, D07, D08 y D09. Primer alcance ejecutable: npm patch/minor con lockfile reproducible, respetando D9/D10 del [interview](definition-interview.md). Una receta TLS existente puede demostrar el circuito privado antes, pero requiere la ampliación explícita del contrato para un PR real.
3. **Entrega C — entregar y verificar en desarrollo:** D10 y D15. Merge autorizado y despliegue real en entorno aislado de desarrollo, sin recursos de pago ni producción. Dejar listo el contrato de producción sin activarlo.
4. **Entrega D — investigar y ampliar defensa:** D11 y D12. Investigación asistida, nuevas recetas y evaluación selectiva del código de dependencias, apoyadas en pruebas y presupuestos reales.
5. **Entrega E — operar con seguridad:** D13 y D14. Endurecimiento, capacidad, recuperación y automatización limitada. Cada adaptador tiene su propio gate; no se habilitan juntos por completar el dashboard.
6. **Entrega F — defensa informacional:** D16, como módulo separado después del núcleo. No bloquear el primer circuito útil intentando abarcar todos los dominios de defensa.

D01/D02 preparan D03. D04 puede avanzar independientemente del triage; D05 y D06 dependen de identidad de fuentes y runner. D07/D08 deben estar completos antes de D09. D10 depende del circuito de PR. D11 puede empezar en lectura, pero cualquier candidato que produzca vuelve a D05–D10. D14 y la evaluación son trabajo transversal, no limpieza posterior.

## 6. Backlog detallado

### D01 — Vincular activos, código y despliegue

**Problema:** una etiqueta `revision` de un upload no es un commit; un digest de snapshot tampoco demuestra que esos bytes estén desplegados.

Trabajo:

- [x] Incorporar entorno, servicio, origen autorizado, relación de dependencia, proveedor/componente y versión de despliegue. Cada relación conserva origen, fecha y estado declarado/verificado/desconocido.
- [ ] Vincular repositorio autorizado, commit, subdirectorio, snapshot digest y artefacto desplegado; conservar identidad de imagen/build cuando exista. Un cliente puede empezar sólo con HTTPS o sólo con fuente.
- [x] Extender eventos mediante una versión compatible para identificar release, servicio y dependencia/ruta lógica sin capturar secretos, cuerpos o URLs sensibles. La firma prueba procedencia de la integración, no veracidad absoluta del emisor comprometido.
- [x] Añadir onboarding y revocación de repositorio en la interfaz. Empezar con catálogo local administrado y adaptador GitHub opcional; permisos de lectura y escritura separados. No exponer tokens al navegador.
- [ ] Permitir varias aplicaciones y relaciones de una empresa sin asumir propiedad de dominios descubiertos; cada nuevo activo requiere autorización específica antes de probarlo.
- [ ] Evolucionar el target único actual hacia un inventario de orígenes y APIs autorizados por entorno. Importar candidatos desde inventario aportado, DNS y referencias públicas dentro de una política acotada; descubrimiento, propiedad y permiso de prueba son estados separados. Un enlace a un tercero no autoriza escanearlo.

**Nota D01:** el catálogo, las relaciones tenant-scoped, el alta/revocación del enlace de repositorio y los atributos opcionales de telemetría están implementados. Las declaraciones de clientes siempre permanecen `declared` y `customer_declared`; sólo las rutas confiables futuras podrán producir estado `verified`. La propiedad de un origen se deriva de su target DNS vigente y nunca se acepta como verificada desde el cliente. Siguen parciales la unión de repositorio↔commit/snapshot↔despliegue, la materialización automática de deployments desde eventos firmados y la importación/discovery de orígenes desde DNS o referencias públicas; los candidatos actuales no conceden permiso de prueba.

**Componentes:** `@gotchu/contracts`, database/backend, monitoring, SDK y workspace web. Nuevas tablas/migraciones con FKs tenant-aware y RLS; no sobrecargar texto libre de reportes como inventario.

**Aceptación:** pruebas de RLS entre empresas y aplicaciones; actualización/revocación de relaciones; despliegue distinto al commit analizado mostrado como desconocido; selector de entorno visible. Ninguna coincidencia de nombres se presenta como vinculación verificada.

### D02 — Catálogo de escenarios comunes y contexto del proyecto

**Problema:** hay detectores y recetas, pero no un catálogo exhaustivo que declare qué evidencia requiere cada escenario y qué respuesta es compatible con la arquitectura.

Trabajo:

- [x] Catalogar vulnerabilidad de código/dependencia, secreto expuesto, configuración insegura, autenticación abusiva, enumeración, error de aplicación, regresión de release, indisponibilidad, fallo DNS/TLS, dependencia externa y agotamiento de recursos.
- [ ] Priorizar escenarios de inyección, XSS, autorización, SSRF, secretos y cadena de suministro según entradas reales y perfiles soportados. Una etiqueta de categoría no implica cobertura completa ni un detector de BOLA sin contexto de identidad.
- [x] Para cada escenario versionar precondiciones, señales necesarias, evidencia contraria, cobertura mínima, severidad/confianza, opciones, condiciones de parada y pruebas. Preservar anomalías fuera del catálogo como desconocidas investigables. Núcleo determinista; persistencia/UI pendiente.
- [ ] Derivar contexto de manifiestos literales, configuración, inventario autorizado y telemetría. No ejecutar configuración para descubrirla. Un cambio de stack o advisory reevalúa qué recetas aplican.
- [ ] Añadir detectores configurables con umbrales calibrados sobre tráfico representativo. Desplegarlos primero en observación y evitar tormentas con ventanas, dedupe y estados de resolución/reapertura.
- [ ] Ampliar análisis externo por perfiles: observación pública, comprobaciones de API descrita mediante contrato validado y, posteriormente, DAST autenticado en staging autorizado. Credenciales de prueba y permisos por ruta/método van separados del consentimiento público; tasas, exclusiones y parada deben poder configurarse. Las pruebas activas potencialmente modificadoras quedan fuera del perfil público y necesitan laboratorio/permiso específico.

**Aceptación:** matriz de escenarios soportados/no soportados visible; casos legítimos de promociones, cambios de tráfico y despliegues; muestras maliciosas e incompletas. Una caída aislada o tráfico alto sin deterioro no produce una propuesta de capacidad automática. Un contrato API con rutas externas, operaciones destructivas o credenciales de otro entorno no amplía el scope de prueba.

### D03 — Correlacionar ataque, bug y fallo de proveedor

**Problema:** falta el diferenciador central propuesto. La coincidencia temporal entre dos alertas no establece causalidad.

Trabajo:

- [x] Crear un resultado de triage tipado con impacto observado, servicios afectados, ventana, hipótesis, evidencia favorable/contraria, datos faltantes y próxima comprobación. Separar `impacto` de `causa probable`. Las revisiones se guardan de forma inmutable y se muestran en la tarjeta de incidente.
- [x] Evaluar hipótesis de regresión de aplicación, abuso, dependencia/proveedor y desconocido. Admitir varias simultáneas; no forzar un único culpable. Los datos del release y las dependencias conservan su estado declarado o verificado.
- [x] Alinear tiempos de evento/aceptación, latencia de entrega, sampling, frescura y línea base por servicio/entorno. Los datos ausentes o caducos se excluyen y se muestran; un feed global no confirma región/componente. Las métricas firmadas sin etiquetas verificables quedan a nivel de aplicación.
- [x] Relacionar errores por dependencia/ruta, cambios de release, métricas de recursos y comprobaciones HTTPS independientes dentro del consentimiento. La ruta de control sana aísla un fallo de proveedor; si también falla, la causa específica queda sin confirmar. Los roles/dependencias de ruta son declaraciones del Owner/Operator y sólo usan rutas fijas permitidas por el perfil HTTPS activo.
- [x] Persistir cada revisión con versión del correlador y referencias de evidencia, sin mutar la historia. Evidencia posterior puede subir, bajar o retirar una hipótesis. La evaluación se agenda como trabajo durable después de cada lote de telemetría firmado; la falta de cupo degrada la proyección sin rechazar detecciones aceptadas.
- [x] Definir confianza por reglas auditables y resultados de evaluación. Reservar probabilidades numéricas para cuando haya calibración; no usar la seguridad verbal del modelo como medida. El núcleo, las revisiones y la interfaz están integrados; la primera calibración de errores de confianza se midió en D15, mientras que calibración representativa sigue pendiente.
- [x] Mostrar una tarjeta de incidente con impacto, explicación, contradicciones, límites y botón para obtener evidencia faltante. “No se observó impacto en los puntos comprobados” no significa “toda tu empresa está sana”. Las rutas declaradas se muestran como datos declarados, nunca como autorización para añadir destinos.

**Aceptación mínima:** proveedor caído/app sana; proveedor sano/app fallando tras release; proveedor caído/fallos compatibles en una dependencia; telemetría vieja; dos causas simultáneas; feed regional incompleto; incremento legítimo de tráfico. Incluir controles donde la conclusión correcta es abstenerse. Medir falsos positivos y tiempo hasta decisión frente a señales sin correlacionar.

**Prueba real completada:** tests del coordinador contra Postgres/Redis reales para proveedor con aplicación sana, release verificado con errores y alternativa de tráfico, dependencia con control independiente sano, telemetría caducada y límites de incidentes/revisiones. Los eventos usan HMAC real; el adaptador de Cloudflare marca el feed como fixture y las rutas pasan por un servidor TLS local. La primera medición D15 usa una aplicación instrumentada local, ingestión firmada y 14 casos/split × 5 repeticiones; `pnpm eval:triage` la reproduce. Las lecturas holdout repetidas muestran omisiones intermitentes de `runtime.resources.v1` y de presión del event loop. No se han validado feeds reales de proveedor, comportamiento de clientes reales ni capacidad de producción.

### D04 — Runner desechable y perfiles mantenidos

**Problema:** ejecutar pruebas, instalar dependencias o fuzzear es ejecutar código del cliente. Los contenedores actuales de parsing no satisfacen el gate de aislamiento.

Trabajo:

- [ ] Seleccionar un adaptador VM por trabajo y verificar virtualización, recursos y coste en el entorno disponible. Evaluar una microVM u otra VM desechable; el [diseño de Firecracker](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md) es una referencia, no una decisión ni una garantía de disponibilidad local.
- [x] Definir imagen base fija, usuario sin privilegios, disco efímero, límites de CPU/RAM/PID/tiempo/salida, red denegada por defecto y destrucción comprobada. Sin DB, Redis, secretos productivos, socket Docker del host, mounts del control plane ni metadatos cloud.
- [x] Separar descarga de paquetes y ejecución. Las instalaciones usan destinos permitidos y artefactos exactos; los scripts/tests no heredan acceso abierto a Internet. Las opciones del package manager no sustituyen aislamiento.
- [ ] Entregar input por objeto acotado y resultado mediante permiso breve de un solo uso. Validar salida como no confiable; conservar digest, versión de runner, perfil y evidencia de limpieza.
- [ ] Mantener ownership/admisión hasta terminar procesos y cleanup. Timeout, host perdido o limpieza incierta producen cuarentena y requieren reconciliación, nunca capacidad liberada como si el trabajo hubiera terminado.
- [ ] Sustituir Semgrep 1.90.0 por un perfil mantenido, fijado por digest y validado con corpus. Revisar igualmente los otros perfiles y su política de actualización. No quitar el bloqueo de producción para pasar readiness.

**Aceptación:** pruebas reales de filesystem/red/metadata, fork bomb y límites de salida, cancelación, caída del worker, escape de paths/symlinks y eliminación del guest. Si no hay VM disponible, el gate permanece cerrado con razón visible; un mock no lo satisface.

### D05 — Reproducción y validación independiente de una corrección

**Problema:** desaparecer de Semgrep/Trivy no demuestra que una corrección preserve funcionalidad.

Trabajo:

- [x] Introducir registros durables por tenant de validación, fuente base/candidata, target, patch y árbol, perfil, suite versionada, runner/Firecracker/kernel/rootfs, estado, tiempos, límites y caducidad; las cuatro attestations se guardan separadas e inmutables.
- [x] Permitir a Owner/Operator configurar una suite por enlace de repositorio; comparar scripts y metadatos de `package.json`, configuración de runners, `.npmrc`, todos los paths de test y archivos `setupFiles` entre base y candidato. Una suite modificada queda inconclusa. Los PR de dependencias sólo permiten cambios de versión en el allowlist exacto y el lockfile.
- [x] Ejecutar base y candidato en Firecracker con `node24-npm-test`; guardar reproducción, regresión candidata, suite y reanálisis como attestations distintas. La suite informa conteos y la reproducción objetivo desde `test-results/*.json`.
- [ ] Añadir fuzzing con corpus y harnesses de API. El alcance actual se limita al laboratorio local y al perfil Node/JS fijo.
- [x] Comparar identidades de findings nuevos/objetivo y cobertura antes/después; scanner fallido, coverage parcial, identity objetivo ausente, mismatch de digest y gate cerrado no producen validación completa.
- [x] Compartir una regla pura de identidad/cobertura entre la attestation de reanálisis y `scoreValidation`; la fact sólo pasa si el objetivo desapareció y no hay findings nuevos.
- [x] Comparar los conteos base/candidato de la suite: menos tests ejecutados o más skips falla con `suite_shrank`, aunque el mínimo de tests pasados se alcance.
- [x] Firmar las attestations con una clave Ed25519 del proceso validator, protegida fuera del repo con modo 0600. `validationAttestationSchema` y `getValidationFacts({organizationId, actionRef})` entregan al verificador evidencia firmada y clave pública; la verificación es independiente del modelo.
- [x] Validar con seis casos unitarios de scoring, cinco ejecuciones reales de guest VM y nueve escenarios reportados (arreglo correcto, funcionalidad borrada, configuración cambiada, suite fallida/omitida, frame malformado, digest base no aprobado y gate cerrado); el adaptador de frame está etiquetado como fixture.
- [x] Verificar bytes de attestations modificados, lease vencido sin doble registro y `cleanup_uncertain` en cuarentena que mantiene capacidad: 14 casos de base de datos y 130 de backend pasaron en Postgres real.

**Aceptación:** arreglo correcto; arreglo que borra/desactiva la funcionalidad; suite omitida; nuevo hallazgo; perfil viejo; salida falsificada; base diferente; test fallido; cobertura parcial; runner no aislado. UI con “reanálisis objetivo pasó” y “suite X pasó”, nunca “aplicación completamente segura”.

El circuito local registra por separado el reanálisis objetivo y la suite. El profile del runner sólo admite `npm test`; otros `scriptName` quedan inconclusos. La evidencia anterior es local de desarrollo: los casos guest usaron Firecracker real y el test de firma/lease usó Postgres real. No demuestra AWS, cobertura general de fuzzing, ni capacidad de producción.

Esto adopta la exigencia práctica de un CRS: encontrar y corregir manteniendo comportamiento. La [evaluación de AIxCC](https://www.darpa.mil/news/2025/ai-cyber-challenge-scoring) valoró explícitamente parches que preservan funcionalidad. No implica que Gotchu ya alcance las capacidades de esos sistemas.

### D06 — Candidatos npm y evolución del contrato de acciones

**Problema:** la primera escritura acordada es una actualización npm reproducible, pero las recetas actuales sólo preparan TLS/Kubernetes y snapshots; falta el puente completo hacia commits y aprobaciones.

Trabajo:

- [x] Implementar candidato de dependencia patch/minor: usar metadata OSV persistida y metadata acotada del registro npm; comprobar SHA-512 del tarball actual y del candidato; resolver manifiesto y lockfile sin instalar ni ejecutar código en el host; rechazar majors, rangos ambiguos, prereleases y cambios fuera del paquete.
- [x] Empezar con lockfiles npm v2/v3 del proyecto raíz. Añadir otros formatos mediante adaptadores y corpus; no anunciar soporte genérico de pnpm/yarn por detectar `package.json`.
- [x] Vincular el candidato al repositorio/commit de D01 sólo con una instantánea enlazada a una GitHub App activa, un link de repositorio verificado y el mismo commit/digest. Una subida parcial se corrige privadamente; no autoriza sustituir todo el árbol del repositorio. Las transitivas quedan como orientación hasta demostrar un override seguro.
- [x] Versionar una unión estricta de acciones con payload y capability id por capacidad. La lectura/hash/ejecución de filas v1 conserva su esquema y fórmula originales; las acciones v2 tienen hash separado con epoch de recuperación. D08/D09 habilitan sólo `source_patch_pull_request` y `dependency_pull_request`.
- [ ] Añadir acciones de patch de fuente/IaC para TLS/Kubernetes sólo tras definir sus precondiciones, suites, artefactos y política. Es una extensión explícita del primer alcance npm.
- [x] Guardar candidato, corrida de validación D05 y metadata inmutable en una transacción; sólo admitir candidatos cuando existe una suite versionada para ese repositorio. Al pasar la validación, la acción v2 y su artifact privado de `execution-artifacts` se persisten juntos. Preparar no consume aprobación ni escribe en Git.
- [x] Extender D05 para que vuelva a consultar OSV en el reanálisis independiente y emita hechos firmados que exigen cobertura completa, desaparición de cada aviso del alcance y suite funcional aprobada.
- [x] Mostrar recomendaciones npm, razones de orientación, estado de validación y la propuesta exacta en la vista existente de acciones; un Owner puede aprobar el PR draft de dependencia tras validar el candidato y otorgar escritura explícita al Writer App.
- [x] Mantener el permiso Writer separado de la conexión Reader: el Owner concede/revoca con WebAuthn fresco, el executor comprueba que su instalación cubre el repositorio y la revocación invalida aprobaciones pendientes. Migración 038 exige volver a conceder grants previos que no tenían evidencia de cobertura.

**Límites comprobados:** sólo se admite una dependencia directa del `package.json` raíz con lockfile npm v2/v3. Se rechazan árboles de paquete que requieran cambios de otras entradas, repositorios sin GitHub App activa o cualquier manifest/lockfile fuera del alcance exacto. La resolución consulta un packument abreviado con timeout, redirects deshabilitados y límite de 1 MiB; el runner conserva la red denegada y verifica el tarball por SHA-512 antes de ejecutarlo dentro de la VM. No se ejecuta `npm install` ni código del cliente en el control plane. Los parches transitivos, workspaces y versiones major permanecen como orientación.

**Aceptación:** manifiesto y lockfile consistentes; varias advisories fijadas a la vez; ausencia de versión patch/minor; scripts del cliente no autorizados; digest/base stale; snapshot incompleto; conflicto de idempotencia; rollback de transacción; compatibilidad v1/v2; borrado del source que no resucita con un retry. La persistencia de propuestas/artifacts se prueba con PostgreSQL; la integración opt-in de lodash usa npm/OSV reales y requiere PostgreSQL desechable y la gate Firecracker abierta. El executor publica sólo los dos archivos aprobados, un commit determinista con SHA verificable y un PR draft que lista advisories, versiones y validación. La publicación live se cuenta sólo si se ejecuta la prueba Writer App opt-in y se verifica/cierra el PR.

El detalle posterior de acciones, operación y expansiones se consolidó en [Roadmap](roadmap.md).

## 11. Secuencia de commits y organización del trabajo

Propuesta para la siguiente implementación, con commits pequeños que puedan revisarse por separado:

1. D01: contratos de contexto/deploy; migración y RLS; servicios; adaptadores/SDK; UI de conexión y estados.
2. D02/D03: catálogo y reglas; persistencia del triage; correlación determinista; proyección/API; UI; integración con los tres controles de proveedor/app.
3. D04/D05: contrato runner; implementación VM y pruebas reales; lifecycle/cleanup; artefactos; validación base/candidato; verificador.
4. D06: propuesta v2 compatible; actualización npm/lockfile; admission/outbox; pruebas de candidato; extensión explícita TLS/Kubernetes si procede.
5. D07–D09: MFA; executor lifecycle; adaptador local; adaptador GitHub; reconciliación; interfaz de aprobación; prueba de PR real.
6. D10: acciones merge/deploy; entorno local; verificación/rollback; recorrido de navegador completo.
7. D11–D16: cada capacidad en su entrega con métricas y gates propios, sin un commit masivo de “agente autónomo”.

Si se autoriza implementación paralela, aislar worktrees y asignar contratos/DB, runner, executor y web con límites de archivos acordados; integrar contratos temprano y reconciliar el lockfile desde el parent. La integración debe seguir productores y consumidores, no sólo hacer cherry-pick de paquetes que compilan aislados. Los cambios de seguridad requieren revisión independiente conforme a las instrucciones del proyecto.

## 12. Decisiones que hay que resolver antes de habilitar capacidades

- **Primera validación funcional:** fijar versión Node/npm, lockfile y suite por repositorio. Propuesta inicial: npm con lockfile reproducible y un repositorio Node/TS controlado; otros stacks quedan explícitos como pendientes.
- **Runner disponible:** comprobar soporte VM local; si no existe, mantener tests del cliente deshabilitados y documentar opción de runner externo configurable, sin contratarlo en este trabajo.
- **Primer proveedor de escritura:** GitHub opcional para cumplir la decisión de PR y Git local para pruebas portables; acordar repositorios, CI permitido y permisos mínimos antes de un check real.
- **Identidad de despliegue:** decidir cómo atestigua cada cliente el vínculo commit/artefacto/release y qué nivel de confianza obtiene una mera declaración manual.
- **Modelo y datos:** consentimiento, campos salientes, proveedor/local, límites y política de retención. El producto sigue funcionando sin elegir un proveedor de IA.
- **Calidad y coste:** fijar umbrales sobre corpus y piloto, presupuestos por cliente y política al agotar cuotas. El presupuesto histórico es una referencia provisional, no coste comprobado.
- **Extensión de acciones:** aprobar el diseño v2 y suites antes de llevar TLS/Kubernetes a un PR; después, políticas distintas para merge, deploy y automatización.
- **Producción futura:** dominio/región, identidad, red, backup y acceso operativo se decidirán al retomar despliegue. No son bloqueantes para construir y comprobar el flujo local.

## 13. Criterio de finalización

La siguiente meta de producto queda cumplida cuando un usuario conecta su aplicación real, obtiene un triage respaldado por evidencia que distingue impacto de hipótesis y puede llevar una corrección admitida hasta un PR real y una entrega local verificada, sin escribir comandos y sin saltarse aislamiento, MFA o autorización exacta.

Para declarar una capacidad lista para producción hacen falta además sus gates operativos y pruebas reales de proveedor/runner/recuperación. Un contrato, un botón, una simulación o un test verde con fixtures no sustituyen esos resultados. La comparación comercial se actualizará con evidencia y pruebas de usuarios; “hacerlo mejor” se demostrará en menos ruido y tiempo hasta una decisión/reparación correcta, con alcance y coste explícitos.

Actualizar este plan al cerrar cada ID con commits y evidencia. Mantener [architecture.md](architecture.md) y [implementation-plan.md](implementation-plan.md) como descripción del comportamiento implementado; no convertir este backlog en una lista de funciones anunciadas como disponibles.
