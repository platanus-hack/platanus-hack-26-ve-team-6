# Roadmap

Este documento reúne propuestas y trabajo futuro. No amplía las funcionalidades actuales ni autoriza su implementación, publicación o despliegue.

La base acordada es `main` en `26162b7`, que integra el [PR 25](https://github.com/0bkevin/gotchu/pull/25). El alcance vigente está en el [README](../README.md) y el [estado de implementación](implementation-plan.md). Las notificaciones por email/webhook, las investigaciones y correcciones con IA opcional, y los PR en borrador tras aprobación exacta **ya están implementados**; no son pendientes de este roadmap. Su disponibilidad depende de los servicios y permisos configurados en cada instalación.

## Consolidación de los planes anteriores

Sustituye los backlogs de `pendientes.md`, `plan-defensa-autonoma.md` y `paridad-snyk-aikido.md`, y las propuestas de expansión de la entrevista original. Se conserva aquí el trabajo que excede el producto actual, sin reutilizar estados antiguos que quedaron obsoletos al integrar el PR 25.

Los identificadores D01–D16 se conservan para relacionar decisiones históricas. No representan dieciséis entregas pendientes: contexto, triage, runner, validación, candidatos npm, aprobación, executor e investigación ya tienen implementación.

## Ampliaciones de cobertura

- **Activos y despliegues (D01):** vinculación verificable repositorio–commit–artefacto–despliegue; materialización de despliegues desde evidencia confiable; varios orígenes/API por entorno y descubrimiento de candidatos. Descubrir un activo no concede permiso para evaluarlo.
- **Scanners y escenarios (D02/D12):** más lenguajes, reglas y ecosistemas; detección de paquetes maliciosos y análisis más profundo de dependencias. Ampliar el corpus y medir precisión antes de anunciar cobertura.
- **Imágenes:** registros privados y archivos mayores que los límites actuales, con credenciales efímeras y coste medido. Las entradas actuales por digest público y archivo acotado se mantienen.
- **Correcciones de dependencias (D06):** parches transitivos, workspaces, pnpm/Yarn y cambios major. Detectar sus lockfiles actualmente no implica poder corregirlos de forma automática.
- **Pruebas activas:** DAST autenticado en staging, permisos por ruta/método, credenciales de prueba y parada segura. El perfil HTTP `api_checks` actual ya descubre OpenAPI y observa protocolos; no es este DAST.
- **Laboratorio de explotación (D04/D05):** apps Node y canarios dentro de una VM aislada, sin salida al host; reproducir una condición en la base y comprobar el candidato. Requiere un perfil de arranque, red interna y payloads versionados. No reproducir un caso conserva la explotabilidad como desconocida.
- **Fuzzing y perfiles de validación (D05):** corpus, harnesses y stacks adicionales. Las suites y selecciones Node actuales siguen teniendo el alcance firmado por su perfil.

## Integraciones adicionales

- **GitHub por push:** receptor autenticado, protección contra repetición y deduplicación para complementar las revisiones periódicas actuales.
- **CI/CD e IDE:** GitHub Checks, integración de IDE y presentación de resultados en el flujo de desarrollo.
- **Colaboración:** Slack, tickets en Jira/Linear y escalamiento de responsables. Email y webhook actuales continúan disponibles.
- **WhatsApp:** adaptador de la plataforma oficial, verificación del número, consentimiento y plantillas. Una respuesta nunca concede aprobación de escritura.
- **MCP de Gotchu:** lectura de informes, hallazgos y alertas y solicitudes acotadas de análisis con autorización por workspace. La publicación conserva la aprobación exacta del Owner.
- **Postura cloud (CSPM):** conectores de recursos del cliente, comenzando por AWS, con alcance y permisos propios. Alojar Gotchu en AWS o leer un feed público no inspecciona la cuenta cloud del cliente.
- **Identidad:** vinculación explícita de proveedores a una cuenta existente y entrega de invitaciones por email. La gestión actual de miembros/invitaciones y los proveedores configurables no se vuelven a proponer como funciones nuevas.
- **Cumplimiento y comercialización:** informes específicos de cumplimiento, medición comercial, precios y facturación. Un SBOM o una política de licencias declaradas no certifica cumplimiento.

## Acciones posteriores al PR (D10/D13)

Merge, deploy, rollback, contención, cambios de capacidad, migración y recuperación de proveedores quedan fuera del producto acordado. Los contratos o planes de preparación existentes no habilitan su ejecución.

Cada acción necesita un adaptador independiente, precondiciones verificables, autorización específica, límites, reconciliación de resultados inciertos y comprobación del resultado. La aprobación de un PR nunca autoriza merge ni despliegue. Empezar cualquier comprobación en un entorno aislado autorizado; una mayor severidad no amplía permisos.

## Operación y calidad pendientes (D14/D15)

Son mejoras o verificaciones de capacidades actuales, no nuevas promesas del producto:

- Medir capacidad, equidad entre organizaciones, latencia, precisión y falsas alarmas con entradas representativas; separar fixtures, servicios locales y proveedores reales.
- Completar recuperación de un host limpio y medir pérdida de datos y tiempo de recuperación. El backup local y las copias S3 documentadas no equivalen a failover ni a un RPO/RTO garantizado.
- Añadir un watchdog independiente del coordinator; verificar destinatarios de email y rotación con solapamiento de secretos de webhook. La entrega durable actual ya existe.
- Borrado permanente de aplicaciones/workspaces y ciclo de privacidad que incluya copias existentes; conservar retención y archivado actuales.
- Revisar revocación inmediata de autorizaciones y comportamiento con múltiples procesos. El segundo factor fue retirado del flujo de cliente; no es un requisito pendiente de aprobación.
- Ampliar pruebas reales de proveedores de modelos con clave API, renovación de sesiones y coordinación entre réplicas. Las credenciales de modelo excluidas del backup deben reconectarse tras restaurar.
- Verificar por separado la topología alojada: disponer del código de gateway/worker/validator/executor no demuestra que estén activos en el host publicado.
- Diagnosticar el fallo histórico de limpieza del scanner y observar cierre de trabajos revocados. Una recuperación por reinicio no demuestra una corrección; el estado de cuarentena debe conservarse.
- Revisar textos en español, errores de autenticación y scanner, navegación y accesibilidad con el cliente real.
- Medir el aporte incremental del modelo y el tiempo hasta una reparación verificada; ampliar la evaluación del triage y revisar las omisiones intermitentes registradas de CPU/event loop.

Los antiguos pendientes de progreso interno/externo y de aviso por falta de noticias del scanner se retiran: el PR 25 ya los implementa. Las mejoras futuras parten de ese comportamiento.

## Defensa informacional (D16)

Phishing, deepfakes, suplantación y campañas de influencia serían un módulo separado. Requieren entradas autorizadas, conectores, contratos, política de datos sensibles, corpus benigno/adversarial, revisión humana y mediciones propias. No se derivan de disponer de scanners de código o de un modelo. No automatizar acusaciones, denuncias o comunicaciones públicas a partir de una puntuación.

## Criterios para incorporar una propuesta

1. Confirmar el problema y autorizar el alcance concreto.
2. Definir entradas, estados, permisos, límites, cancelación y resultados inciertos.
3. Implementar y comprobar productores, consumidores y acciones inversas.
4. Registrar evidencia, comandos, entorno y limitaciones; un mock no sustituye una prueba real.
5. Actualizar documentación y landing solo cuando la capacidad esté disponible bajo condiciones explícitas.

Los objetivos históricos de piloto (cinco organizaciones, diez aplicaciones, tasas de eventos, presupuesto de USD 250/mes y recuperación de 15 minutos/4 horas) fueron hipótesis de planificación, no compromisos vigentes ni medidas de producción. Cualquier objetivo nuevo requiere acuerdo y verificación. La comparación comercial anterior con Snyk/Aikido tampoco demuestra paridad, exclusividad o superioridad.
