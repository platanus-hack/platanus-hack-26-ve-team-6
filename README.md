<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="Gotchu" width="440">
  </picture>
</p>

<p align="center">
  <strong>Mira de cerca. Decide con pruebas.</strong>
</p>

<p align="center">
  <a href="https://gotchu.kevinbravo.com">App</a> ·
  <a href="#ejecutar-en-tu-máquina">Ejecutar</a> ·
  <a href="docs/self-hosting.md">Self-hosting</a> ·
  <a href="docs/architecture.md">Arquitectura</a> ·
  <a href="docs/implementation-plan.md">Estado</a>
</p>

<p align="center">
  <img alt="Node 24" src="https://img.shields.io/badge/node-24-e7147d?style=flat-square&labelColor=191923">
  <img alt="pnpm 11" src="https://img.shields.io/badge/pnpm-11-191923?style=flat-square">
  <img alt="TanStack Start" src="https://img.shields.io/badge/TanStack-Start-191923?style=flat-square">
  <img alt="Auth.js" src="https://img.shields.io/badge/Auth.js-191923?style=flat-square">
  <a href="https://gotchu.kevinbravo.com"><img alt="Producción en AWS" src="https://img.shields.io/badge/producción-AWS-e7147d?style=flat-square&labelColor=191923"></a>
</p>

---

> **¿Qué riesgos tiene mi aplicación, qué prueba cada uno y qué hago después?**

Gotchu revisa el código fuente, el origen HTTPS o los dos. Guarda un informe con evidencia, permite vigilar cambios y enviar notificaciones, y prepara correcciones que pueden llegar a un PR en borrador tras la aprobación exacta del Owner.

