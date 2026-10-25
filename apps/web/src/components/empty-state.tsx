import './onboarding.css';

export function FirstProjectEmptyState({ canManage, onCreateProject, onAnalyzeWeb }: {
  canManage: boolean;
  onCreateProject: () => void;
  onAnalyzeWeb: () => void;
}) {
  return <section className="customer-first-project-empty" aria-labelledby="first-project-title">
    <h1 id="first-project-title">Agrega tu primer proyecto</h1>
    {!canManage && <p>Una persona Owner u Operator puede crear proyectos e iniciar revisiones.</p>}
    <div className="customer-first-project-actions">
      <button className="customer-button customer-button-primary" data-catch onClick={onCreateProject} disabled={!canManage}>Crear proyecto</button>
      <button className="customer-button customer-button-secondary" onClick={onAnalyzeWeb} disabled={!canManage}>Analizar una web por URL</button>
    </div>
  </section>;
}
