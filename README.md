<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" alt="Gotchu" width="440">
  </picture>
</p>

<p align="center">
  <strong>Revisa el código de tu app, tu web o ambos. Cada hallazgo trae su evidencia.</strong>
</p>

<p align="center">
  <a href="#ejecutar-en-tu-máquina">Ejecutar</a> ·
  <a href="docs/self-hosting.md">Self-hosting</a> ·
  <a href="docs/architecture.md">Arquitectura</a> ·
  <a href="docs/implementation-plan.md">Estado</a> ·
  <a href="docs/validation.md">Verificación</a>
</p>

<p align="center">
  <img alt="Node 24" src="https://img.shields.io/badge/node-24-e7147d?style=flat-square&labelColor=191923">
  <img alt="pnpm 11" src="https://img.shields.io/badge/pnpm-11-191923?style=flat-square">
  <img alt="TanStack Start" src="https://img.shields.io/badge/TanStack-Start-191923?style=flat-square">
  <img alt="Auth.js" src="https://img.shields.io/badge/Auth.js-191923?style=flat-square">
  <img alt="Runtime local" src="https://img.shields.io/badge/runtime-desarrollo%20local-191923?style=flat-square">
</p>

---

> **¿Qué riesgos tiene mi aplicación, qué prueba cada uno y qué hago después?**

Gotchu responde a esa pregunta. Revisa el código fuente, el origen HTTPS o los dos. Después, te da un reporte con evidencia y te ayuda a preparar correcciones.

- **Tú eliges.** Revisa solo el código, solo la web o ambos. La revisión externa no necesita tu código.
- **Muestra la evidencia.** Cada hallazgo enlaza su evidencia, su severidad y su confianza.
- **No oculta lo que no revisó.** Una cobertura parcial queda como desconocida, no como limpia.
- **No ejecuta tu código.** Gotchu no instala paquetes, no ejecuta scripts y no intenta explotar nada.

## Cómo funciona

```mermaid
%%{init: {'theme':'base','themeVariables':{'primaryColor':'#fffefa','primaryTextColor':'#191923','primaryBorderColor':'#e7147d','lineColor':'#e7147d','fontFamily':'Saira, Helvetica, sans-serif'}}}%%
flowchart LR
  A[Espacio de trabajo] --> B[Aplicación]
  B --> C[Código fuente<br/>internal]
  B --> D[Origen HTTPS verificado<br/>external]
  C --> E[Evaluación]
  D --> E
  E --> F[Reporte con evidencia]
  F --> G[Alertas y vigilancia]
  F --> H[Corrección y nueva evaluación]
```

| Paso | Qué hace Gotchu |
|---|---|
| 1. Espacio de trabajo | Crea un espacio privado. El creador es su Owner. Los roles controlan el acceso. |
| 2. Código fuente | Sube una instantánea o conecta un repositorio Git o GitHub autorizado. Gotchu guarda el commit exacto. |
| 3. Origen HTTPS | Publica un registro TXT en `_gotchu.<hostname>`. Gotchu verifica el control DNS antes de consultar el origen. |
| 4. Evaluación | Ejecuta una evaluación `internal`, `external` o de los dos tipos. |
| 5. Reporte | Muestra la evidencia, la cobertura, la severidad, la confianza y las limitaciones. |
| 6. Corrección | Prepara correcciones compatibles en una instantánea privada y pide una nueva evaluación. |

## Qué puedes hacer

| Función | Descripción |
|---|---|
| Espacios de trabajo | Roles Owner, Operator y Viewer. Los Viewer solo pueden leer. |
| Revisión del código | Inventario de versiones exactas de npm, pnpm y Yarn. Política de licencias declaradas. SBOM CycloneDX 1.5 para descargar. |
| Revisión externa | Con el perfil raíz, una sola petición GET a `/`. Con el consentimiento `public_surface`, hasta diez peticiones GET al mismo origen. |
| Vigilancia | Revisiones programadas del código y del origen. Alertas por cambios del repositorio y por nuevos avisos de npm. |
| Eventos firmados | Agrupa errores, presión del servicio y actividad sospechosa compatible en alertas. |
| Historial de decisiones | Muestra quién hizo cada acción, cuándo y con qué resultado. No muestra credenciales ni direcciones IP. |
| Correcciones | Recetas versionadas para hallazgos de Semgrep (TLS desactivado) y de Trivy (KSV001, KSV012, KSV014, KSV017). Los otros hallazgos solo reciben guía. |

