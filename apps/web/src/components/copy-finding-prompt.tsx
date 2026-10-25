import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from './ui/button';

/** Icon button that copies a ready-made coding-assistant instruction for one finding. */
export function CopyFindingPrompt({ prompt }: { prompt: () => string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timeout = window.setTimeout(() => setState('idle'), 2_000);
    return () => window.clearTimeout(timeout);
  }, [state]);
  const label = state === 'copied' ? 'Instrucción copiada' : state === 'failed' ? 'No se pudo copiar' : 'Copiar instrucción para un LLM';
  return <Button type="button" variant="ghost" size="icon-sm" aria-label={label} title={label} onClick={() => {
    navigator.clipboard.writeText(prompt()).then(() => setState('copied'), () => setState('failed'));
  }}>
    {state === 'copied' ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
    <span className="sr-only" role="status">{state === 'idle' ? '' : label}</span>
  </Button>;
}
