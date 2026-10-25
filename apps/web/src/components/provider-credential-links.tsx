import type { InvestigationProviderPreset } from '@gotchu/contracts';

const keyUrls = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://platform.claude.com/settings/keys',
  google_gemini: 'https://aistudio.google.com/apikey',
  deepseek: 'https://platform.deepseek.com/api_keys',
  moonshot: 'https://platform.kimi.ai/console/api-keys',
  zhipu_glm: 'https://z.ai/manage-apikey/apikey-list',
  mistral: 'https://console.mistral.ai/api-keys',
  xai: 'https://console.x.ai',
  groq: 'https://console.groq.com/keys',
  openrouter: 'https://openrouter.ai/settings/keys',
} as const;

export function ProviderCredentialLink({ preset }: { preset: InvestigationProviderPreset }) {
  if (preset.billing === 'subscription' || preset.id === 'custom_openai_compatible') return null;
  const url = Object.entries(keyUrls).find(([id]) => id === preset.id)?.[1];
  if (!url) return null;
  return <div>
    <a className="customer-button" href={url} target="_blank" rel="noopener noreferrer">Obtener clave de {preset.displayName}</a>
    <p className="customer-field-note">Crea una clave en la página del proveedor y pégala aquí. Al guardar y probar se hace una solicitud pequeña con tu presupuesto; la clave se conserva sólo en el servidor.</p>
  </div>;
}
