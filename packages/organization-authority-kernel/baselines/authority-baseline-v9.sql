-- Authority baseline V7: project context plus raw Person uploads and optional
-- search enrichment. Fresh initialization only; no V6-to-V7 transition or
-- backfill exists, and this file is never an in-place upgrade.

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
  ), expected_email_sha256 TEXT NOT NULL CHECK (
    length(expected_email_sha256) = 71 AND
    substr(expected_email_sha256, 1, 7) = 'sha256:' AND
    substr(expected_email_sha256, 8) NOT GLOB '*[^0-9a-f]*'
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
  upstream_assertion_issued_at TEXT CHECK (
    upstream_assertion_issued_at IS NULL OR (
      strftime('%Y-%m-%dT%H:%M:%fZ', upstream_assertion_issued_at) IS NOT NULL AND
      upstream_assertion_issued_at = strftime(
        '%Y-%m-%dT%H:%M:%fZ', upstream_assertion_issued_at
      ) AND
      upstream_assertion_issued_at >= strftime(
        '%Y-%m-%dT%H:%M:%fZ', created_at, '-60 seconds'
      ) AND
      upstream_assertion_issued_at <= strftime(
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
      resolved_identity_binding_id IS NULL AND upstream_assertion_issued_at IS NULL AND
      pkce_verifier_seal_key_id IS NOT NULL AND
      pkce_verifier_sealed IS NOT NULL) OR
    (terminal_outcome = 'succeeded' AND completed_at IS NOT NULL AND
      completed_at < expires_at AND resolved_identity_binding_id IS NOT NULL AND
      upstream_assertion_issued_at IS NOT NULL AND
      redemption_claim_id IS NULL AND redemption_claimed_at IS NULL AND
      pkce_verifier_seal_key_id IS NULL AND pkce_verifier_sealed IS NULL) OR
    (terminal_outcome = 'denied' AND completed_at IS NOT NULL AND
      completed_at < expires_at AND resolved_identity_binding_id IS NULL AND
      upstream_assertion_issued_at IS NULL AND
      redemption_claim_id IS NULL AND redemption_claimed_at IS NULL AND
      pkce_verifier_seal_key_id IS NULL AND pkce_verifier_sealed IS NULL) OR
    (terminal_outcome = 'expired' AND completed_at IS NOT NULL AND
      completed_at >= expires_at AND resolved_identity_binding_id IS NULL AND
      upstream_assertion_issued_at IS NULL AND
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
  upstream_assertion_issued_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', upstream_assertion_issued_at) IS NOT NULL AND
    upstream_assertion_issued_at = strftime('%Y-%m-%dT%H:%M:%fZ', upstream_assertion_issued_at) AND
    upstream_assertion_issued_at <= strftime(
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
      '%Y-%m-%dT%H:%M:%fZ', upstream_assertion_issued_at, '+7 days'
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

CREATE TABLE authority_live_source_admission_v2 (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  membership_type TEXT NOT NULL CHECK (membership_type = 'owner'),
  source_adapter_id TEXT NOT NULL CHECK (length(trim(source_adapter_id)) BETWEEN 1 AND 128),
  source_adapter_version TEXT NOT NULL CHECK (length(trim(source_adapter_version)) BETWEEN 1 AND 128),
  source_adapter_instance_id TEXT NOT NULL CHECK (
    source_adapter_instance_id GLOB '[a-z][a-z0-9-]*' AND
    length(source_adapter_instance_id) <= 128
  ),
  normalizer_version TEXT NOT NULL CHECK (length(trim(normalizer_version)) BETWEEN 1 AND 128),
  source_custodian_sha256 TEXT NOT NULL CHECK (source_custodian_sha256 LIKE 'sha256:%'),
  source_custodian_assurance TEXT NOT NULL CHECK (
    length(trim(source_custodian_assurance)) BETWEEN 1 AND 128
  ),
  source_custodian_observed_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', source_custodian_observed_at) IS NOT NULL AND
    source_custodian_observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', source_custodian_observed_at)
  ),
  source_credential_reference_sha256 TEXT NOT NULL CHECK (source_credential_reference_sha256 LIKE 'sha256:%'),
  initial_cursor TEXT NOT NULL UNIQUE CHECK (length(initial_cursor) BETWEEN 1 AND 65536),
  cutoff_at TEXT NOT NULL CHECK (unixepoch(cutoff_at) IS NOT NULL),
  processor_adapter_id TEXT NOT NULL CHECK (length(trim(processor_adapter_id)) BETWEEN 1 AND 128),
  processor_adapter_version TEXT NOT NULL CHECK (length(trim(processor_adapter_version)) BETWEEN 1 AND 128),
  processor_instance_id TEXT NOT NULL CHECK (
    processor_instance_id GLOB '[a-z][a-z0-9-]*' AND
    length(processor_instance_id) <= 128
  ),
  processor_configuration_sha256 TEXT NOT NULL CHECK (processor_configuration_sha256 LIKE 'sha256:%'),
  processor_credential_reference_sha256 TEXT NOT NULL CHECK (processor_credential_reference_sha256 LIKE 'sha256:%'),
  semantic_input_sha256 TEXT NOT NULL UNIQUE CHECK (semantic_input_sha256 LIKE 'sha256:%'),
  admitted_at TEXT NOT NULL CHECK (unixepoch(admitted_at) IS NOT NULL),
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(membership_id, organization_id, principal_id, membership_type)
) STRICT;

CREATE TABLE authority_live_source_progress_v2 (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  admission_semantic_input_sha256 TEXT NOT NULL UNIQUE
    REFERENCES authority_live_source_admission_v2(semantic_input_sha256),
  cursor TEXT NOT NULL UNIQUE CHECK (length(cursor) BETWEEN 1 AND 65536),
  cursor_version INTEGER NOT NULL CHECK (cursor_version >= 0),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL)
) STRICT;

CREATE TABLE authority_live_source_candidates_v2 (
  candidate_id TEXT PRIMARY KEY CHECK (candidate_id GLOB 'cnd_*'),
  candidate_semantic_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(candidate_semantic_sha256) = 71 AND substr(candidate_semantic_sha256, 1, 7) = 'sha256:'
  ),
  admission_semantic_input_sha256 TEXT NOT NULL
    REFERENCES authority_live_source_admission_v2(semantic_input_sha256),
  review_lineage_id TEXT NOT NULL CHECK (review_lineage_id GLOB 'rli_*'),
  review_input_sha256 TEXT NOT NULL CHECK (review_input_sha256 LIKE 'sha256:%'),
  review_semantic_sha256 TEXT NOT NULL CHECK (review_semantic_sha256 LIKE 'sha256:%'),
  review_policy_id TEXT NOT NULL CHECK (length(review_policy_id) BETWEEN 1 AND 256),
  review_policy_contract_sha256 TEXT NOT NULL CHECK (review_policy_contract_sha256 LIKE 'sha256:%'),
  review_policy_consequence_text TEXT NOT NULL CHECK (length(review_policy_consequence_text) BETWEEN 1 AND 8192),
  review_policy_consequence_sha256 TEXT NOT NULL CHECK (review_policy_consequence_sha256 LIKE 'sha256:%'),
  disposition TEXT NOT NULL CHECK (disposition IN ('actionable', 'coalesced', 'no_signals')),
  source_cursor TEXT NOT NULL CHECK (length(source_cursor) BETWEEN 1 AND 65536),
  meeting_sha256 TEXT NOT NULL CHECK (meeting_sha256 LIKE 'sha256:%'),
  meeting_json TEXT NOT NULL UNIQUE CHECK (json_valid(meeting_json) AND json_type(meeting_json) = 'object'),
  decisions_sha256 TEXT NOT NULL CHECK (decisions_sha256 LIKE 'sha256:%'),
  decisions_json TEXT NOT NULL UNIQUE CHECK (json_valid(decisions_json) AND json_type(decisions_json) = 'object'),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TABLE authority_live_source_review_lineage_heads_v2 (
  review_lineage_id TEXT PRIMARY KEY CHECK (review_lineage_id GLOB 'rli_*'),
  candidate_id TEXT NOT NULL UNIQUE REFERENCES authority_live_source_candidates_v2(candidate_id),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL)
) STRICT;

CREATE TABLE authority_live_approval_outbox_v2 (
  candidate_id TEXT PRIMARY KEY REFERENCES authority_live_source_candidates_v2(candidate_id),
  approval_id TEXT NOT NULL UNIQUE CHECK (approval_id GLOB 'apr_*'),
  stage_command_id TEXT NOT NULL UNIQUE CHECK (stage_command_id GLOB 'pas_*'),
  state TEXT NOT NULL CHECK (state IN ('queued', 'posting', 'posted', 'staged', 'superseded')),
  provider_message_ts TEXT UNIQUE,
  frozen_card_sha256 TEXT CHECK (frozen_card_sha256 LIKE 'sha256:%'),
  approved_snapshot_json TEXT CHECK (approved_snapshot_json IS NULL OR (json_valid(approved_snapshot_json) AND json_type(approved_snapshot_json) = 'object')),
  approved_snapshot_sha256 TEXT CHECK (approved_snapshot_sha256 LIKE 'sha256:%'),
  post_started_at TEXT CHECK (post_started_at IS NULL OR unixepoch(post_started_at) IS NOT NULL),
  control_approval_sha256 TEXT UNIQUE CHECK (control_approval_sha256 LIKE 'sha256:%'),
  superseded_by_candidate_id TEXT REFERENCES authority_live_source_candidates_v2(candidate_id),
  superseded_at TEXT CHECK (superseded_at IS NULL OR unixepoch(superseded_at) IS NOT NULL),
  tombstoned_at TEXT CHECK (tombstoned_at IS NULL OR unixepoch(tombstoned_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  CHECK (
    (state = 'queued' AND provider_message_ts IS NULL AND frozen_card_sha256 IS NULL AND approved_snapshot_json IS NULL AND approved_snapshot_sha256 IS NULL AND post_started_at IS NULL AND control_approval_sha256 IS NULL AND superseded_by_candidate_id IS NULL AND superseded_at IS NULL AND tombstoned_at IS NULL) OR
    (state = 'posting' AND provider_message_ts IS NULL AND frozen_card_sha256 IS NOT NULL AND approved_snapshot_json IS NOT NULL AND approved_snapshot_sha256 IS NOT NULL AND post_started_at IS NOT NULL AND control_approval_sha256 IS NULL AND superseded_by_candidate_id IS NULL AND superseded_at IS NULL AND tombstoned_at IS NULL) OR
    (state = 'posted' AND provider_message_ts IS NOT NULL AND frozen_card_sha256 IS NOT NULL AND approved_snapshot_json IS NOT NULL AND approved_snapshot_sha256 IS NOT NULL AND post_started_at IS NOT NULL AND control_approval_sha256 IS NULL AND superseded_by_candidate_id IS NULL AND superseded_at IS NULL AND tombstoned_at IS NULL) OR
    (state = 'staged' AND provider_message_ts IS NOT NULL AND frozen_card_sha256 IS NOT NULL AND approved_snapshot_json IS NOT NULL AND approved_snapshot_sha256 IS NOT NULL AND post_started_at IS NOT NULL AND control_approval_sha256 IS NOT NULL AND superseded_by_candidate_id IS NULL AND superseded_at IS NULL AND tombstoned_at IS NULL) OR
    (state = 'superseded' AND ((provider_message_ts IS NULL AND frozen_card_sha256 IS NULL AND approved_snapshot_json IS NULL AND approved_snapshot_sha256 IS NULL AND post_started_at IS NULL AND control_approval_sha256 IS NULL) OR (frozen_card_sha256 IS NOT NULL AND approved_snapshot_json IS NOT NULL AND approved_snapshot_sha256 IS NOT NULL AND post_started_at IS NOT NULL)) AND superseded_by_candidate_id IS NOT NULL AND superseded_at IS NOT NULL AND (tombstoned_at IS NULL OR provider_message_ts IS NOT NULL))
  )
) STRICT;

CREATE TABLE authority_private_approval_assignments_v3 (
  approval_id TEXT NOT NULL UNIQUE CHECK (approval_id GLOB 'apr_*'),
  candidate_id TEXT NOT NULL UNIQUE REFERENCES authority_live_source_candidates_v2(candidate_id),
  candidate_sha256 TEXT NOT NULL CHECK (candidate_sha256 LIKE 'sha256:%'),
  frozen_card_sha256 TEXT NOT NULL CHECK (frozen_card_sha256 LIKE 'sha256:%'),
  approved_snapshot_sha256 TEXT NOT NULL CHECK (approved_snapshot_sha256 LIKE 'sha256:%'),
  connection_id TEXT NOT NULL CHECK (connection_id GLOB 'con_*'),
  connection_contract_sha256 TEXT NOT NULL CHECK (connection_contract_sha256 LIKE 'sha256:%'),
  connection_state_sha256 TEXT NOT NULL CHECK (connection_state_sha256 LIKE 'sha256:%'),
  external_identity_link_id TEXT NOT NULL CHECK (external_identity_link_id GLOB 'clm_*'),
  external_identity_link_contract_sha256 TEXT NOT NULL CHECK (external_identity_link_contract_sha256 LIKE 'sha256:%'),
  assignee_principal_id TEXT NOT NULL CHECK (assignee_principal_id GLOB 'prn_*'),
  assignee_membership_id TEXT NOT NULL CHECK (assignee_membership_id GLOB 'mem_*'),
  slack_workspace_id TEXT NOT NULL CHECK (length(trim(slack_workspace_id)) > 0),
  slack_enterprise_id TEXT CHECK (
    slack_enterprise_id IS NULL OR length(trim(slack_enterprise_id)) > 0
  ),
  slack_subject_id TEXT NOT NULL CHECK (length(trim(slack_subject_id)) > 0),
  slack_dm_channel_id TEXT NOT NULL CHECK (
    length(trim(slack_dm_channel_id)) > 0 AND substr(slack_dm_channel_id, 1, 1) = 'D'
  ),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  PRIMARY KEY (approval_id, candidate_id)
) STRICT;

CREATE TABLE authority_private_approval_terminal_receipts_v3 (
  approval_id TEXT PRIMARY KEY CHECK (approval_id GLOB 'apr_*'),
  candidate_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'rejected')),
  resolution_json TEXT NOT NULL UNIQUE CHECK (json_valid(resolution_json) AND json_type(resolution_json) = 'object'),
  resolution_sha256 TEXT NOT NULL UNIQUE CHECK (length(resolution_sha256) = 71 AND substr(resolution_sha256, 1, 7) = 'sha256:' AND substr(resolution_sha256, 8) NOT GLOB '*[^0-9a-f]*'),
  v4_receipt_json TEXT UNIQUE CHECK (v4_receipt_json IS NULL OR (json_valid(v4_receipt_json) AND json_type(v4_receipt_json) = 'object')),
  v4_receipt_sha256 TEXT UNIQUE CHECK (v4_receipt_sha256 IS NULL OR (length(v4_receipt_sha256) = 71 AND substr(v4_receipt_sha256, 1, 7) = 'sha256:' AND substr(v4_receipt_sha256, 8) NOT GLOB '*[^0-9a-f]*')),
  card_render_state TEXT NOT NULL CHECK (card_render_state IN ('unrendered', 'rendered')),
  card_rendered_at TEXT CHECK (card_rendered_at IS NULL OR unixepoch(card_rendered_at) IS NOT NULL),
  recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
  FOREIGN KEY (approval_id, candidate_id) REFERENCES authority_private_approval_assignments_v3(approval_id, candidate_id),
  CHECK ((outcome = 'approved' AND v4_receipt_json IS NOT NULL AND v4_receipt_sha256 IS NOT NULL) OR (outcome = 'rejected' AND v4_receipt_json IS NULL AND v4_receipt_sha256 IS NULL)),
  CHECK ((card_render_state = 'unrendered' AND card_rendered_at IS NULL) OR (card_render_state = 'rendered' AND card_rendered_at IS NOT NULL))
) STRICT;

CREATE TABLE authority_live_approval_delivery_quarantines_v1 (
  candidate_id TEXT PRIMARY KEY
    REFERENCES authority_live_approval_outbox_v2(candidate_id),
  reason_code TEXT NOT NULL CHECK (
    reason_code = 'approval_package_unrepresentable'
  ),
  quarantined_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', quarantined_at) IS NOT NULL AND
    quarantined_at = strftime('%Y-%m-%dT%H:%M:%fZ', quarantined_at)
  )
) STRICT;

CREATE INDEX authority_memberships_current
  ON authority_memberships (principal_id, status, membership_id);

CREATE UNIQUE INDEX authority_memberships_active_employee_email
  ON authority_memberships (organization_id, employee_email_sha256)
  WHERE membership_type = 'employee' AND status = 'active';

CREATE INDEX authority_person_login_grants_membership
  ON authority_person_login_grants (membership_id, issued_at);

CREATE INDEX authority_person_login_grants_pending_membership
  ON authority_person_login_grants (membership_id, consumed_at);

CREATE INDEX authority_person_login_grants_expiry
  ON authority_person_login_grants (expires_at, login_grant_sha256);

CREATE INDEX authority_oidc_identity_bindings_membership
  ON authority_oidc_identity_bindings (membership_id, status);

CREATE UNIQUE INDEX authority_oidc_identity_bindings_active_subject
  ON authority_oidc_identity_bindings (issuer, subject)
  WHERE status = 'active';

CREATE INDEX authority_oidc_login_attempts_expiry
  ON authority_oidc_login_attempts (expires_at, login_attempt_id);

CREATE INDEX authority_person_session_families_membership
  ON authority_person_session_families (membership_id, status, created_at);

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

CREATE INDEX authority_live_source_candidates_v2_review_input
ON authority_live_source_candidates_v2(review_lineage_id, review_input_sha256, created_at);

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
  NEW.upstream_assertion_issued_at IS NULL AND
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
      OLD.upstream_assertion_issued_at IS NULL AND NEW.upstream_assertion_issued_at IS NULL AND
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
      OLD.upstream_assertion_issued_at IS NULL AND NEW.upstream_assertion_issued_at IS NULL AND
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
      OLD.upstream_assertion_issued_at IS NULL AND
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
      OLD.upstream_assertion_issued_at IS NULL AND NEW.upstream_assertion_issued_at IS NULL AND
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
       AND attempt.upstream_assertion_issued_at = NEW.upstream_assertion_issued_at
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
  NEW.upstream_assertion_issued_at IS OLD.upstream_assertion_issued_at AND
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

CREATE TRIGGER authority_person_read_decision_audit_v2_immutable
BEFORE UPDATE ON authority_person_read_decision_audit_v2
BEGIN SELECT RAISE(ABORT, 'person read decision audit row is immutable'); END;

CREATE TRIGGER authority_person_read_decision_audit_v2_delete_denied
BEFORE DELETE ON authority_person_read_decision_audit_v2
BEGIN SELECT RAISE(ABORT, 'person read decision audit row deletion is denied'); END;

CREATE TRIGGER authority_live_source_admission_v2_immutable
BEFORE UPDATE ON authority_live_source_admission_v2
BEGIN SELECT RAISE(ABORT, 'live source admission is immutable'); END;

CREATE TRIGGER authority_live_source_admission_v2_delete_denied
BEFORE DELETE ON authority_live_source_admission_v2
BEGIN SELECT RAISE(ABORT, 'live source admission deletion is denied'); END;

CREATE TRIGGER authority_live_source_progress_v2_only_advances
BEFORE UPDATE ON authority_live_source_progress_v2
WHEN NEW.singleton != OLD.singleton
  OR NEW.admission_semantic_input_sha256 != OLD.admission_semantic_input_sha256
  OR NEW.cursor = OLD.cursor
  OR NEW.cursor_version != OLD.cursor_version + 1
BEGIN SELECT RAISE(ABORT, 'live source progress only permits ordered cursor advances'); END;

CREATE TRIGGER authority_live_source_progress_v2_delete_denied
BEFORE DELETE ON authority_live_source_progress_v2
BEGIN SELECT RAISE(ABORT, 'live source progress deletion is denied'); END;

CREATE TRIGGER authority_live_source_candidates_v2_immutable_update
BEFORE UPDATE ON authority_live_source_candidates_v2
BEGIN SELECT RAISE(ABORT, 'live source candidate is immutable'); END;

CREATE TRIGGER authority_live_source_candidates_v2_delete_denied
BEFORE DELETE ON authority_live_source_candidates_v2
BEGIN SELECT RAISE(ABORT, 'live source candidate deletion is denied'); END;

CREATE TRIGGER authority_live_source_review_lineage_heads_v2_candidate_matches_lineage_insert
BEFORE INSERT ON authority_live_source_review_lineage_heads_v2
WHEN NOT EXISTS (
  SELECT 1 FROM authority_live_source_candidates_v2
   WHERE candidate_id = NEW.candidate_id AND review_lineage_id = NEW.review_lineage_id
)
BEGIN SELECT RAISE(ABORT, 'live source review lineage head candidate must match its lineage'); END;

CREATE TRIGGER authority_live_source_review_lineage_heads_v2_candidate_matches_lineage_update
BEFORE UPDATE ON authority_live_source_review_lineage_heads_v2
WHEN NOT EXISTS (
  SELECT 1 FROM authority_live_source_candidates_v2
   WHERE candidate_id = NEW.candidate_id AND review_lineage_id = NEW.review_lineage_id
)
BEGIN SELECT RAISE(ABORT, 'live source review lineage head candidate must match its lineage'); END;

CREATE TRIGGER authority_live_source_review_lineage_heads_v2_delete_denied
BEFORE DELETE ON authority_live_source_review_lineage_heads_v2
BEGIN SELECT RAISE(ABORT, 'live source review lineage head deletion is denied'); END;

CREATE TRIGGER authority_live_source_review_lineage_heads_v2_ordered_update
BEFORE UPDATE ON authority_live_source_review_lineage_heads_v2
WHEN NEW.review_lineage_id != OLD.review_lineage_id
  OR NEW.candidate_id = OLD.candidate_id
  OR unixepoch(NEW.updated_at) < unixepoch(OLD.updated_at)
BEGIN SELECT RAISE(ABORT, 'live source review lineage head only permits ordered successor advances'); END;

CREATE TRIGGER authority_live_approval_outbox_v2_ordered_transition
BEFORE UPDATE ON authority_live_approval_outbox_v2
WHEN NEW.candidate_id != OLD.candidate_id
  OR NEW.approval_id != OLD.approval_id
  OR NEW.stage_command_id != OLD.stage_command_id
  OR (OLD.state = 'queued' AND NEW.state NOT IN ('posting', 'superseded'))
  OR (OLD.state = 'posting' AND NEW.state NOT IN ('queued', 'posted', 'superseded'))
  OR (OLD.state = 'posted' AND NEW.state NOT IN ('staged', 'superseded'))
  OR (OLD.state = 'staged' AND NEW.state NOT IN ('superseded'))
  -- A provider or approval result can land after another runner supersedes
  -- the outbox. Permit each missing external witness to be filled once while
  -- preserving every already-known field.
  OR (OLD.state = 'superseded' AND NOT (
      NEW.state = 'superseded'
      AND NEW.superseded_by_candidate_id IS OLD.superseded_by_candidate_id
      AND NEW.superseded_at IS OLD.superseded_at
      AND (NEW.post_started_at IS OLD.post_started_at OR
           (OLD.provider_message_ts IS NULL AND
            OLD.post_started_at IS NOT NULL AND NEW.post_started_at IS NULL))
      AND (
        (NEW.provider_message_ts IS OLD.provider_message_ts
         AND NEW.frozen_card_sha256 IS OLD.frozen_card_sha256
         AND NEW.approved_snapshot_json IS OLD.approved_snapshot_json
         AND NEW.approved_snapshot_sha256 IS OLD.approved_snapshot_sha256
         AND NEW.control_approval_sha256 IS OLD.control_approval_sha256
         AND NEW.tombstoned_at IS OLD.tombstoned_at)
        OR
        (OLD.provider_message_ts IS NULL
         AND NEW.provider_message_ts IS NOT NULL
         AND NEW.frozen_card_sha256 IS OLD.frozen_card_sha256
         AND NEW.approved_snapshot_json IS OLD.approved_snapshot_json
         AND NEW.approved_snapshot_sha256 IS OLD.approved_snapshot_sha256
         AND NEW.control_approval_sha256 IS OLD.control_approval_sha256
         AND NEW.tombstoned_at IS OLD.tombstoned_at)
        OR
        (OLD.control_approval_sha256 IS NULL
         AND NEW.control_approval_sha256 IS NOT NULL
         AND NEW.provider_message_ts IS OLD.provider_message_ts
         AND NEW.frozen_card_sha256 IS OLD.frozen_card_sha256
         AND NEW.approved_snapshot_json IS OLD.approved_snapshot_json
         AND NEW.approved_snapshot_sha256 IS OLD.approved_snapshot_sha256
         AND NEW.tombstoned_at IS OLD.tombstoned_at)
        OR
        (OLD.tombstoned_at IS NULL
         AND NEW.tombstoned_at IS NOT NULL
         AND OLD.provider_message_ts IS NOT NULL
         AND OLD.frozen_card_sha256 IS NOT NULL
         AND OLD.approved_snapshot_json IS NOT NULL
         AND OLD.approved_snapshot_sha256 IS NOT NULL
         AND NEW.provider_message_ts IS OLD.provider_message_ts
         AND NEW.frozen_card_sha256 IS OLD.frozen_card_sha256
         AND NEW.approved_snapshot_json IS OLD.approved_snapshot_json
         AND NEW.approved_snapshot_sha256 IS OLD.approved_snapshot_sha256
         AND NEW.control_approval_sha256 IS OLD.control_approval_sha256
         AND NEW.updated_at = NEW.tombstoned_at)
        OR
        (OLD.provider_message_ts IS NULL
         AND OLD.frozen_card_sha256 IS NOT NULL
         AND OLD.approved_snapshot_json IS NOT NULL
         AND OLD.approved_snapshot_sha256 IS NOT NULL
         AND OLD.post_started_at IS NOT NULL
         AND OLD.control_approval_sha256 IS NULL
         AND NEW.provider_message_ts IS NULL
         AND NEW.frozen_card_sha256 IS NULL
         AND NEW.approved_snapshot_json IS NULL
         AND NEW.approved_snapshot_sha256 IS NULL
         AND NEW.post_started_at IS NULL
         AND NEW.control_approval_sha256 IS NULL
         AND NEW.tombstoned_at IS NULL)
      )
    ))
  OR (OLD.provider_message_ts IS NOT NULL AND NEW.provider_message_ts IS NOT OLD.provider_message_ts)
  OR (OLD.frozen_card_sha256 IS NOT NULL AND NEW.frozen_card_sha256 IS NOT OLD.frozen_card_sha256
      AND NOT (OLD.state = 'posting' AND NEW.state = 'queued')
      AND NOT (OLD.state = 'superseded' AND NEW.state = 'superseded'
               AND OLD.provider_message_ts IS NULL AND NEW.post_started_at IS NULL))
  OR (OLD.approved_snapshot_json IS NOT NULL AND NEW.approved_snapshot_json IS NOT OLD.approved_snapshot_json
      AND NOT (OLD.state = 'posting' AND NEW.state = 'queued')
      AND NOT (OLD.state = 'superseded' AND NEW.state = 'superseded'
               AND OLD.provider_message_ts IS NULL AND NEW.post_started_at IS NULL))
  OR (OLD.approved_snapshot_sha256 IS NOT NULL AND NEW.approved_snapshot_sha256 IS NOT OLD.approved_snapshot_sha256
      AND NOT (OLD.state = 'posting' AND NEW.state = 'queued')
      AND NOT (OLD.state = 'superseded' AND NEW.state = 'superseded'
               AND OLD.provider_message_ts IS NULL AND NEW.post_started_at IS NULL))
  OR (OLD.post_started_at IS NOT NULL AND NEW.post_started_at IS NOT OLD.post_started_at
      AND NOT (OLD.state = 'posting' AND NEW.state = 'queued')
      AND NOT (OLD.state = 'superseded' AND NEW.state = 'superseded'
               AND OLD.provider_message_ts IS NULL AND NEW.post_started_at IS NULL))
  OR (OLD.control_approval_sha256 IS NOT NULL AND NEW.control_approval_sha256 IS NOT OLD.control_approval_sha256)
  OR (OLD.state = 'queued' AND NEW.state = 'superseded' AND (NEW.provider_message_ts IS NOT NULL OR NEW.frozen_card_sha256 IS NOT NULL OR NEW.approved_snapshot_json IS NOT NULL OR NEW.approved_snapshot_sha256 IS NOT NULL OR NEW.post_started_at IS NOT NULL OR NEW.control_approval_sha256 IS NOT NULL))
  OR (OLD.state = 'posting' AND NEW.state = 'superseded' AND (NEW.provider_message_ts IS NOT OLD.provider_message_ts OR NEW.frozen_card_sha256 IS NOT OLD.frozen_card_sha256 OR NEW.approved_snapshot_json IS NOT OLD.approved_snapshot_json OR NEW.approved_snapshot_sha256 IS NOT OLD.approved_snapshot_sha256 OR NEW.post_started_at IS NOT OLD.post_started_at OR NEW.control_approval_sha256 IS NOT NULL))
  OR (OLD.state = 'posted' AND NEW.state = 'superseded' AND NEW.control_approval_sha256 IS NOT NULL)
  OR (OLD.state != 'superseded' AND NEW.tombstoned_at IS NOT NULL)
  OR (OLD.tombstoned_at IS NOT NULL AND NEW.tombstoned_at IS NOT OLD.tombstoned_at)
  OR (NEW.state = 'superseded' AND (NEW.superseded_by_candidate_id IS NULL OR NEW.superseded_at IS NULL))
  OR (NEW.state != 'superseded' AND (NEW.superseded_by_candidate_id IS NOT NULL OR NEW.superseded_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'live approval outbox only permits queued-posting-posted-staged-superseded'); END;

CREATE TRIGGER authority_live_approval_outbox_v2_delete_denied
BEFORE DELETE ON authority_live_approval_outbox_v2
BEGIN SELECT RAISE(ABORT, 'live approval outbox deletion is denied'); END;

CREATE TRIGGER authority_private_approval_assignments_v3_immutable_update
BEFORE UPDATE ON authority_private_approval_assignments_v3
BEGIN SELECT RAISE(ABORT, 'private approval assignment is immutable'); END;

CREATE TRIGGER authority_private_approval_assignments_v3_delete_denied
BEFORE DELETE ON authority_private_approval_assignments_v3
BEGIN SELECT RAISE(ABORT, 'private approval assignment cannot be deleted'); END;

CREATE TRIGGER authority_private_approval_terminal_receipts_v3_guarded_render_update
BEFORE UPDATE ON authority_private_approval_terminal_receipts_v3
WHEN NEW.approval_id != OLD.approval_id
  OR NEW.candidate_id != OLD.candidate_id
  OR NEW.outcome != OLD.outcome
  OR NEW.resolution_json != OLD.resolution_json
  OR NEW.resolution_sha256 != OLD.resolution_sha256
  OR NEW.v4_receipt_json IS NOT OLD.v4_receipt_json
  OR NEW.v4_receipt_sha256 IS NOT OLD.v4_receipt_sha256
  OR NEW.recorded_at != OLD.recorded_at
  OR OLD.card_render_state != 'unrendered'
  OR NEW.card_render_state != 'rendered'
  OR NEW.card_rendered_at IS NULL
BEGIN SELECT RAISE(ABORT, 'private approval terminal receipt only permits final card render acknowledgement'); END;

CREATE TRIGGER authority_private_approval_terminal_receipts_v3_delete_denied
BEFORE DELETE ON authority_private_approval_terminal_receipts_v3
BEGIN SELECT RAISE(ABORT, 'private approval terminal receipt cannot be deleted'); END;

CREATE TRIGGER authority_live_approval_delivery_quarantines_v1_immutable_update
BEFORE UPDATE ON authority_live_approval_delivery_quarantines_v1
BEGIN SELECT RAISE(ABORT, 'approval delivery quarantine is immutable'); END;

CREATE TRIGGER authority_live_approval_delivery_quarantines_v1_delete_denied
BEFORE DELETE ON authority_live_approval_delivery_quarantines_v1
BEGIN SELECT RAISE(ABORT, 'approval delivery quarantine deletion is denied'); END;

CREATE TRIGGER authority_live_approval_outbox_v2_quarantine_transition_fence
BEFORE UPDATE ON authority_live_approval_outbox_v2
WHEN EXISTS (
  SELECT 1
  FROM authority_live_approval_delivery_quarantines_v1
  WHERE candidate_id = OLD.candidate_id
)
  AND NOT (OLD.state <> 'superseded' AND NEW.state = 'superseded')
BEGIN SELECT RAISE(ABORT, 'quarantined approval outbox only permits supersession'); END;

-- The upload carrier records original text and explicit access, with no context taxonomy.
CREATE TABLE authority_person_updates_v1 (
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee')),
  request_id TEXT NOT NULL,
  context_id TEXT NOT NULL UNIQUE,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 LIKE 'sha256:%'),
  title TEXT NOT NULL CHECK (length(CAST(title AS BLOB)) BETWEEN 1 AND 200),
  text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) BETWEEN 1 AND 8192),
  visibility TEXT NOT NULL CHECK (visibility IN ('only_me', 'team')),
  received_at TEXT NOT NULL CHECK (unixepoch(received_at) IS NOT NULL),
  PRIMARY KEY (organization_id, membership_id, request_id),
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(membership_id, organization_id, principal_id, membership_type)
) STRICT;
CREATE TABLE authority_person_update_work_v1 (
  context_id TEXT PRIMARY KEY REFERENCES authority_person_updates_v1(context_id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'ready', 'unavailable')),
  search_hints TEXT NOT NULL DEFAULT '' CHECK (length(CAST(search_hints AS BLOB)) <= 4096),
  enrichment_sha256 TEXT CHECK (enrichment_sha256 LIKE 'sha256:%'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at TEXT NOT NULL CHECK (unixepoch(retry_at) IS NOT NULL)
) STRICT;
CREATE INDEX authority_person_update_work_v1_pending ON authority_person_update_work_v1(state, retry_at);
CREATE TABLE authority_person_upload_read_audit_v1 (
  row_sha256 TEXT PRIMARY KEY,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL)
) STRICT;
CREATE TRIGGER authority_person_updates_v1_immutable
BEFORE UPDATE ON authority_person_updates_v1
BEGIN SELECT RAISE(ABORT, 'Person upload is immutable'); END;
CREATE TRIGGER authority_person_updates_v1_delete_denied
BEFORE DELETE ON authority_person_updates_v1
BEGIN SELECT RAISE(ABORT, 'Person upload deletion is denied'); END;
CREATE TRIGGER authority_person_update_work_v1_identity_immutable
BEFORE UPDATE ON authority_person_update_work_v1
WHEN NEW.context_id != OLD.context_id
BEGIN SELECT RAISE(ABORT, 'Person upload work identity is immutable'); END;
CREATE TRIGGER authority_person_update_work_v1_delete_denied
BEFORE DELETE ON authority_person_update_work_v1
BEGIN SELECT RAISE(ABORT, 'Person upload work deletion is denied'); END;
CREATE TRIGGER authority_person_upload_read_audit_v1_immutable
BEFORE UPDATE ON authority_person_upload_read_audit_v1
BEGIN SELECT RAISE(ABORT, 'Person upload read audit is immutable'); END;
CREATE TRIGGER authority_person_upload_read_audit_v1_delete_denied
BEFORE DELETE ON authority_person_upload_read_audit_v1
BEGIN SELECT RAISE(ABORT, 'Person upload read audit deletion is denied'); END;

