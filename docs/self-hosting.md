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

En el dashboard, crea una aplicación, sube una carpeta o un pequeño conjunto de archivos JS/TS/configuración y elige `internal`. El escaneo no instala dependencias ni ejecuta código del cliente. Las fuentes subidas se conservan en Postgres local hasta que se eliminen o se ejecute `reset`.

El perfil Semgrep fijado en 1.90.0 está permitido sólo para desarrollo/pruebas. No se debe describir como SAST de producción. Los informes muestran cobertura parcial y desconocida; un resultado sin hallazgos no demuestra que el sistema sea seguro.

## Comandos

```sh
./gotchu status             # servicios, límites y componentes opcionales
./gotchu logs               # todos los registros
./gotchu logs web           # también coordinator, scanner, postgres o redis
./gotchu down               # detiene procesos; conserva los datos
./gotchu up                 # reinicia y conserva los datos
./gotchu upgrade            # reconstruye desde el checkout actual y migra
./gotchu github setup       # permisos mínimos y rutas de credenciales opcionales
./gotchu reset              # pide escribir RESET; borra volúmenes y secretos locales
```

`./gotchu doctor` comprueba requisitos frecuentes. El executor y las escrituras a proveedores no están disponibles. GitHub App no se necesita para el flujo local; su guía no implica que el adaptador esté activado. El validator VM aún no se inicia desde Compose. Requiere Linux, `/dev/kvm`, `bwrap`, una sesión systemd de usuario, runtime login, clave privada y preparación de imágenes; el worker se puede ejecutar manualmente después de configurar esos valores con `GOTCHU_VALIDATOR_DATABASE_URL=… GOTCHU_VALIDATOR_KEY_PATH=… pnpm --filter @gotchu/validator start`. `doctor` indica cuando faltan esos requisitos. No hay una promesa de aislamiento VM lista para producción.

## Seguridad y exposición

- Por defecto, los puertos publicados se enlazan a `127.0.0.1`. No cambies el bind de Compose para exponerlos directamente.
- Mantén `${state_dir:-.gotchu}` privado: `.env`, el secreto HMAC, la clave TLS local del scanner y registros viven ahí con permisos `0600`; el directorio usa `0700`. El coordinator confía en el certificado local sólo para la conexión HTTPS al scanner. No subas estos archivos a Git ni compartas enlaces de configuración.
- El primer arranque sólo permite credenciales locales para Auth.js. OIDC/GitHub no es obligatorio. Las contraseñas usan el hash scrypt existente y los límites actuales de autenticación.
- `GOTCHU_PUBLIC_URL` se debe configurar con un origen HTTPS si se accede a través de un proxy reverso. El proxy debe terminar TLS, autenticar la gestión del host, limitar tamaños y tiempos de petición y reenviar únicamente a `127.0.0.1:3000`. Edita `.gotchu/.env` y recrea web con `./gotchu up` después de cambiarlo. Gotchu no termina TLS y no afirma que esta topología esté endurecida para producción.
- La evaluación externa sólo debe apuntar a un origen cuya autorización tenga el cliente. Las acciones de proveedor, ejecución de código cliente, respuesta automática y recuperación permanecen deshabilitadas.
- Los backups/restore automatizados no están implementados. Antes de actualizar o eliminar datos, crea una copia consistente de los volúmenes de Postgres y Redis con un procedimiento local probado y protege esa copia como los secretos originales.

## Actualizar y desinstalar

`./gotchu upgrade` no modifica el checkout ni ejecuta `git pull`: reconstruye desde los archivos locales, aplica migraciones y reinicia conservando volúmenes y configuración. Actualiza el repositorio después de revisar sus cambios y luego ejecuta el comando. No hay rollback automatizado: toma una copia de datos antes de actualizar.

Para detener Gotchu sin borrar los datos, usa `./gotchu down`. Para eliminar sus contenedores, volúmenes y secretos de ese estado local, confirma `./gotchu reset`; luego puedes borrar el checkout. No hay backup/restore integrado.
