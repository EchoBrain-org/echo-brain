-- New-lineage baseline v1 for the Authority database role.
--
-- This is deliberately an explicit server/Person schema, not a dump of the
-- legacy migration chain. Durable protocol evidence is stored as the complete
-- canonical body plus its independently verified digest. A later application
-- adapter must validate and reprove those bodies before it writes them.

CREATE TABLE authority_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL UNIQUE,
  organization_display_name TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  created_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL
) STRICT;

CREATE TABLE authority_principals (
  principal_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  display_name TEXT NOT NULL,
  provisioned_at TEXT NOT NULL,
  UNIQUE (principal_id, organization_id)
) STRICT;

CREATE TABLE authority_memberships (
  membership_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  provisioned_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  employee_email TEXT,
  employee_email_sha256 TEXT CHECK (
    employee_email_sha256 IS NULL OR (
      length(employee_email_sha256) = 71 AND
      substr(employee_email_sha256, 1, 7) = 'sha256:' AND
      substr(employee_email_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  UNIQUE (membership_id, organization_id, principal_id, membership_type),
  CHECK (
    (membership_type = 'employee' AND employee_email IS NOT NULL AND employee_email_sha256 IS NOT NULL) OR
    (membership_type = 'owner' AND employee_email IS NULL AND employee_email_sha256 IS NULL)
  ),
  CHECK ((status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL) OR
         (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
) STRICT;

CREATE INDEX authority_memberships_current
  ON authority_memberships (principal_id, status, membership_id);

CREATE UNIQUE INDEX authority_memberships_active_employee_email
  ON authority_memberships (organization_id, employee_email_sha256)
  WHERE membership_type = 'employee' AND status = 'active';
-- Provider-neutral person identity and opaque browser-session persistence.
-- Provider-neutral person identity and opaque browser-session persistence.
--
-- OIDC identities are keyed by the exact `(issuer, subject)` pair only while
-- active. A revoked membership retains its historical binding, while a later
-- employee tenure may bind the same upstream account again. Raw state, nonce,
-- login-grant, access-token, refresh-token, and PKCE verifier values have no
-- column in this schema. The PKCE verifier is accepted only as an already
-- sealed byte string; cryptographic sealing remains an application adapter
-- responsibility.

CREATE TABLE authority_person_login_grants (
  login_grant_sha256 TEXT PRIMARY KEY CHECK (
    length(login_grant_sha256) = 71 AND
    substr(login_grant_sha256, 1, 7) = 'sha256:' AND
    substr(login_grant_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  grant_purpose TEXT NOT NULL CHECK (
    grant_purpose = 'oidc_identity_bootstrap'
  ),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee')),
  expected_issuer TEXT NOT NULL CHECK (
    length(expected_issuer) BETWEEN 1 AND 2048
  ),
  oidc_configuration_sha256 TEXT NOT NULL CHECK (
    length(oidc_configuration_sha256) = 71 AND
    substr(oidc_configuration_sha256, 1, 7) = 'sha256:' AND
    substr(oidc_configuration_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  issued_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) IS NOT NULL AND
    issued_at = strftime('%Y-%m-%dT%H:%M:%fZ', issued_at)
  ),
  expires_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL AND
    expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) AND
    expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', issued_at, '+15 minutes')
  ),
  consumed_at TEXT CHECK (
    consumed_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS NOT NULL AND
      consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) AND
      consumed_at >= issued_at AND consumed_at < expires_at
    )
  ),
  invalidated_at TEXT CHECK (
    invalidated_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) IS NOT NULL AND
      invalidated_at = strftime('%Y-%m-%dT%H:%M:%fZ', invalidated_at) AND
      invalidated_at >= issued_at AND invalidated_at < expires_at
    )
  ),
  CHECK (NOT (consumed_at IS NOT NULL AND invalidated_at IS NOT NULL)),
  UNIQUE (login_grant_sha256, expected_issuer, oidc_configuration_sha256),
  UNIQUE (
    login_grant_sha256, expected_issuer, oidc_configuration_sha256,
    organization_id, principal_id, membership_id, membership_type
  ),
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(
      membership_id, organization_id, principal_id, membership_type
    )
) STRICT;

CREATE INDEX authority_person_login_grants_membership
  ON authority_person_login_grants (membership_id, issued_at);

CREATE INDEX authority_person_login_grants_pending_membership
  ON authority_person_login_grants (membership_id, consumed_at);

CREATE INDEX authority_person_login_grants_expiry
  ON authority_person_login_grants (expires_at, login_grant_sha256);

CREATE TABLE authority_oidc_identity_bindings (
  identity_binding_id TEXT PRIMARY KEY CHECK (
    length(identity_binding_id) = 40 AND
    identity_binding_id GLOB 'oib_????????-????-4???-[89ab]???-????????????' AND
    replace(substr(identity_binding_id, 5), '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 1024),
  tenant_constraint_sha256 TEXT NOT NULL CHECK (
    length(tenant_constraint_sha256) = 71 AND
    substr(tenant_constraint_sha256, 1, 7) = 'sha256:' AND
    substr(tenant_constraint_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  oidc_configuration_sha256 TEXT NOT NULL CHECK (
    length(oidc_configuration_sha256) = 71 AND
    substr(oidc_configuration_sha256, 1, 7) = 'sha256:' AND
    substr(oidc_configuration_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  initial_login_attempt_id TEXT NOT NULL UNIQUE
    REFERENCES authority_oidc_login_attempts(login_attempt_id)
    DEFERRABLE INITIALLY DEFERRED,
  initial_login_grant_sha256 TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  bound_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', bound_at) IS NOT NULL AND
    bound_at = strftime('%Y-%m-%dT%H:%M:%fZ', bound_at)
  ),
  revoked_at TEXT CHECK (
    revoked_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS NOT NULL AND
      revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at)
    )
  ),
  revocation_reason TEXT CHECK (
    revocation_reason IS NULL OR length(revocation_reason) BETWEEN 1 AND 500
  ),
  UNIQUE (identity_binding_id, issuer),
  UNIQUE (identity_binding_id, initial_login_attempt_id),
  UNIQUE (
    identity_binding_id, organization_id, principal_id, membership_id,
    membership_type
  ),
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(
      membership_id, organization_id, principal_id, membership_type
    ),
  FOREIGN KEY (
    initial_login_grant_sha256, issuer, oidc_configuration_sha256,
    organization_id, principal_id, membership_id, membership_type
  ) REFERENCES authority_person_login_grants(
    login_grant_sha256, expected_issuer, oidc_configuration_sha256,
    organization_id, principal_id, membership_id, membership_type
  ),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND
      revoked_at >= bound_at AND revocation_reason IS NOT NULL)
  )
) STRICT;

CREATE INDEX authority_oidc_identity_bindings_membership
  ON authority_oidc_identity_bindings (membership_id, status);

CREATE UNIQUE INDEX authority_oidc_identity_bindings_active_subject
  ON authority_oidc_identity_bindings (issuer, subject)
  WHERE status = 'active';

CREATE TABLE authority_oidc_login_attempts (
  login_attempt_id TEXT PRIMARY KEY CHECK (
    length(login_attempt_id) = 40 AND
    login_attempt_id GLOB 'ola_????????-????-4???-[89ab]???-????????????' AND
    replace(substr(login_attempt_id, 5), '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  issuer TEXT NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  attempt_purpose TEXT NOT NULL CHECK (
    attempt_purpose IN ('identity_bootstrap', 'existing_identity_login')
  ),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 1024),
  redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 4096),
  tenant_constraint_sha256 TEXT NOT NULL CHECK (
    length(tenant_constraint_sha256) = 71 AND
    substr(tenant_constraint_sha256, 1, 7) = 'sha256:' AND
    substr(tenant_constraint_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  oidc_configuration_sha256 TEXT NOT NULL CHECK (
    length(oidc_configuration_sha256) = 71 AND
    substr(oidc_configuration_sha256, 1, 7) = 'sha256:' AND
    substr(oidc_configuration_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  -- Null for a previously bound identity. Bootstrap attempts carry the
  -- administrator-issued, digest-only grant they must consume at callback.
  login_grant_sha256 TEXT UNIQUE,
  state_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(state_sha256) = 71 AND
    substr(state_sha256, 1, 7) = 'sha256:' AND
    substr(state_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  nonce_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(nonce_sha256) = 71 AND
    substr(nonce_sha256, 1, 7) = 'sha256:' AND
    substr(nonce_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  pkce_verifier_seal_key_id TEXT CHECK (
    pkce_verifier_seal_key_id IS NULL OR
    length(pkce_verifier_seal_key_id) BETWEEN 1 AND 200
  ),
  pkce_verifier_sealed BLOB CHECK (
    pkce_verifier_sealed IS NULL OR (
      typeof(pkce_verifier_sealed) = 'blob' AND
      length(pkce_verifier_sealed) BETWEEN 32 AND 8192
    )
  ),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  ),
  expires_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL AND
    expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) AND
    expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+10 minutes')
  ),
  redemption_claim_id TEXT UNIQUE CHECK (
    redemption_claim_id IS NULL OR (
      length(redemption_claim_id) = 40 AND
      redemption_claim_id GLOB
        'olc_????????-????-4???-[89ab]???-????????????' AND
      replace(substr(redemption_claim_id, 5), '-', '')
        NOT GLOB '*[^0-9a-f]*'
    )
  ),
  redemption_claimed_at TEXT CHECK (
    redemption_claimed_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', redemption_claimed_at) IS NOT NULL AND
      redemption_claimed_at = strftime(
        '%Y-%m-%dT%H:%M:%fZ', redemption_claimed_at
      ) AND
      redemption_claimed_at >= created_at AND
      redemption_claimed_at < expires_at
    )
  ),
  terminal_outcome TEXT CHECK (
    terminal_outcome IS NULL OR
    terminal_outcome IN ('succeeded', 'denied', 'expired')
  ),
  completed_at TEXT CHECK (
    completed_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS NOT NULL AND
      completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) AND
      completed_at >= created_at
    )
  ),
  resolved_identity_binding_id TEXT,
  upstream_auth_time TEXT CHECK (
    upstream_auth_time IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', upstream_auth_time) IS NOT NULL AND
      upstream_auth_time = strftime(
        '%Y-%m-%dT%H:%M:%fZ', upstream_auth_time
      ) AND
      upstream_auth_time >= strftime(
        '%Y-%m-%dT%H:%M:%fZ', created_at, '-60 seconds'
      ) AND
      upstream_auth_time <= strftime(
        '%Y-%m-%dT%H:%M:%fZ', completed_at, '+60 seconds'
      )
    )
  ),
  bootstrap_initial_login_attempt_id TEXT GENERATED ALWAYS AS (
    CASE
      WHEN attempt_purpose = 'identity_bootstrap' AND
           terminal_outcome = 'succeeded'
      THEN login_attempt_id
      ELSE NULL
    END
  ) STORED,
  CHECK (
    (attempt_purpose = 'identity_bootstrap' AND
      login_grant_sha256 IS NOT NULL) OR
    (attempt_purpose = 'existing_identity_login' AND
      login_grant_sha256 IS NULL)
  ),
  CHECK (
    (terminal_outcome IS NULL AND completed_at IS NULL AND
      resolved_identity_binding_id IS NULL AND upstream_auth_time IS NULL AND
      pkce_verifier_seal_key_id IS NOT NULL AND
      pkce_verifier_sealed IS NOT NULL) OR
    (terminal_outcome = 'succeeded' AND completed_at IS NOT NULL AND
      completed_at < expires_at AND resolved_identity_binding_id IS NOT NULL AND
      upstream_auth_time IS NOT NULL AND
      redemption_claim_id IS NULL AND redemption_claimed_at IS NULL AND
      pkce_verifier_seal_key_id IS NULL AND pkce_verifier_sealed IS NULL) OR
    (terminal_outcome = 'denied' AND completed_at IS NOT NULL AND
      completed_at < expires_at AND resolved_identity_binding_id IS NULL AND
      upstream_auth_time IS NULL AND
      redemption_claim_id IS NULL AND redemption_claimed_at IS NULL AND
      pkce_verifier_seal_key_id IS NULL AND pkce_verifier_sealed IS NULL) OR
    (terminal_outcome = 'expired' AND completed_at IS NOT NULL AND
      completed_at >= expires_at AND resolved_identity_binding_id IS NULL AND
      upstream_auth_time IS NULL AND
      redemption_claim_id IS NULL AND redemption_claimed_at IS NULL AND
      pkce_verifier_seal_key_id IS NULL AND pkce_verifier_sealed IS NULL)
  ),
  CHECK (
    (redemption_claim_id IS NULL AND redemption_claimed_at IS NULL) OR
    (redemption_claim_id IS NOT NULL AND redemption_claimed_at IS NOT NULL)
  ),
  FOREIGN KEY (login_grant_sha256, issuer, oidc_configuration_sha256)
    REFERENCES authority_person_login_grants(
      login_grant_sha256, expected_issuer, oidc_configuration_sha256
    ),
  FOREIGN KEY (resolved_identity_binding_id, issuer)
    REFERENCES authority_oidc_identity_bindings(identity_binding_id, issuer)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (
    resolved_identity_binding_id, bootstrap_initial_login_attempt_id
  ) REFERENCES authority_oidc_identity_bindings(
    identity_binding_id, initial_login_attempt_id
  )
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX authority_oidc_login_attempts_expiry
  ON authority_oidc_login_attempts (expires_at, login_attempt_id);

CREATE TABLE authority_person_session_families (
  session_family_id TEXT PRIMARY KEY CHECK (
    length(session_family_id) = 40 AND
    session_family_id GLOB 'psf_????????-????-4???-[89ab]???-????????????' AND
    replace(substr(session_family_id, 5), '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee')),
  identity_binding_id TEXT NOT NULL
    REFERENCES authority_oidc_identity_bindings(identity_binding_id),
  authentication_login_attempt_id TEXT NOT NULL UNIQUE
    REFERENCES authority_oidc_login_attempts(login_attempt_id),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  ),
  upstream_auth_time TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', upstream_auth_time) IS NOT NULL AND
    upstream_auth_time = strftime('%Y-%m-%dT%H:%M:%fZ', upstream_auth_time) AND
    upstream_auth_time <= strftime(
      '%Y-%m-%dT%H:%M:%fZ', created_at, '+60 seconds'
    )
  ),
  tenant_constraint_sha256 TEXT NOT NULL CHECK (
    length(tenant_constraint_sha256) = 71 AND
    substr(tenant_constraint_sha256, 1, 7) = 'sha256:' AND
    substr(tenant_constraint_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  oidc_configuration_sha256 TEXT NOT NULL CHECK (
    length(oidc_configuration_sha256) = 71 AND
    substr(oidc_configuration_sha256, 1, 7) = 'sha256:' AND
    substr(oidc_configuration_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  hard_reauthentication_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', hard_reauthentication_at) IS NOT NULL AND
    hard_reauthentication_at = strftime(
      '%Y-%m-%dT%H:%M:%fZ', hard_reauthentication_at
    ) AND
    hard_reauthentication_at = strftime(
      '%Y-%m-%dT%H:%M:%fZ', upstream_auth_time, '+7 days'
    ) AND
    hard_reauthentication_at > created_at
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revoked_at TEXT CHECK (
    revoked_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS NOT NULL AND
      revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at)
    )
  ),
  revocation_reason TEXT CHECK (
    revocation_reason IS NULL OR length(revocation_reason) BETWEEN 1 AND 500
  ),
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(
      membership_id, organization_id, principal_id, membership_type
    ),
  FOREIGN KEY (
    identity_binding_id, organization_id, principal_id, membership_id,
    membership_type
  ) REFERENCES authority_oidc_identity_bindings(
    identity_binding_id, organization_id, principal_id, membership_id,
    membership_type
  ),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND
      revoked_at >= created_at AND revocation_reason IS NOT NULL)
  )
) STRICT;

