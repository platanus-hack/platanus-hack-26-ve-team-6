-- Coordinator-observed phases of a running job, so clients can show where an assessment is.
-- Entries are {phase, at} appended under the current lease; the API reads them with the job.
ALTER TABLE gotchu.jobs ADD COLUMN progress jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(progress) = 'array' AND jsonb_array_length(progress) <= 8);
