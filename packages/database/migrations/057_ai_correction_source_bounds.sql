-- Candidate insertion must pass the same file bounds as an authenticated upload.
GRANT EXECUTE ON FUNCTION gotchu.customer_source_file_bounds(jsonb) TO gotchu_coordinator;