-- Project context V1 is fresh V7 state. It preserves the V1 carrier above
-- for supported current clients, but no V5/V6 row is ever copied here.
CREATE TABLE authority_project_authorization_state_v1 (
  organization_id TEXT PRIMARY KEY REFERENCES authority_metadata(organization_id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL)
) STRICT;

CREATE TABLE authority_projects_v1 (
  project_id TEXT PRIMARY KEY CHECK (
    length(project_id) = 40 AND
    project_id GLOB 'prj_????????-????-4???-[89ab]???-????????????' AND
    replace(substr(project_id, 5), '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  name TEXT NOT NULL CHECK (length(CAST(name AS BLOB)) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  creator_principal_id TEXT NOT NULL,
  creator_membership_id TEXT NOT NULL,
  creator_membership_type TEXT NOT NULL CHECK (creator_membership_type IN ('owner', 'employee')),
  UNIQUE (project_id, organization_id),
  FOREIGN KEY (creator_membership_id, organization_id, creator_principal_id, creator_membership_type)
    REFERENCES authority_memberships(membership_id, organization_id, principal_id, membership_type)
) STRICT;

CREATE TABLE authority_project_memberships_v1 (
  project_membership_id TEXT PRIMARY KEY CHECK (
    length(project_membership_id) = 40 AND
    project_membership_id GLOB 'pgm_????????-????-4???-[89ab]???-????????????' AND
    replace(substr(project_membership_id, 5), '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee')),
  role TEXT NOT NULL CHECK (role IN ('lead', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_at TEXT NOT NULL CHECK (unixepoch(granted_at) IS NOT NULL),
  revoked_at TEXT CHECK (revoked_at IS NULL OR unixepoch(revoked_at) IS NOT NULL),
  CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)),
  CHECK (revoked_at IS NULL OR unixepoch(revoked_at) >= unixepoch(granted_at)),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES authority_projects_v1(project_id, organization_id),
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(membership_id, organization_id, principal_id, membership_type)
) STRICT;
CREATE UNIQUE INDEX authority_project_memberships_v1_active_tenure
  ON authority_project_memberships_v1(project_id, membership_id)
  WHERE status = 'active';
CREATE INDEX authority_project_memberships_v1_current_member
  ON authority_project_memberships_v1(organization_id, membership_id, status, project_id);
CREATE INDEX authority_project_memberships_v1_project_roster
  ON authority_project_memberships_v1(project_id, status, role, membership_id);

CREATE TABLE authority_person_updates_v2 (
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee')),
  request_id TEXT NOT NULL,
  request_version INTEGER NOT NULL CHECK(request_version IN (2,3)),
  context_id TEXT NOT NULL UNIQUE,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 LIKE 'sha256:%'),
  title TEXT NOT NULL CHECK (length(CAST(title AS BLOB)) BETWEEN 1 AND 200),
  text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) BETWEEN 1 AND 8192),
  audience_kind TEXT NOT NULL CHECK (audience_kind IN ('only_me', 'team', 'project', 'projects')),
  audience_project_id TEXT,
  -- Canonical JSON arrays are checked by the admission adapter. These snapshots
  -- bind immutable request custody; current associations live in their own table.
  submitted_association_project_ids_json TEXT NOT NULL CHECK(json_valid(submitted_association_project_ids_json) AND json_type(submitted_association_project_ids_json) = 'array' AND json_array_length(submitted_association_project_ids_json) BETWEEN 0 AND 20),
  audience_project_ids_json TEXT NOT NULL CHECK(json_valid(audience_project_ids_json) AND json_type(audience_project_ids_json) = 'array' AND json_array_length(audience_project_ids_json) BETWEEN 0 AND 20),
  project_id TEXT,
  received_at TEXT NOT NULL CHECK (unixepoch(received_at) IS NOT NULL),
  PRIMARY KEY (organization_id, membership_id, request_id),
  UNIQUE (context_id, organization_id),
  CHECK (
    (request_version = 2 AND audience_kind = 'project' AND audience_project_id IS NOT NULL
      AND ((project_id IS NULL AND json_array_length(submitted_association_project_ids_json) = 0)
        OR (project_id IS NOT NULL AND json_array_length(submitted_association_project_ids_json) = 1
          AND json_extract(submitted_association_project_ids_json, '$[0]') = project_id))
      AND json_array_length(audience_project_ids_json) = 1
      AND json_extract(audience_project_ids_json, '$[0]') = audience_project_id) OR
    (request_version = 2 AND audience_kind IN ('only_me', 'team') AND audience_project_id IS NULL
      AND json_array_length(audience_project_ids_json) = 0
      AND ((project_id IS NULL AND json_array_length(submitted_association_project_ids_json) = 0)
        OR (project_id IS NOT NULL AND json_array_length(submitted_association_project_ids_json) = 1
          AND json_extract(submitted_association_project_ids_json, '$[0]') = project_id))) OR
    (request_version = 3 AND audience_kind IN ('only_me', 'team') AND audience_project_id IS NULL AND project_id IS NULL
      AND json_array_length(audience_project_ids_json) = 0) OR
    (request_version = 3 AND audience_kind = 'project' AND audience_project_id IS NOT NULL AND project_id IS NULL
      AND json_array_length(audience_project_ids_json) = 1
      AND json_extract(audience_project_ids_json, '$[0]') = audience_project_id) OR
    (request_version = 3 AND audience_kind = 'projects' AND audience_project_id IS NULL AND project_id IS NULL
      AND json_array_length(audience_project_ids_json) BETWEEN 1 AND 20)
  ),
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(membership_id, organization_id, principal_id, membership_type),
  FOREIGN KEY (audience_project_id, organization_id)
    REFERENCES authority_projects_v1(project_id, organization_id),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES authority_projects_v1(project_id, organization_id)
) STRICT;
CREATE INDEX authority_person_updates_v2_audience_project
  ON authority_person_updates_v2(organization_id, audience_kind, audience_project_id, received_at, context_id);

