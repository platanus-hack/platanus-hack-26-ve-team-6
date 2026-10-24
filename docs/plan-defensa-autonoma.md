# Plan de defensa autónoma y diferenciación de Gotchu

> **Actualización (24 de octubre de 2026):** este plan conserva como línea base el último commit del archivo, `ce281c9`. Las afirmaciones de esa línea base sobre Semgrep 1.90.0 como perfil sólo de desarrollo/pruebas, el bloqueo de escaneo en producción y los gates equivalentes del scanner quedaron superadas para el alcance local Linux/amd64 validado por el pin Semgrep 1.182.0 y las pruebas finales del flujo scanner/coordinator TLS con persistencia durable. No se afirma despliegue cloud ni cobertura general. Consulta el [registro de validación](validation.md) para la evidencia actual. Las demás prioridades y análisis históricos no se reescribieron.

Fecha: 24 de octubre de 2026. Base revisada: `68e19c5c6d099a1fc8b6c5feb5e823afd27cd895`.

Este documento convierte las nuevas direcciones del producto en trabajo verificable. Se revisaron implementación, contratos, consumidores, pruebas y límites documentados. **Es un plan pendiente de ejecución; su publicación no habilita estas capacidades.** La revisión fue de código y documentación: no se volvieron a ejecutar las suites de infraestructura ni se probaron productos competidores. Los resultados anteriores están en el [registro de validación](validation.md).

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
- Semgrep, Gitleaks, Trivy y OSV con perfiles acotados; HTTPS autorizado con DNS TXT y perfil público limitado. Semgrep 1.90.0 está restringido a desarrollo/pruebas; Docker no establece el aislamiento requerido para ejecutar código del cliente. Fuentes: [motor](../packages/customer-assessment/README.md), [scanner](../apps/scanner/README.md).
- Telemetría firmada, outbox, consumidores repetibles, detectores de autenticación, errores, latencia, recursos y ciertas señales de abuso. Estado Cloudflare/Railway, liveness durable de comprobaciones programadas y notificaciones por email/webhook con bandeja de salida y estado de entrega. Sin watchdog independiente, una caída total del coordinador retrasa alertas externas hasta que vuelva un worker. Fuentes: [detección](../apps/coordinator/src/operational-detectors.ts), [operación actual](operations.md).
- Historial de decisiones visible para miembros del espacio con rol de lectura: identidad del miembro mediante su correo cuando está disponible, etiqueta de sistema para actores automatizados, acción, categoría del asunto, fecha, resultado y resumen seguro. Incluye las mutaciones que hoy escriben auditoría, como reconocimiento/resolución de alertas, creación/preparación/declaraciones de planes, solicitudes de corrección y reanálisis, creación/solicitud de descarga de informes, cambios de miembros, factores de verificación, propuestas y seguimiento de incidentes. La solicitud de descarga de informe también deja un registro. La proyección omite detalle JSON, IDs de actor, credenciales e IP. No es todavía una cronología completa de ejecución por incidente ni un historial completo de acciones de proveedor; las escrituras de proveedor siguen deshabilitadas.
- Reportes internos/externos con procedencia, confianza y límites; recetas seleccionadas por evidencia. Dos familias de transformación preparan cambios privados exactos: verificación TLS en JS/TS y ciertos permisos de Kubernetes YAML. La preparación almacena una copia y encola un reanálisis; no cambia el repositorio. Fuentes: [recetas](../packages/scenarios/README.md), [correcciones](../packages/backend/src/corrections.ts).
- Ledger de propuesta, aprobación exacta y ejecución; recuperación y resultados inciertos. Sus verificadores de MFA/elegibilidad y proveedores se prueban con fixtures. Existe una biblioteca de executor, no un servicio de escritura real conectado al producto. Fuentes: [propuestas](../packages/backend/src/proposals.ts), [executor](../apps/executor/README.md).
- LangGraph y gateway de lectura con límites y checkpoints. La ruta de modelo responde `503 model_not_configured`; no existe investigación de código mediante un modelo activo. Fuente: [gateway](../apps/gateway/src/service.ts).

### Brechas que impiden cumplir la visión

