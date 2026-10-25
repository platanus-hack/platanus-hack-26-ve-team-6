import { useState } from 'react';
import type { InvestigationProviderPreset } from '@gotchu/contracts';

export function InvestigationModelPicker({ preset, modelId, onChange, disabled }: {
  preset: InvestigationProviderPreset; modelId: string; onChange(modelId: string): void; disabled: boolean;
}) {
  const [manual, setManual] = useState(false);
  const custom = manual || !preset.suggestedModelIds.includes(modelId);
  return <>
    <label htmlFor="investigation-model-choice">Modelo</label>
    <select id="investigation-model-choice" value={custom ? '__custom__' : modelId} disabled={disabled} onChange={event => {
      if (event.target.value === '__custom__') setManual(true);
      else { setManual(false); onChange(event.target.value); }
    }}>
      {preset.suggestedModelIds.map(model => <option value={model} key={model}>{model}{model === preset.defaultModelId ? ' · predeterminado' : ''}</option>)}
      <option value="__custom__">{preset.suggestedModelIds.length ? 'Otro modelo…' : 'Modelo de tu servidor'}</option>
    </select>
    {custom && <>
      <label htmlFor="investigation-model-id">ID del modelo personalizado</label>
      <input id="investigation-model-id" value={modelId} onChange={event => onChange(event.target.value)} maxLength={200} disabled={disabled} placeholder="ID indicado por el proveedor" />
    </>}
    {preset.modelDocsUrl && <p className="customer-field-note"><a href={preset.modelDocsUrl} target="_blank" rel="noopener noreferrer">Ver modelos de {preset.displayName}</a></p>}
  </>;
}