CREATE INDEX authority_person_session_families_membership
  ON authority_person_session_families (membership_id, status, created_at);

CREATE TABLE authority_person_session_credentials (
  session_credential_id TEXT PRIMARY KEY CHECK (
    length(session_credential_id) = 40 AND
    session_credential_id GLOB 'psc_????????-????-4???-[89ab]???-????????????' AND
    replace(substr(session_credential_id, 5), '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  session_family_id TEXT NOT NULL
    REFERENCES authority_person_session_families(session_family_id),
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('access', 'refresh')),
  rotation_sequence INTEGER NOT NULL CHECK (rotation_sequence > 0),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(token_sha256) = 71 AND
    substr(token_sha256, 1, 7) = 'sha256:' AND
    substr(token_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  issued_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', issued_at) IS NOT NULL AND
    issued_at = strftime('%Y-%m-%dT%H:%M:%fZ', issued_at)
  ),
  expires_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS NOT NULL AND
    expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) AND
    expires_at > issued_at
  ),
  consumed_at TEXT CHECK (
    consumed_at IS NULL OR (
      credential_kind = 'refresh' AND
      strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS NOT NULL AND
      consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) AND
      consumed_at >= issued_at AND consumed_at < expires_at
    )
  ),
  revoked_at TEXT CHECK (
    revoked_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS NOT NULL AND
      revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) AND
      revoked_at >= issued_at
    )
  ),
  revocation_reason TEXT CHECK (
    revocation_reason IS NULL OR length(revocation_reason) BETWEEN 1 AND 500
  ),
  CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL) OR
    (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  ),
  UNIQUE (session_family_id, credential_kind, rotation_sequence)
) STRICT;