CREATE TABLE authority_person_update_work_v2 (
  context_id TEXT PRIMARY KEY REFERENCES authority_person_updates_v2(context_id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'ready', 'unavailable')),
  search_hints TEXT NOT NULL DEFAULT '' CHECK (length(CAST(search_hints AS BLOB)) <= 4096),
  enrichment_sha256 TEXT CHECK (enrichment_sha256 LIKE 'sha256:%'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  retry_at TEXT NOT NULL CHECK (unixepoch(retry_at) IS NOT NULL)
) STRICT;
CREATE INDEX authority_person_update_work_v2_pending ON authority_person_update_work_v2(state, retry_at);

CREATE TABLE authority_project_context_associations_v1 (
  context_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  associator_principal_id TEXT NOT NULL,
  associator_membership_id TEXT NOT NULL,
  associator_membership_type TEXT NOT NULL CHECK (associator_membership_type IN ('owner', 'employee')),
  associated_at TEXT NOT NULL CHECK (unixepoch(associated_at) IS NOT NULL),
  PRIMARY KEY (context_id, project_id),
  FOREIGN KEY (context_id, organization_id)
    REFERENCES authority_person_updates_v2(context_id, organization_id),
  FOREIGN KEY (project_id, organization_id)
    REFERENCES authority_projects_v1(project_id, organization_id),
  FOREIGN KEY (associator_membership_id, organization_id, associator_principal_id, associator_membership_type)
    REFERENCES authority_memberships(membership_id, organization_id, principal_id, membership_type)
) STRICT, WITHOUT ROWID;
CREATE INDEX authority_project_context_associations_v1_feed
  ON authority_project_context_associations_v1(project_id, associated_at DESC, context_id);
