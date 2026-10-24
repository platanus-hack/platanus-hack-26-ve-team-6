ALTER TABLE gotchu.investigation_model_settings ADD COLUMN provider_preset_id text;

UPDATE gotchu.investigation_model_settings
SET provider_preset_id = CASE
  WHEN provider='anthropic_messages' THEN 'anthropic'
  WHEN endpoint='https://api.openai.com/v1' THEN 'openai'
  ELSE 'custom_openai_compatible'
END,
endpoint = CASE
  WHEN provider='anthropic_messages' THEN 'https://api.anthropic.com/v1'
  ELSE endpoint
END;

ALTER TABLE gotchu.investigation_model_settings
  ALTER COLUMN provider_preset_id SET NOT NULL,
  ADD CONSTRAINT investigation_model_provider_preset CHECK (provider_preset_id IN (
    'openai','anthropic','google_gemini','deepseek','moonshot','zhipu_glm','mistral','xai','groq','openrouter','custom_openai_compatible'
  )),
  ADD CONSTRAINT investigation_model_provider_adapter CHECK (
    (provider_preset_id='anthropic') = (provider='anthropic_messages')
  );
