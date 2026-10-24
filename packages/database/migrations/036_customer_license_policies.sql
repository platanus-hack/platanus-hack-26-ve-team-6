CREATE TABLE gotchu.customer_license_policies (
  organization_id uuid PRIMARY KEY REFERENCES gotchu.organizations(id),
  allow_licenses text[] NOT NULL CHECK (cardinality(allow_licenses) <= 100),
  deny_licenses text[] NOT NULL CHECK (cardinality(deny_licenses) <= 100),
  review_licenses text[] NOT NULL CHECK (cardinality(review_licenses) <= 100),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gotchu.customer_license_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE gotchu.customer_license_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON gotchu.customer_license_policies
  USING (organization_id = gotchu.tenant_id())
  WITH CHECK (organization_id = gotchu.tenant_id());
REVOKE ALL ON gotchu.customer_license_policies FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON gotchu.customer_license_policies TO gotchu_api;
