# Autoalojar Gotchu

Este flujo ejecuta Gotchu en la máquina del operador. No publica imágenes ni envía código a un servicio de pago.

## Requisitos

- Linux x86_64 con Docker Engine activo y Docker Compose v2. Ejecuta `./gotchu` desde una cuenta sin privilegios que ya tenga acceso al daemon Docker; no se requiere `sudo`. Docker Desktop en macOS/Windows no está validado.
- Node.js 24, pnpm 11, OpenSSL y al menos 5 GiB libres en el almacenamiento de Docker. Hace falta Internet la primera vez para instalar dependencias y descargar imágenes.
- Puertos loopback libres: web `3000`, coordinator `3003`, scanner `4400`, PostgreSQL `55432` y Redis `56379`. Configúralos con `GOTCHU_WEB_PORT`, `GOTCHU_COORDINATOR_PORT`, `GOTCHU_SCANNER_PORT`, `GOTCHU_POSTGRES_PORT` y `GOTCHU_REDIS_PORT` antes del primer arranque.

## Instalar y configurar Owner

Desde una máquina limpia:

```sh
git clone <url-del-repositorio>
cd gotchu
./gotchu up
```

`up` instala dependencias si faltan, comprueba Docker/Compose, puertos y espacio, genera secretos con permisos privados, prepara las imágenes Semgrep/Gitleaks/Trivy y Postgres/Redis, ejecuta migraciones y provisioning de roles, inicia los datos en Compose y ejecuta web, coordinator y scanner como procesos locales enlazados sólo a `127.0.0.1`. El coordinator y el scanner se comunican por HTTPS con certificado local y HMAC; el readiness espera los perfiles reales del scanner. El scanner usa el daemon Docker del operador para ejecutar sus contenedores fijados; esos contenedores de análisis usan `--network none`. Ninguna conexión entre contenedores y el scanner cruza el host ni depende de una regla en `INPUT`, por lo que no hay que editar `firewalld`, `ufw` ni reglas de iptables. La primera preparación puede tardar varios minutos mientras Docker descarga imágenes. No imprime las credenciales.

Abre el enlace `/setup?token=…` que imprime `up`. Caduca en una hora y sólo se puede usar una vez. El formulario crea en una operación atómica la cuenta, el primer workspace y su membership Owner. Después de bootstrap, el registro abierto permanece deshabilitado; invita a las demás personas desde **Personas y acceso**. Para emitir otro enlace antes de que exista un Owner:

```sh
./gotchu setup-link
```

El comando invalida enlaces anteriores no usados. No puede emitir enlaces cuando ya hay un Owner.

## Primer escaneo

En el dashboard, **Conectar GitHub** crea el primer espacio y la aplicación si hace falta; después del regreso de GitHub, cada repositorio tiene su propio botón **Analizar**. Para código local, elige una carpeta y pulsa **Analizar carpeta**. Ambas rutas conservan el consentimiento explícito antes de guardar una instantánea y poner en cola el trabajo. El escaneo no instala dependencias ni ejecuta código del cliente. Las fuentes subidas se conservan en Postgres local hasta su vencimiento según la retención del espacio de trabajo o hasta ejecutar `reset`.

Un Owner puede cambiar los plazos desde **Retención** en el dashboard. Los valores iniciales son: instantáneas de código 90 días, imágenes de contenedor 30, informes 365, observaciones 30, ejecuciones 30, entregas de notificaciones 90 y eventos de protección 30. El coordinator ejecuta el trabajo durable de limpieza aun cuando el monitoreo programado esté desactivado y vuelve a revisar cada aplicación al menos cada diez minutos. Mantiene fuentes usadas por trabajos activos o en reconciliación; al vencer, elimina el contenido de las instantáneas e imágenes y sus informes, observaciones y alertas vencidos, ejecuciones finalizadas, entregas antiguas y eventos de protección. También recorta ejecuciones completadas, observaciones y planes antiguos para permanecer bajo sus cuotas de 1.000, 2.000 y 100 elementos; al alcanzar una cuota, ese historial puede borrarse antes del plazo configurado. La página **Vigilancia** muestra el consumo actual y las cuotas diarias; si se agotan las 100 proyecciones diarias, los eventos firmados aceptados siguen procesándose y la cobertura se marca incompleta. Los identificadores mínimos de fuentes se conservan para mantener las referencias de solicitudes. Esto no ofrece borrado permanente de aplicaciones o espacios de trabajo.

Semgrep está fijado en 1.182.0 por digest. La validación local Linux/amd64 cubre los perfiles acotados que registra [`docs/validation.md`](./validation.md); el gate general de perfil y las garantías de precisión/capacidad siguen cerrados. Los informes muestran cobertura parcial y desconocida; un resultado sin hallazgos no demuestra que el sistema sea seguro.

## Investigación con IA

