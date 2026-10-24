import { createFileRoute } from '@tanstack/react-router';
import '../components/public-legal.css';

export const Route = createFileRoute('/terms')({
  head: () => ({ meta: [{ title: 'Términos · Gotchu' }] }),
  component: TermsPage,
});

function TermsPage() {
  return <main className="customer-legal-page"><article className="customer-legal-document" aria-labelledby="terms-title">
    <a className="customer-legal-brand" href="/dashboard"><span className="customer-legal-brand-mark" aria-hidden="true">g</span>gotchu.</a>
    <h1 id="terms-title">Términos de uso</h1>
    <p className="customer-legal-draft"><strong>Borrador:</strong> la persona operadora debe revisar y completar estos términos antes de ofrecer Gotchu a otras personas.</p>
    <p>Usa Gotchu únicamente con aplicaciones, repositorios y dominios sobre los que tengas autorización. Define y confirma el alcance antes de solicitar una evaluación HTTPS.</p>
    <h2>Alcance de los resultados</h2>
    <p>Las evaluaciones aplican perfiles acotados y pueden tener cobertura parcial. Un informe sin observaciones no demuestra que una aplicación sea segura ni reemplaza una auditoría completa, respuesta a incidentes o revisión profesional.</p>
    <h2>Responsabilidad de la instalación</h2>
    <p>La persona operadora administra las cuentas, los permisos, la disponibilidad y los datos guardados en su instalación. Protege tus credenciales y no envíes información que no tengas autorización para compartir.</p>
    <p>Este texto es provisional. El operador debe revisar las condiciones de acceso, los límites del servicio, el contacto, las reglas de suspensión y las condiciones legales aplicables a su instalación.</p>
    <a className="customer-legal-back" href="/dashboard">Volver al inicio de sesión</a>
  </article></main>;
}
