-- Bootstrap grants are issued only for one administrator-approved work email.
-- The table is intentionally empty before this pre-live migration, so the new
-- invariant can be required without inventing or backfilling identity data.

ALTER TABLE authority_person_login_grants
  ADD COLUMN expected_email_sha256 TEXT NOT NULL CHECK (
    length(expected_email_sha256) = 71 AND
    substr(expected_email_sha256, 1, 7) = 'sha256:' AND
    substr(expected_email_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  );

DROP TRIGGER authority_person_login_grants_consume_only;

CREATE TRIGGER authority_person_login_grants_consume_only
BEFORE UPDATE ON authority_person_login_grants
WHEN NOT (
  NEW.login_grant_sha256 IS OLD.login_grant_sha256 AND
  NEW.grant_purpose IS OLD.grant_purpose AND
  NEW.organization_id IS OLD.organization_id AND
  NEW.principal_id IS OLD.principal_id AND
  NEW.membership_id IS OLD.membership_id AND
  NEW.membership_type IS OLD.membership_type AND
  NEW.expected_issuer IS OLD.expected_issuer AND
  NEW.expected_email_sha256 IS OLD.expected_email_sha256 AND
  NEW.oidc_configuration_sha256 IS OLD.oidc_configuration_sha256 AND
  NEW.issued_at IS OLD.issued_at AND NEW.expires_at IS OLD.expires_at AND
  OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'person login grant mutation is denied');
END;
