-- Claude Code and Codex run the vendor CLI with the customer's own subscription login.
ALTER TABLE gotchu.investigation_model_settings
  DROP CONSTRAINT investigation_model_settings_provider_check,
  DROP CONSTRAINT investigation_model_provider_preset,
  DROP CONSTRAINT investigation_model_provider_adapter;

ALTER TABLE gotchu.investigation_model_settings
  ADD CONSTRAINT investigation_model_settings_provider_check CHECK (provider IN (
    'openai_compatible','anthropic_messages','claude_code_cli','codex_cli'
  )),
  ADD CONSTRAINT investigation_model_provider_preset CHECK (provider_preset_id IN (
    'openai','anthropic','google_gemini','deepseek','moonshot','zhipu_glm','mistral','xai','groq','openrouter','custom_openai_compatible',
    'claude_code','codex'
  )),
  ADD CONSTRAINT investigation_model_provider_adapter CHECK (provider = CASE provider_preset_id
    WHEN 'anthropic' THEN 'anthropic_messages'
    WHEN 'claude_code' THEN 'claude_code_cli'
    WHEN 'codex' THEN 'codex_cli'
    ELSE 'openai_compatible'
  END);

ALTER TABLE gotchu.model_reservations DROP CONSTRAINT model_reservations_provider_check;
ALTER TABLE gotchu.model_reservations ADD CONSTRAINT model_reservations_provider_check CHECK (provider IS NULL OR provider IN (
  'openai_compatible','anthropic_messages','claude_code_cli','codex_cli'
));
