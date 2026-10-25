# Autoalojar Gotchu

Este flujo ejecuta Gotchu en la máquina del operador. No publica imágenes ni envía código a un servicio de pago.

## Requisitos

- Linux x86_64 con Docker Engine activo y Docker Compose v2. Ejecuta `./gotchu` desde una cuenta sin privilegios con acceso al daemon Docker; Gotchu usa ese UID/GID para mantener privados los montajes. Docker Desktop en macOS/Windows no está validado; la conexión del scanner necesita acceso desde el host al puente de Docker.
- Node.js 24, pnpm 11, OpenSSL y al menos 5 GiB libres en el almacenamiento de Docker. Hace falta Internet la primera vez para instalar dependencias y descargar imágenes.
- Puertos loopback libres: web `3000`, coordinator `3003`, scanner `4400`, PostgreSQL `55432` y Redis `56379`. Configúralos con `GOTCHU_WEB_PORT`, `GOTCHU_COORDINATOR_PORT`, `GOTCHU_SCANNER_PORT`, `GOTCHU_POSTGRES_PORT` y `GOTCHU_REDIS_PORT` antes del primer arranque.

## Instalar y configurar Owner

Desde una máquina limpia:

```sh
git clone <url-del-repositorio>
cd gotchu
./gotchu up
```

`up` instala dependencias si faltan, comprueba Docker/Compose, puertos y espacio, genera secretos con permisos privados, prepara las imágenes Semgrep/Gitleaks/Trivy y Postgres/Redis, ejecuta migraciones y provisioning de roles, inicia los servicios y espera su readiness. La primera preparación puede tardar varios minutos mientras Docker descarga imágenes. No imprime las credenciales.

Abre el enlace `/setup?token=…` que imprime `up`. Caduca en una hora y sólo se puede usar una vez. El formulario crea en una operación atómica la cuenta, el primer workspace y su membership Owner. Después de bootstrap, el registro abierto permanece deshabilitado; invita a las demás personas desde **Personas y acceso**. Para emitir otro enlace antes de que exista un Owner:

```sh
./gotchu setup-link
```

El comando invalida enlaces anteriores no usados. No puede emitir enlaces cuando ya hay un Owner.

## Primer escaneo

En el dashboard, **Conectar GitHub** crea el primer espacio y la aplicación si hace falta; después del regreso de GitHub, cada repositorio tiene su propio botón **Analizar**. Para código local, elige una carpeta y pulsa **Analizar carpeta**. Ambas rutas conservan el consentimiento explícito antes de guardar una instantánea y poner en cola el trabajo. El escaneo no instala dependencias ni ejecuta código del cliente. Las fuentes subidas se conservan en Postgres local hasta su vencimiento según la retención del espacio de trabajo o hasta ejecutar `reset`.

Un Owner puede cambiar los plazos desde **Retención** en el dashboard. Los valores iniciales son: instantáneas de código 90 días, imágenes de contenedor 30, informes 365, observaciones 30, ejecuciones 30, entregas de notificaciones 90 y eventos de protección 30. El coordinator ejecuta el trabajo durable de limpieza aun cuando el monitoreo programado esté desactivado y vuelve a revisar cada aplicación al menos cada diez minutos. Mantiene fuentes usadas por trabajos activos o en reconciliación; al vencer, elimina el contenido de las instantáneas e imágenes y sus informes, observaciones y alertas vencidos, ejecuciones finalizadas, entregas antiguas y eventos de protección. También recorta ejecuciones completadas, observaciones y planes antiguos para permanecer bajo sus cuotas de 1.000, 2.000 y 100 elementos; al alcanzar una cuota, ese historial puede borrarse antes del plazo configurado. La página **Vigilancia** muestra el consumo actual y las cuotas diarias; si se agotan las 100 proyecciones diarias, los eventos firmados aceptados siguen procesándose y la cobertura se marca incompleta. Los identificadores mínimos de fuentes se conservan para mantener las referencias de solicitudes. Esto no ofrece borrado permanente de aplicaciones o espacios de trabajo.

Semgrep está fijado en 1.182.0 por digest. La validación local Linux/amd64 cubre los perfiles acotados del scanner; el gate general de perfil y las garantías de precisión/capacidad siguen cerrados. Los informes muestran cobertura parcial y desconocida; un resultado sin hallazgos no demuestra que el sistema sea seguro.

## Investigación con IA

`./gotchu up` arranca el gateway y el worker de investigación junto al resto de servicios. Una persona Owner abre **Modelos de IA** en el menú del espacio, elige un proveedor, conecta su cuenta o introduce su clave y marca las categorías de datos que autoriza. La página está disponible aunque todavía no haya proyectos. El modelo sugerido puede cambiarse o escribirse como texto libre. La credencial se almacena sólo en el servidor (`.gotchu/model-secrets`); Gotchu exige consentimiento explícito por categoría. Los proveedores con clave API conservan los presupuestos de gasto y tokens; las suscripciones registran su consumo sin un tope fijo de tokens. **Probar conexión** envía una solicitud mínima por el gateway y muestra un resultado breve.

