import { useId, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { validationSuiteConfigSchema, validationTestSelectionSchema } from '@gotchu/contracts';
import { customerApi } from './customer-client';

export function ValidationSuiteConfig({ organizationId, applicationId, repositoryLinkId }: {
  organizationId: string;
  applicationId: string;
  repositoryLinkId: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [suiteName, setSuiteName] = useState('');
  const [filesText, setFilesText] = useState('');
  const [namePattern, setNamePattern] = useState('');
  const [requiredCount, setRequiredCount] = useState('1');
  const [formError, setFormError] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (input: Parameters<typeof customerApi.configureValidationSuite>[0]) => customerApi.configureValidationSuite(input) });

  function clearResult() {
    setFormError(null);
    save.reset();
  }

  function closeForm() {
    clearResult();
    setSuiteName('');
    setFilesText('');
    setNamePattern('');
    setRequiredCount('1');
    setOpen(false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    clearResult();

    const files = filesText.split(/\r?\n/).map(file => file.trim()).filter(Boolean);
    const selection = validationTestSelectionSchema.safeParse({
      files,
      ...(namePattern.trim() ? { namePattern: namePattern.trim() } : {}),
    });
    if (!selection.success) {
      const hasFileIssue = selection.error.issues.some(issue => issue.path[0] === 'files');
      setFormError(hasFileIssue
        ? files.length === 0
          ? 'Añade al menos un archivo de prueba.'
          : files.length > 20
            ? 'Selecciona como máximo 20 archivos de prueba.'
            : new Set(files).size !== files.length
              ? 'Elimina las rutas duplicadas.'
              : 'Cada ruta debe ser un archivo de prueba .test o .spec del repositorio.'
        : 'El patrón de nombres debe ser una expresión regular válida de hasta 256 caracteres.');
      return;
    }

    const config = validationSuiteConfigSchema.safeParse({
      organizationId,
      applicationId,
      repositoryLinkId,
      suiteName,
      scriptName: 'test',
      profile: 'node24-tsx-selected-v1',
      regressionTestPath: null,
      testSelection: selection.data,
      requiredCount: Number(requiredCount),
    });
    if (!config.success) {
      const issue = config.error.issues[0];
      setFormError(issue?.path.includes('suiteName')
        ? 'Escribe un nombre para esta configuración (máximo 128 caracteres).'
        : issue?.path.includes('requiredCount')
          ? 'Indica un número entero de pruebas necesarias entre 1 y 10 000.'
          : 'Revisa los datos de la configuración e inténtalo de nuevo.');
      return;
    }

    save.mutate({
      organizationId: config.data.organizationId,
      applicationId: config.data.applicationId,
      repositoryLinkId: config.data.repositoryLinkId,
      suiteName: config.data.suiteName,
      testSelection: selection.data,
      requiredCount: config.data.requiredCount,
    });
  }

  return <div className="customer-validation-suite-config">
    <button
      className="customer-link-button"
      type="button"
      aria-expanded={open}
      aria-controls={`${id}-form`}
      disabled={save.isPending}
      onClick={() => open ? closeForm() : setOpen(true)}
    >{open ? 'Cancelar configuración' : 'Configurar validación'}</button>
    <div id={`${id}-form`} className="customer-context-forms" style={{ display: open ? undefined : 'none' }}>
      <form onSubmit={submit} style={{ gridColumn: '1 / -1', display: 'grid', gap: '10px' }}>
        <h3>Pruebas de compatibilidad</h3>
        <p className="customer-field-note">La selección define la cobertura de compatibilidad y excluye la suite completa. En una futura validación de candidatos, estos archivos se ejecutarán sin modificarse dentro de una VM aislada. Guardar solo registra la configuración: no ejecuta pruebas ni concede permisos para abrir un PR.</p>
        <label className="customer-context-label" htmlFor={`${id}-name`}>Nombre de la configuración</label>
        <input id={`${id}-name`} value={suiteName} maxLength={128} required disabled={save.isPending} onChange={event => { setSuiteName(event.currentTarget.value); clearResult(); }} />
        <label className="customer-context-label" htmlFor={`${id}-files`}>Archivos de prueba existentes del repositorio</label>
        <textarea id={`${id}-files`} value={filesText} rows={5} required disabled={save.isPending} onChange={event => { setFilesText(event.currentTarget.value); clearResult(); }} aria-describedby={`${id}-files-note`} />
        <small id={`${id}-files-note`}>Una ruta relativa a la raíz por línea; entre 1 y 20 archivos .test o .spec.</small>
        <label className="customer-context-label" htmlFor={`${id}-pattern`}>Patrón opcional de nombres de prueba</label>
        <input id={`${id}-pattern`} value={namePattern} maxLength={256} disabled={save.isPending} onChange={event => { setNamePattern(event.currentTarget.value); clearResult(); }} />
        <label className="customer-context-label" htmlFor={`${id}-required-count`}>Número mínimo de pruebas aprobadas</label>
        <input id={`${id}-required-count`} type="number" min={1} max={10_000} step={1} required value={requiredCount} disabled={save.isPending} onChange={event => { setRequiredCount(event.currentTarget.value); clearResult(); }} />
        {formError && <p className="customer-form-error" role="alert">{formError}</p>}
        {save.isError && <p className="customer-form-error" role="alert">No se pudo guardar la configuración. Inténtalo de nuevo.</p>}
        {save.data && <section className="customer-success" role="status"><div>
          <p>Configuración guardada, versión {save.data.version}. Archivos registrados:</p>
          {save.data.testSelection && <ul>{save.data.testSelection.files.map(file => <li key={file}><code>{file}</code></li>)}</ul>}
        </div></section>}
        <div><button className="customer-button customer-button-secondary" type="submit" disabled={save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar configuración'}</button></div>
      </form>
    </div>
  </div>;
}
