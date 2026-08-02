DROP TRIGGER organization_authority_connections_are_write_once;

ALTER TABLE organization_authority_connections
ADD COLUMN authority_ca_pem TEXT;

-- The cryptographic authority identity remains write-once in
-- organization_authority_pins. Only its network origin may be relocated after
-- the caller proves the exact same pinned descriptor at the new endpoint.
CREATE TRIGGER organization_authority_connections_preserve_identity
BEFORE UPDATE ON organization_authority_connections
WHEN
  NEW.singleton IS NOT OLD.singleton OR
  NEW.authority_id IS NOT OLD.authority_id OR
  NEW.organization_id IS NOT OLD.organization_id OR
  NEW.configured_at IS NOT OLD.configured_at
BEGIN
  SELECT RAISE(ABORT, 'organization authority connection identity is write-once');
END;