### Con tu suscripción de Claude o ChatGPT

Claude Code y Codex usan tu suscripción en lugar de una clave API: el gateway ejecuta el CLI oficial sin herramientas, en un directorio temporal vacío y con un `HOME` propio. El host que ejecuta `./gotchu up` necesita el CLI instalado y en el `PATH` (o `GOTCHU_CLAUDE_CODE_BIN` / `GOTCHU_CODEX_BIN` en `.gotchu/.env`); `./gotchu doctor` indica si los encuentra.

- **Claude Code (Pro o Max).** Pulsa **Conectar Claude**. Gotchu inicia `claude setup-token` en una sesión privada y abre la autorización de Claude. Si el proveedor muestra un código, pégalo en **Completar autorización** dentro de Gotchu. La utilidad Linux `script` debe estar instalada. La conexión manual queda en una sección desplegable.
- **Codex (ChatGPT).** Pulsa **Conectar ChatGPT**. Gotchu abre la página oficial de OpenAI y muestra un código corto que puedes copiar. Para autorizar desde otro equipo, usa **Conectar desde otro dispositivo**: Gotchu espera sin abrir un navegador; copia el enlace público y escribe el código en la página oficial desde cualquier equipo. No hace falta un callback a `localhost`. Autoriza tu cuenta y vuelve a Gotchu: la sesión se guarda automáticamente sin copiar `auth.json` ni reutilizar la sesión de otra terminal. Si OpenAI lo solicita, activa la autorización por dispositivo en la seguridad de tu cuenta. El gateway conserva las renovaciones en el almacén privado.

El uso se descuenta de tu suscripción. Gotchu registra el consumo real sin imponer un tope fijo de tokens a Claude Code o Codex ni cambiar su nivel de razonamiento. Para gestionar el consumo de Codex, elige **GPT-6 Luna** o **GPT-6.1 Sol** en el selector. La respuesta estructurada permite guardar el resultado del agente; los permisos sobre datos y las aprobaciones siguen siendo independientes del modelo.

### Del hallazgo a una corrección revisable

En **Modelos de IA**, autoriza las categorías de datos y activa **Investigar automáticamente los hallazgos de código medios, altos y críticos**. Cada análisis puede encolar hasta tres investigaciones. El informe conserva la explicación, sus evidencias, implicaciones, riesgos y plan de validación aunque cierres la página.

En un hallazgo de código, pulsa **Corregir con IA** y confirma el envío acotado de archivos al modelo seleccionado. Un agente LangGraph prepara un parche sobre la instantánea exacta del informe. El worker guarda una nueva instantánea privada y su diff, y encola un análisis estático independiente. No instala dependencias ni ejecuta código del proyecto.

El mismo panel muestra **Ver informe de la instantánea candidata** y el estado de la validación de comportamiento. **Preparar propuesta de PR** usa el ejecutor y las aprobaciones existentes: requiere repositorio vinculado, commit verificado, validación D05 en VM y aprobación humana exacta con segundo factor. Cuando falta un requisito, el cambio privado permanece disponible y la interfaz muestra el bloqueo.

