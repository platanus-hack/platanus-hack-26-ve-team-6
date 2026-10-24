CREATE INDEX audit_records_tenant_page ON gotchu.audit_records(organization_id, created_at DESC, id DESC);
CREATE INDEX audit_records_tenant_subject_page ON gotchu.audit_records(organization_id, subject_id, created_at DESC, id DESC)
  WHERE subject_id IS NOT NULL;