CREATE UNIQUE INDEX authority_person_session_credentials_one_live_refresh
  ON authority_person_session_credentials (session_family_id)
  WHERE credential_kind = 'refresh'
    AND consumed_at IS NULL
    AND revoked_at IS NULL;

CREATE UNIQUE INDEX authority_person_session_credentials_one_live_access
  ON authority_person_session_credentials (session_family_id)
  WHERE credential_kind = 'access'
    AND revoked_at IS NULL;

CREATE INDEX authority_person_session_credentials_family
  ON authority_person_session_credentials (
    session_family_id, credential_kind, issued_at
  );

-- Stable identity and session facts cannot be retargeted in place. The only
-- online mutations are the narrow terminal transitions used by the repository.
CREATE TRIGGER authority_person_login_grants_initial_state_insert
BEFORE INSERT ON authority_person_login_grants
WHEN NEW.consumed_at IS NOT NULL OR NEW.invalidated_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'person login grant must begin pending');
END;

CREATE TRIGGER authority_oidc_identity_bindings_provenance_insert
BEFORE INSERT ON authority_oidc_identity_bindings
WHEN NOT (
  NEW.status = 'active' AND NEW.revoked_at IS NULL AND
  NEW.revocation_reason IS NULL AND
  EXISTS (
    SELECT 1
      FROM authority_memberships membership
     WHERE membership.membership_id = NEW.membership_id
       AND membership.organization_id = NEW.organization_id
       AND membership.principal_id = NEW.principal_id
       AND membership.membership_type = NEW.membership_type
       AND membership.status = 'active'
  ) AND
  EXISTS (
    SELECT 1
      FROM authority_oidc_login_attempts attempt
      JOIN authority_person_login_grants grant_row
        ON grant_row.login_grant_sha256 = attempt.login_grant_sha256
       AND grant_row.expected_issuer = attempt.issuer
       AND grant_row.oidc_configuration_sha256 =
             attempt.oidc_configuration_sha256
     WHERE attempt.login_attempt_id = NEW.initial_login_attempt_id
       AND attempt.attempt_purpose = 'identity_bootstrap'
       AND attempt.terminal_outcome = 'succeeded'
       AND attempt.completed_at = NEW.bound_at
       AND attempt.resolved_identity_binding_id = NEW.identity_binding_id
       AND attempt.issuer = NEW.issuer
       AND attempt.tenant_constraint_sha256 = NEW.tenant_constraint_sha256
       AND attempt.oidc_configuration_sha256 =
             NEW.oidc_configuration_sha256
       AND attempt.login_grant_sha256 = NEW.initial_login_grant_sha256
       AND grant_row.organization_id = NEW.organization_id
       AND grant_row.principal_id = NEW.principal_id
       AND grant_row.membership_id = NEW.membership_id
       AND grant_row.membership_type = NEW.membership_type
       AND grant_row.consumed_at = NEW.bound_at
  )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'OIDC identity binding requires a successful exact bootstrap attempt'
  );
END;

