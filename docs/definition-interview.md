# Definición del producto

## Alcance acordado

La referencia vigente es `main` en `26162b7`, con el [PR 25](https://github.com/0bkevin/gotchu/pull/25) integrado. Se mantienen sus funciones implementadas; las propuestas adicionales de la entrevista original se reúnen en [Roadmap](roadmap.md).

Gotchu permite revisar aplicaciones autorizadas desde su código, su origen HTTPS o ambas perspectivas, consultar evidencia y preparar cambios revisables. La aplicación ficticia vulnerable/corregida es un fixture de regresión, no el producto ni un límite para las aplicaciones del cliente.

## Funciones que se mantienen

- Registro e inicio de sesión con Auth.js; espacios de trabajo, roles, miembros e invitaciones.
- Proyectos con onboarding desde una web HTTPS, carpeta de código o repositorio GitHub opcional; fuentes y contexto por aplicación.
- Auditorías internas, externas y combinadas; progreso por fases internas/externas, correlación e informe, con aviso cuando el scanner deja de informar.
- Semgrep, Gitleaks, Trivy y consultas OSV configurables; inventario de dependencias, licencias declaradas, SBOM e imágenes dentro de los perfiles admitidos.
- Informes persistidos con evidencia, severidad, confianza, explotabilidad y cobertura; resúmenes del proyecto y prompt copiable por hallazgo para un asistente de código.
- Vigilancia periódica, eventos firmados, protección Node optativa, alertas e incidentes con revisiones de triage.
- Notificaciones por email y webhook, con entrega durable, reintentos y estado visible.
- Investigación y corrección con IA opcional, con proveedor configurado, consentimiento y presupuesto; candidatos privados y reanálisis independiente.
- Correcciones compatibles de código y dependencias npm, suites de validación configuradas y PR en borrador por executor independiente tras aprobación exacta del Owner.
- Historial de decisiones, retención y backup/restore; autoalojamiento y herramientas de desarrollo local.

Las condiciones y los límites están en el [estado de implementación](implementation-plan.md), [operaciones](operations.md) y [self-hosting](self-hosting.md). Una función presente en el repositorio requiere sus servicios y permisos para estar disponible en una instalación.

## Decisiones de arquitectura y permisos

TanStack Start, React, Auth.js, TypeScript estricto y pnpm son las elecciones actuales. Los contratos de runtime pertenecen a paquetes compartidos; los servicios de dominio permanecen fuera de las rutas. Postgres es la autoridad durable, Redis/BullMQ entrega trabajo y los procesos independientes ejecutan tareas persistentes.

La sesión del servidor determina la identidad. Membresía, roles y RLS acotan los datos de cada workspace. La evaluación externa no requiere código y se limita al origen/perfil solicitado; la solicitud no prueba propiedad del dominio. No hay desafío DNS TXT de onboarding.

La evaluación estática no ejecuta código del cliente. Las suites de validación son una ruta aparte, condicionada al runner y a su aislamiento; no se permite trasladar esas pruebas al host por falta del runner. Un reanálisis sin hallazgos y una suite seleccionada tienen alcances diferentes.

La aprobación de PR usa la sesión autenticada del Owner y el hash del cambio exacto. El segundo factor fue retirado del flujo de cliente. Se mantienen la concesión de escritura por repositorio, la validación independiente, la frescura de la base, la caducidad, el consumo único y la comprobación del executor. La severidad y el modelo no conceden permisos.

## Current user correction: actual customer application in development

La corrección del 24 de octubre de 2026 establece que Gotchu es la aplicación real del cliente y que el demo es solo un fixture. Se conserva este encabezado para los enlaces históricos. El alcance actual lo fija la revisión de `main` y del PR 25 descrita arriba; las hipótesis de piloto y las ampliaciones anteriores están en el roadmap.

Esta revisión es documental y de presentación. No autoriza operaciones cloud, publicación ni cambios en las aplicaciones de los clientes. El despliegue AWS y la CI/CD de GitHub se retiraron posteriormente por petición del operador; véase el [registro de retirada](../infra/aws/README.md).
