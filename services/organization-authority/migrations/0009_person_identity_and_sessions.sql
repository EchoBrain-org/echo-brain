-- Provider-neutral person identity and opaque browser-session persistence.
--
-- OIDC identities are keyed only by the exact `(issuer, subject)` pair. Raw
-- state, nonce, login-grant, access-token, refresh-token, and PKCE verifier
-- values have no column in this schema. The PKCE verifier is accepted only as
-- an already sealed byte string; cryptographic sealing remains an application
-- adapter responsibility.

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
  UNIQUE (issuer, subject),
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
WHEN NEW.consumed_at IS NOT NULL
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