1. **No hay correlación explicativa proveedor–aplicación.** El estado del proveedor se conserva como impacto no verificado; falta unir dependencias, entorno, versión desplegada, rutas y ventanas de señales. Fuente: [contrato de observaciones](../packages/contracts/src/operations.ts).
2. **Comparar hallazgos internos y externos no prueba explotabilidad.** Falta vincular el commit analizado al despliegue y verificar condiciones relevantes. Ver un endpoint accesible no confirma que ejecute una función vulnerable. Fuente: [comparación actual](../packages/customer-assessment/src/common.ts).
3. **Las correcciones privadas y las aprobaciones están desconectadas.** La propuesta ejecutable v1 sólo admite `github.pull_request` con actualizaciones npm patch/minor, commits y artefactos. Las recetas TLS/Kubernetes no caben en ese contrato. No se puede conectar un botón sin evolucionar el modelo y sus verificadores.
4. **No existen pruebas funcionales de cliente en una VM desechable, artefactos de validación independientes ni MFA de acción real.** Un reanálisis estático no satisface esas condiciones.
5. **No hay escritura real de repositorio, PR, merge, deploy, contención o migración.** El executor no tiene adaptador de proveedor ni proceso consumidor de producción. Los planes operativos devuelven `ready: false`; marcar pasos es una declaración del usuario. Fuentes: [executor](../apps/executor/src/execution.ts), [planes](../packages/backend/src/operations.ts).
6. **El agente no investiga automáticamente todo hallazgo.** Las herramientas actuales de la investigación están centradas en evidencia y eventos de autenticación; faltan contexto de fuente, topología y contratos de nuevas investigaciones.
7. **La evaluación profunda de dependencias, phishing, deepfakes y campañas de influencia no está implementada.** Son capacidades distintas y necesitan entradas, pruebas y permisos propios.
8. **Quedan requisitos operativos:** notificaciones externas, miembros/invitaciones, borrado permanente, cuotas visibles, producción de identidad/TLS, actualización del scanner, restauración y capacidad medida. La infraestructura AWS está definida y probada con mocks, sin despliegue real.

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

**Prueba real completada:** tests del coordinador contra Postgres/Redis reales para proveedor con aplicación sana, release verificado con errores y alternativa de tráfico, dependencia con control independiente sano, telemetría caducada y límites de incidentes/revisiones. Los eventos usan HMAC real; el adaptador de Cloudflare marca el feed como fixture y las rutas pasan por un servidor TLS local. La primera medición D15 usa una aplicación instrumentada local, ingestión firmada y 14 casos/split × 5 repeticiones; véase [triage-evaluation.md](triage-evaluation.md). Las lecturas holdout repetidas muestran omisiones intermitentes de `runtime.resources.v1` y de presión del event loop. No se han validado feeds reales de proveedor, comportamiento de clientes reales ni capacidad de producción.

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
- [x] Versionar una unión estricta de acciones con payload y capability id por capacidad. La lectura/hash/ejecución de filas v1 conserva su esquema y fórmula originales; las acciones v2 tienen hash separado con epoch de recuperación. Esto no habilita todavía los adaptadores de D08/D09.
- [ ] Añadir acciones de patch de fuente/IaC para TLS/Kubernetes sólo tras definir sus precondiciones, suites, artefactos y política. Es una extensión explícita del primer alcance npm.
- [x] Guardar candidato, corrida de validación D05 y metadata inmutable en una transacción; sólo admitir candidatos cuando existe una suite versionada para ese repositorio. Al pasar la validación, la acción v2 y su artifact privado de `execution-artifacts` se persisten juntos. Preparar no consume aprobación ni escribe en Git.
- [x] Extender D05 para que vuelva a consultar OSV en el reanálisis independiente y emita hechos firmados que exigen cobertura completa, desaparición de cada aviso del alcance y suite funcional aprobada.
- [x] Mostrar recomendaciones npm, razones de orientación, estado de validación y la propuesta exacta en la vista existente de acciones; no se publica un PR hasta integrar el executor.

**Límites comprobados:** sólo se admite una dependencia directa del `package.json` raíz con lockfile npm v2/v3. Se rechazan árboles de paquete que requieran cambios de otras entradas, repositorios sin GitHub App activa o cualquier manifest/lockfile fuera del alcance exacto. La resolución consulta un packument abreviado con timeout, redirects deshabilitados y límite de 1 MiB; el runner conserva la red denegada y verifica el tarball por SHA-512 antes de ejecutarlo dentro de la VM. No se ejecuta `npm install` ni código del cliente en el control plane. Los parches transitivos, workspaces y versiones major permanecen como orientación.

**Aceptación:** manifiesto y lockfile consistentes; varias advisories fijadas a la vez; ausencia de versión patch/minor; scripts del cliente no autorizados; digest/base stale; snapshot incompleto; conflicto de idempotencia; rollback de transacción; compatibilidad v1/v2; borrado del source que no resucita con un retry. La persistencia de propuestas/artifacts se prueba con PostgreSQL; la integración opt-in de lodash usa npm/OSV reales y requiere PostgreSQL desechable y la gate Firecracker abierta. La publicación de PR sigue dependiendo del executor D08/D09 y no se cuenta como evidencia de D06.

### D07 — MFA real y aprobación comprensible de la acción exacta

Trabajo:

- [x] Implementar enrolamiento, desafío y verificación de segundo factor mediante `@simplewebauthn/server` y `@simplewebauthn/browser`, con recuperación de un solo uso y revocación ligada a otra aserción o código. Auth.js proporciona sesiones, no esta garantía automáticamente. Referencia: [WebAuthn](https://www.w3.org/TR/webauthn-3/).
- [x] Emitir prueba opaca, breve, de un uso, vinculada a usuario, organización y hash de acción. Mantener controles actuales de rol, autenticación reciente, caducidad y recovery epoch.
- [x] Revalidar membresía y estado antes de aprobar y antes de escribir. El cierre de sesión invalida los desafíos y pruebas pendientes; ambos vencen además en dos minutos. Un rol revocado o epoch distinto invalida el consumo.
- [x] Round 2: factores y códigos de recuperación globales por usuario, protegidos por RLS y el contexto validado de sesión/organización. El primer factor exige reautenticación de contraseña local; las cuentas sin contraseña local no pueden usar bootstrap. Añadir otro factor requiere una prueba WebAuthn reciente para el hash fijo de enrolamiento o un código de recuperación de un uso. El desafío conserva la autorización y el conjunto exacto de factores, que se vuelve a comprobar bajo advisory lock al terminar.
- [x] Invalida desafíos y pruebas pendientes al cerrar sesión mediante `events.signOut`; el vencimiento de dos minutos sigue como segunda barrera. El API de step-up conserva las cookies de sesión renovadas.
- [x] Presentar efecto, alcance, coste conocido/desconocido, resumen de diff seguro, validaciones separadas, límites y razones de bloqueo. Los controles distinguen aprobar PR, merge y deploy y sólo el Owner inicia WebAuthn para el hash exacto cuando el servidor informa elegibilidad. La primera acción de fuente queda bloqueada hoy porque faltan attestations de D05/D08 y adaptadores D09; no se habilita por severidad ni por estado visual.

**Aceptación:** ceremonia real en navegador y ledger PostgreSQL: CSRF/origen, replay, desafío equivocado, actionHash cambiado, caducidad, dos consumos concurrentes, rol revocado, factor perdido y recuperación. No usar el fixture `StepUpVerifier` como evidencia de MFA real.

La migración 017 descarta expresamente las tablas de la migración 015, que no se desplegaron; desafíos y pruebas siguen ligados a usuario, organización, hash exacto y recovery epoch. La verificación de enrolamiento de segunda llave y los controles de recuperación se mantienen en la prueba CDP opt-in, contra Postgres desechable y la biblioteca WebAuthn real.

### D08 — Artefactos, verificador independiente y servicio executor

Trabajo:

- [x] Añadir `ActionVerifier` con una consulta de candidato privado/digest, lectura de base y un `ValidationFactsPort` con schema local estricto. El runtime web lo conecta fail-closed; por ahora retorna `null` hasta que la integración D05 provea hechos firmados.
- [x] Añadir persistencia restringida por tenant para intentos del executor, con transiciones `claimed → branch_published → pr_opened → verified` y estados inciertos/reconciliación.
- [ ] Guardar patches, árboles/commits candidatos y attestations de D05 con acceso privado, integridad verificable y retención. El modelo no puede editar el registro de validación ni marcarse elegible.
- [ ] Conectar el `ValidationFactsPort` con `backend.validations.getValidationFacts(actionRef)`; D05 aún no está integrado en esta rama.
- [ ] Crear el proceso consumidor de executor, su lifecycle completo, readiness y apagado. La biblioteca y el ledger existen, pero esta rama todavía no conecta un worker a la cola de ejecuciones.
- [ ] Reutilizar claims/outbox desde el proceso independiente; credenciales de escritura sólo en el executor y sólo para los recursos aprobados. Registrar intentos por etapa sin source, tokens ni secretos en logs.
- [ ] Extender máquina de estados y reconciliación a escrituras de varios pasos. Tras timeout consultar estado remoto antes de retry; una respuesta desconocida conserva bloqueo y no permite una segunda acción.
- [ ] Mantener freeze tras restore, epoch de recuperación y verificación independiente del efecto. Las conexiones del worker/modelo siguen siendo de lectura.

**Aceptación:** DB/Redis reales con caídas entre cada transición, duplicados, fallo de credenciales, aprobación ausente, permisos incompatibles, resultado incierto y restauración. Las pruebas con proveedor simulado validan el ledger; D09 aporta la prueba del proveedor real.

### D09 — PR real, seguro frente a concurrencia y automatización del repo

Trabajo:

- [x] Implementar `@gotchu/git-adapters` con salida local Git y GitHub App, ramas deterministas, creación condicional de ref y búsqueda de PR por branch tras entregas repetidas.
- [x] Rechazar cambios candidatos bajo `.github/workflows/**`; leer los workflows del commit base y parsear YAML con `js-yaml`, en modo deny-by-default, rechazando `pull_request_target`, `push` sin filtro de ramas, `push` hacia `gotchu/**` y secretos distintos de `GITHUB_TOKEN` en `pull_request`. Un YAML inválido también se rechaza. La prueba opt-in real confirmó head/base, inspeccionó el sandbox (sin workflows) y cerró el PR/eliminó la rama.
- [ ] Integrar el adaptador con el executor, publicar artefactos D05 almacenados y verificar digest exacto del diff/commit desde el proveedor.
- [ ] Conectar la inspección al runtime lector y al registro de excepciones por repositorio, aprobado por Owner, versionado y auditado. La opción de excepción actual sólo es una costura del adaptador y no satisface ese registro. La prueba GitHub adapter directa no sustituye esa integración.
- [ ] Definir operaciones condicionales reales por proveedor. Un lock de Postgres y leer el head antes de escribir no bloquean un editor remoto. GitHub no ofrece un parámetro universal de expected-old-SHA para todas las operaciones; revisar capacidades concretas y cerrar las que no garanticen la política. Referencia: [Git refs REST](https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28).
- [ ] Si cambia la base, invalidar y regenerar aprobación. Si el cambio se descubre después de crear el PR, conservarlo como obsoleto y bloquear merge/deploy hasta validar de nuevo; no describir ese caso como libre de carreras.
- [ ] Gestionar permiso revocado, PR cerrado, conflicto, branch borrada y reconciliación de resultado incierto sin repetir la publicación.

**Aceptación:** repositorio desechable real, aprobado para estas pruebas; un PR exacto pese a entrega duplicada; base cambiada; CI no permitido; timeout tras creación; credenciales revocadas; efecto verificado. No hace falta desplegar AWS. La validación de Git local no sustituye el check del adaptador GitHub.

### D10 — Merge, deploy y rollback como capacidades separadas

Trabajo:

- [ ] Añadir tipos de acción propios para merge y despliegue. Bind de aprobación a head/base del PR, checks, política, entorno, artefacto/imagen digest y plan exacto. No reutilizar un permiso de abrir PR.
- [ ] Empezar con entorno de desarrollo aislado y plantilla de despliegue administrada por operador. Builds y scripts del cliente permanecen en D04; no ejecutar shell arbitrario en el host del control plane.
- [ ] Verificar disponibilidad y comportamiento desde fuera del proceso desplegado, junto con métricas antes/después. Distinguir fallo de despliegue, verificación pendiente y release aplicada pero degradada.
- [ ] Guardar versión anterior y condiciones de reversión; usar escritura condicional para no revertir un cambio posterior. Si no se conoce el estado, reconciliar.
- [ ] Tratar migraciones de datos como acciones aparte. Un rollback de imagen no revierte datos ni demuestra compatibilidad del esquema.
- [ ] Guiar la UI por cada etapa y exponer bloqueos específicos. Permitir cancelar antes de escribir; durante una operación no interrumpible, mostrar seguimiento/reconciliación.

**Aceptación:** circuito real local de PR/commit admitido → aprobación de merge → deploy → checks → rollback ante regresión; caída a mitad de deploy, health falso, release concurrente y cambio irreversible rechazado. Producción sigue deshabilitada hasta D14 y una solicitud de despliegue real del usuario.

### D11 — Agente investigador y generación controlada de nuevas propuestas

Trabajo:

- [x] Conectar un puerto de modelo sustituible, con adaptadores OpenAI-compatible y Anthropic Messages y opción local. Mantener el camino determinista y mostrar investigación deshabilitada cuando no haya modelo o consentimiento.
- [x] Ampliar el gateway con lecturas acotadas de contexto de D01, código redactado, findings, diffs, resultados de validación y triage. Autorización por tenant/app/run; cada herramienta tiene schema y presupuesto.
- [x] Persistir reservas y liquidación de tokens y dinero por run/organización antes de llamar al modelo. Los límites del worker no son contabilidad autoritativa en backend. Las llamadas en vuelo y el coste desconocido siguen reservados.
- [x] Crear investigaciones de findings/operaciones materiales con dedupe, cancelación, reanudación y checkpoints mínimos. La reanudación abre una ejecución nueva desde la evidencia original; no reabre cada evento ni desplaza el carril determinista.
- [x] Tratar código, logs, avisos y respuestas como datos no confiables. Probar prompt injection, secretos canario, referencias inexistentes y herramientas fuera de scope. El modelo no recibe permisos de escritura ni elige su rol.
- [x] Permitir una hipótesis o sugerencia de candidato privada sin volverla ejecutable; la salida indica que requiere D05. El candidato no se publica ni se marca verificado.
- [ ] Encaminar candidatos por validación D05 y política humana antes de cualquier acción ejecutable. Versionar y permitir retirar el catálogo.

**Estado de esta entrega:** la configuración es por workspace y Owner, el consentimiento distingue siete categorías de datos y las credenciales nunca se devuelven. En desarrollo, el secreto usa un adaptador local de archivos con permisos privados; los entornos alojados deben inyectar un almacén cifrado. No había Ollama ni llama.cpp disponible en este entorno; el caso con modelo real queda como prueba opt-in y no se ejecutó. Los tests del proveedor fixture son deterministas y no cuentan como evidencia de modelo real.

**Aceptación:** al menos un caso de investigación útil con modelo real configurado y minimización auditada; pruebas deterministas con proveedor fixture etiquetado; cero escrituras por prompt injection; límites durables bajo concurrencia/restart. Explicar una evidencia no confiere “hallazgo verificado”.

### D12 — Código de dependencias y aprendizajes de los CRS

Trabajo:

- [ ] Mantener consulta de avisos aunque el commit no cambie; ampliar formatos sólo con parsers probados. Modelar nombre/ecosistema, versión exacta, directas/transitivas y origen de paquete; generar inventario/SBOM exportable mediante formato abierto elegido.
- [ ] Para dependencias priorizadas, obtener el artefacto exacto del registro y verificar integridad. El Git `main` del mantenedor puede diferir de la versión distribuida; conservar esa limitación y su correspondencia de commit cuando se pueda verificar.
- [ ] Extracción segura con límites de archivo/tamaño/descompresión, paths y enlaces; sin hooks de instalación. Analizar código/configuración de ese artefacto en el runner y registrar dependencia/versión, sin prometer revisar ilimitadamente todo árbol transitivo.
- [ ] Añadir análisis de importación/uso y, cuando proceda, reproducción en laboratorio. “No se encontró una ruta” sigue siendo desconocido si el análisis es parcial, dinámico o incompatible.
- [ ] Evaluar un adaptador CRS antes de integrarlo: lenguajes, harnesses, licencia, requerimientos, datos salientes y coste. [Buttercup](https://github.com/trailofbits/buttercup) ofrece un punto de estudio en C/Java con harnesses OSS-Fuzz; no es un sustituto directo del motor Node/TS ni exige adoptar su stack completo.
- [ ] Separar evidencia de CVE conocida, sospecha nueva y reproducción. Añadir tratamiento privado y divulgación coordinada para problemas nuevos, sin publicar exploits automáticamente.

**Aceptación:** paquete exacto distinto de upstream; dependencia transitiva afectada; checksum incorrecto; archivo malicioso; runtime dinámico desconocido; mismo source con advisory nuevo; reproducción base/candidato. Cualquier promesa sobre coste/cobertura del CRS requiere benchmark local propio.

### D13 — Endurecimiento, capacidad y recuperación guiada

Tres capacidades independientes, apoyadas en D01/D03 y ejecutadas mediante D07–D10:

**Endurecimiento:**

- [ ] Inventario autorizado de recursos/configuración realmente desplegados, empezando por lectura AWS acotada para S3, RDS y EC2/red; IaC y estado real deben distinguirse. Mantener puertos para otros proveedores.
- [ ] Plantillas específicas de permisos/red/almacenamiento y rotación de credenciales con integración del emisor. Borrar una clave del repo no revoca la credencial filtrada.
- [ ] Medir diferencias entre estado deseado/actual, impacto esperado, verificaciones y rollback aplicable. Sistemas críticos requieren políticas por entorno, ventanas y responsable operativo; no inferir aptitud para OT/hospitales por escanear una app web.

**Capacidad y contención:**

- [ ] Relacionar solicitudes, errores, latencia, CPU/memoria/conexiones, límites de proveedor y arquitectura. Evaluar rate limit, cola, backpressure, caché, réplica o balanceador según el cuello de botella.
- [ ] Antes de recomendar balanceador/replicación, comprobar backend escalable, sesiones, estado, datos y cuotas/coste. Un fallo del pool de base de datos puede empeorar al añadir réplicas.
- [ ] Diseñar una primera plantilla de respuesta reversible con scope, límites, preautorización, kill switch y expiración del propio proveedor demostrada. No confiar sólo en un cleanup programado en nuestra DB.

**Recuperación entre proveedores:**

- [ ] Descubrir servicios, secretos referenciados, estado, dominios y dependencias; comprobar compatibilidad y permisos de destino, exportación/restauración y presupuesto.
- [ ] Preparar el destino y validar aplicación/datos antes de cutover. Medir RPO/RTO, identificar replicación retrasada, escrituras concurrentes y punto sin retorno.
- [ ] Autorizar por separado aprovisionamiento, transferencia de datos y cambio de tráfico/DNS; comprobar salud y mantener estrategia de retorno sólo mientras los datos sigan siendo compatibles.
- [ ] Convertir checklists actuales en comprobaciones independientes por adaptador; una confirmación del usuario sigue siendo autodeclarada.

**Aceptación:** saturación legítima y ataque; servicio stateful que no admite réplica automática; fallo de DB que un balanceador no resuelve; API de proveedor caída; permisos incompletos; destino sano con datos incompletos; plataforma offline durante expiración; cutover y rollback con datos controlados. Primero laboratorio local. Preparar contratos no autoriza crear recursos ni migrar producción ahora.

### D14 — Operación privada, privacidad y gates de producción

Trabajo:

- [ ] Completar el borrado y la retención reconciliados con jobs, evidencias, propuestas, aprobaciones y ejecuciones, incluyendo borrado permanente de aplicaciones/espacios de trabajo con Owner y step-up reciente. **Parcial implementado:** retención configurable por espacio para instantáneas, imágenes, informes, observaciones, ejecuciones, entregas y eventos de protección; un job durable del coordinator purga por lotes, conserva fuentes aún usadas y consume aprobaciones/pruebas e invalida propuestas cuyos candidatos pierden su fuente. Las auditorías de purga guardan sólo conteos y no copian source. Pruebas Postgres reales cubren defaults/roles, fuente en uso y rechazo de aprobación obsoleta; falta la eliminación permanente y ampliar cobertura de purga a cada categoría.
- [ ] Resolver límites de retención antes de llamar al monitoreo continuo: hoy 1.000 runs/app detienen programación; 2.000 observaciones/app, 100 nuevas/día y 100 planes/app son cuotas finitas. Mostrar consumo y degradación y probar que una proyección sin cupo no bloquea detecciones aceptadas.
- [x] Entrega externa básica por SMTP/webhook sustituible: prueba de contacto, outbox durable, idempotencia estable, retry acotado, estado de entrega y dead letter; webhook HTTPS con firma y defensa SSRF. La entrega no equivale a lectura humana y una caída completa del coordinador retrasa la salida externa.
- [ ] Añadir verificación de destinatarios, rotación de secretos, escalamiento y watchdog independiente; probar recuperación y disponibilidad con proveedores externos.
- [x] Completar invitaciones de un solo uso y siete días, roles, baja y salida de miembros. PostgreSQL impone límites por espacio, último Owner y consumo atómico; cada cambio se audita. Una revocación o democión a Viewer invalida verificaciones de segundo factor y aprobaciones pendientes en la misma transacción. El executor vuelve a comprobar la membresía antes de reclamar y antes de I/O.
- [ ] Completar la revocación de integraciones y MFA. No exponer registros privados de checkpoint o credenciales.

Las invitaciones se vinculan al correo normalizado de la cuenta y el token sólo se almacena como SHA-256. El registro de cuentas locales todavía no verifica el correo; por tanto, esta unión es defensa en profundidad y no prueba control del buzón. El enlace se muestra una sola vez; la entrega por correo no está configurada.
- [ ] Preparar identidad fuera de dev, TLS de cada frontera, actualizaciones de perfiles/imágenes, secretos fuera de logs, backups externos cifrados y restauración probada con freeze de escrituras.
- [ ] Medir capacidad, equidad entre organizaciones, retrasos de entrega, coste por run y storage. Conservar carriles reservados para monitoreo determinista frente a investigaciones y validaciones lentas.
- [ ] Presentar datos salientes al modelo, consentimiento, retención y borrado incluyendo backups. Redacción automática reduce riesgo pero no garantiza ausencia de información sensible.

**Aceptación:** alcanzar cuotas durante un incidente sin perder trabajo ya aceptado; borrar/desconectar/cancelar; restore real de datos aislados; aprobación anterior a restore rechazada; alertas retrasadas/duplicadas; fairness; perfil de producción incompatible falla cerrado. AWS sigue siendo destino configurable, no una garantía establecida por mocks de Pulumi.

### D15 — Evaluación, interfaz y demostración repetible

Trabajo:

- [x] Construir una matriz versionada de escenarios con verdad conocida, controles negativos y un conjunto separado no usado para ajustar reglas. Se etiquetaron impacto/causas y límites antes de ejecutar el correlador. Matriz v1.0.2: tuning y holdout independientes, 14 casos/split y 5 repeticiones/caso; no evalúa reparaciones verificadas y el holdout no se usó para ajustar reglas.
- [x] Medir precisión/recall por escenario, falsas alarmas por app/ventana, abstención, errores de confianza, demora hasta alerta y decisión, runtime, coste/tokens y cobertura. Reportar denominadores y fallos en [triage-evaluation.md](triage-evaluation.md) y el JSON por ensayo. El camino determinista usó 0 llamadas/tokens; la reparación verificada y regresiones de reparación siguen sin medirse.
- [ ] Medir tiempo hasta reparación verificada y regresiones de reparación sobre cambios reales y aislados.
- [ ] Comparar reglas solas, reglas+contexto y reglas+agente; medir aporte incremental de la IA. Para comparar con competidores usar el mismo caso autorizado y condiciones reproducibles, sin inventar sus resultados.
- [x] Fijar antes del holdout los umbrales medidos de recall de causa, error de confianza, falsas alarmas del control de tráfico y p95 de decisión. El holdout pasó esos cuatro umbrales; el recall de alertas se informa sin umbral de aceptación (96.3%, 77/80). Los gates de seguridad y autorización de extremo a extremo siguen pendientes.
- [ ] Validar en navegador el recorrido sin comandos: conexión → cobertura → incidente/reporte → opciones → candidato → pruebas → aprobación → PR → entrega → resultado. Mostrar bloqueos y estados loading/empty/error/partial/uncertain.
- [x] Verificar que severidad y confianza son campos distintos, que impacto no se confunde con confianza de hipótesis y que provider execution permanece deshabilitado durante esta evaluación.
- [ ] Representar y medir explotabilidad como dimensión propia, distinta de severidad, confianza, impacto y permiso. Resolver una alerta por triage no certifica que desapareció el problema.

**Aceptación:** informe reproducible con commit, dataset, versiones, comando y tipo de evidencia; fallos también publicados en el registro interno. El número de herramientas conectadas no es una métrica de resultado defensivo.

**Medición D15 (24-10-2026):** `pnpm eval:triage`, matriz v1.0.2 y commit medido `8fb44603be5ca7a65e8b5f8486529ee103082965`. Con 70 ventanas de tuning y 70 de holdout: holdout alertas P/R 100%/98.8% (79/79/80), causas P/R 100%/100% (25/25/25), falsas alarmas 0/70, confianza 1/85 errores, impacto 0/70 errores, cobertura desconocida visible 10/10, decisión p50/p95 228/2637 ms y runtime p50/p95 261/2664 ms. Pasaron los umbrales fijados de causa, confianza, control negativo y demora; la corrida final omitió `runtime.resources.v1` en 1/5 repeticiones holdout de presión CPU. Dos lecturas holdout anteriores del mismo código de detectores registraron, por separado, una omisión de event-loop entre 5 y tres omisiones de la regla CPU en 5; los resultados y denominadores no se combinan ([detalle](triage-evaluation-holdout-repeat-v1.0.2.json)). La corrida usó app demo, PostgreSQL/Redis y coordinador reales locales, pero proveedores/HTTPS fueron fixtures; no es evidencia de precisión de producción. Sin UI, reparación, explotabilidad representada, proveedor real ni capacidad representativa.

### D16 — Phishing, deepfakes y operaciones de influencia

Estas funciones no se derivan de tener Semgrep o un LLM. Requieren un módulo de defensa informacional independiente y no entran en las primeras entregas.

- [ ] **Phishing:** ingestión opt-in de mensajes/URLs, MIME y adjuntos acotados, autenticación del conector y manejo seguro de contenido; distinguir cabeceras de autenticación confiables de texto aportado por el remitente. No abrir enlaces ni descargar adjuntos automáticamente en la red del control plane. Resultado con evidencia y cuarentena sólo mediante capacidad autorizada.
- [ ] **Deepfakes:** evaluación de procedencia y señales de manipulación, consentimiento y política de datos biométricos, datasets representativos y abstención. Antes de elegir bibliotecas, investigar estándares de procedencia y sus límites. Falta de metadatos no demuestra falsedad; procedencia válida tampoco demuestra verdad del contenido.
- [ ] **Influencia/suplantación:** empezar por dominios y marcas autorizadas, reportes de suplantación y agrupación con fuentes verificables; no clasificar opiniones como ataques ni atribuir campañas a una IA sin evidencia independiente.
- [ ] Crear contratos, retención, revisión humana, umbrales y pruebas propios. No automatizar borrado público, acusaciones, denuncias o comunicaciones externas por una puntuación.

**Aceptación:** corpus benigno/adversarial, falsos positivos medidos, revisión humana y datos sensibles minimizados; evaluación especializada y controles de abuso antes de exponer acciones. No anunciar cobertura general de ataques asistidos por IA hasta contar con estas pruebas.

## 7. Contratos, persistencia y evolución

Las entidades ya implementadas y las propuestas pendientes se distinguen aquí:

- **Contexto:** servicios/entornos, enlaces de repositorio y despliegue, relaciones de dependencia y evidencia de vinculación.
- **Triage:** revisión de incidente con hipótesis, impacto observado, contradicciones, evidencia, freshness y versión de reglas.
- **Corrección:** candidato con source/report/finding, receta, base/tree/patch, integridad y perfil de validación.
- **Validación (implementada localmente):** `validation_runs`, suites versionadas por repositorio, attestations Ed25519 inmutables por tipo, proyección pública de “reanálisis objetivo” y “suite”, y worker con rol/lease/quarantine propios. El perfil sigue fijo a `node24-npm-test`; no hay fuzzing ni perfiles adicionales.
- **Acción v2:** unión discriminada para PR de dependencia, patch admitido, merge, deploy y respuesta de proveedor; cada variante exige sus propios campos y capacidad.

El flujo objetivo es candidato → validación → propuesta elegible → aprobación exacta → ejecución → comprobación de resultado. Estados alternativos explícitos: rechazado, obsoleto, expirado, cancelado, fallido, inconcluso y pendiente de reconciliación. No comprimir todas las etapas en `success` ni inferirlas de un checkbox.

Aplicar migraciones aditivas y compatibilidad de lectores/jobs en vuelo. El servidor calcula hashes normalizados; aprobar una versión no aprueba la siguiente. Un restore cambia epoch e invalida permisos anteriores. Los clientes reciben sólo proyecciones públicas; source, patch privado, credenciales y resultados sensibles no deben salir en respuestas de estado ordinarias.

Las rutas adaptan servicios backend tipados; validación expone configuración de suite por aplicación y lectura de estado por candidato. La cola duradera transporta referencias y las tareas largas se ejecutan fuera del HTTP request. Las proyecciones omiten snapshots y contenido de código.

## 8. Recorrido de interfaz que debemos completar

1. **Conectar:** empresa/aplicación, fuente o repositorio, entorno, target verificado y telemetría; se puede continuar con fuentes parciales y límites visibles.
2. **Entender:** “qué observamos”, “qué puede explicarlo”, “qué no comprobamos” y efecto sobre servicios/rutas verificadas. Línea de tiempo de cambios y evidencia.
3. **Elegir:** opciones compatibles con el proyecto, riesgos de actuar/no actuar, requisitos, alcance y coste conocido/desconocido. Las opciones sin adaptador se muestran como guía, sin botón que finja ejecución.
4. **Preparar y comprobar:** copia privada, cambios sanitizados, progreso de rescan y pruebas, resultado de cada validación y nuevas alertas.
5. **Autorizar:** MFA y resumen del cambio exacto. PR, merge y deploy tienen acciones separadas. Los botones reflejan rol, frescura y capacidad efectiva del servidor.
6. **Seguir el efecto:** estado remoto y evidencia de verificación; fallo parcial o incierto con siguiente paso seguro. Revertir sólo si las condiciones siguen aplicando.

La navegación debe conservar el contexto de la app, admitir acceso no técnico y evitar exigir copiar comandos. Un control deshabilitado debe decir qué requisito falta y cómo resolverlo. El servidor vuelve a verificar todo aunque el botón parezca habilitado.

## 9. Historia de demostración y diferenciación medible

Demostrar tres situaciones comparables con la misma aplicación y permisos normales:

1. **Proveedor con incidente, app sana en los puntos observados:** registrar el feed simulado como tal, comprobar rutas y señales y concluir que no se observó impacto allí. No proponer migración automática.
2. **Proveedor sano, app con errores tras un release:** mostrar relación temporal, evidencia de ruta/dependencia y explicaciones alternativas. No declarar causa del despliegue sin comprobación adicional.
3. **Proveedor con incidente y fallos compatibles en la app:** relacionar dependencia configurada, errores firmados y probes/controles. Separar impacto observado de atribución probable; mostrar qué evidencia falta para mayor certeza.

Después, un caso de reparación independiente: hallazgo real de código/dependencia → candidato privado → regresión y suite/rescan → MFA → PR exacto → despliegue local autorizado → verificación, y rollback si se induce una regresión. No utilizar un patch irrelevante como solución ficticia a una caída de proveedor.

Incluir un camino de fallo visible: telemetría vieja, instrucciones maliciosas en un log, base cambiada tras aprobación o resultado remoto incierto. La buena respuesta es abstenerse, invalidar o reconciliar sin ampliar permisos.

El demo no requiere incidentes de proveedores reales ni producción; sí requiere servicios reales de Gotchu, persistencia, red local, firmas y recorrido de navegador. Distinguir fixtures de feed/DNS, herramienta real, VM real y proveedor real en cada evidencia.

## 10. Comprobaciones y evidencias para cerrar cada entrega

Usar scripts existentes; no ejecutar instalaciones o builds innecesarios durante una revisión documental. Para implementación futura, comenzar por los paquetes afectados y ampliar al cambiar contratos compartidos:

```sh
pnpm --filter @gotchu/contracts build
pnpm --filter @gotchu/backend typecheck
pnpm --filter @gotchu/coordinator typecheck
pnpm --filter @gotchu/web typecheck
pnpm --filter @gotchu/database test:postgres
pnpm --filter @gotchu/executor test:postgres
pnpm --filter @gotchu/coordinator test:live
pnpm test:integration
GOTCHU_TEST_SCANNERS=1 pnpm test:integration test/integration/customer-applications.test.ts
pnpm build
pnpm typecheck
pnpm test
```

Estos comandos no prueban automáticamente las capacidades nuevas. Añadir suites de correlación, VM, validación, MFA y proveedor cuando existan; sus scripts todavía no están definidos. Actualizar CI para que un gate requerido no pase silenciosamente con todos sus casos omitidos.

Registrar por entrega:

- Unitarias/schema: estados, canonización, campos inválidos, compatibilidad y escenarios negativos.
- Postgres real con roles runtime: tenant, FKs, revocación, concurrencia, cuotas, rollback y caducidad.
- Redis/HTTP/procesos reales: outbox, publicación repetida, pérdida/reinicio de transporte, leases y resultado atómico.
- TLS/DNS/red: autorización, cambios de target, límites, SSRF, redirects y cancelación con cleanup.
- VM real: aislamiento y pruebas del cliente, sin sustituirla por mocks o containers.
- Repositorio/proveedor real controlado: PR y reconciliación; separar este resultado del ledger con proveedor fixture.
- Navegador: registro/login, permisos, carga/error, evidencia, aprobación y acciones inversas.
- Recuperación: backup/restore aislado, freeze y rechazo de permisos anteriores; RPO/RTO medidos.

Guardar commit, entorno, comandos, resultados, skips, recursos temporales y limitaciones en [validation.md](validation.md). No sumar suites solapadas como si fueran muestras independientes. Parar y limpiar sólo los procesos/recursos propios.

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