## Qué no afirma Gotchu

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
3. Sube una carpeta de código desde el dashboard.
4. Inicia una evaluación `internal`.

El runtime escucha solo en loopback. No expongas el puerto sin `GOTCHU_PUBLIC_URL` con HTTPS y un proxy TLS. Los requisitos y los componentes opcionales están en [self-hosting](docs/self-hosting.md).

## Desarrollo local

```sh
pnpm install --frozen-lockfile
pnpm dev:prepare   # solo si faltan las imágenes fijadas
pnpm dev:start
```

Abre http://localhost:3000/dashboard. El registro está activo solo en desarrollo. No hay cuentas, espacios ni datos de demostración precargados.

| Servicio | Puerto | Variable para cambiarlo |
|---|---|---|
| Web | 3000 | `GOTCHU_DEV_WEB_PORT` |
| Coordinator | 3003 | `GOTCHU_DEV_COORDINATOR_PORT` |
| Scanner | 4400 | `GOTCHU_DEV_SCANNER_PORT` |

Postgres y Redis usan volúmenes locales persistentes. El launcher guarda los PID, los puertos, los logs y las credenciales locales del scanner en `.local/dev`. `pnpm dev:stop` detiene las apps y deja Postgres, Redis y sus datos activos. Más detalles en [desarrollo local](docs/development.md).

<details>
<summary><strong>Conectar una GitHub App en desarrollo</strong></summary>

1. Crea una GitHub App con estos permisos de repositorio: **Contents: read-only**, **Checks: read-only** y **Pull requests: read-only**.
2. Deja los webhooks desactivados, salvo que los configures aparte.
3. Usa esta Callback URL: `http://localhost:3000/api/customer/github/callback`.
4. Activa **Request user authorization (OAuth) during installation**.
5. Guarda las credenciales en un archivo JSON con `id`, `clientId`, `clientSecret`, `privateKeyPem` y `webhookSecret`. Agrega `slug` o define `GOTCHU_GITHUB_APP_SLUG`.
6. Define `GOTCHU_GITHUB_READER_APP_FILE` con la ruta de ese archivo.
7. Instala la App solo en repositorios que tienes autorización para evaluar.

No envíes ese archivo al navegador y no lo agregues a Git. Gotchu crea los tokens de instalación en el servidor y los guarda solo en memoria.

Para mover una instalación a otro espacio de trabajo, desconéctala primero del espacio actual. Después, un Owner del espacio de destino autoriza la conexión. Solo un espacio puede tener la instalación activa.

</details>

## Estado y límites

| Área | Estado |
|---|---|
| Runtime | Desarrollo local. Este README no afirma un despliegue en la nube. AWS es el objetivo principal futuro. |
| Scanner HTTPS | Implementado y probado en local en Linux/amd64, con Semgrep CE 1.182.0 fijado. |
| Abierto | Ingress web alojado, política de red en la nube, ciclo de secretos de producción, backups y restauración, capacidad representativa y otras arquitecturas. |
| Desactivado | Ejecución del código del cliente, escrituras en proveedores y acciones de respuesta automáticas. |
| Identidad | El registro local es solo para desarrollo. Existen el inicio de sesión local, WebAuthn step-up e invitaciones por espacio. La identidad de producción no está certificada. |

Las pruebas de integración del flujo del cliente están en `test/integration/customer-applications.test.ts`. La ruta TLS de producción del scanner está en `test/integration/production-scanner.test.ts`. El [registro de verificación](docs/validation.md) describe el alcance y los límites de cada prueba.

Las aplicaciones ficticias vulnerables y corregidas son fixtures de regresión. No son el producto y no limitan las evaluaciones de los clientes.

## Documentación

| Documento | Contenido |
|---|---|
| [Arquitectura](docs/architecture.md) · [Vista general](docs/architecture-overview.html) | Componentes y contratos |
| [Plan de implementación](docs/implementation-plan.md) | Estado y release gates |
| [Operaciones](docs/operations.md) | Monitoreo, alertas y correcciones |
| [Self-hosting](docs/self-hosting.md) | Instalación en tu propia máquina |
| [Entrevista de definición](docs/definition-interview.md#current-user-correction-actual-customer-application-in-development) | Decisiones de producto |
| [Plan de defensa autónoma](docs/plan-defensa-autonoma.md) | Hoja de ruta. No es una lista de funciones disponibles. |