Los intentos caducan en diez minutos y se pueden cancelar. Sólo la persona Owner que los inició puede completarlos. Conectar una cuenta conserva los permisos y presupuestos existentes; si ya autorizaste datos, Gotchu prueba el modelo al terminar. El flujo integrado con CLI está limitado a instalaciones locales: un servicio alojado necesita una integración registrada de [Sign in with ChatGPT](https://developers.openai.com/siwc), y no reutiliza el cliente de autenticación de Codex.

### Con clave API

**Conectar OpenRouter** abre su autorización oficial con PKCE y guarda la clave recibida sólo en el servidor. Los demás proveedores ofrecen **Obtener clave** para abrir su página de credenciales; introduce una clave en el campo privado y pulsa **Guardar y probar conexión**. Para un endpoint personalizado, usa las credenciales de tu propia instalación. Ninguna de estas conexiones autoriza escribir en repositorios.

| Proveedor | Modelo inicial o sugerencias | Documentación oficial |
| --- | --- | --- |
| OpenAI | `gpt-5.4` | [API](https://developers.openai.com/api/reference/overview) · [modelo](https://developers.openai.com/api/docs/models/gpt-5.4) |
| Anthropic | `claude-sonnet-5-5`, `claude-opus-5-5` | [API Messages](https://platform.claude.com/docs/en/api/overview) · [modelos](https://platform.claude.com/docs/en/models/overview) |
| Google Gemini | `gemini-3.8-flash` | [endpoint compatible](https://ai.google.dev/gemini-api/docs/openai/) · [modelos](https://ai.google.dev/gemini-api/docs/models) |
| DeepSeek | `deepseek-flash`, `deepseek-v4-pro` | [API](https://api-docs.deepseek.com/api/create-chat-completion/) · [modelos y precios](https://api-docs.deepseek.com/quick_start/pricing/) |
| Moonshot AI (Kimi) | `kimi-k3.1-pro`, `kimi-k3.1-pro-highspeed` | [API](https://platform.kimi.ai/docs/api/chat) · [modelos](https://platform.kimi.ai/docs/models) |
| Zhipu GLM (Z.ai) | `glm-5.3`, `glm-5.2`, `glm-5.1` | [chat completions y modelos](https://docs.z.ai/api-reference/llm/chat-completion) |
| Mistral | `mistral-large-latest`, `mistral-small-latest` | [chat](https://docs.mistral.ai/api/endpoint/chat) · [modelos](https://docs.mistral.ai/api/endpoint/models) |
| xAI Grok | `grok-4.7` | [API](https://docs.x.ai/developers/rest-api-reference/inference) · [modelo](https://docs.x.ai/developers/models/grok-4.7) |
| Groq | `openai/gpt-oss-120b`, `openai/gpt-oss-20b` | [API](https://console.groq.com/docs/overview) · [modelos](https://console.groq.com/docs/models) |
| OpenRouter | `anthropic/claude-sonnet-5.5`, `openai/gpt-6.1-sol`, `google/gemini-3.8-flash`, `deepseek/deepseek-v4.1-flash`, `moonshotai/kimi-k3.1-pro`, `z-ai/glm-5.3`, o cualquier ID del catálogo; indica sus precios por token | [API](https://openrouter.ai/docs/api_reference/overview) · [catálogo](https://openrouter.ai/models) |
| Custom OpenAI-compatible | Escribe el ID y endpoint | [formato de chat](https://developers.openai.com/api/reference/chat/completions/overview) |

Los proveedores alojados usan sus endpoints HTTPS oficiales. Custom OpenAI-compatible requiere HTTPS y DNS público; para permitir un endpoint autohospedado, el operador debe establecer `GOTCHU_ALLOW_SELF_HOSTED_LLM_ENDPOINT=true` tanto en Web como en Gateway. En despliegues separados, configura `GOTCHU_GATEWAY_URL` en Web, comparte el mismo secreto aleatorio base64url de al menos 32 bytes mediante `GOTCHU_GATEWAY_MODEL_PROBE_SECRET` entre Web y Gateway, y proporciona al Gateway acceso al almacén de claves de modelo configurado. No pongas claves de proveedor en variables del navegador ni en logs.

En el arranque local, Web, coordinator, worker y gateway se comunican por loopback con TLS (`.gotchu/internal.crt`), y el coordinator firma las capacidades de cada ejecución con `.gotchu/run-capability.key`. Las credenciales de modelo no forman parte de `./gotchu backup`; tras restaurar, vuelve a pegarlas.

## Comandos

```sh
./gotchu status             # servicios, límites y componentes opcionales
./gotchu logs               # todos los registros
./gotchu logs web           # también coordinator, scanner, postgres o redis
./gotchu down               # detiene procesos; conserva los datos
./gotchu up                 # reinicia y conserva los datos
./gotchu upgrade            # reconstruye desde el checkout actual y migra
./gotchu backup             # crea un archivo cifrado en .gotchu.backups/
./gotchu backup /mnt/secure/gotchu.backup  # elige otra ubicación
./gotchu restore /mnt/secure/gotchu.backup # reemplaza datos en una instalación detenida
./gotchu github setup       # callbacks exactos y ubicación de credenciales de sólo lectura
./gotchu google setup       # origen y callback exactos para OAuth de Google
./gotchu reset              # pide escribir RESET; borra volúmenes y secretos locales
```

`backup` pide una frase de paso de 16 a 1024 bytes UTF-8 dos veces; `restore` la pide una vez y solicita confirmar la sustitución. El dump Postgres es consistente y el archivo se cifra con AES-256-GCM y una clave derivada mediante scrypt. Redis no se copia: las colas y el outbox se recuperan desde el estado durable de Postgres. El respaldo contiene `.env`, las claves del scanner y, si existe, las credenciales de GitHub; guarda la frase de paso por separado. La carpeta `.gotchu.backups/` queda junto al directorio de estado y sobrevive a `./gotchu reset`, pero sigue en el mismo disco por defecto. Copia el archivo a almacenamiento cifrado separado para cubrir una pérdida del host; Gotchu no hace copias programadas ni mide RPO/RTO.

`restore` necesita una instalación ya inicializada y detenida. Después de `./gotchu reset`, ejecuta `./gotchu up` y `./gotchu down` antes de restaurar el archivo externo. El comando deja todos los servicios detenidos, congela escrituras de proveedor e incrementa el recovery epoch; luego `./gotchu up` reinicia la aplicación. Los valores locales de Postgres y los puertos permanecen de la instalación destino. Para borrar una copia, elimina su archivo y las demás copias que hayas guardado; la limpieza de una workspace no puede editar respaldos cifrados existentes.

`./gotchu doctor` comprueba requisitos frecuentes. GitHub es opcional. El operador puede configurar la conexión con una App o conservar la integración anterior con dos Apps. La publicación de PR está desactivada por defecto y conserva el flujo de aprobación Owner descrito abajo.

### Conectar GitHub con una sola App

La experiencia de cliente comienza en **Conectar GitHub**: autoriza la App de Gotchu en GitHub, selecciona los repositorios y vuelve al mismo flujo para elegir cuál analizar. No crea Apps ni copia claves o IDs de instalación. GitHub puede mostrar pantallas separadas de autorización de cuenta e instalación; Gotchu no puede omitir ese consentimiento. Instalar la App tampoco concede una aprobación de cambios en Gotchu: la escritura en un repositorio y cada PR mantienen sus aprobaciones independientes.

El operador configura una sola App con `Contents: Read and write`, `Pull requests: Read and write` y `Metadata: Read-only`; el acceso a organizaciones requiere también `Members: Read-only`. Registra `<PUBLIC_APP_URL>/api/customer/github/callback` como callback. Guarda un JSON privado con `id`, `clientId`, `clientSecret`, `slug` y `privateKeyPem` en `.gotchu/github-single-app.json`, modo `0600`, y configura:

```dotenv
GOTCHU_GITHUB_CONNECTION_MODE=single_app
GOTCHU_GITHUB_SINGLE_APP_FILE=/ruta/privada/github-single-app.json
GOTCHU_EXECUTOR_ENABLED=false
```

`./gotchu up` inicia el broker aunque la publicación de PR esté desactivada. Sólo el executor carga la clave privada y el secreto OAuth. La web recibe una identidad pública generada y resultados acotados de lectura; no recibe tokens de proveedor. El executor resuelve repositorios e instalaciones desde los vínculos autorizados del workspace, sin un ID de instalación global ni un catálogo editado por cada cliente. Para publicar, el operador habilita `GOTCHU_EXECUTOR_ENABLED=true`; siguen siendo necesarias la validación aislada, la concesión de escritura y la aprobación exacta con segundo factor.

Este modo es para conectar repositorios. No reutilices su cliente OAuth en el proveedor de inicio de sesión de Auth.js: la web rechaza esa coincidencia. El inicio local, Google, OIDC y un cliente GitHub independiente conservan sus configuraciones. Cambiar de App o de modo requiere desconectar y volver a conectar; la migración conserva las conexiones anteriores mientras continúen en el modo anterior.

### Configurar la conexión anterior con dos Apps

`./gotchu github setup` muestra la URL de callback de autorización que usa **Conectar GitHub** para el `PUBLIC_APP_URL` actual y prepara la carpeta privada de credenciales. En GitHub configura una App con `Contents: Read-only` y `Metadata: Read-only`, instala sólo los repositorios autorizados y guarda el JSON de credenciales en `${state_dir}/github/reader-app.json` con permisos `0600`. El Web monta esa carpeta como sólo lectura. En `${state_dir}/.env` configura:

```dotenv
GOTCHU_GITHUB_READER_APP_FILE=/run/secrets/github/reader-app.json
GOTCHU_GITHUB_APP_SLUG=<slug-de-la-app>
```

La App debe incluir el callback de autorización que imprime `./gotchu github setup`, normalmente `http://localhost:3000/api/customer/github/callback` en el perfil local. Ejecuta `./gotchu up` para aplicar la configuración. Después, **Conectar GitHub** abre la instalación autorizada, vuelve a Gotchu, lista los repositorios de esa instalación y **Analizar repositorio** guarda una instantánea para la primera evaluación. El permiso `Contents` permanece en sólo lectura.

El bootstrap inicial usa correo y contraseña. Para ofrecer además **Iniciar sesión con GitHub**, configura `AUTH_GITHUB_ID` y `AUTH_GITHUB_SECRET` con el client ID y secret de una GitHub App y registra también `<PUBLIC_APP_URL>/api/auth/callback/github` entre sus callback URLs. GitHub admite hasta 10 URLs de callback en una App; conserva `/api/customer/github/callback` como primera URL para Conectar GitHub y agrega la ruta de Auth.js. Al configurar varias URLs, cada flujo OAuth debe solicitar la URL de retorno correspondiente. Si no puedes cambiar la configuración de callbacks, el botón de inicio de sesión con GitHub no funcionará. Los IDs y secrets no deben copiarse a páginas ni registrarse en logs. OIDC y el inicio local siguen disponibles. Consulta [callbacks de autorización de GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url) y la [configuración del proveedor GitHub de Auth.js](https://authjs.dev/guides/configuring-github).

### Iniciar sesión con Google

Ejecuta `./gotchu google setup`. El comando lee `PUBLIC_APP_URL` del archivo privado `${state_dir}/.env` y muestra el origen de JavaScript autorizado y el URI de redirección exactos. En Google Cloud Console, crea o abre un cliente OAuth de tipo **Aplicación web** y registra esos valores en **Orígenes de JavaScript autorizados** y **URI de redirección autorizados**. El callback es `<origin>/api/auth/callback/google`. Si compartes un cliente entre desarrollo y producción, registra también `http://localhost:3000` y `http://localhost:3000/api/auth/callback/google`.

En la pantalla de consentimiento, configura el dominio autorizado y los enlaces públicos de privacidad y términos. Las páginas `/privacy` y `/terms` de Gotchu son borradores; el operador debe revisarlas antes de ofrecer el servicio. Si la aplicación OAuth continúa en modo de prueba, añade como usuarios de prueba a las personas que iniciarán sesión.

En `${state_dir}/.env`, configura `AUTH_GOOGLE_ID=<client-id>` y `AUTH_GOOGLE_SECRET=<client-secret>`. El botón aparece sólo cuando ambas variables están presentes. Gotchu solicita `openid email profile` y acepta únicamente perfiles con correo verificado por Google. Los usuarios nuevos pasan al onboarding normal una vez iniciada la sesión. En una instalación autoalojada, Google no puede crear al primer Owner: antes debe completarse `/setup` con el enlace de un solo uso de `./gotchu up` o `./gotchu setup-link`.

Si el correo verificado ya pertenece a una cuenta local, Gotchu no vincula Google automáticamente. Inicia sesión con la contraseña local; la vinculación explícita desde ajustes de cuenta queda pendiente porque la aplicación todavía no cuenta con persistencia de identidades enlazadas. Reinicia con `./gotchu up` después de cambiar las variables. No copies el client secret a páginas, capturas ni registros.

### Activar el executor de PR en la integración anterior

El executor de PR está desactivado por defecto. Para habilitarlo en desarrollo local, crea una GitHub App Writer instalada sólo en los repositorios que autorizas. Dale permisos de lectura/escritura de Contents y Pull requests; Gotchu abre PRs draft y no hace merge. Guarda fuera de Git el JSON de la App en `.gotchu/github-writer-app.json`, con campos `id` y `privateKeyPem`, permisos `0600`. Usa una clave RSA de 2048 bits o más. La clave debe pertenecer a una App de escritura; no reutilices el token o la clave del Reader. El Writer App installation ID puede ser distinto del Reader installation ID.

Edita `.gotchu/.env` y configura el ID de instalación de esa App y `GOTCHU_EXECUTOR_ENABLED=true`:

```dotenv
GOTCHU_EXECUTOR_ENABLED=true
GOTCHU_GITHUB_WRITER_INSTALLATION_ID=<installation-id>
```

Después, añade al archivo privado `.gotchu/monitoring-repositories.json` una entrada GitHub con los IDs reales del workspace y la aplicación, y el `repositoryKey` que coincide con el repositorio vinculado en Gotchu:

```json
{
  "repositoryRoot": "/run/repos",
  "repositories": [{
    "organizationId": "<workspace-uuid>",
    "applicationId": "<application-uuid>",
    "repositoryKey": "<linked-repository-key>",
    "displayName": "Production source",
    "provider": "github",
    "owner": "<github-owner>",
    "repository": "<github-repository>",
    "ref": "main"
  }]
}
```

Mantén catálogo y credencial con permisos privados. El catálogo limita el destino que web y executor pueden resolver; sólo el executor recibe la clave Writer. `./gotchu up` configura un token aleatorio que comparten web y executor. El executor escucha sólo en `127.0.0.1`, así que la verificación Writer no acepta conexiones remotas. No reutilices ese token como credencial de GitHub.

Conecta primero la GitHub App Reader y vincula un repositorio verificado con lectura concedida. En el panel de repositorios, un Owner puede **Conceder escritura con WebAuthn**. Gotchu verifica por medio del executor que la instalación Writer configurada puede leer el repositorio y su rama base; sólo entonces guarda el ID verificado, la hora y el commit base. El Owner puede revocar ese permiso con otra prueba WebAuthn. La revocación invalida las aprobaciones pendientes de PR para ese repositorio. Las migraciones 038 y posteriores requieren volver a conceder permisos anteriores, porque un valor histórico `granted` no demuestra cobertura de la Writer App actual. Las propuestas npm también requieren una suite `npm test` configurada y validada para el repositorio; sin ella, D06 no habilita una aprobación.

Reinicia con `./gotchu up`; el comando valida la configuración y espera readiness. La UI ofrece **Aprobar PR** para correcciones de código y **Aprobar PR de dependencias** para candidatos npm elegibles después de la validación vigente y WebAuthn del Owner. El executor publica la rama y abre un PR draft después de reclamar la aprobación exacta. Revisa y cierra PRs manualmente: merge, deploy, respuesta automática y recuperación no están habilitados. Esta configuración es para desarrollo local; la activación en producción sigue bloqueada.

El validator VM aún no se inicia desde Compose. Requiere Linux, `/dev/kvm`, `bwrap`, una sesión systemd de usuario, runtime login, clave privada y preparación de imágenes; el worker se puede ejecutar manualmente después de configurar esos valores con `GOTCHU_VALIDATOR_DATABASE_URL=… GOTCHU_VALIDATOR_KEY_PATH=… pnpm --filter @gotchu/validator start`. Para que el usuario de desarrollo acceda a `/dev/kvm`, añádelo al grupo `kvm` y abre una sesión nueva. `doctor` indica cuando faltan esos requisitos. La prueba de desarrollo verifica el flujo Firecracker configurado; no es una garantía de aislamiento para producción.

## Seguridad y exposición

- Web, coordinator, scanner y executor son procesos host enlazados a `127.0.0.1`, igual que los puertos de Postgres y Redis. No cambies esos binds a una interfaz pública.
- Mantén `${state_dir:-.gotchu}` privado: `.env`, el secreto HMAC, la clave TLS local del scanner, las credenciales GitHub, archivos de identidad de procesos y registros viven ahí con permisos `0600`; el directorio de estado y `github/` usan `0700`. El coordinator confía en el certificado local sólo para la conexión HTTPS al scanner. No subas estos archivos a Git ni compartas enlaces de configuración.
- `./gotchu up` verifica por HTTPS el mismo endpoint de readiness que ejecuta los perfiles fijados del scanner antes de anunciar que está listo. Web, coordinator y scanner son procesos locales; Compose inicia sólo Postgres y Redis. Así, el tráfico del scanner no cruza el host INPUT y la instalación no requiere cambios de firewall.
- El bootstrap inicial usa el flujo local `/setup` para crear el primer Owner. Google, GitHub y OIDC no pueden sustituirlo. Las contraseñas locales usan el hash scrypt existente y los límites actuales de autenticación.
- `PUBLIC_APP_URL` es el origen canónico usado por Auth.js. En producción detrás de un proxy reverso, configúralo como `https://gotchu.kevinbravo.com`; TLS debe terminar en el proxy, que debe limitar tamaños y tiempos de petición y reenviar únicamente a la dirección loopback del puerto web configurado. `GOTCHU_PUBLIC_URL` sólo establece el valor inicial al crear `${state_dir}/.env`; después, edita `PUBLIC_APP_URL` en ese archivo y reinicia con `./gotchu up`. Gotchu no termina TLS y no afirma que esta topología esté endurecida para producción.
- La evaluación externa sólo debe apuntar a un origen cuya autorización tenga el cliente. Las únicas escrituras opcionales habilitables aquí son PR draft acotados a propuestas exactas; ejecución del cliente fuera de la VM, merge, deploy, respuesta automática y recuperación permanecen deshabilitados.
- `./gotchu backup [archivo]` y `./gotchu restore <archivo>` usan un respaldo local cifrado y probado contra Postgres desechable. La restauración incrementa el epoch, deja las escrituras de proveedor congeladas y los servicios detenidos. La copia por defecto permanece en el mismo disco; la réplica externa, retención de archivos y objetivos medidos de recuperación siguen pendientes.

## Actualizar y desinstalar

`./gotchu upgrade` no modifica el checkout ni ejecuta `git pull`: reconstruye desde los archivos locales, aplica migraciones y reinicia conservando volúmenes y configuración. Actualiza el repositorio después de revisar sus cambios y luego ejecuta el comando. No hay rollback automatizado: toma una copia de datos antes de actualizar.

Para detener Gotchu sin borrar los datos, usa `./gotchu down`. Para eliminar sus contenedores, volúmenes y secretos de ese estado local, confirma `./gotchu reset`; luego puedes borrar el checkout. `reset` conserva la carpeta hermana `.gotchu.backups/`; borra sus respaldos cifrados manualmente cuando ya no deban conservarse. Mantén fuera del directorio de estado la única copia que necesites para restaurar después de una pérdida del host.


## Reproducible source-investigation pipeline regression

Run `node test/run-stack.mjs test/integration/pipeline.test.ts test/integration/source-model-investigation.test.ts` after building the workspace. The runner provisions disposable PostgreSQL and Redis containers on random loopback ports and removes them afterward.

The source regression persists a synthetic assessment, admits its automatic investigation, delivers the durable outbox through BullMQ, and runs the actual HTTP worker, LangGraph, capability gateway and Codex subprocess adapter. Controlled provider responses first request finding details and a source excerpt, then return a suggestion with implications, risks and validation steps. Assertions cover saved results, excerpt redaction, exclusion of an unrelated file, settled token reservations, tenant isolation and no repeated model calls on job replay.

This regression uses synthetic scan observations and a fixture executable in place of the Codex service. It proves pipeline integration, not a live provider response or customer-repository finding. A live Codex check requires a dedicated account connection through **Modelos de IA → Conectar ChatGPT**, followed by **Guardar y probar conexión** and an authorized investigation. When accessing a remote development environment, use its shared preview or a configured port forward; `localhost` in a browser on another computer refers to that computer. The public device-authorization page can be opened in the account owner's own browser while Gotchu waits for completion.

## Earlier subscription-provider validation — 2026-10-25

This historical run predates the device-authorization interface, private correction agents and removal of subscription token limits. Its automated results apply to that earlier revision, not the current HEAD.

Claude Code and Codex now run investigations on the Owner's own subscription. Everything below ran against a fresh `./gotchu up` in this worktree (isolated ports, disposable state) with this machine's real Claude Max and ChatGPT logins; no API keys were used. OpenRouter and the other API-key presets were **not** run live.

| Check | Observed result |
| --- | --- |
| Self-host startup | `./gotchu up` applied gateway migrations and started web, coordinator, worker, gateway and scanner; `./gotchu status` reported all running. |
| UI connection test, Claude Code (`claude-sonnet-5-5`) | Owner pasted the OAuth token in **Aplicaciones → Modelo y consentimiento**; "Conexión correcta · 416 tokens de entrada y 9 de salida". |
| UI connection test, Codex (`gpt-6-luna`) | Owner pasted a Codex `auth.json`; "Conexión correcta · 5795 tokens de entrada y 9 de salida". |
| Investigation from the report, Claude Code | Coordinator → worker → gateway → `claude -p`: `investigated`, `candidate_issue`, cited the uploaded `eval` evidence, 2 model calls + 2 additional reads, reservations settled (1,539/400 and 2,461/674 tokens), $0 charged. |
| Investigation from the report, Codex | Same path through `codex exec`: `investigated`, `candidate_issue`, 2 model calls, 14,051 tokens settled, $0 charged. The terminal's own `auth.json` was unchanged (`last_refresh` 2026-10-19). |
| Contract check | With the gateway's instruction, both CLIs returned replies that pass the worker's `modelOutputSchema`, in Spanish. |
| Automated | Gateway suite 46 passed (Postgres-backed suite on a disposable PostgreSQL 17.11), backend investigation and budget suites 8 passed, worker 6 passed, `scripts/gotchu.test.mjs` passed, typecheck clean for gateway and worker. |

The live run found two defects that fixtures had hidden, both fixed: the probe locked the settings row with `FOR UPDATE`, which the gateway role is not granted (every UI probe answered "no disponible"), and the gateway's fixed instruction never described the reply shape the worker enforces (the first live investigation ended `invalid_model_output`). Not measured: a real Codex token rotation, OpenRouter or any API-key provider live, the AWS runtime, and explanation quality beyond this single `eval` fixture.

### Earlier adversarial review — 2026-10-25

My own review pass plus two independent read-only reviews (Codex `gpt-6-luna`, high effort) of the gateway path and the self-host wiring. Fixed:

- Provably unbilled failures (CLI missing, rejected login, unknown model) left reservations stuck; a few Codex probes with an expired login could exhaust a 100k token budget. They now settle at zero.
- At that revision, output caps subtracted a conservative input estimate for every provider. Subscription token limits have since been removed; the current Codex and Claude subscription paths omit output-token limits.
- A rotated Codex login written back after the Owner replaced or disabled it could recreate the deleted file; leftover CLI scratch directories after a crash are now swept at gateway start.
- The money budget stays visible for subscriptions, since earlier API-key spending can still block them.
- Existing installs get free gateway and worker ports on upgrade, and every service now receives its environment through a private `--env-file` instead of process arguments (previously `AUTH_SECRET`, database passwords and the new keys were readable in `/proc/<pid>/cmdline`).

Re-verified live after the fixes: all services started through the new launcher, no secret appeared in any process's arguments, the Claude Code probe and a new investigation succeeded (Spanish explanation, both calls settled, 0 tokens left reserved), and the gateway (51) and backend investigation/budget (8) suites passed. Open: the Codex lock covers one gateway process only (see pendientes).

## Current source and correction workflow, observed locally — 2026-10-25

This run used an isolated local stack with real PostgreSQL, Redis, scanner, coordinator, worker, LangGraph and Codex. The Owner completed a fresh official ChatGPT device authorization from another browser. The source was an uploaded three-file synthetic snapshot containing a scanner-detectable `eval` call; it was never executed. This was not a GitHub OAuth capture or evidence about a customer repository.

| User action | Observed persisted result |
| --- | --- |
| Upload the snapshot and start an assessment with automatic investigation enabled | Scanner produced one medium indication. The durable worker ran the investigation graph with `gpt-6-luna`: two model calls, two evidence reads and 31,908 tokens. One call alone consumed 23,697 tokens, exceeding the former fixed limit. The report saved the explanation, evidence references, implications, risks and validation plan. |
| Choose `gpt-6.1-sol` and save/test the connection | The real Codex probe completed with 5,832 tokens. |
| Choose **Corregir con IA** and confirm the scoped consent | The correction graph made one real Sol call, consuming 8,174 tokens. It produced a private replacement snapshot and a saved one-file diff. An independent static rescan completed with zero indications. |
| Reload the report and repeat the same correction request | The saved correction and rescan link remained available. Concurrent repeated requests returned the existing correction ID without another model invocation. |
| Choose **Preparar propuesta de PR** | The interface explained the missing verified repository binding and preserved the private correction. No provider write or PR was performed. |
| Delete an older generated fixture candidate through the customer service | The source body, saved model patch, diff and explanation were erased together. Usage and digest metadata remained. The newer Sol correction retained its source and private diff. |
| Expire that older synthetic report and run the coordinator retention service | PostgreSQL deleted the expired report and its correction request. The completed job and its 7,217-token usage remained; the newer Sol correction stayed prepared. Migrations 059 and 060 applied successfully. |

Subscription reservations in this run settled with their actual token usage and zero reserved tokens. Two older, uncertain investigations from before the fix retain their historical holds; they were not silently cleared. A zero-indication rescan does not establish behavioral correctness. Independent behavioral validation remained inconclusive because no validation suite or VM runner was configured. GitHub write binding, VM validation, human exact approval and actual PR publication therefore remain unverified here.

No test suites, lint, standalone checks or CI waits were run for these changes after the Owner requested functional verification only. Runtime packages were built to operate the local product. The newly committed regression sources remain unexecuted, including concurrent retention and admission scenarios. Contended or held reports defer cleanup; the existing 500-report batch can delay later expired reports behind held rows. API-key providers and a fresh Claude connection were not exercised in this current run.

### Authorized arena-criolla source run

The Owner authorized `0bkevin/arena-criolla` as the repository for a draft-PR workflow exercise. A read-only clone at `12ba507e329283e9c5f17ff90fc058c06d5f9dfb` supplied a pinned snapshot of all 337 supported files: 3,014,368 serialized bytes, canonical digest `28eb36949dce9a1e8a8854ece91edb4f2ced9dbc26c0f6ae6f636da4adbbf25c`. Another 342 tracked files were excluded by the existing format allowlist. This was a clone snapshot, not GitHub OAuth capture or a complete repository archive. No repository code, dependency installation or test script was executed.

The first durable scan ended `assessment_reconciliation_required` and remains recorded. A separate diagnostic run of the real scanner completed; the old scanner service subsequently returned HTTP 503 immediately. After restarting only this thread's local stack, a new durable assessment completed and saved report `81663e41-4c32-4419-8783-b6f72a688edc` with 22 indications. The original service failure's underlying cause was not established; restarting is recovery evidence, not a demonstrated code fix.

Three automatic Codex investigations completed with two model calls and two evidence reads each, recording 15,482, 15,520 and 15,541 tokens with no remaining token reservations. All three classified the loaded generic-key evidence as `no_issue_supported`, retained `independentVerification: not_verified`, and produced no correction suggestion. No credential was exercised or declared valid, and no vulnerability was introduced to manufacture a PR.

Coverage remains partial: 228 exact dependency entries were inventoried, but advisory queries covered at most 200 unique versions. Two advisory matches and license-review items require their own assessment; the three investigations do not settle those observations. The current VM suite cannot validate this repository from the source snapshot alone: its tests consume excluded HTML/image assets and do not emit the required structured regression artifact. PR publication remains unverified. The repository's existing pull-request workflow may run for drafts; no CI was started or awaited by this exercise.

### Single GitHub connection verification

The local product now runs in `single_app` mode with the broker ready and publication disabled. Web receives only the public App ID, client ID and slug; its service environment has no private App or legacy Reader credential path. Actual broker requests returned 401 without internal authentication, 400 for invalid input and 403 for an unbound repository. The disabled write-verification endpoint returned 503. No repository branch, PR or workflow was created.

A direct invocation of the connection route, using the existing fixture Owner identity and real PostgreSQL services, returned the official GitHub authorization URL with the configured App, actor-bound state, PKCE and the expected callback. This proves route/state preparation, not a browser-authenticated OAuth exchange. A live installation metadata response confirmed the additional account fields that previously broke provider parsing. A temporary metadata-only token was created and revoked; no source or write token was exported to web.

Review fixes cover provider account projection, exact backend repository scopes, wrapped workflow base64, suspended installations and verification before the first write grant. Capture admission now preserves immutable provenance and atomically binds the saved snapshot. Migration 063 allows identical canonical bytes under different capture authority, while ordinary uploads retain digest deduplication. The first-scan idempotency key includes the saved source ID. Reuploading the real Arena clone snapshot reused its existing source; unauthorized capture admission remained rejected. Regression sources for these changes are committed but unrun. The GitHub account consent, an actual OAuth repository capture, positive reconnect/concurrency regression execution, VM validation, exact approval and draft-PR publication remain unverified.