CREATE TRIGGER authority_oidc_identity_bindings_terminal_update
BEFORE UPDATE ON authority_oidc_identity_bindings
WHEN NOT (
  OLD.status = 'active' AND NEW.status = 'revoked' AND
  NEW.identity_binding_id IS OLD.identity_binding_id AND
  NEW.issuer IS OLD.issuer AND NEW.subject IS OLD.subject AND
  NEW.tenant_constraint_sha256 IS OLD.tenant_constraint_sha256 AND
  NEW.oidc_configuration_sha256 IS OLD.oidc_configuration_sha256 AND
  NEW.initial_login_attempt_id IS OLD.initial_login_attempt_id AND
  NEW.initial_login_grant_sha256 IS OLD.initial_login_grant_sha256 AND
  NEW.organization_id IS OLD.organization_id AND
  NEW.principal_id IS OLD.principal_id AND
  NEW.membership_id IS OLD.membership_id AND
  NEW.membership_type IS OLD.membership_type AND
  NEW.bound_at IS OLD.bound_at AND
  OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND
  OLD.revocation_reason IS NULL AND NEW.revocation_reason IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'OIDC identity binding mutation is denied');
END;

CREATE TRIGGER authority_oidc_identity_bindings_revoke_families
AFTER UPDATE OF status ON authority_oidc_identity_bindings
WHEN OLD.status = 'active' AND NEW.status = 'revoked'
BEGIN
  UPDATE authority_person_session_families
     SET status = 'revoked', revoked_at = NEW.revoked_at,
         revocation_reason = NEW.revocation_reason
   WHERE identity_binding_id = NEW.identity_binding_id
     AND status = 'active';
END;

CREATE TRIGGER authority_oidc_identity_bindings_delete_denied
BEFORE DELETE ON authority_oidc_identity_bindings
BEGIN
  SELECT RAISE(ABORT, 'OIDC identity binding deletion is denied');
END;

CREATE TRIGGER authority_oidc_login_attempts_bootstrap_grant_insert
BEFORE INSERT ON authority_oidc_login_attempts
WHEN NEW.attempt_purpose = 'identity_bootstrap' AND NOT EXISTS (
  SELECT 1
    FROM authority_person_login_grants grant_row
   WHERE grant_row.login_grant_sha256 = NEW.login_grant_sha256
     AND grant_row.expected_issuer = NEW.issuer
     AND grant_row.oidc_configuration_sha256 =
           NEW.oidc_configuration_sha256
     AND grant_row.consumed_at IS NULL
     AND grant_row.invalidated_at IS NULL
     AND grant_row.issued_at <= NEW.created_at
     AND grant_row.expires_at > NEW.created_at
)
BEGIN
  SELECT RAISE(
    ABORT,
    'OIDC bootstrap attempt requires a pending live login grant'
  );
END;

CREATE TRIGGER authority_oidc_login_attempts_initial_state_insert
BEFORE INSERT ON authority_oidc_login_attempts
WHEN NOT (
  NEW.redemption_claim_id IS NULL AND
  NEW.redemption_claimed_at IS NULL AND
  NEW.terminal_outcome IS NULL AND
  NEW.completed_at IS NULL AND
  NEW.resolved_identity_binding_id IS NULL AND
  NEW.upstream_auth_time IS NULL AND
  NEW.pkce_verifier_seal_key_id IS NOT NULL AND
  NEW.pkce_verifier_sealed IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'OIDC login attempt must begin pending and unclaimed');
END;

CREATE TRIGGER authority_oidc_login_attempts_terminal_bootstrap_grant
BEFORE UPDATE OF terminal_outcome ON authority_oidc_login_attempts
WHEN OLD.terminal_outcome IS NULL AND NEW.terminal_outcome IS NOT NULL AND
     OLD.attempt_purpose = 'identity_bootstrap'
BEGIN
  UPDATE authority_person_login_grants
     SET consumed_at = NEW.completed_at
   WHERE login_grant_sha256 = OLD.login_grant_sha256
     AND consumed_at IS NULL
     AND invalidated_at IS NULL
     AND issued_at <= NEW.completed_at
     AND expires_at > NEW.completed_at;

  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
        FROM authority_person_login_grants grant_row
       WHERE grant_row.login_grant_sha256 = OLD.login_grant_sha256
         AND (
           (
             NEW.terminal_outcome = 'succeeded' AND
             grant_row.consumed_at = NEW.completed_at
           ) OR
           (
             NEW.terminal_outcome IN ('denied', 'expired') AND
             (
               grant_row.consumed_at IS NOT NULL OR
               grant_row.invalidated_at IS NOT NULL OR
               (
                 grant_row.expires_at <= NEW.completed_at AND
                 grant_row.consumed_at IS NULL
               )
             )
           )
         )
    )
    THEN RAISE(
      ABORT,
      'terminal bootstrap attempt requires exact login grant disposition'
    )
  END;
END;

