ALTER TABLE gotchu.customer_targets ADD COLUMN scan_profile text NOT NULL DEFAULT 'root'
  CHECK (scan_profile IN ('root','public_surface'));
