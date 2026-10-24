ALTER TABLE gotchu.gateway_read_calls DROP CONSTRAINT gateway_read_calls_tool_name_check;
ALTER TABLE gotchu.gateway_read_calls ADD CONSTRAINT gateway_read_calls_tool_name_check CHECK(tool_name IN (
  'evidence.read','auth.events.read','application.context.read','finding.details.read',
  'source.excerpt.read','assessment.diff.read','validation.results.read','triage.results.read'
));
ALTER TABLE gotchu.gateway_read_calls DROP CONSTRAINT gateway_read_calls_response_check;
ALTER TABLE gotchu.gateway_read_calls ADD CONSTRAINT gateway_read_calls_response_check CHECK(octet_length(response::text)<=16384);
ALTER TABLE gotchu.gateway_read_calls ADD COLUMN data_scope text NOT NULL DEFAULT 'runtime_summaries'
  CHECK(data_scope IN ('application_context','finding_details','source_excerpts','assessment_diffs','validation_results','triage_summaries','runtime_summaries'));
