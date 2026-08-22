-- Google and other SSO providers can issue a fresh signed identity assertion
-- without forcing the user to re-enter upstream credentials. Name the stored
-- timestamp for the exact fact it records: the verified ID token's `iat`.

ALTER TABLE authority_oidc_login_attempts
  RENAME COLUMN upstream_auth_time TO upstream_assertion_issued_at;

ALTER TABLE authority_person_session_families
  RENAME COLUMN upstream_auth_time TO upstream_assertion_issued_at;
