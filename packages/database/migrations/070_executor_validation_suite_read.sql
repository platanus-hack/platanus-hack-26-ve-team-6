-- Independent selected-suite verification reads the persisted definition as executor.
-- Existing FORCE RLS still scopes rows to the current tenant; no mutation is granted.
GRANT SELECT ON gotchu.validation_suite_definitions TO gotchu_executor;