El alcance vigente es el de `main` con el [PR 25](https://github.com/0bkevin/gotchu/pull/25) integrado. Las propuestas adicionales están en [Roadmap](docs/roadmap.md).

- **Tú eliges.** Revisa solo el código, solo la web o ambos. La revisión externa no necesita tu código.
- **Muestra la evidencia.** Cada hallazgo enlaza su evidencia, su severidad y su confianza.
- **No oculta lo que no revisó.** Una cobertura parcial queda como desconocida, no como limpia.
- **Escaneo estático.** La auditoría no ejecuta tu código ni instala paquetes. La validación de correcciones usa una ruta aislada y configurada por separado.

## En vivo

| | |
|---|---|
| Aplicación | https://gotchu.kevinbravo.com |
| Infraestructura | AWS Lightsail en `us-east-1`, con TLS en Caddy y backups cifrados en S3 |

Abre `/dashboard` y elige **Crear una cuenta**. Cada cuenta nueva empieza sin acceso a espacios existentes y puede crear su propio espacio de trabajo. El runbook de producción está en [infra/aws](infra/aws/README.md).

<p align="center">
  <img src="docs/diagrams/arquitectura-produccion.svg" alt="Producción en AWS Lightsail: Caddy, web, coordinator, PostgreSQL, Redis y scanner en un servidor, con backups cifrados en S3" width="900">
</p>

## Cómo funciona

<p align="center">
  <img src="docs/diagrams/flujo-evaluacion.svg" alt="Flujo de Gotchu en seis pasos: espacio de trabajo, código fuente, origen HTTPS, evaluación, reporte y corrección" width="900">
</p>

| Paso | Qué hace Gotchu |
|---|---|
| 1. Espacio de trabajo | Crea un espacio privado. El creador es su Owner. Los roles controlan el acceso. |
| 2. Código fuente | Sube una carpeta o conecta GitHub. Cada instantánea tiene digest; las capturas de repositorio conservan el commit exacto. Git local también admite catálogo del operador. |
| 3. Origen HTTPS | Indica un origen HTTPS público y elige un perfil acotado. Al pedir el análisis, ese alcance queda autorizado durante 7 días. Gotchu no comprueba quién controla el dominio. |
| 4. Evaluación | Ejecuta una evaluación `internal`, `external` o `both`. Sigue las fases internas/externas y los avisos de falta de progreso. |
| 5. Reporte | Muestra la evidencia, la cobertura, la severidad, la confianza y las limitaciones. |
| 6. Corrección | Prepara una copia privada, revisa el reanálisis y la suite configurada, y aprueba el cambio exacto si quieres publicar un PR draft. |

## Qué puedes hacer

| Función | Descripción |
|---|---|
| Espacios de trabajo | Roles Owner, Operator y Viewer. Los Viewer solo pueden leer. |
| Revisión del código | Inventario de versiones exactas de npm, pnpm y Yarn. Política de licencias declaradas. SBOM CycloneDX 1.5 para descargar. |
| Revisión externa | Perfiles raíz, `public_surface` y `api_checks`: TLS, cabeceras, security.txt y escenarios HTTP/API acotados, sin acceso al código. |
| Dashboard e informes | Observaciones, cobertura e historial por proyecto. JSON y prompt por hallazgo para copiar a un asistente de código. |
| Vigilancia | Revisiones programadas del código y del origen. Alertas por cambios del repositorio y por nuevos avisos de npm. |
| Notificaciones | Email SMTP y webhooks HTTPS firmados, con canales por workspace, reintentos y estado de entrega. Requieren configurar sus adaptadores. |
| Eventos firmados | Agrupa errores, presión del servicio y actividad sospechosa compatible en alertas. |
| Historial de decisiones | Muestra quién hizo cada acción, cuándo y con qué resultado. No muestra credenciales ni direcciones IP. |
| IA opcional | Investigación y corrección privada con el modelo configurado, consentimiento y límites de consumo. El escaneo determinista funciona sin IA. |
| Correcciones | Recetas TLS/Kubernetes, cambios de código compatibles y actualizaciones npm directas patch/minor con package-lock raíz v2/v3; candidato privado, reanálisis y validación configurada. |
| PR aprobados | Un executor independiente publica y verifica el PR en borrador tras validar el candidato, el permiso de escritura y la aprobación exacta del Owner. Optativo por instalación. |
| Retención y respaldo | Políticas por workspace, purga en background y backup/restore cifrado. |

## Qué no afirma Gotchu

<p align="center">
  <img src="docs/diagrams/reporte-evidencia.svg" alt="Cómo leer un reporte: confirmado, indicio y desconocido, con severidad, confianza y explotabilidad" width="900">
</p>

- Una coincidencia no prueba que el código esté desplegado.
- Un paquete vulnerable no prueba que el código vulnerable se pueda alcanzar.
- Un pico de tráfico no prueba un ataque.
- "Sin hallazgos" no es una garantía de seguridad. Solo describe lo que la evaluación revisó.
- La severidad de un incidente no da más permisos de acción.

## Ejecutar en tu máquina

Necesitas Docker iniciado, Node 24 y pnpm 11.

```sh
git clone https://github.com/0bkevin/gotchu.git
cd gotchu
./gotchu up
```

1. Abre el enlace de configuración. El comando lo imprime y solo funciona una vez.
2. Crea el Owner y el primer espacio de trabajo.
3. Empieza con un origen HTTPS autorizado, una carpeta o GitHub opcional.
4. Inicia la auditoría y abre el informe; usa `external`, `internal` o `both` según las entradas.

El runtime escucha solo en loopback. No expongas el puerto sin `GOTCHU_PUBLIC_URL` con HTTPS y un proxy TLS. Los requisitos y los componentes opcionales están en [self-hosting](docs/self-hosting.md).

## Desarrollo local

```sh
pnpm install --frozen-lockfile
pnpm dev:prepare   # solo si faltan las imágenes fijadas
pnpm dev:start
```

Abre http://localhost:3000/dashboard. En desarrollo, el registro local está activo. No hay cuentas, espacios ni datos de demostración precargados.

| Servicio | Puerto | Variable para cambiarlo |
|---|---|---|
| Web | 3000 | `GOTCHU_DEV_WEB_PORT` |
| Coordinator | 3003 | `GOTCHU_DEV_COORDINATOR_PORT` |
| Scanner | 4400 | `GOTCHU_DEV_SCANNER_PORT` |

Postgres y Redis usan volúmenes locales persistentes. El launcher guarda los PID, los puertos, los logs y las credenciales locales del scanner en `.local/dev`. `pnpm dev:stop` detiene las apps y deja Postgres, Redis y sus datos activos. Más detalles en [desarrollo local](docs/development.md).

GitHub es opcional. La configuración de una sola App, la integración Reader/Writer anterior y el executor de PR están en [self-hosting](docs/self-hosting.md#conectar-github-con-una-sola-app). Los permisos de conexión, publicación y aprobación del cambio son independientes.

## Estado y límites

| Área | Estado |
|---|---|
| Producción | Desplegado en AWS: un servidor Lightsail de 4 GB en `us-east-1`. Web, coordinator y scanner corren como servicios systemd. Solo los puertos 80 y 443 son públicos. |
| Registro | Público en producción. Cada cuenta nueva no tiene acceso a los espacios existentes. |
| Backups | Cada diez minutos, cifrados y enviados a S3. Una restauración en una base de datos desechable funcionó. |
| Scanner | Semgrep, Gitleaks y Trivy fijados. Probado en vivo con casos sintéticos. |
| Abierto | Un solo servidor sin failover. Falta medir la capacidad con usuarios reales y la recuperación completa en un servidor limpio. |
| Componentes opcionales | IA, notificaciones y PR aprobados necesitan sus servicios, credenciales y permisos. Su presencia en `main` no implica que estén activos en todo host. |
| Identidad | Correo y contraseña con Auth.js, proveedores opcionales e invitaciones por espacio. Aprobación de PR desde sesión Owner, sin segundo factor. El correo de las cuentas locales no está verificado. La configuración alojada se registra en el runbook AWS. |

Las pruebas de integración del flujo del cliente están en `test/integration/customer-applications.test.ts`. La ruta TLS de producción del scanner está en `test/integration/production-scanner.test.ts`.

Las aplicaciones ficticias vulnerables y corregidas son fixtures de regresión. No son el producto y no limitan las evaluaciones de los clientes.

## Documentación

| Documento | Contenido |
|---|---|
| [Arquitectura](docs/architecture.md) · [Vista general](docs/architecture-overview.html) | Componentes y contratos |
| [Estado de implementación](docs/implementation-plan.md) | Funciones actuales, condiciones y evidencia |
| [Operaciones](docs/operations.md) | Monitoreo, alertas y correcciones |
| [Self-hosting](docs/self-hosting.md) | Instalación en tu propia máquina |
| [Definición](docs/definition-interview.md) | Alcance acordado y decisiones de producto |
| [Roadmap](docs/roadmap.md) | Propuestas futuras y verificaciones pendientes |
