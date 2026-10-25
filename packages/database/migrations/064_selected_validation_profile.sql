ALTER TABLE gotchu.validation_suite_definitions
  DROP CONSTRAINT validation_suite_definitions_profile_check;
ALTER TABLE gotchu.validation_suite_definitions
  ADD CONSTRAINT validation_suite_definitions_profile_check
  CHECK (profile IN ('node24-npm-test','node24-tsx-selected-v1'));

ALTER TABLE gotchu.validation_runs
  DROP CONSTRAINT validation_runs_runner_profile_check;
ALTER TABLE gotchu.validation_runs
  ADD CONSTRAINT validation_runs_runner_profile_check
  CHECK (runner_profile IN ('node24-npm-test','node24-tsx-selected-v1'));

ALTER TABLE gotchu.validation_suite_definitions
  ADD COLUMN test_selection jsonb DEFAULT NULL;

CREATE FUNCTION gotchu.validation_test_selection_is_valid(p_selection jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
DECLARE
  selected_file jsonb;
  file_path text;
  seen_files text[] := ARRAY[]::text[];
BEGIN
  IF jsonb_typeof(p_selection) IS DISTINCT FROM 'object' OR octet_length(p_selection::text) > 8192 THEN
    RETURN false;
  END IF;
  IF p_selection - 'files' - 'namePattern' <> '{}'::jsonb
    OR NOT (p_selection ? 'files')
    OR jsonb_typeof(p_selection->'files') IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  IF jsonb_array_length(p_selection->'files') NOT BETWEEN 1 AND 20 THEN
    RETURN false;
  END IF;

  IF p_selection ? 'namePattern' THEN
    IF jsonb_typeof(p_selection->'namePattern') IS DISTINCT FROM 'string' THEN
      RETURN false;
    END IF;
    IF length(p_selection->>'namePattern') NOT BETWEEN 1 AND 256
      OR p_selection->>'namePattern' ~ '[[:cntrl:]]' THEN
      RETURN false;
    END IF;
  END IF;

  FOR selected_file IN SELECT value FROM jsonb_array_elements(p_selection->'files') AS item(value) LOOP
    IF jsonb_typeof(selected_file) <> 'string' THEN
      RETURN false;
    END IF;
    file_path := selected_file #>> '{}';
    IF length(file_path) NOT BETWEEN 1 AND 512
      OR file_path !~ '^([A-Za-z0-9_@][A-Za-z0-9_@.-]*/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$'
      OR file_path ~ '(^|/)node_modules(/|$)'
      OR file_path = ANY(seen_files) THEN
      RETURN false;
    END IF;
    seen_files := array_append(seen_files, file_path);
  END LOOP;

  RETURN true;
END $$;

ALTER TABLE gotchu.validation_suite_definitions
  ADD CONSTRAINT validation_suite_definitions_test_selection_check
  CHECK (
    (profile='node24-npm-test' AND test_selection IS NULL)
    OR (profile='node24-tsx-selected-v1' AND script_name='test' AND test_selection IS NOT NULL AND gotchu.validation_test_selection_is_valid(test_selection))
  );
