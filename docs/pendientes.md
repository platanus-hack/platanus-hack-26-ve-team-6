# Pendientes

Estado al 24 de octubre de 2026. Lista viva de lo que falta, ordenada por prioridad. El detalle de cada entrega D01–D16 está en el [plan de defensa autónoma](plan-defensa-autonoma.md); la comparación con competidores, en [paridad Snyk/Aikido](paridad-snyk-aikido.md). Al cerrar un punto, muévelo al plan o al registro de [validación](validation.md) con su evidencia y bórralo de aquí.

## 1. Núcleo: terminar antes de cualquier capacidad nueva

- **Integrar el executor con D12.** Integrar el worker independiente, el registro de políticas, los permisos de escritura verificados (migración 038) y la alcanzabilidad de dependencias (migración 043) sobre la topología nueva del instalador. Falta la prueba en vivo de un PR de dependencia npm en el sandbox; el PR de corrección de código ya se probó.
- **Historial de commits.** Actualizar `commit-history*.md` y documentar las excepciones de tamaño: `lockfiles.ts` (501 líneas) y el gateway de D11 (445 líneas).

## 2. Al pasar a producción y al final

Acordado el 24 de octubre de 2026: no bloquean el cierre del núcleo.

- **Recorrido completo en navegador real, ya en producción.** Recorrer y corregir todo el flujo: inicio de sesión con Google o GitHub → conectar repo o subir código → escaneo → informe → recomendación → candidato → validación → aprobación con WebAuthn → PR real → vigilancia y alertas. Incluye `./gotchu backup` y `./gotchu restore` con la topología de procesos en el host.
- **Pasada de textos.**
  - La interfaz debe estar entera en español; hoy hay recomendaciones en inglés.
  - Corregir "Protege lo que construyes" en el dashboard.
  - Corregir "continuous monitoring" en el README; son revisiones periódicas.
  - Traducir la página de cierre de sesión de Auth.js.
  - Mostrar el nombre en el avatar.
  - Cada afirmación debe estar respaldada por evidencia.

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
  - Ejecutar en vivo con al menos un proveedor; los presets sólo se verificaron con un servidor simulado.
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