CREATE TRIGGER authority_oidc_login_attempts_state_transition_only
BEFORE UPDATE ON authority_oidc_login_attempts
WHEN NOT (
  NEW.login_attempt_id IS OLD.login_attempt_id AND
  NEW.issuer IS OLD.issuer AND
  NEW.attempt_purpose IS OLD.attempt_purpose AND
  NEW.client_id IS OLD.client_id AND
  NEW.redirect_uri IS OLD.redirect_uri AND
  NEW.tenant_constraint_sha256 IS OLD.tenant_constraint_sha256 AND
  NEW.oidc_configuration_sha256 IS OLD.oidc_configuration_sha256 AND
  NEW.login_grant_sha256 IS OLD.login_grant_sha256 AND
  NEW.state_sha256 IS OLD.state_sha256 AND
  NEW.nonce_sha256 IS OLD.nonce_sha256 AND
  NEW.created_at IS OLD.created_at AND NEW.expires_at IS OLD.expires_at AND
  (
    (
      OLD.terminal_outcome IS NULL AND NEW.terminal_outcome IS NULL AND
      OLD.completed_at IS NULL AND NEW.completed_at IS NULL AND
      OLD.resolved_identity_binding_id IS NULL AND
      NEW.resolved_identity_binding_id IS NULL AND
      OLD.upstream_auth_time IS NULL AND NEW.upstream_auth_time IS NULL AND
      OLD.redemption_claim_id IS NULL AND
      OLD.redemption_claimed_at IS NULL AND
      NEW.redemption_claim_id IS NOT NULL AND
      NEW.redemption_claimed_at IS NOT NULL AND
      NEW.pkce_verifier_seal_key_id IS OLD.pkce_verifier_seal_key_id AND
      NEW.pkce_verifier_sealed IS OLD.pkce_verifier_sealed
    ) OR
    (
      OLD.terminal_outcome IS NULL AND NEW.terminal_outcome IS NULL AND
      OLD.completed_at IS NULL AND NEW.completed_at IS NULL AND
      OLD.resolved_identity_binding_id IS NULL AND
      NEW.resolved_identity_binding_id IS NULL AND
      OLD.upstream_auth_time IS NULL AND NEW.upstream_auth_time IS NULL AND
      OLD.redemption_claim_id IS NOT NULL AND
      OLD.redemption_claimed_at IS NOT NULL AND
      NEW.redemption_claim_id IS NULL AND
      NEW.redemption_claimed_at IS NULL AND
      NEW.pkce_verifier_seal_key_id IS OLD.pkce_verifier_seal_key_id AND
      NEW.pkce_verifier_sealed IS OLD.pkce_verifier_sealed
    ) OR
    (
      OLD.terminal_outcome IS NULL AND
      NEW.terminal_outcome IN ('succeeded', 'denied') AND
      OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL AND
      OLD.resolved_identity_binding_id IS NULL AND
      OLD.upstream_auth_time IS NULL AND
      OLD.redemption_claim_id IS NOT NULL AND
      OLD.redemption_claimed_at IS NOT NULL AND
      NEW.redemption_claim_id IS NULL AND
      NEW.redemption_claimed_at IS NULL AND
      OLD.pkce_verifier_seal_key_id IS NOT NULL AND
      OLD.pkce_verifier_sealed IS NOT NULL AND
      NEW.pkce_verifier_seal_key_id IS NULL AND
      NEW.pkce_verifier_sealed IS NULL
    ) OR
    (
      OLD.terminal_outcome IS NULL AND NEW.terminal_outcome = 'expired' AND
      OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL AND
      OLD.resolved_identity_binding_id IS NULL AND
      NEW.resolved_identity_binding_id IS NULL AND
      OLD.upstream_auth_time IS NULL AND NEW.upstream_auth_time IS NULL AND
      NEW.redemption_claim_id IS NULL AND
      NEW.redemption_claimed_at IS NULL AND
      OLD.pkce_verifier_seal_key_id IS NOT NULL AND
      OLD.pkce_verifier_sealed IS NOT NULL AND
      NEW.pkce_verifier_seal_key_id IS NULL AND
      NEW.pkce_verifier_sealed IS NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'OIDC login attempt mutation is denied');
END;

CREATE TRIGGER authority_oidc_login_attempts_delete_denied
BEFORE DELETE ON authority_oidc_login_attempts
BEGIN
  SELECT RAISE(ABORT, 'OIDC login attempt deletion is denied');
END;

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
  NEW.oidc_configuration_sha256 IS OLD.oidc_configuration_sha256 AND
  NEW.issued_at IS OLD.issued_at AND NEW.expires_at IS OLD.expires_at AND
  OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'person login grant mutation is denied');
END;

CREATE TRIGGER authority_person_login_grants_delete_denied
BEFORE DELETE ON authority_person_login_grants
BEGIN
  SELECT RAISE(ABORT, 'person login grant deletion is denied');
END;

CREATE TRIGGER authority_person_session_families_provenance_insert
BEFORE INSERT ON authority_person_session_families
WHEN NOT (
  NEW.status = 'active' AND NEW.revoked_at IS NULL AND
  NEW.revocation_reason IS NULL AND
  EXISTS (
    SELECT 1
      FROM authority_memberships membership
      JOIN authority_oidc_identity_bindings binding
        ON binding.identity_binding_id = NEW.identity_binding_id
       AND binding.organization_id = NEW.organization_id
       AND binding.principal_id = NEW.principal_id
       AND binding.membership_id = NEW.membership_id
       AND binding.membership_type = NEW.membership_type
     WHERE membership.membership_id = NEW.membership_id
       AND membership.organization_id = NEW.organization_id
       AND membership.principal_id = NEW.principal_id
       AND membership.membership_type = NEW.membership_type
       AND membership.status = 'active'
       AND binding.status = 'active'
  ) AND
  EXISTS (
    SELECT 1
      FROM authority_oidc_login_attempts attempt
      JOIN authority_oidc_identity_bindings binding
        ON binding.identity_binding_id = attempt.resolved_identity_binding_id
     WHERE attempt.login_attempt_id = NEW.authentication_login_attempt_id
       AND attempt.terminal_outcome = 'succeeded'
       AND attempt.completed_at = NEW.created_at
       AND attempt.resolved_identity_binding_id = NEW.identity_binding_id
       AND attempt.upstream_auth_time = NEW.upstream_auth_time
       AND attempt.tenant_constraint_sha256 = NEW.tenant_constraint_sha256
       AND attempt.oidc_configuration_sha256 =
             NEW.oidc_configuration_sha256
       AND (
         attempt.attempt_purpose = 'existing_identity_login' OR
         (
           attempt.attempt_purpose = 'identity_bootstrap' AND
           binding.initial_login_attempt_id = attempt.login_attempt_id
         )
       )
  )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'person session family requires a successful exact login attempt'
  );
END;

CREATE TRIGGER authority_person_session_families_terminal_update
BEFORE UPDATE ON authority_person_session_families
WHEN NOT (
  OLD.status = 'active' AND NEW.status = 'revoked' AND
  NEW.session_family_id IS OLD.session_family_id AND
  NEW.organization_id IS OLD.organization_id AND
  NEW.principal_id IS OLD.principal_id AND
  NEW.membership_id IS OLD.membership_id AND
  NEW.membership_type IS OLD.membership_type AND
  NEW.identity_binding_id IS OLD.identity_binding_id AND
  NEW.authentication_login_attempt_id IS
    OLD.authentication_login_attempt_id AND
  NEW.created_at IS OLD.created_at AND
  NEW.upstream_auth_time IS OLD.upstream_auth_time AND
  NEW.tenant_constraint_sha256 IS OLD.tenant_constraint_sha256 AND
  NEW.oidc_configuration_sha256 IS OLD.oidc_configuration_sha256 AND
  NEW.hard_reauthentication_at IS OLD.hard_reauthentication_at AND
  OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND
  OLD.revocation_reason IS NULL AND NEW.revocation_reason IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'person session family mutation is denied');
END;

CREATE TRIGGER authority_person_session_families_revoke_credentials
AFTER UPDATE OF status ON authority_person_session_families
WHEN OLD.status = 'active' AND NEW.status = 'revoked'
BEGIN
  UPDATE authority_person_session_credentials
     SET revoked_at = NEW.revoked_at,
         revocation_reason = NEW.revocation_reason
   WHERE session_family_id = NEW.session_family_id
     AND revoked_at IS NULL;
END;

CREATE TRIGGER authority_person_session_families_delete_denied
BEFORE DELETE ON authority_person_session_families
BEGIN
  SELECT RAISE(ABORT, 'person session family deletion is denied');
END;

CREATE TRIGGER authority_memberships_revoke_person_session_families
AFTER UPDATE OF status ON authority_memberships
WHEN OLD.status = 'active' AND NEW.status = 'revoked'
BEGIN
  UPDATE authority_oidc_identity_bindings
     SET status = 'revoked', revoked_at = NEW.revoked_at,
         revocation_reason = NEW.revocation_reason
   WHERE membership_id = NEW.membership_id
     AND organization_id = NEW.organization_id
     AND principal_id = NEW.principal_id
     AND membership_type = NEW.membership_type
     AND status = 'active';

  UPDATE authority_person_session_families
     SET status = 'revoked', revoked_at = NEW.revoked_at,
         revocation_reason = NEW.revocation_reason
   WHERE membership_id = NEW.membership_id
     AND organization_id = NEW.organization_id
     AND principal_id = NEW.principal_id
     AND membership_type = NEW.membership_type
     AND status = 'active';
END;

CREATE TRIGGER authority_person_session_credentials_policy_insert
BEFORE INSERT ON authority_person_session_credentials
WHEN NOT EXISTS (
  SELECT 1
    FROM authority_person_session_families family
   WHERE family.session_family_id = NEW.session_family_id
     AND family.status = 'active'
     AND family.hard_reauthentication_at > NEW.issued_at
     AND (
       (
         NEW.credential_kind = 'access' AND
         NEW.expires_at = CASE
           WHEN strftime(
             '%Y-%m-%dT%H:%M:%fZ', NEW.issued_at, '+12 hours'
           ) < family.hard_reauthentication_at
           THEN strftime(
             '%Y-%m-%dT%H:%M:%fZ', NEW.issued_at, '+12 hours'
           )
           ELSE family.hard_reauthentication_at
         END
       ) OR
       (
         NEW.credential_kind = 'refresh' AND
         NEW.expires_at = family.hard_reauthentication_at
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'person session credential lifetime is invalid');
END;

CREATE TRIGGER authority_person_session_credentials_initial_state_insert
BEFORE INSERT ON authority_person_session_credentials
WHEN NOT (
  NEW.consumed_at IS NULL AND NEW.revoked_at IS NULL AND
  NEW.revocation_reason IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'person session credential must begin live');
END;

CREATE TRIGGER authority_person_session_credentials_contiguous
BEFORE INSERT ON authority_person_session_credentials
WHEN NEW.rotation_sequence != COALESCE(
  (
    SELECT MAX(existing.rotation_sequence) + 1
      FROM authority_person_session_credentials existing
     WHERE existing.session_family_id = NEW.session_family_id
       AND existing.credential_kind = NEW.credential_kind
  ),
  1
)
BEGIN
  SELECT RAISE(ABORT, 'person session credential rotation is not contiguous');
END;

CREATE TRIGGER authority_person_session_credentials_terminal_update
BEFORE UPDATE ON authority_person_session_credentials
WHEN NOT (
  NEW.session_credential_id IS OLD.session_credential_id AND
  NEW.session_family_id IS OLD.session_family_id AND
  NEW.credential_kind IS OLD.credential_kind AND
  NEW.rotation_sequence IS OLD.rotation_sequence AND
  NEW.token_sha256 IS OLD.token_sha256 AND
  NEW.issued_at IS OLD.issued_at AND NEW.expires_at IS OLD.expires_at AND
  (
    (
      OLD.credential_kind = 'refresh' AND
      OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL AND
      OLD.revoked_at IS NULL AND NEW.revoked_at IS NULL AND
      OLD.revocation_reason IS NULL AND NEW.revocation_reason IS NULL
    ) OR
    (
      NEW.consumed_at IS OLD.consumed_at AND
      OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND
      OLD.revocation_reason IS NULL AND NEW.revocation_reason IS NOT NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'person session credential mutation is denied');
END;

CREATE TRIGGER authority_person_session_credentials_delete_denied
BEFORE DELETE ON authority_person_session_credentials
BEGIN
  SELECT RAISE(ABORT, 'person session credential deletion is denied');
END;
-- Google and other SSO providers can issue a fresh signed identity assertion
-- without forcing the user to re-enter upstream credentials. Name the stored
-- timestamp for the exact fact it records: the verified ID token's `iat`.

ALTER TABLE authority_oidc_login_attempts
  RENAME COLUMN upstream_auth_time TO upstream_assertion_issued_at;

ALTER TABLE authority_person_session_families
  RENAME COLUMN upstream_auth_time TO upstream_assertion_issued_at;
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
  (
    (
      OLD.consumed_at IS NULL AND OLD.invalidated_at IS NULL AND
      NEW.consumed_at IS NOT NULL AND NEW.invalidated_at IS NULL
    ) OR
    (
      OLD.consumed_at IS NULL AND OLD.invalidated_at IS NULL AND
      NEW.consumed_at IS NULL AND NEW.invalidated_at IS NOT NULL
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'person login grant mutation is denied');
END;
-- New-lineage D2 state retains only the references required to reprove the
-- control-plane-owned action and audit chain. Its bodies stay in that role.
CREATE TABLE authority_provider_human_action_reproofs (
  provider_action_sha256 TEXT PRIMARY KEY CHECK (provider_action_sha256 LIKE 'sha256:%'),
  authorization_sha256 TEXT NOT NULL UNIQUE CHECK (authorization_sha256 LIKE 'sha256:%'),
  integration_audit_entry_sha256 TEXT NOT NULL UNIQUE CHECK (integration_audit_entry_sha256 LIKE 'sha256:%'),
  durable_result_sha256 TEXT NOT NULL UNIQUE CHECK (durable_result_sha256 LIKE 'sha256:%'),
  currentness_reproof_sha256 TEXT NOT NULL CHECK (currentness_reproof_sha256 LIKE 'sha256:%'),
  recorded_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER authority_provider_human_action_reproofs_immutable
BEFORE UPDATE ON authority_provider_human_action_reproofs
BEGIN SELECT RAISE(ABORT, 'provider human action reproof is immutable'); END;

-- D3 keeps the exact Authority-writer bodies and their committed references.
CREATE TABLE authority_record_write_inputs (
  semantic_idempotency_sha256 TEXT PRIMARY KEY CHECK (semantic_idempotency_sha256 LIKE 'sha256:%'),
  human_act_sha256 TEXT NOT NULL UNIQUE CHECK (human_act_sha256 LIKE 'sha256:%'),
  human_act_json TEXT NOT NULL UNIQUE CHECK (json_valid(human_act_json) AND json_type(human_act_json) = 'object'),
  envelope_sha256 TEXT NOT NULL UNIQUE CHECK (envelope_sha256 LIKE 'sha256:%'),
  envelope_json TEXT NOT NULL UNIQUE CHECK (json_valid(envelope_json) AND json_type(envelope_json) = 'object'),
  provider_action_sha256 TEXT NOT NULL REFERENCES authority_provider_human_action_reproofs(provider_action_sha256),
  currentness_reproof_sha256 TEXT NOT NULL CHECK (currentness_reproof_sha256 LIKE 'sha256:%'),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE authority_record_write_receipts (
  receipt_sha256 TEXT PRIMARY KEY CHECK (receipt_sha256 LIKE 'sha256:%'),
  receipt_json TEXT NOT NULL UNIQUE CHECK (json_valid(receipt_json) AND json_type(receipt_json) = 'object'),
  semantic_idempotency_sha256 TEXT NOT NULL UNIQUE REFERENCES authority_record_write_inputs(semantic_idempotency_sha256),
  recorded_at TEXT NOT NULL
) STRICT;

-- The clean lineage has one append-only read-audit table. The nullable hash
-- reservation is deliberately inert until a later accepted Layer 4 decision.
CREATE TABLE authority_person_read_decision_audit_v2 (
  row_sha256 TEXT PRIMARY KEY CHECK (row_sha256 LIKE 'sha256:%'),
  body_json TEXT NOT NULL UNIQUE CHECK (json_valid(body_json) AND json_type(body_json) = 'object'),
  context_kind TEXT NOT NULL CHECK (context_kind IN ('record_read', 'answer_composition')),
  prompt_sha256 TEXT CHECK (prompt_sha256 IS NULL OR (
    length(prompt_sha256) = 71 AND prompt_sha256 LIKE 'sha256:%' AND
    substr(prompt_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  )),
  answer_sha256 TEXT CHECK (answer_sha256 IS NULL OR (
    length(answer_sha256) = 71 AND answer_sha256 LIKE 'sha256:%' AND
    substr(answer_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  )),
  recorded_at TEXT NOT NULL,
  CHECK (
    (context_kind = 'record_read' AND prompt_sha256 IS NULL AND answer_sha256 IS NULL) OR
    (context_kind = 'answer_composition' AND prompt_sha256 IS NOT NULL AND answer_sha256 IS NOT NULL)
  ),
  -- The indexed discriminator and hashes are redundant commitments of the
  -- immutable body. JSON null is distinct from an absent key.
  CHECK (
    COALESCE(
      json_type(body_json, '$.context_kind') = 'text' AND
      json_extract(body_json, '$.context_kind') = context_kind AND
      CASE
        WHEN prompt_sha256 IS NULL THEN json_type(body_json, '$.prompt_sha256') = 'null'
        WHEN json_type(body_json, '$.prompt_sha256') = 'text'
          THEN json_extract(body_json, '$.prompt_sha256') = prompt_sha256
        ELSE 0
      END AND
      CASE
        WHEN answer_sha256 IS NULL THEN json_type(body_json, '$.answer_sha256') = 'null'
        WHEN json_type(body_json, '$.answer_sha256') = 'text'
          THEN json_extract(body_json, '$.answer_sha256') = answer_sha256
        ELSE 0
      END,
      0
    )
  )
) STRICT;

CREATE TRIGGER authority_person_read_decision_audit_v2_immutable
BEFORE UPDATE ON authority_person_read_decision_audit_v2
BEGIN SELECT RAISE(ABORT, 'person read decision audit row is immutable'); END;

CREATE TRIGGER authority_person_read_decision_audit_v2_delete_denied
BEFORE DELETE ON authority_person_read_decision_audit_v2
BEGIN SELECT RAISE(ABORT, 'person read decision audit row deletion is denied'); END;

CREATE TABLE authority_readable_search_active_generation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  generation_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 LIKE 'sha256:%'),
  retrieval_contract_sha256 TEXT NOT NULL CHECK (retrieval_contract_sha256 LIKE 'sha256:%'),
  record_head_position INTEGER NOT NULL CHECK (record_head_position >= 0),
  record_head_hash TEXT CHECK (
    (record_head_position = 0 AND record_head_hash IS NULL) OR
    (record_head_position > 0 AND record_head_hash IS NOT NULL)
  ),
  published_at TEXT NOT NULL,
  UNIQUE (organization_id, generation_id, manifest_sha256)
) STRICT;

-- The clean founder source admission is deliberately one stopped-state,
-- live-only pipeline.  It records only configuration commitments and custody;
-- it contains neither provider bytes nor imported notes/candidates.
CREATE TABLE authority_clean_granola_source_admission_v1 (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  membership_type TEXT NOT NULL CHECK (membership_type = 'owner'),
  source_instance_id TEXT NOT NULL CHECK (
    source_instance_id GLOB '[a-z][a-z0-9-]*' AND
    length(source_instance_id) <= 128
  ),
  source_adapter_version TEXT NOT NULL CHECK (source_adapter_version = '2.2.0'),
  normalizer_version TEXT NOT NULL CHECK (normalizer_version = '2.2.0'),
  owner_email_sha256 TEXT NOT NULL CHECK (owner_email_sha256 LIKE 'sha256:%'),
  owner_observation_assurance TEXT NOT NULL CHECK (
    owner_observation_assurance = 'provider_record_owner_observed'
  ),
  owner_observed_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', owner_observed_at) IS NOT NULL AND
    owner_observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', owner_observed_at)
  ),
  source_credential_reference_sha256 TEXT NOT NULL CHECK (
    source_credential_reference_sha256 LIKE 'sha256:%'
  ),
  cursor TEXT NOT NULL UNIQUE,
  cutoff_at TEXT NOT NULL,
  processor_instance_id TEXT NOT NULL CHECK (
    processor_instance_id GLOB '[a-z][a-z0-9-]*' AND
    length(processor_instance_id) <= 128
  ),
  processor_adapter_version TEXT NOT NULL CHECK (
    processor_adapter_version GLOB '1.3.0+processing.[0-9a-f]*'
  ),
  processor_configuration_sha256 TEXT NOT NULL CHECK (
    processor_configuration_sha256 LIKE 'sha256:%'
  ),
  processor_credential_reference_sha256 TEXT NOT NULL CHECK (
    processor_credential_reference_sha256 LIKE 'sha256:%'
  ),
  semantic_input_sha256 TEXT NOT NULL UNIQUE CHECK (
    semantic_input_sha256 LIKE 'sha256:%'
  ),
  admitted_at TEXT NOT NULL,
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(
      membership_id, organization_id, principal_id, membership_type
    )
) STRICT;

CREATE TRIGGER authority_clean_granola_source_admission_v1_immutable
BEFORE UPDATE ON authority_clean_granola_source_admission_v1
BEGIN SELECT RAISE(ABORT, 'clean Granola source admission is immutable'); END;

CREATE TRIGGER authority_clean_granola_source_admission_v1_delete_denied
BEFORE DELETE ON authority_clean_granola_source_admission_v1
BEGIN SELECT RAISE(ABORT, 'clean Granola source admission deletion is denied'); END;

-- The mutable counterpart to the immutable live-only admission. It is exactly
-- one compare-and-set checkpoint for that admission, never a historical import
-- cursor or a queue of provider data. The first source run materializes it
-- from the admitted cutoff; every later move is an ordered cursor transition.
CREATE TABLE authority_clean_granola_source_progress_v1 (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  admission_semantic_input_sha256 TEXT NOT NULL UNIQUE
    REFERENCES authority_clean_granola_source_admission_v1(semantic_input_sha256),
  cursor TEXT NOT NULL UNIQUE CHECK (
    length(cursor) BETWEEN 1 AND 65536 AND
    substr(cursor, 1, 11) = 'granola:v1:'
  ),
  cursor_version INTEGER NOT NULL CHECK (cursor_version >= 0),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER authority_clean_granola_source_progress_v1_only_advances
BEFORE UPDATE ON authority_clean_granola_source_progress_v1
WHEN NEW.singleton != OLD.singleton
  OR NEW.admission_semantic_input_sha256 != OLD.admission_semantic_input_sha256
  OR NEW.cursor = OLD.cursor
  OR NEW.cursor_version != OLD.cursor_version + 1
BEGIN SELECT RAISE(ABORT, 'clean Granola source progress only permits ordered cursor advances'); END;

CREATE TRIGGER authority_clean_granola_source_progress_v1_delete_denied
BEFORE DELETE ON authority_clean_granola_source_progress_v1
BEGIN SELECT RAISE(ABORT, 'clean Granola source progress deletion is denied'); END;

-- Every extracted candidate is frozen in Authority before any Slack side
-- effect. This is the small restart boundary between the live source and the
-- control plane: raw source/processor facts remain Authority-owned, while the
-- control plane stores only the resulting human-approval commitment.
CREATE TABLE authority_clean_live_candidates_v1 (
  candidate_id TEXT PRIMARY KEY CHECK (candidate_id GLOB 'cnd_*'),
  candidate_semantic_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(candidate_semantic_sha256) = 71 AND
    substr(candidate_semantic_sha256, 1, 7) = 'sha256:'
  ),
  admission_semantic_input_sha256 TEXT NOT NULL
    REFERENCES authority_clean_granola_source_admission_v1(semantic_input_sha256),
  source_cursor TEXT NOT NULL CHECK (
    length(source_cursor) BETWEEN 1 AND 65536 AND
    substr(source_cursor, 1, 11) = 'granola:v1:'
  ),
  meeting_sha256 TEXT NOT NULL CHECK (meeting_sha256 LIKE 'sha256:%'),
  meeting_json TEXT NOT NULL UNIQUE CHECK (
    json_valid(meeting_json) AND json_type(meeting_json) = 'object'
  ),
  decisions_sha256 TEXT NOT NULL CHECK (decisions_sha256 LIKE 'sha256:%'),
  decisions_json TEXT NOT NULL UNIQUE CHECK (
    json_valid(decisions_json) AND json_type(decisions_json) = 'object'
  ),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER authority_clean_live_candidates_v1_immutable_update
BEFORE UPDATE ON authority_clean_live_candidates_v1
BEGIN SELECT RAISE(ABORT, 'clean live candidate is immutable'); END;

CREATE TRIGGER authority_clean_live_candidates_v1_delete_denied
BEFORE DELETE ON authority_clean_live_candidates_v1
BEGIN SELECT RAISE(ABORT, 'clean live candidate deletion is denied'); END;

-- The exact post-once handoff. It starts queued with deterministic approval
-- and command identities, persists the Slack card reference exactly once, and
-- finally records the immutable D2 commitment digest. No retired machine
-- capability or historical cursor can enter this outbox.
CREATE TABLE authority_clean_live_approval_outbox_v1 (
  candidate_id TEXT PRIMARY KEY
    REFERENCES authority_clean_live_candidates_v1(candidate_id),
  approval_id TEXT NOT NULL UNIQUE CHECK (approval_id GLOB 'apr_*'),
  stage_command_id TEXT NOT NULL UNIQUE CHECK (stage_command_id GLOB 'pas_*'),
  state TEXT NOT NULL CHECK (state IN ('queued', 'posted', 'staged')),
  provider_message_ts TEXT UNIQUE,
  frozen_card_sha256 TEXT CHECK (frozen_card_sha256 LIKE 'sha256:%'),
  approved_snapshot_json TEXT CHECK (
    approved_snapshot_json IS NULL OR
    (json_valid(approved_snapshot_json) AND json_type(approved_snapshot_json) = 'object')
  ),
  approved_snapshot_sha256 TEXT CHECK (approved_snapshot_sha256 LIKE 'sha256:%'),
  control_approval_sha256 TEXT UNIQUE CHECK (control_approval_sha256 LIKE 'sha256:%'),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  CHECK (
    (state = 'queued' AND provider_message_ts IS NULL AND
      frozen_card_sha256 IS NULL AND approved_snapshot_json IS NULL AND
      approved_snapshot_sha256 IS NULL AND
      control_approval_sha256 IS NULL) OR
    (state = 'posted' AND provider_message_ts IS NOT NULL AND
      frozen_card_sha256 IS NOT NULL AND approved_snapshot_json IS NOT NULL AND
      approved_snapshot_sha256 IS NOT NULL AND
      control_approval_sha256 IS NULL) OR
    (state = 'staged' AND provider_message_ts IS NOT NULL AND
      frozen_card_sha256 IS NOT NULL AND approved_snapshot_json IS NOT NULL AND
      approved_snapshot_sha256 IS NOT NULL AND
      control_approval_sha256 IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER authority_clean_live_approval_outbox_v1_ordered_transition
BEFORE UPDATE ON authority_clean_live_approval_outbox_v1
WHEN NEW.candidate_id != OLD.candidate_id
  OR NEW.approval_id != OLD.approval_id
  OR NEW.stage_command_id != OLD.stage_command_id
  OR (OLD.state = 'queued' AND NEW.state NOT IN ('posted'))
  OR (OLD.state = 'posted' AND NEW.state NOT IN ('staged'))
  OR OLD.state = 'staged'
BEGIN SELECT RAISE(ABORT, 'clean live approval outbox only permits queued-posted-staged'); END;

CREATE TRIGGER authority_clean_live_approval_outbox_v1_delete_denied
BEFORE DELETE ON authority_clean_live_approval_outbox_v1
BEGIN SELECT RAISE(ABORT, 'clean live approval outbox deletion is denied'); END;

-- The V4 receipt is Authority-owned and immutable. It binds the resolved D2
-- witness to exactly one final record append without reusing removed
-- machine-era record-write tables.
CREATE TABLE authority_clean_live_v4_receipts_v1 (
  approval_id TEXT PRIMARY KEY
    REFERENCES authority_clean_live_approval_outbox_v1(approval_id),
  control_approval_sha256 TEXT NOT NULL CHECK (control_approval_sha256 LIKE 'sha256:%'),
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK (receipt_sha256 LIKE 'sha256:%'),
  receipt_json TEXT NOT NULL UNIQUE CHECK (
    json_valid(receipt_json) AND json_type(receipt_json) = 'object'
  ),
  recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER authority_clean_live_v4_receipts_v1_immutable_update
BEFORE UPDATE ON authority_clean_live_v4_receipts_v1
BEGIN SELECT RAISE(ABORT, 'clean live V4 receipt is immutable'); END;

CREATE TRIGGER authority_clean_live_v4_receipts_v1_delete_denied
BEFORE DELETE ON authority_clean_live_v4_receipts_v1
BEGIN SELECT RAISE(ABORT, 'clean live V4 receipt deletion is denied'); END;
