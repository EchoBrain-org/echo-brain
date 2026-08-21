-- Immutable, digest-only configuration for one Authority-owned meeting source.
--
-- The raw owner email and provider credential stay in private files. The
-- owner-email digest, organization-only scope attestation, and the digest of
-- the protected logical credential reference are permanently bound before the
-- first provider pull. Secret values rotate behind that reference without
-- resetting the source cursor or changing meeting-processing identity.

CREATE TABLE authority_processing_source_configuration_bindings (
  source_adapter_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  owner_email_sha256 TEXT NOT NULL CHECK (
    length(owner_email_sha256) = 71 AND
    substr(owner_email_sha256, 1, 7) = 'sha256:' AND
    substr(owner_email_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  credential_scope TEXT NOT NULL CHECK (credential_scope = 'organization'),
  credential_reference_sha256 TEXT NOT NULL CHECK (
    length(credential_reference_sha256) = 71 AND
    substr(credential_reference_sha256, 1, 7) = 'sha256:' AND
    substr(credential_reference_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  bound_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', bound_at) IS NOT NULL AND
    bound_at = strftime('%Y-%m-%dT%H:%M:%fZ', bound_at)
  ),
  PRIMARY KEY (source_adapter_id, source_instance_id),
  FOREIGN KEY (source_adapter_id, source_instance_id)
    REFERENCES authority_processing_source_owner_bindings(
      source_adapter_id, source_instance_id
    )
) STRICT;

CREATE TRIGGER authority_processing_source_configuration_bindings_immutable_update
BEFORE UPDATE ON authority_processing_source_configuration_bindings
BEGIN
  SELECT RAISE(
    ABORT,
    'authority processing source configuration binding is immutable'
  );
END;

CREATE TRIGGER authority_processing_source_configuration_bindings_delete_denied
BEFORE DELETE ON authority_processing_source_configuration_bindings
BEGIN
  SELECT RAISE(
    ABORT,
    'authority processing source configuration binding cannot be deleted'
  );
END;
