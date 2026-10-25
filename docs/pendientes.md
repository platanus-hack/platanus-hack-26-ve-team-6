# Pendientes

Estado al 24 de octubre de 2026. Lista viva de lo que falta, ordenada por prioridad. El detalle de cada entrega D01–D16 está en el [plan de defensa autónoma](plan-defensa-autonoma.md); la comparación con competidores, en [paridad Snyk/Aikido](paridad-snyk-aikido.md). Al cerrar un punto, muévelo al plan con su evidencia y bórralo de aquí.

## 1. Núcleo

Cerrado el 24 de octubre de 2026 en `89c4df4`. El executor y D12 están integrados, con PRs reales de corrección de código (#36) y de dependencia npm (#37) verificados en el sandbox. El instalador arranca con todos los servicios y el historial de commits está extendido hasta la integración. Lo que sigue abierto está en las secciones siguientes.

## 2. Al pasar a producción y al final

Acordado el 24 de octubre de 2026: no bloquean el cierre del núcleo.

- **Recorrido completo en navegador real, ya en producción.** Recorrer y corregir todo el flujo: inicio de sesión con Google o GitHub → conectar repo o subir código → escaneo → informe → recomendación → candidato → validación → aprobación con WebAuthn → PR real → vigilancia y alertas. Incluye `./gotchu backup` y `./gotchu restore` con la topología de procesos en el host.
- **Pasada de textos.**
  - La interfaz debe estar entera en español; hoy hay recomendaciones en inglés.
  - Al superar el límite de 5 intentos de inicio de sesión por cuenta cada 15 minutos, mostrar el mensaje real del límite: el flujo de credenciales de Auth.js descarta el 429 y dice que el correo o la contraseña no son correctos.
  - Traducir los aproximadamente 330 mensajes de error del backend; `customer-client.ts` solo traduce los códigos de los flujos principales.
  - Traducir los títulos y las recomendaciones de hallazgos generados por los escáneres.
- **Dividir `customer-dashboard.tsx`.** Las rutas por sección ya conservan el marco y cada sección tiene su URL, pero las consultas del proyecto y el contenido de cada sección siguen en ese archivo (~1.080 líneas). Moverlos a un proveedor del proyecto y a componentes por sección.
  - Corregir "Protege lo que construyes" en el dashboard.
  - Corregir "continuous monitoring" en el README; son revisiones periódicas.
  - Traducir la página de cierre de sesión de Auth.js.
  - Mostrar el nombre en el avatar.
  - Cada afirmación debe estar respaldada por evidencia.

## Errores y verificaciones abiertas

Se encontraron durante la integración del 24 de octubre de 2026 y quedan para resolver después.

- **Escáner bloqueado tras un fallo de limpieza.** Al arrancar un entorno nuevo, el escáner quedó en `fault` tras un error de limpieza y respondió 503 a todas las evaluaciones, sin escribir nada en su log, hasta reiniciarlo. El coordinator solo registra `assessment_reconciliation_required`, sin la causa. Falta registrar la causa en ambos y recuperarse sin reinicio manual.
- **Vigilancia de repositorios por push.** Las revisiones son periódicas (mínimo cada hora); falta un receptor de webhooks de GitHub para revisar al hacer push, con verificación de firma y protección contra repetición. Necesita una URL pública.
- **Correcciones y PRs con repos conectados por la GitHub App.** La vigilancia ya los usa, pero las correcciones exigen vínculos de fuente verificados (los de la App quedan `declared`) y los lectores de acciones y del executor solo aceptan entradas del catálogo del operador. Las puertas de escritura siguen cerradas.
- **Detección de cambios de GitHub en vivo.** La lectura, OSV y CISA KEV se probaron en vivo con el repositorio sandbox; el diff entre dos commits reales de GitHub solo está cubierto por pruebas con repositorios Git locales.
- **WebAuthn en vivo.** El circuito "Aprobar PR" se probó con aserciones WebAuthn de fixture. Falta registrar una llave real y aprobar con ella.
- **Proveedores LLM con clave API.** Claude Code y Codex con suscripción ya funcionan en vivo de punta a punta (ver [validación](validation.md)). Los presets con clave API, OpenRouter incluido, sólo se verificaron con un servidor HTTPS simulado. xAI documenta Chat Completions como legado y la capa OpenAI-compatible de Gemini sigue en beta.
- **Renovación de la sesión de Codex.** El gateway guarda el `auth.json` que Codex rota y serializa las llamadas que comparten sesión; está cubierto con un CLI simulado, pero aún no se observó una rotación real (Codex renueva cada ~8 días).
- **Sesión de Codex con varias réplicas.** Si varias réplicas del gateway comparten un login de Codex, necesitan un bloqueo entre procesos o escrituras de secretos con compare-and-swap; el bloqueo actual sólo serializa dentro de un proceso.
- **Credenciales de modelo en copias.** `./gotchu backup` no incluye `.gotchu/model-secrets`; tras restaurar, la configuración queda "Disponible" pero cada llamada falla hasta volver a pegar la credencial.
- **Investigación en AWS.** El runtime desplegado no ejecuta todavía gateway ni worker, ni tiene instalados los CLI `claude` y `codex`.
- **Atestaciones del validator y scanners de la prueba D06.** En la prueba en vivo del PR de dependencia, las atestaciones de validación del parche de código y los scanners que no son npm fueron fixtures.
- **Readiness del scanner.** La falta de la base de Trivy para imágenes bloqueaba la readiness completa. Ya se refresca en cada `./gotchu up`. Queda por decidir si la falta de un perfil opcional debe degradar la cobertura en lugar de bloquear el arranque.
- **Integración de streams paralelos.** Al integrar quedaron imports duplicados y fixtures desactualizados; ya están corregidos. Conviene que cada agente compile la rama integrada antes de entregar.

- **Progreso en vivo por rama del grafo de fases.** El grafo de la evaluación solo muestra lo que observa el coordinator: cola, validación y la llamada al scanner como una sola fase. Para ver por separado el análisis interno, el externo y la correlación, el scanner debe enviar eventos de progreso firmados durante la ejecución y el coordinator guardarlos bajo la misma reserva. Hasta entonces, si el scanner falla no se sabe qué rama falló.
- **Trabajo sin noticias del scanner.** Si el proceso cae a mitad del análisis, la reserva dura 300 s y el grafo sigue mostrando "Análisis" en curso todo ese tiempo. Mostrar "sin noticias del analizador" al pasar el plazo de 55 s del motor.

## 3. Seguridad y operación (D14, resto)

- **Revocación inmediata (D14).** Protege la garantía central: nada se escribe sin una aprobación exacta y vigente. Desconectar GitHub, rotar la firma de eventos, borrar un canal de notificación o quitar una llave WebAuthn (por ejemplo, tras perder el dispositivo) debe cancelar en la misma operación las aprobaciones pendientes y las pruebas de segundo factor, y quedar en el historial de decisiones. Hoy una aprobación previa podría seguir vigente y ejecutarse después.
- **Borrado permanente (D14).** Hoy sólo se puede archivar. Los clientes necesitan borrar del todo aplicaciones y espacios de trabajo por privacidad, cierre de cuenta o GDPR. Debe exigir un Owner y segundo factor reciente, para que un error o una sesión robada no borre todo, y quedar auditado.
- Confirmar el destinatario de email antes de enviar.
- Rotar el secreto de webhook con una ventana de solapamiento.
- Añadir un watchdog independiente del coordinator.
- Copias fuera del host y retención de copias; RPO/RTO medidos.
- Identidad, TLS y capacidad de producción. El despliegue en `gotchu.kevinbravo.com` queda fuera de alcance hasta pedirlo.

## 4. Entregas del plan

- **D10 — Merge, deploy y rollback** como capacidades separadas, empezando por un entorno de desarrollo aislado.
- **D11 — Agente investigador.**
  - Llevar los candidatos sugeridos por la IA a la validación D05 y a la política humana; hoy quedan inertes.
- **D13 — Endurecimiento, capacidad y recuperación.** Casi todo depende de una nube real; preparar los contratos sin crear recursos.
- **D15 — Evaluación.**
  - Medir el tiempo hasta una reparación verificada.
  - Comparar reglas solas frente a reglas con IA.
  - Medir la explotabilidad como dimensión propia.
  - Corregir la omisión intermitente del detector de CPU; no se corrigió para no ajustar el detector con datos del holdout.
- **D16 — Phishing, deepfakes e influencia.** Módulo separado; va al final.

## 5. Paridad con Snyk/Aikido que aún no existe

- Checks de PR en CI/CD (GitHub Checks).
- Slack y escalamiento.
- Tickets en Jira o Linear.
- Escaneo de APIs (OpenAPI).
- Detección de paquetes maliciosos.
- Postura cloud (CSPM).
- Extensión de IDE.
- Informes de cumplimiento.
- Precios, medición de uso y facturación.

## 6. Integraciones futuras

- **Servidor MCP de Gotchu.** Exponer a asistentes y agentes de IA (Claude, Codex, IDEs) herramientas acotadas por espacio de trabajo: consultar informes, hallazgos, alertas y su estado, y pedir un análisis. Todo con las mismas autorizaciones del servidor. Las acciones que escriben (aprobar, PR) siguen exigiendo la aprobación exacta del Owner con segundo factor, nunca desde el MCP.
- **Integración con WhatsApp.** Canal de notificaciones para alertas, "Vigilancia detenida" y resultados de análisis, junto al email y el webhook existentes. Debe usar la WhatsApp Business Platform oficial mediante un adaptador sustituible, con verificación del número, consentimiento explícito y plantillas aprobadas. Una respuesta por WhatsApp nunca debe conceder permisos de acción.

## 7. Al final: laboratorio de explotación en sandbox

Decisión del 24 de octubre de 2026: el primer mecanismo de pruebas activas será un laboratorio dentro del runner Firecracker existente. El DAST contra un staging del cliente queda para una segunda fase.

**Por qué:**
- Convierte un hallazgo de "explotabilidad desconocida" en evidencia: la explotación se reproduce en la base y se bloquea en el candidato.
- Esa evidencia viaja al PR.
- El riesgo para los entornos del cliente es nulo.
- Extiende el validator D05 sin crear un sistema nuevo.

El DAST contra staging es paridad con Aikido/Snyk, pero exige sesión autenticada, límites de tasa, payloads no destructivos y consentimiento por alcance.

**Primer alcance:**
- Apps Node que arrancan solas dentro de la microVM, sin red hacia afuera.
- Un atacante y un servicio canario dentro de la misma red aislada de la VM.
- Reproducir los tipos que Gotchu ya detecta: inyección de código por `eval`, SQLi, path traversal, inyección de comandos y SSRF hacia el canario.
- Ejecutar sobre la base y sobre el candidato; el resultado se firma en las validation facts y se muestra en el informe y en el PR.
- Sin exploits publicados ni ejecución fuera de la VM.
- "No reproducido" sigue siendo desconocido, no seguro.

**Prerrequisitos:**
- Perfil de runner para arrancar la app (hoy sólo existe `node24-npm-test`).
- Red interna entre VMs o contenedores dentro del sandbox sin salida al host.
- Payloads versionados y reglas de canario.
- Revisión de seguridad del aislamiento: hoy bwrap con systemd en desarrollo; el *jailer* en producción.