CREATE TRIGGER authority_project_context_associations_v1_update_denied
BEFORE UPDATE ON authority_project_context_associations_v1
BEGIN SELECT RAISE(ABORT, 'project context association update is denied'); END;

CREATE TABLE authority_person_update_audience_projects_v1 (
  context_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  PRIMARY KEY(context_id, project_id),
  FOREIGN KEY(context_id, organization_id) REFERENCES authority_person_updates_v2(context_id, organization_id),
  FOREIGN KEY(project_id, organization_id) REFERENCES authority_projects_v1(project_id, organization_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX authority_person_update_audience_projects_v1_project
  ON authority_person_update_audience_projects_v1(project_id, organization_id, context_id);
CREATE TRIGGER authority_person_update_audience_projects_v1_insert_fence
BEFORE INSERT ON authority_person_update_audience_projects_v1
WHEN NOT EXISTS (
  SELECT 1 FROM authority_person_updates_v2 u, json_each(u.audience_project_ids_json) ids
  WHERE u.context_id=NEW.context_id AND u.organization_id=NEW.organization_id
    AND u.audience_kind IN ('project','projects') AND ids.value=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'Person upload audience project must bind immutable custody'); END;
CREATE TRIGGER authority_person_update_audience_projects_v1_update_denied
BEFORE UPDATE ON authority_person_update_audience_projects_v1
BEGIN SELECT RAISE(ABORT, 'Person upload audience projects are immutable'); END;
CREATE TRIGGER authority_person_update_audience_projects_v1_delete_denied
BEFORE DELETE ON authority_person_update_audience_projects_v1
BEGIN SELECT RAISE(ABORT, 'Person upload audience projects are immutable'); END;

CREATE TABLE authority_project_command_receipts_v1 (
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee')),
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'member_set', 'member_remove', 'associate', 'dissociate', 'upload_submit', 'upload_submit_v3')),
  command_sha256 TEXT NOT NULL CHECK (command_sha256 LIKE 'sha256:%'),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  receipt_sha256 TEXT NOT NULL CHECK (receipt_sha256 LIKE 'sha256:%'),
  committed_at TEXT NOT NULL CHECK (unixepoch(committed_at) IS NOT NULL),
  PRIMARY KEY (organization_id, membership_id, request_id),
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(membership_id, organization_id, principal_id, membership_type)
) STRICT;

