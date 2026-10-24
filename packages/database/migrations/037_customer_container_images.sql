-- Container image archives are immutable customer inputs, stored and authorized
-- under the same tenant/application boundary as source snapshots.
CREATE TABLE gotchu.customer_container_images (
  organization_id uuid NOT NULL,
  application_id uuid NOT NULL,
  id uuid NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 200),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 8388608),
  body bytea,
  deleted_at timestamptz,
  consent_actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,application_id,id),
  FOREIGN KEY (organization_id,application_id) REFERENCES gotchu.applications(organization_id,id),
  CHECK ((deleted_at IS NULL) = (body IS NOT NULL)),
  CHECK (deleted_at IS NOT NULL OR octet_length(body)=size)
);
CREATE UNIQUE INDEX customer_container_images_active_digest
  ON gotchu.customer_container_images(organization_id,application_id,digest) WHERE deleted_at IS NULL;
CREATE INDEX customer_container_images_recent
  ON gotchu.customer_container_images(organization_id,application_id,created_at DESC,id);

ALTER TABLE gotchu.customer_requests ADD COLUMN container_image_id uuid;
ALTER TABLE gotchu.customer_requests ADD CONSTRAINT customer_requests_container_image_fk
  FOREIGN KEY (organization_id,application_id,container_image_id)
  REFERENCES gotchu.customer_container_images(organization_id,application_id,id);
ALTER TABLE gotchu.customer_requests DROP CONSTRAINT customer_requests_check;
ALTER TABLE gotchu.customer_requests ADD CONSTRAINT customer_requests_input_binding CHECK (
  input->>'version'='2'
  AND input->>'organizationId'=organization_id::text
  AND input->>'applicationId'=application_id::text
  AND input->>'jobId'=job_id::text
  AND (input->'source'->>'id') IS NOT DISTINCT FROM source_id::text
  AND (input->'target'->>'id') IS NOT DISTINCT FROM target_id::text
  AND (input->'containerImage'->>'id') IS NOT DISTINCT FROM container_image_id::text
  AND ((coalesce(input->>'inputKind','source_snapshot')='container_image') = coalesce(jsonb_typeof(input->'containerImage')='object',false))
);

ALTER TABLE gotchu.customer_container_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.customer_container_images FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.customer_container_images
  USING (organization_id=gotchu.tenant_id()) WITH CHECK (organization_id=gotchu.tenant_id());
REVOKE ALL ON gotchu.customer_container_images FROM PUBLIC;
GRANT SELECT ON gotchu.customer_container_images TO gotchu_api,gotchu_coordinator;
GRANT INSERT ON gotchu.customer_container_images TO gotchu_api;

-- Preserve only the archive digest and metadata after deletion. Queued/running
-- work retains the same in-use guard as source snapshots.
CREATE FUNCTION gotchu.customer_delete_container_image(p_organization uuid,p_application uuid,p_image uuid,p_user text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE deleted timestamptz;
BEGIN
  IF p_organization IS DISTINCT FROM gotchu.tenant_id() OR p_user='demo:controlled-assessment'
    OR coalesce(gotchu.lock_membership(p_organization,p_user) NOT IN ('owner','operator'),true) THEN RETURN 'forbidden'; END IF;
  IF NOT gotchu.lock_customer_organization(p_organization) THEN RETURN 'not_found'; END IF;
  SELECT deleted_at INTO deleted FROM gotchu.customer_container_images
    WHERE organization_id=p_organization AND application_id=p_application AND id=p_image FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF deleted IS NOT NULL THEN RETURN 'deleted'; END IF;
  IF EXISTS (SELECT 1 FROM gotchu.customer_requests r JOIN gotchu.jobs j
    ON j.organization_id=r.organization_id AND j.application_id=r.application_id AND j.id=r.job_id
    WHERE r.organization_id=p_organization AND r.application_id=p_application
      AND r.container_image_id=p_image
      AND (j.state IN ('queued','running') OR (j.state='failed' AND j.result->>'reasonCode'='assessment_reconciliation_required'))) THEN RETURN 'in_use'; END IF;
  UPDATE gotchu.customer_container_images SET body=NULL,deleted_at=clock_timestamp()
    WHERE organization_id=p_organization AND application_id=p_application AND id=p_image;
  INSERT INTO gotchu.audit_records(organization_id,id,actor_id,action,subject_id)
    VALUES (p_organization,gen_random_uuid(),p_user,'container_image.deleted',p_image);
  RETURN 'deleted';
END $$;
REVOKE ALL ON FUNCTION gotchu.customer_delete_container_image(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gotchu.customer_delete_container_image(uuid,uuid,uuid,text) TO gotchu_api;

CREATE OR REPLACE FUNCTION gotchu.check_customer_report_subject() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE request jsonb; expected jsonb;
BEGIN
  SELECT input INTO request FROM gotchu.customer_requests WHERE organization_id=NEW.organization_id
    AND application_id=NEW.application_id AND job_id=NEW.job_id;
  expected := jsonb_build_object(
    'sourceSnapshotId',request->'source'->'id',
    'sourceDigest',request->'source'->'digest',
    'targetId',request->'target'->'id',
    'targetVersion',request->'target'->'version',
    'origin',request->'target'->'origin',
    'containerImageId',request->'containerImage'->'id',
    'containerImageDigest',request->'containerImage'->'digest',
    'containerImageReference',request->'containerImage'->'reference'
  );
  IF request IS NULL OR NEW.body->'subject' IS DISTINCT FROM expected
    OR NEW.body->'mode' IS DISTINCT FROM request->'mode'
    OR NEW.body->'applicationName' IS DISTINCT FROM request->'applicationName' THEN
    RAISE EXCEPTION 'Customer report differs from durable request' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