En un despliegue con el investigador y el gateway D11 habilitados, una persona Owner abre la configuración de investigación del workspace, elige un proveedor, pega su clave API y guarda. El modelo sugerido puede cambiarse o escribirse como texto libre. La clave se almacena sólo en el servidor; Gotchu exige consentimiento explícito por categoría y conserva los límites de gasto y tokens. **Probar conexión** envía una solicitud mínima de hasta 64 tokens por el gateway y muestra un resultado breve.

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
| OpenRouter | Escribe un ID del catálogo de OpenRouter | [API](https://openrouter.ai/docs/api_reference/overview) · [catálogo](https://openrouter.ai/models) |
| Custom OpenAI-compatible | Escribe el ID y endpoint | [formato de chat](https://developers.openai.com/api/reference/chat/completions/overview) |

Los proveedores alojados usan sus endpoints HTTPS oficiales. Custom OpenAI-compatible requiere HTTPS y DNS público; para permitir un endpoint autohospedado, el operador debe establecer `GOTCHU_ALLOW_SELF_HOSTED_LLM_ENDPOINT=true` tanto en Web como en Gateway. En despliegues separados, configura `GOTCHU_GATEWAY_URL` en Web, comparte el mismo secreto aleatorio base64url de al menos 32 bytes mediante `GOTCHU_GATEWAY_MODEL_PROBE_SECRET` entre Web y Gateway, y proporciona al Gateway acceso al almacén de claves de modelo configurado. No pongas claves de proveedor en variables del navegador ni en logs.

El arranque local de esta guía mantiene Agent y Gateway deshabilitados; en esa topología, la prueba de conexión informa que no está disponible. Los proveedores quedan utilizables cuando el operador habilita y configura esos servicios con sus credenciales y transporte privado.

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

`./gotchu doctor` comprueba requisitos frecuentes. GitHub App es opcional y sólo necesita permisos de lectura. El executor, las escrituras a proveedores y el validator VM no están disponibles. El validator requiere Linux, `/dev/kvm`, `bwrap`, una sesión systemd de usuario, runtime login, clave privada y preparación de imágenes; el worker se puede ejecutar manualmente después de configurar esos valores con `GOTCHU_VALIDATOR_DATABASE_URL=… GOTCHU_VALIDATOR_KEY_PATH=… pnpm --filter @gotchu/validator start`. `doctor` indica cuando faltan esos requisitos. No hay una promesa de aislamiento VM lista para producción.

### Configurar GitHub App

`./gotchu github setup` muestra callbacks absolutos derivados del `PUBLIC_APP_URL` configurado y prepara la carpeta privada de credenciales. En GitHub configura una GitHub App con `Contents: Read-only` y `Metadata: Read-only`, instala sólo los repositorios autorizados y guarda su JSON en `${state_dir}/github/reader-app.json` con permisos `0600`. En `${state_dir}/.env` configura:

```dotenv
GOTCHU_GITHUB_READER_APP_FILE=${state_dir}/github/reader-app.json
GOTCHU_GITHUB_APP_SLUG=<slug-de-la-app>
```

En la configuración de la GitHub App, registra la URL exacta que imprime `./gotchu github setup` para la instalación, normalmente `http://localhost:3000/api/customer/github/callback`. Ejecuta `./gotchu up` para aplicar la configuración. Después, **Conectar GitHub** abre la instalación autorizada y vuelve a Gotchu; cada repositorio autorizado aparece con su botón **Analizar**, que guarda una instantánea y encola la primera evaluación. El permiso `Contents` permanece en sólo lectura.

Para ofrecer además **Iniciar sesión con GitHub**, registra la URL exacta `<origin>/api/auth/callback/github` que imprime `./gotchu github setup` como callback URL de autorización de la GitHub App. Mantén también `<origin>/api/customer/github/callback` para **Conectar GitHub**. En `${state_dir}/.env`, define `AUTH_GITHUB_ID=<client-id>` y `AUTH_GITHUB_SECRET=<client-secret>` con las credenciales de esa App. También puedes crear una OAuth App separada, registrar allí `<origin>/api/auth/callback/github` y usar su client ID/secret en esas mismas variables. Gotchu muestra el botón de GitHub en la página de inicio de sesión sólo cuando ambas variables están configuradas. Reinicia con `./gotchu up` para aplicar cambios. No copies IDs ni secrets a páginas ni a logs. OIDC y el inicio local siguen disponibles. Consulta [callbacks de autorización de GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url) y la [configuración del proveedor GitHub de Auth.js](https://authjs.dev/guides/configuring-github).

### Iniciar sesión con Google

Ejecuta `./gotchu google setup`. El comando lee `PUBLIC_APP_URL` del archivo privado `${state_dir}/.env` y muestra el origen de JavaScript autorizado y el URI de redirección exactos. En Google Cloud Console, crea o abre un cliente OAuth de tipo **Aplicación web** y registra esos valores en **Orígenes de JavaScript autorizados** y **URI de redirección autorizados**. El callback es `<origin>/api/auth/callback/google`. Si compartes un cliente entre desarrollo y producción, registra también `http://localhost:3000` y `http://localhost:3000/api/auth/callback/google`.

En la pantalla de consentimiento, configura el dominio autorizado y los enlaces públicos de privacidad y términos. Las páginas `/privacy` y `/terms` de Gotchu son borradores; el operador debe revisarlas antes de ofrecer el servicio. Si la aplicación OAuth continúa en modo de prueba, añade como usuarios de prueba a las personas que iniciarán sesión.

En `${state_dir}/.env`, configura `AUTH_GOOGLE_ID=<client-id>` y `AUTH_GOOGLE_SECRET=<client-secret>`. El botón aparece sólo cuando ambas variables están presentes. Gotchu solicita `openid email profile` y acepta únicamente perfiles con correo verificado por Google. Los usuarios nuevos pasan al onboarding normal una vez iniciada la sesión. En una instalación autoalojada, Google no puede crear al primer Owner: antes debe completarse `/setup` con el enlace de un solo uso de `./gotchu up` o `./gotchu setup-link`.

Si el correo verificado ya pertenece a una cuenta local, Gotchu no vincula Google automáticamente. Inicia sesión con la contraseña local; la vinculación explícita desde ajustes de cuenta queda pendiente porque la aplicación todavía no cuenta con persistencia de identidades enlazadas. Reinicia con `./gotchu up` después de cambiar las variables. No copies el client secret a páginas, capturas ni registros.

## Seguridad y exposición

- Los puertos de web, coordinator, scanner, Postgres y Redis enlazan sólo a `127.0.0.1`. No cambies el bind a una interfaz pública.
- Mantén `${state_dir:-.gotchu}` privado: `.env`, el secreto HMAC, la clave TLS local del scanner, las credenciales GitHub, archivos de identidad de procesos y registros viven ahí con permisos `0600`; el directorio de estado y `github/` usan `0700`. El coordinator confía en el certificado local sólo para la conexión HTTPS al scanner. No subas estos archivos a Git ni compartas enlaces de configuración.
- `./gotchu up` verifica por HTTPS el mismo endpoint de readiness que ejecuta los perfiles fijados del scanner antes de anunciar que está listo. Web, coordinator y scanner son procesos locales; Compose inicia sólo Postgres y Redis. Así, el tráfico del scanner no cruza el host INPUT y la instalación no requiere cambios de firewall.
- El bootstrap inicial usa el flujo local `/setup` para crear el primer Owner. Google, GitHub y OIDC no pueden sustituirlo. Las contraseñas locales usan el hash scrypt existente y los límites actuales de autenticación.
- `PUBLIC_APP_URL` es el origen canónico usado por Auth.js. En producción detrás de un proxy reverso, configúralo como `https://gotchu.kevinbravo.com`; TLS debe terminar en el proxy, que debe limitar tamaños y tiempos de petición y reenviar únicamente a la dirección loopback del puerto web configurado. `GOTCHU_PUBLIC_URL` sólo establece el valor inicial al crear `${state_dir}/.env`; después, edita `PUBLIC_APP_URL` en ese archivo y reinicia con `./gotchu up`. Gotchu no termina TLS y no afirma que esta topología esté endurecida para producción.
- La evaluación externa sólo debe apuntar a un origen cuya autorización tenga el cliente. Las acciones de proveedor, ejecución de código cliente, respuesta automática y recuperación permanecen deshabilitadas.
- `./gotchu backup [archivo]` y `./gotchu restore <archivo>` usan un respaldo local cifrado y probado contra Postgres desechable. La restauración incrementa el epoch, deja las escrituras de proveedor congeladas y los servicios detenidos. La copia por defecto permanece en el mismo disco; la réplica externa, retención de archivos y objetivos medidos de recuperación siguen pendientes.

## Actualizar y desinstalar

`./gotchu upgrade` no modifica el checkout ni ejecuta `git pull`: reconstruye desde los archivos locales, aplica migraciones y reinicia conservando volúmenes y configuración. Actualiza el repositorio después de revisar sus cambios y luego ejecuta el comando. No hay rollback automatizado: toma una copia de datos antes de actualizar.

Para detener Gotchu sin borrar los datos, usa `./gotchu down`. Para eliminar sus contenedores, volúmenes y secretos de ese estado local, confirma `./gotchu reset`; luego puedes borrar el checkout. `reset` conserva la carpeta hermana `.gotchu.backups/`; borra sus respaldos cifrados manualmente cuando ya no deban conservarse. Mantén fuera del directorio de estado la única copia que necesites para restaurar después de una pérdida del host.
