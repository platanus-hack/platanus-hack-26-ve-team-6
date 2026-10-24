import { createFileRoute } from '@tanstack/react-router';
import { PublicTop } from '../components/public-top';
import '../components/public-legal.css';

export const Route = createFileRoute('/privacy')({
  head: () => ({ meta: [{ title: 'Privacidad · Gotchu' }] }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return <main className="gl pub-page"><PublicTop /><article className="pub-doc" aria-labelledby="privacy-title">
    <h1 id="privacy-title">Aviso de privacidad</h1>
    <p className="pub-note"><strong>Borrador:</strong> la persona operadora debe revisar y completar este aviso antes de ofrecer Gotchu a otras personas.</p>
    <p>Gotchu se ejecuta en la infraestructura de quien lo opera. La configuración concreta de retención, acceso y copias de respaldo depende de esa instalación.</p>
    <h2>Datos que puede almacenar Gotchu</h2>
    <ul>
      <li>Identificadores de cuenta, correo electrónico y nombre de perfil usados para iniciar sesión. Al usar Google, Gotchu exige un correo marcado como verificado.</li>
      <li>Espacios de trabajo, membresías y permisos, además de los registros necesarios para administrar la cuenta.</li>
      <li>El alcance HTTPS autorizado, las instantáneas de código que envía el equipo, sus evaluaciones, evidencias e informes.</li>
      <li>Configuración e identificadores de integraciones que el operador haya habilitado.</li>
    </ul>
    <p>Gotchu no guarda contraseñas en texto claro. Los tokens de acceso y renovación de Google no se incluyen en la sesión de Gotchu. La opción para recordar el acceso en este dispositivo guarda únicamente el correo y el último método en el almacenamiento local del navegador; no guarda contraseñas ni tokens.</p>
    <h2>Revisión del operador</h2>
    <p>Antes de publicar este aviso, el operador debe definir quién administra la instalación, el contacto de privacidad, las finalidades y plazos de conservación, el procedimiento de eliminación, los proveedores externos aplicables y la jurisdicción correspondiente.</p>
    <a className="pub-link" href="/dashboard">Volver al inicio de sesión</a>
  </article></main>;
}