CREATE TABLE authority_project_read_audit_v1 (
  row_sha256 TEXT PRIMARY KEY CHECK (row_sha256 LIKE 'sha256:%'),
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER authority_person_updates_v2_immutable
BEFORE UPDATE ON authority_person_updates_v2
BEGIN SELECT RAISE(ABORT, 'Person upload V2 is immutable'); END;
CREATE TRIGGER authority_person_updates_v2_delete_denied
BEFORE DELETE ON authority_person_updates_v2
BEGIN SELECT RAISE(ABORT, 'Person upload V2 deletion is denied'); END;
CREATE TRIGGER authority_person_update_work_v2_identity_immutable
BEFORE UPDATE ON authority_person_update_work_v2
WHEN NEW.context_id != OLD.context_id
BEGIN SELECT RAISE(ABORT, 'Person upload V2 work identity is immutable'); END;
CREATE TRIGGER authority_person_update_work_v2_delete_denied
BEFORE DELETE ON authority_person_update_work_v2
BEGIN SELECT RAISE(ABORT, 'Person upload V2 work deletion is denied'); END;
CREATE TRIGGER authority_project_command_receipts_v1_immutable
BEFORE UPDATE ON authority_project_command_receipts_v1
BEGIN SELECT RAISE(ABORT, 'project command receipt is immutable'); END;
CREATE TRIGGER authority_project_command_receipts_v1_delete_denied
BEFORE DELETE ON authority_project_command_receipts_v1
BEGIN SELECT RAISE(ABORT, 'project command receipt deletion is denied'); END;
CREATE TRIGGER authority_project_read_audit_v1_immutable
BEFORE UPDATE ON authority_project_read_audit_v1
BEGIN SELECT RAISE(ABORT, 'project read audit is immutable'); END;
CREATE TRIGGER authority_project_read_audit_v1_delete_denied
BEFORE DELETE ON authority_project_read_audit_v1
BEGIN SELECT RAISE(ABORT, 'project read audit deletion is denied'); END;

-- Project authorization snapshots commit this private monotonic revision. The
-- triggers below cover every change that can affect project discovery, roster,
-- project-source visibility or directory rendering. It is deliberately absent
-- from Person responses and never represents a public/global activity count.
CREATE TRIGGER authority_project_authorization_state_v1_ordered_update
BEFORE UPDATE ON authority_project_authorization_state_v1
WHEN NEW.organization_id != OLD.organization_id
  OR NEW.revision != OLD.revision + 1
  OR unixepoch(NEW.updated_at) < unixepoch(OLD.updated_at)
BEGIN SELECT RAISE(ABORT, 'project authorization state only permits ordered revision advances'); END;
CREATE TRIGGER authority_project_authorization_state_v1_delete_denied
BEFORE DELETE ON authority_project_authorization_state_v1
BEGIN SELECT RAISE(ABORT, 'project authorization state cannot be deleted'); END;

CREATE TRIGGER authority_projects_v1_immutable
BEFORE UPDATE ON authority_projects_v1
BEGIN SELECT RAISE(ABORT, 'project metadata is immutable'); END;
CREATE TRIGGER authority_projects_v1_delete_denied
BEFORE DELETE ON authority_projects_v1
BEGIN SELECT RAISE(ABORT, 'project cannot be deleted'); END;

CREATE TRIGGER authority_project_memberships_v1_identity_immutable
BEFORE UPDATE ON authority_project_memberships_v1
WHEN NEW.project_membership_id != OLD.project_membership_id
  OR NEW.project_id != OLD.project_id
  OR NEW.organization_id != OLD.organization_id
  OR NEW.principal_id != OLD.principal_id
  OR NEW.membership_id != OLD.membership_id
  OR NEW.membership_type != OLD.membership_type
  OR NEW.granted_at != OLD.granted_at
BEGIN SELECT RAISE(ABORT, 'project membership identity is immutable'); END;
CREATE TRIGGER authority_project_memberships_v1_terminal_transition
BEFORE UPDATE ON authority_project_memberships_v1
WHEN NOT (
  (OLD.status = 'active' AND NEW.status = 'active' AND NEW.revoked_at IS NULL)
  OR
  (OLD.status = 'active' AND NEW.status = 'revoked' AND OLD.revoked_at IS NULL
   AND NEW.revoked_at IS NOT NULL AND NEW.role = OLD.role)
)
BEGIN SELECT RAISE(ABORT, 'project membership only permits active role updates or terminal revocation'); END;
CREATE TRIGGER authority_project_memberships_v1_delete_denied
BEFORE DELETE ON authority_project_memberships_v1
BEGIN SELECT RAISE(ABORT, 'project membership cannot be deleted'); END;

CREATE TRIGGER authority_project_auth_revision_project_insert
AFTER INSERT ON authority_projects_v1
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1,
         updated_at = CASE WHEN unixepoch(NEW.created_at) >= unixepoch(updated_at) THEN NEW.created_at ELSE updated_at END
   WHERE organization_id = NEW.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_project_membership_insert
AFTER INSERT ON authority_project_memberships_v1
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1,
         updated_at = CASE WHEN unixepoch(NEW.granted_at) >= unixepoch(updated_at) THEN NEW.granted_at ELSE updated_at END
   WHERE organization_id = NEW.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_project_membership_update
AFTER UPDATE ON authority_project_memberships_v1
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1,
         updated_at = CASE WHEN NEW.revoked_at IS NOT NULL AND unixepoch(NEW.revoked_at) >= unixepoch(updated_at) THEN NEW.revoked_at ELSE updated_at END
   WHERE organization_id = NEW.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_source_insert
AFTER INSERT ON authority_person_updates_v2
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1,
         updated_at = CASE WHEN unixepoch(NEW.received_at) >= unixepoch(updated_at) THEN NEW.received_at ELSE updated_at END
   WHERE organization_id = NEW.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_association_insert
AFTER INSERT ON authority_project_context_associations_v1
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1,
         updated_at = CASE WHEN unixepoch(NEW.associated_at) >= unixepoch(updated_at) THEN NEW.associated_at ELSE updated_at END
   WHERE organization_id = NEW.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_association_delete
AFTER DELETE ON authority_project_context_associations_v1
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1
   WHERE organization_id = OLD.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_update_audience_insert
AFTER INSERT ON authority_person_update_audience_projects_v1
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1
   WHERE organization_id = NEW.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_update_audience_delete
AFTER DELETE ON authority_person_update_audience_projects_v1
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1
   WHERE organization_id = OLD.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_organization_membership_insert
AFTER INSERT ON authority_memberships
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1,
         updated_at = CASE WHEN unixepoch(NEW.provisioned_at) >= unixepoch(updated_at) THEN NEW.provisioned_at ELSE updated_at END
   WHERE organization_id = NEW.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_organization_membership_update
AFTER UPDATE ON authority_memberships
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1,
         updated_at = CASE WHEN NEW.revoked_at IS NOT NULL AND unixepoch(NEW.revoked_at) >= unixepoch(updated_at) THEN NEW.revoked_at ELSE updated_at END
   WHERE organization_id = NEW.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_organization_membership_delete
AFTER DELETE ON authority_memberships
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1
   WHERE organization_id = OLD.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_principal_display_update
AFTER UPDATE OF display_name ON authority_principals
WHEN NEW.display_name != OLD.display_name
BEGIN
  UPDATE authority_project_authorization_state_v1
     SET revision = revision + 1
   WHERE organization_id = NEW.organization_id;
END;

-- Project documents V1. Original bytes never enter metadata, feed or FTS scans.
CREATE TABLE authority_person_documents_v1 (
  document_id TEXT PRIMARY KEY CHECK(length(document_id) = 68 AND substr(document_id, 1, 4) = 'doc_' AND substr(document_id, 5) NOT GLOB '*[^0-9a-f]*'),
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  membership_type TEXT NOT NULL CHECK(membership_type IN ('owner', 'employee')),
  request_id TEXT NOT NULL,
  request_version INTEGER NOT NULL CHECK(request_version IN (1,2)),
  filename TEXT NOT NULL CHECK(length(CAST(filename AS BLOB)) BETWEEN 1 AND 255),
  title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 200),
  detected_media_type TEXT NOT NULL CHECK(detected_media_type IN ('text/plain','text/markdown','application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  original_size INTEGER NOT NULL CHECK(original_size BETWEEN 1 AND 26214400),
  original_sha256 TEXT NOT NULL CHECK(length(original_sha256) = 71 AND substr(original_sha256, 1, 7) = 'sha256:' AND substr(original_sha256, 8) NOT GLOB '*[^0-9a-f]*'),
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 71 AND substr(payload_sha256, 1, 7) = 'sha256:' AND substr(payload_sha256, 8) NOT GLOB '*[^0-9a-f]*'),
  audience_kind TEXT NOT NULL CHECK(audience_kind IN ('only_me','team','project','projects')),
  audience_project_id TEXT,
  -- Immutable initial association; the current association has its own table.
  submitted_association_project_ids_json TEXT NOT NULL CHECK(json_valid(submitted_association_project_ids_json) AND json_type(submitted_association_project_ids_json) = 'array' AND json_array_length(submitted_association_project_ids_json) BETWEEN 0 AND 20),
  audience_project_ids_json TEXT NOT NULL CHECK(json_valid(audience_project_ids_json) AND json_type(audience_project_ids_json) = 'array' AND json_array_length(audience_project_ids_json) BETWEEN 0 AND 20),
  project_id TEXT,
  received_at TEXT NOT NULL CHECK(unixepoch(received_at) IS NOT NULL),
  UNIQUE(organization_id, membership_id, request_id),
  UNIQUE(document_id, organization_id),
  FOREIGN KEY(membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(membership_id, organization_id, principal_id, membership_type),
  FOREIGN KEY(audience_project_id, organization_id) REFERENCES authority_projects_v1(project_id, organization_id),
  FOREIGN KEY(project_id, organization_id) REFERENCES authority_projects_v1(project_id, organization_id),
  CHECK(
    (request_version = 1 AND audience_kind = 'project' AND audience_project_id IS NOT NULL
      AND ((project_id IS NULL AND json_array_length(submitted_association_project_ids_json) = 0)
        OR (project_id IS NOT NULL AND json_array_length(submitted_association_project_ids_json) = 1
          AND json_extract(submitted_association_project_ids_json, '$[0]') = project_id))
      AND json_array_length(audience_project_ids_json) = 1
      AND json_extract(audience_project_ids_json, '$[0]') = audience_project_id) OR
    (request_version = 1 AND audience_kind IN ('only_me','team') AND audience_project_id IS NULL
      AND json_array_length(audience_project_ids_json) = 0
      AND ((project_id IS NULL AND json_array_length(submitted_association_project_ids_json) = 0)
        OR (project_id IS NOT NULL AND json_array_length(submitted_association_project_ids_json) = 1
          AND json_extract(submitted_association_project_ids_json, '$[0]') = project_id))) OR
    (request_version = 2 AND audience_kind IN ('only_me','team') AND audience_project_id IS NULL AND project_id IS NULL
      AND json_array_length(audience_project_ids_json) = 0) OR
    (request_version = 2 AND audience_kind = 'project' AND audience_project_id IS NOT NULL AND project_id IS NULL
      AND json_array_length(audience_project_ids_json) = 1
      AND json_extract(audience_project_ids_json, '$[0]') = audience_project_id) OR
    (request_version = 2 AND audience_kind = 'projects' AND audience_project_id IS NULL AND project_id IS NULL
      AND json_array_length(audience_project_ids_json) BETWEEN 1 AND 20)
  )
) STRICT;
CREATE INDEX authority_person_documents_feed_v1 ON authority_person_documents_v1(organization_id, received_at DESC, document_id);
CREATE INDEX authority_person_documents_membership_bytes_v1 ON authority_person_documents_v1(organization_id, membership_id, original_size);
CREATE INDEX authority_person_documents_audience_v1 ON authority_person_documents_v1(organization_id, audience_kind, audience_project_id, received_at DESC);
CREATE TABLE authority_person_document_originals_v1 (
  document_id TEXT PRIMARY KEY REFERENCES authority_person_documents_v1(document_id),
  original BLOB NOT NULL CHECK(length(original) BETWEEN 1 AND 26214400)
) STRICT;
CREATE TRIGGER authority_person_document_original_size_v1 BEFORE INSERT ON authority_person_document_originals_v1
WHEN length(NEW.original) != (SELECT original_size FROM authority_person_documents_v1 WHERE document_id = NEW.document_id)
BEGIN SELECT RAISE(ABORT, 'document original size does not match metadata'); END;
CREATE TABLE authority_person_document_associations_v1 (
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  associated_at TEXT NOT NULL CHECK(unixepoch(associated_at) IS NOT NULL),
  PRIMARY KEY(document_id, project_id),
  FOREIGN KEY(document_id, organization_id) REFERENCES authority_person_documents_v1(document_id, organization_id),
  FOREIGN KEY(project_id, organization_id) REFERENCES authority_projects_v1(project_id, organization_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX authority_person_document_associations_project_v1 ON authority_person_document_associations_v1(project_id, organization_id, document_id);
CREATE TABLE authority_person_document_work_v1 (
  document_id TEXT PRIMARY KEY REFERENCES authority_person_documents_v1(document_id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','complete')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  lease_token TEXT,
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR unixepoch(lease_expires_at) IS NOT NULL),
  retry_at TEXT NOT NULL CHECK(unixepoch(retry_at) IS NOT NULL),
  extraction_state TEXT NOT NULL DEFAULT 'extracting' CHECK(extraction_state IN ('extracting','ready','partial','no_text','encrypted','malformed','limit_exceeded','timed_out','unsupported','unavailable')),
  extraction_detail TEXT CHECK(extraction_detail IS NULL OR length(CAST(extraction_detail AS BLOB)) <= 4096),
  extractor TEXT CHECK(extractor IS NULL OR length(CAST(extractor AS BLOB)) BETWEEN 1 AND 512),
  extracted_text_bytes INTEGER NOT NULL DEFAULT 0 CHECK(extracted_text_bytes BETWEEN 0 AND 2097152),
  CHECK((state = 'processing' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR (state != 'processing' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK((state = 'complete' AND extraction_state != 'extracting') OR (state != 'complete' AND extraction_state = 'extracting'))
) STRICT;
CREATE INDEX authority_person_document_work_pending_v1 ON authority_person_document_work_v1(state, retry_at, lease_expires_at);
CREATE TABLE authority_person_document_text_v1 (
  chunk_id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES authority_person_documents_v1(document_id),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 65535),
  anchor_kind TEXT NOT NULL CHECK(anchor_kind IN ('page','paragraph')),
  anchor_start INTEGER NOT NULL CHECK(anchor_start >= 1),
  text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 32768),
  extractor TEXT NOT NULL CHECK(length(CAST(extractor AS BLOB)) BETWEEN 1 AND 512),
  UNIQUE(document_id, ordinal)
) STRICT;
CREATE VIRTUAL TABLE authority_person_document_text_fts_v1 USING fts5(text, content='authority_person_document_text_v1', content_rowid='chunk_id');
CREATE TRIGGER authority_person_document_text_fts_insert_v1 AFTER INSERT ON authority_person_document_text_v1
BEGIN
  INSERT INTO authority_person_document_text_fts_v1(rowid, text) VALUES (NEW.chunk_id, NEW.text);
  UPDATE authority_person_document_work_v1 SET extracted_text_bytes = extracted_text_bytes + length(CAST(NEW.text AS BLOB)) WHERE document_id = NEW.document_id;
END;
CREATE TRIGGER authority_person_document_text_budget_v1 BEFORE INSERT ON authority_person_document_text_v1
WHEN NOT EXISTS (SELECT 1 FROM authority_person_document_work_v1 WHERE document_id = NEW.document_id AND state = 'processing' AND extracted_text_bytes + length(CAST(NEW.text AS BLOB)) <= 2097152)
BEGIN SELECT RAISE(ABORT, 'document extracted text byte budget exceeded'); END;
CREATE TABLE authority_person_document_receipts_v1 (
  organization_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256) = 71 AND substr(payload_sha256, 1, 7) = 'sha256:' AND substr(payload_sha256, 8) NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 71 AND substr(receipt_sha256, 1, 7) = 'sha256:' AND substr(receipt_sha256, 8) NOT GLOB '*[^0-9a-f]*'),
  committed_at TEXT NOT NULL CHECK(unixepoch(committed_at) IS NOT NULL),
  PRIMARY KEY(organization_id, membership_id, request_id),
  FOREIGN KEY(organization_id, membership_id, request_id) REFERENCES authority_person_documents_v1(organization_id, membership_id, request_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE authority_person_document_read_audit_v1 (
  row_sha256 TEXT PRIMARY KEY CHECK(length(row_sha256) = 71 AND substr(row_sha256, 1, 7) = 'sha256:' AND substr(row_sha256, 8) NOT GLOB '*[^0-9a-f]*'),
  body_json TEXT NOT NULL CHECK(json_valid(body_json)),
  recorded_at TEXT NOT NULL CHECK(unixepoch(recorded_at) IS NOT NULL)
) STRICT;
CREATE TRIGGER authority_person_documents_v1_update_denied BEFORE UPDATE ON authority_person_documents_v1
BEGIN SELECT RAISE(ABORT, 'document custody rows are immutable'); END;
CREATE TRIGGER authority_person_documents_v1_delete_denied BEFORE DELETE ON authority_person_documents_v1
BEGIN SELECT RAISE(ABORT, 'document custody rows are immutable'); END;
CREATE TRIGGER authority_person_document_originals_v1_update_denied BEFORE UPDATE ON authority_person_document_originals_v1
BEGIN SELECT RAISE(ABORT, 'document custody rows are immutable'); END;
CREATE TRIGGER authority_person_document_originals_v1_delete_denied BEFORE DELETE ON authority_person_document_originals_v1
BEGIN SELECT RAISE(ABORT, 'document custody rows are immutable'); END;
CREATE TRIGGER authority_person_document_text_v1_update_denied BEFORE UPDATE ON authority_person_document_text_v1
BEGIN SELECT RAISE(ABORT, 'document custody rows are immutable'); END;
CREATE TRIGGER authority_person_document_text_v1_delete_denied BEFORE DELETE ON authority_person_document_text_v1
BEGIN SELECT RAISE(ABORT, 'document custody rows are immutable'); END;
CREATE TRIGGER authority_person_document_receipts_v1_update_denied BEFORE UPDATE ON authority_person_document_receipts_v1
BEGIN SELECT RAISE(ABORT, 'document custody rows are immutable'); END;
CREATE TRIGGER authority_person_document_receipts_v1_delete_denied BEFORE DELETE ON authority_person_document_receipts_v1
BEGIN SELECT RAISE(ABORT, 'document custody rows are immutable'); END;
CREATE TRIGGER authority_person_document_read_audit_v1_update_denied BEFORE UPDATE ON authority_person_document_read_audit_v1
BEGIN SELECT RAISE(ABORT, 'document custody rows are immutable'); END;
CREATE TRIGGER authority_person_document_read_audit_v1_delete_denied BEFORE DELETE ON authority_person_document_read_audit_v1
BEGIN SELECT RAISE(ABORT, 'document custody rows are immutable'); END;
CREATE TRIGGER authority_person_document_associations_update_denied_v1 BEFORE UPDATE ON authority_person_document_associations_v1
BEGIN SELECT RAISE(ABORT, 'document association update is denied'); END;
CREATE TABLE authority_person_document_audience_projects_v1 (
  document_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  PRIMARY KEY(document_id, project_id),
  FOREIGN KEY(document_id, organization_id) REFERENCES authority_person_documents_v1(document_id, organization_id),
  FOREIGN KEY(project_id, organization_id) REFERENCES authority_projects_v1(project_id, organization_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX authority_person_document_audience_projects_v1_project
  ON authority_person_document_audience_projects_v1(project_id, organization_id, document_id);
CREATE TRIGGER authority_person_document_audience_projects_v1_insert_fence
BEFORE INSERT ON authority_person_document_audience_projects_v1
WHEN NOT EXISTS (
  SELECT 1 FROM authority_person_documents_v1 d, json_each(d.audience_project_ids_json) ids
  WHERE d.document_id=NEW.document_id AND d.organization_id=NEW.organization_id
    AND d.audience_kind IN ('project','projects') AND ids.value=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'Document audience project must bind immutable custody'); END;
CREATE TRIGGER authority_person_document_audience_projects_v1_update_denied
BEFORE UPDATE ON authority_person_document_audience_projects_v1
BEGIN SELECT RAISE(ABORT, 'document audience projects are immutable'); END;
CREATE TRIGGER authority_person_document_audience_projects_v1_delete_denied
BEFORE DELETE ON authority_person_document_audience_projects_v1
BEGIN SELECT RAISE(ABORT, 'document audience projects are immutable'); END;
CREATE TRIGGER authority_person_document_work_bytes_monotonic_v1 BEFORE UPDATE ON authority_person_document_work_v1
WHEN NEW.extracted_text_bytes < OLD.extracted_text_bytes
BEGIN SELECT RAISE(ABORT, 'document extracted byte count cannot decrease'); END;
CREATE TRIGGER authority_person_document_work_identity_v1 BEFORE UPDATE ON authority_person_document_work_v1
WHEN NEW.document_id != OLD.document_id
BEGIN SELECT RAISE(ABORT, 'document work identity is immutable'); END;
CREATE TRIGGER authority_person_document_work_complete_v1 BEFORE UPDATE ON authority_person_document_work_v1
WHEN OLD.state = 'complete'
BEGIN SELECT RAISE(ABORT, 'completed document extraction is immutable'); END;
CREATE TRIGGER authority_person_document_work_delete_denied_v1 BEFORE DELETE ON authority_person_document_work_v1
BEGIN SELECT RAISE(ABORT, 'document work deletion is denied'); END;
-- Shared source admission. Provider content is separate from stable identity.
CREATE TABLE authority_sources_v1 (
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  source_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  custody_ref TEXT NOT NULL,
  access_policy_ref TEXT NOT NULL,
  analysis_policy TEXT NOT NULL CHECK(analysis_policy IN ('on_request','automatic')),
  PRIMARY KEY(organization_id, source_id),
  UNIQUE(organization_id, adapter_id, instance_id, external_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE authority_source_revisions_v1 (
  organization_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  captured_at TEXT NOT NULL CHECK(unixepoch(captured_at) IS NOT NULL),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  revision_sha256 TEXT NOT NULL CHECK(length(revision_sha256)=64 AND revision_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  PRIMARY KEY(organization_id,source_id,revision_id),
  FOREIGN KEY(organization_id,source_id) REFERENCES authority_sources_v1(organization_id,source_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE authority_source_contents_v1 (
  organization_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  content_json TEXT NOT NULL CHECK(json_valid(content_json) AND length(CAST(content_json AS BLOB))<=33554432),
  PRIMARY KEY(organization_id,source_id,revision_id),
  FOREIGN KEY(organization_id,source_id,revision_id) REFERENCES authority_source_revisions_v1(organization_id,source_id,revision_id)
) STRICT, WITHOUT ROWID;
CREATE TABLE authority_source_representations_v1 (
  organization_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  representation_id TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
  content_json TEXT NOT NULL CHECK(json_valid(content_json) AND length(CAST(content_json AS BLOB))<=33554432),
  PRIMARY KEY(organization_id,source_id,revision_id,representation_id),
  FOREIGN KEY(organization_id,source_id,revision_id) REFERENCES authority_source_revisions_v1(organization_id,source_id,revision_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER authority_sources_v1_update_denied BEFORE UPDATE ON authority_sources_v1
BEGIN SELECT RAISE(ABORT, 'source identity and custody are immutable'); END;
CREATE TRIGGER authority_sources_v1_delete_denied BEFORE DELETE ON authority_sources_v1
BEGIN SELECT RAISE(ABORT, 'source identity and custody are immutable'); END;
CREATE TRIGGER authority_source_revisions_v1_update_denied BEFORE UPDATE ON authority_source_revisions_v1
BEGIN SELECT RAISE(ABORT, 'source revisions are immutable'); END;
CREATE TRIGGER authority_source_revisions_v1_delete_denied BEFORE DELETE ON authority_source_revisions_v1
BEGIN SELECT RAISE(ABORT, 'source revisions are immutable'); END;
CREATE TRIGGER authority_source_contents_v1_update_denied BEFORE UPDATE ON authority_source_contents_v1
BEGIN SELECT RAISE(ABORT, 'source evidence is immutable'); END;
CREATE TRIGGER authority_source_contents_v1_delete_denied BEFORE DELETE ON authority_source_contents_v1
BEGIN SELECT RAISE(ABORT, 'source evidence is immutable'); END;
CREATE TRIGGER authority_source_representations_v1_update_denied BEFORE UPDATE ON authority_source_representations_v1
BEGIN SELECT RAISE(ABORT, 'source representations are immutable'); END;
CREATE TRIGGER authority_source_representations_v1_delete_denied BEFORE DELETE ON authority_source_representations_v1
BEGIN SELECT RAISE(ABORT, 'source representations are immutable'); END;

CREATE TABLE authority_person_document_association_receipts_v1 (
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  membership_type TEXT NOT NULL CHECK(membership_type IN ('owner','employee')),
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('associate','dissociate')),
  command_sha256 TEXT NOT NULL CHECK(length(command_sha256) = 71 AND substr(command_sha256, 1, 7) = 'sha256:' AND substr(command_sha256, 8) NOT GLOB '*[^0-9a-f]*'),
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  receipt_sha256 TEXT NOT NULL CHECK(length(receipt_sha256) = 71 AND substr(receipt_sha256, 1, 7) = 'sha256:' AND substr(receipt_sha256, 8) NOT GLOB '*[^0-9a-f]*'),
  committed_at TEXT NOT NULL CHECK(unixepoch(committed_at) IS NOT NULL),
  PRIMARY KEY(organization_id, membership_id, request_id),
  FOREIGN KEY(membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(membership_id, organization_id, principal_id, membership_type)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER authority_person_document_association_receipts_v1_update_denied BEFORE UPDATE ON authority_person_document_association_receipts_v1
BEGIN SELECT RAISE(ABORT, 'document association receipts are immutable'); END;
CREATE TRIGGER authority_person_document_association_receipts_v1_delete_denied BEFORE DELETE ON authority_person_document_association_receipts_v1
BEGIN SELECT RAISE(ABORT, 'document association receipts are immutable'); END;
CREATE TRIGGER authority_project_auth_revision_document_association_insert
AFTER INSERT ON authority_person_document_associations_v1
BEGIN
  UPDATE authority_project_authorization_state_v1 SET revision = revision + 1,
    updated_at = CASE WHEN updated_at < NEW.associated_at THEN NEW.associated_at ELSE updated_at END
   WHERE organization_id = NEW.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_document_association_delete
AFTER DELETE ON authority_person_document_associations_v1
BEGIN
  UPDATE authority_project_authorization_state_v1 SET revision = revision + 1
   WHERE organization_id = OLD.organization_id;
END;

CREATE TRIGGER authority_project_auth_revision_document_audience_insert
AFTER INSERT ON authority_person_document_audience_projects_v1
BEGIN
  UPDATE authority_project_authorization_state_v1 SET revision = revision + 1
   WHERE organization_id = NEW.organization_id;
END;
CREATE TRIGGER authority_project_auth_revision_document_audience_delete
AFTER DELETE ON authority_person_document_audience_projects_v1
BEGIN
  UPDATE authority_project_authorization_state_v1 SET revision = revision + 1
   WHERE organization_id = OLD.organization_id;
END;

PRAGMA user_version = 9;

-- A malformed legacy retained note must not pin the source-admission worker.
-- The disposition carries no title, body, request ID or exception text.
CREATE TABLE authority_person_text_source_failures_v1 (
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  api_version INTEGER NOT NULL CHECK(api_version IN (1,2,3)),
  context_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition = 'invalid_retained_text'),
  recorded_at TEXT NOT NULL CHECK(unixepoch(recorded_at) IS NOT NULL),
  PRIMARY KEY(organization_id, api_version, context_id)
) STRICT, WITHOUT ROWID;
CREATE TRIGGER authority_person_text_source_failures_v1_source_fence
BEFORE INSERT ON authority_person_text_source_failures_v1
WHEN NOT (
  (NEW.api_version = 1 AND EXISTS (
    SELECT 1 FROM authority_person_updates_v1 u
    WHERE u.organization_id = NEW.organization_id AND u.context_id = NEW.context_id
  )) OR
  (NEW.api_version = 2 AND EXISTS (
    SELECT 1 FROM authority_person_updates_v2 u
    WHERE u.organization_id = NEW.organization_id AND u.context_id = NEW.context_id AND u.request_version=2
  )) OR
  (NEW.api_version = 3 AND EXISTS (
    SELECT 1 FROM authority_person_updates_v2 u
    WHERE u.organization_id = NEW.organization_id AND u.context_id = NEW.context_id AND u.request_version=3
  ))
)
BEGIN SELECT RAISE(ABORT, 'person text source failure must bind to retained text'); END;
CREATE TRIGGER authority_person_text_source_failures_v1_immutable
BEFORE UPDATE ON authority_person_text_source_failures_v1
BEGIN SELECT RAISE(ABORT, 'person text source failure disposition is immutable'); END;
CREATE TRIGGER authority_person_text_source_failures_v1_delete_denied
BEFORE DELETE ON authority_person_text_source_failures_v1
BEGIN SELECT RAISE(ABORT, 'person text source failure disposition deletion is denied'); END;
