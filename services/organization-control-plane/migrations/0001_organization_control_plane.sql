-- Minimum organization control plane v1.
--
-- This customer-owned database supports one observable flow:
-- prove a provider account, link it to an Authority membership, bind a
-- customer-held connection to one product adapter, grant a direct action, and
-- audit the result.
--
-- Authority remains the sole source of principal and membership truth. This
-- database stores no membership mirror, provider token, or product content.

CREATE TABLE organization_control_plane_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  control_plane_id TEXT NOT NULL UNIQUE
    CHECK (control_plane_id GLOB 'ocp_*'),
  organization_id TEXT NOT NULL UNIQUE
    CHECK (organization_id GLOB 'org_*'),
  authority_id TEXT NOT NULL UNIQUE
    CHECK (authority_id GLOB 'oau_*'),
  authority_descriptor_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(authority_descriptor_sha256) = 71 AND
      substr(authority_descriptor_sha256, 1, 7) = 'sha256:' AND
      substr(authority_descriptor_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_control_plane_metadata_immutable_update
BEFORE UPDATE ON organization_control_plane_metadata
BEGIN
  SELECT RAISE(ABORT, 'organization control-plane metadata is immutable');
END;

CREATE TRIGGER organization_control_plane_metadata_immutable_delete
BEFORE DELETE ON organization_control_plane_metadata
BEGIN
  SELECT RAISE(ABORT, 'organization control-plane metadata cannot be deleted');
END;

-- A connect ceremony is short-lived, single-use, and bound to the exact
-- Authority member, provider tenant, redirect, scopes, and authenticated admin
-- session that initiated it. Raw OAuth codes and PKCE verifiers are never
-- stored here.
CREATE TABLE organization_connection_attempts (
  connection_attempt_id TEXT PRIMARY KEY
    CHECK (connection_attempt_id GLOB 'cat_*'),
  organization_id TEXT NOT NULL
    REFERENCES organization_control_plane_metadata(organization_id),
  requested_by_principal_id TEXT NOT NULL
    CHECK (requested_by_principal_id GLOB 'prn_*'),
  requested_by_membership_id TEXT NOT NULL
    CHECK (requested_by_membership_id GLOB 'mem_*'),
  attempt_purpose TEXT NOT NULL
    CHECK (attempt_purpose IN ('identity_link', 'tool_connection')),
  target_owner_kind TEXT NOT NULL
    CHECK (target_owner_kind IN ('membership', 'organization')),
  target_principal_id TEXT
    CHECK (target_principal_id IS NULL OR target_principal_id GLOB 'prn_*'),
  target_membership_id TEXT
    CHECK (target_membership_id IS NULL OR target_membership_id GLOB 'mem_*'),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  provider_issuer TEXT NOT NULL CHECK (length(trim(provider_issuer)) > 0),
  provider_tenant_kind TEXT NOT NULL
    CHECK (
      provider_tenant_kind IN ('organization', 'workspace', 'personal')
    ),
  provider_tenant_id TEXT NOT NULL
    CHECK (length(trim(provider_tenant_id)) > 0),
  redirect_uri TEXT NOT NULL CHECK (length(trim(redirect_uri)) > 0),
  requested_scopes_json TEXT NOT NULL
    CHECK (
      json_valid(requested_scopes_json) AND
      json_type(requested_scopes_json) = 'array'
    ),
  requested_scopes_sha256 TEXT NOT NULL,
  state_sha256 TEXT NOT NULL UNIQUE,
  nonce_sha256 TEXT NOT NULL UNIQUE,
  pkce_challenge_sha256 TEXT NOT NULL UNIQUE,
  admin_session_sha256 TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'succeeded', 'failed', 'expired')),
  provider_subject_kind TEXT
    CHECK (
      provider_subject_kind IS NULL OR
      provider_subject_kind IN ('human_user', 'service_account')
    ),
  provider_subject_id TEXT,
  granted_scopes_json TEXT
    CHECK (
      granted_scopes_json IS NULL OR (
        json_valid(granted_scopes_json) AND
        json_type(granted_scopes_json) = 'array'
      )
    ),
  granted_scopes_sha256 TEXT,
  verification_evidence_sha256 TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  outcome_reason TEXT,
  CHECK (
    (
      target_owner_kind = 'membership' AND
      target_principal_id IS NOT NULL AND
      target_membership_id IS NOT NULL
    ) OR (
      target_owner_kind = 'organization' AND
      target_principal_id IS NULL AND
      target_membership_id IS NULL
    )
  ),
  CHECK (
    unixepoch(created_at) IS NOT NULL AND
    unixepoch(expires_at) IS NOT NULL AND
    unixepoch(created_at) < unixepoch(expires_at) AND
    unixepoch(expires_at) - unixepoch(created_at) <= 900 AND
    (
      consumed_at IS NULL OR
      unixepoch(consumed_at) IS NOT NULL
    )
  ),
  CHECK (
    (
      status = 'pending' AND
      provider_subject_kind IS NULL AND
      provider_subject_id IS NULL AND
      granted_scopes_json IS NULL AND
      granted_scopes_sha256 IS NULL AND
      verification_evidence_sha256 IS NULL AND
      consumed_at IS NULL AND
      outcome_reason IS NULL
    ) OR (
      status = 'succeeded' AND
      provider_subject_kind IS NOT NULL AND
      provider_subject_id IS NOT NULL AND
      granted_scopes_json IS NOT NULL AND
      granted_scopes_sha256 IS NOT NULL AND
      granted_scopes_json = requested_scopes_json AND
      granted_scopes_sha256 = requested_scopes_sha256 AND
      verification_evidence_sha256 IS NOT NULL AND
      consumed_at IS NOT NULL AND
      unixepoch(consumed_at) <= unixepoch(expires_at) AND
      outcome_reason IS NULL AND
      (
        (
          attempt_purpose = 'identity_link' AND
          target_owner_kind = 'membership' AND
          provider_subject_kind = 'human_user'
        ) OR (
          attempt_purpose = 'tool_connection' AND
          (
            (
              target_owner_kind = 'membership' AND
              provider_subject_kind = 'human_user'
            ) OR (
              target_owner_kind = 'organization' AND
              provider_subject_kind = 'service_account'
            )
          )
        )
      )
    ) OR (
      status IN ('failed', 'expired') AND
      provider_subject_kind IS NULL AND
      provider_subject_id IS NULL AND
      granted_scopes_json IS NULL AND
      granted_scopes_sha256 IS NULL AND
      verification_evidence_sha256 IS NULL AND
      consumed_at IS NOT NULL AND
      outcome_reason IS NOT NULL
    )
  )
) STRICT;

CREATE TRIGGER organization_connection_attempts_start_pending
BEFORE INSERT ON organization_connection_attempts
WHEN NEW.status != 'pending'
BEGIN
  SELECT RAISE(ABORT, 'connection attempts must start pending');
END;

CREATE TRIGGER organization_connection_attempts_terminal_only
BEFORE UPDATE ON organization_connection_attempts
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'pending' AND
    NEW.status IN ('succeeded', 'failed', 'expired') AND
    NEW.connection_attempt_id = OLD.connection_attempt_id AND
    NEW.organization_id = OLD.organization_id AND
    NEW.requested_by_principal_id = OLD.requested_by_principal_id AND
    NEW.requested_by_membership_id = OLD.requested_by_membership_id AND
    NEW.attempt_purpose = OLD.attempt_purpose AND
    NEW.target_owner_kind = OLD.target_owner_kind AND
    NEW.target_principal_id IS OLD.target_principal_id AND
    NEW.target_membership_id IS OLD.target_membership_id AND
    NEW.provider = OLD.provider AND
    NEW.provider_issuer = OLD.provider_issuer AND
    NEW.provider_tenant_kind = OLD.provider_tenant_kind AND
    NEW.provider_tenant_id = OLD.provider_tenant_id AND
    NEW.redirect_uri = OLD.redirect_uri AND
    NEW.requested_scopes_json = OLD.requested_scopes_json AND
    NEW.requested_scopes_sha256 = OLD.requested_scopes_sha256 AND
    NEW.state_sha256 = OLD.state_sha256 AND
    NEW.nonce_sha256 = OLD.nonce_sha256 AND
    NEW.pkce_challenge_sha256 = OLD.pkce_challenge_sha256 AND
    NEW.admin_session_sha256 = OLD.admin_session_sha256 AND
    NEW.created_at = OLD.created_at AND
    NEW.expires_at = OLD.expires_at
  ) THEN RAISE(ABORT, 'connection attempt transition is invalid') END;
END;

CREATE TRIGGER organization_connection_attempts_immutable_delete
BEFORE DELETE ON organization_connection_attempts
BEGIN
  SELECT RAISE(ABORT, 'connection attempts cannot be deleted');
END;

-- A provider human is linked to one exact Authority principal and membership.
-- Rehire creates a new membership and therefore requires a new verified link.
CREATE TABLE organization_external_identity_links (
  identity_link_id TEXT PRIMARY KEY CHECK (identity_link_id GLOB 'clm_*'),
  organization_id TEXT NOT NULL
    REFERENCES organization_control_plane_metadata(organization_id),
  principal_id TEXT NOT NULL CHECK (principal_id GLOB 'prn_*'),
  membership_id TEXT NOT NULL CHECK (membership_id GLOB 'mem_*'),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  provider_issuer TEXT NOT NULL CHECK (length(trim(provider_issuer)) > 0),
  provider_tenant_kind TEXT NOT NULL
    CHECK (
      provider_tenant_kind IN ('organization', 'workspace', 'personal')
    ),
  provider_tenant_id TEXT NOT NULL
    CHECK (length(trim(provider_tenant_id)) > 0),
  provider_subject_id TEXT NOT NULL
    CHECK (length(trim(provider_subject_id)) > 0),
  verification_attempt_id TEXT NOT NULL UNIQUE
    REFERENCES organization_connection_attempts(connection_attempt_id),
  verification_evidence_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  verified_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL) OR
    (
      status = 'revoked' AND
      revoked_at IS NOT NULL AND
      revocation_reason IS NOT NULL
    )
  ),
  CHECK (
    unixepoch(verified_at) IS NOT NULL AND
    (revoked_at IS NULL OR unixepoch(revoked_at) >= unixepoch(verified_at))
  )
) STRICT;

CREATE UNIQUE INDEX organization_external_identity_links_one_active_subject
ON organization_external_identity_links(
  organization_id,
  provider,
  provider_issuer,
  provider_tenant_kind,
  provider_tenant_id,
  provider_subject_id
)
WHERE status = 'active';

CREATE UNIQUE INDEX organization_external_identity_links_one_active_member
ON organization_external_identity_links(
  organization_id,
  membership_id,
  provider,
  provider_issuer,
  provider_tenant_kind,
  provider_tenant_id
)
WHERE status = 'active';

CREATE TRIGGER organization_external_identity_links_verified_insert
BEFORE INSERT ON organization_external_identity_links
BEGIN
  SELECT CASE WHEN NEW.status != 'active' OR NOT EXISTS (
    SELECT 1
    FROM organization_connection_attempts AS attempt
    WHERE attempt.connection_attempt_id = NEW.verification_attempt_id
      AND attempt.organization_id = NEW.organization_id
      AND attempt.attempt_purpose IN ('identity_link', 'tool_connection')
      AND attempt.target_owner_kind = 'membership'
      AND attempt.target_principal_id = NEW.principal_id
      AND attempt.target_membership_id = NEW.membership_id
      AND attempt.provider = NEW.provider
      AND attempt.provider_issuer = NEW.provider_issuer
      AND attempt.provider_tenant_kind = NEW.provider_tenant_kind
      AND attempt.provider_tenant_id = NEW.provider_tenant_id
      AND attempt.provider_subject_kind = 'human_user'
      AND attempt.provider_subject_id = NEW.provider_subject_id
      AND attempt.verification_evidence_sha256 =
        NEW.verification_evidence_sha256
      AND attempt.status = 'succeeded'
      AND attempt.consumed_at = NEW.verified_at
  ) THEN RAISE(
    ABORT,
    'external identity link does not match a completed connect attempt'
  ) END;
END;

CREATE TRIGGER organization_external_identity_links_revoke_only
BEFORE UPDATE ON organization_external_identity_links
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'active' AND
    NEW.status = 'revoked' AND
    NEW.revoked_at IS NOT NULL AND
    NEW.revocation_reason IS NOT NULL AND
    NEW.identity_link_id = OLD.identity_link_id AND
    NEW.organization_id = OLD.organization_id AND
    NEW.principal_id = OLD.principal_id AND
    NEW.membership_id = OLD.membership_id AND
    NEW.provider = OLD.provider AND
    NEW.provider_issuer = OLD.provider_issuer AND
    NEW.provider_tenant_kind = OLD.provider_tenant_kind AND
    NEW.provider_tenant_id = OLD.provider_tenant_id AND
    NEW.provider_subject_id = OLD.provider_subject_id AND
    NEW.verification_attempt_id = OLD.verification_attempt_id AND
    NEW.verification_evidence_sha256 = OLD.verification_evidence_sha256 AND
    NEW.verified_at = OLD.verified_at
  ) THEN RAISE(ABORT, 'external identity links may only be revoked') END;
END;

CREATE TRIGGER organization_external_identity_links_immutable_delete
BEFORE DELETE ON organization_external_identity_links
BEGIN
  SELECT RAISE(ABORT, 'external identity links cannot be deleted');
END;

-- A connection contains an immutable provider security identity and an opaque
-- customer secret-store handle. Changing account, tenant, scopes, ownership,
-- or handle creates a new connection ID; it never rewrites this row.
CREATE TABLE organization_tool_connections (
  connection_id TEXT PRIMARY KEY CHECK (connection_id GLOB 'con_*'),
  organization_id TEXT NOT NULL
    REFERENCES organization_control_plane_metadata(organization_id),
  connection_kind TEXT NOT NULL
    CHECK (connection_kind IN ('human_account', 'service_account')),
  owner_kind TEXT NOT NULL
    CHECK (owner_kind IN ('membership', 'organization')),
  owner_principal_id TEXT
    CHECK (owner_principal_id IS NULL OR owner_principal_id GLOB 'prn_*'),
  owner_membership_id TEXT
    CHECK (owner_membership_id IS NULL OR owner_membership_id GLOB 'mem_*'),
  human_identity_link_id TEXT
    REFERENCES organization_external_identity_links(identity_link_id),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  provider_issuer TEXT NOT NULL CHECK (length(trim(provider_issuer)) > 0),
  provider_tenant_kind TEXT NOT NULL
    CHECK (
      provider_tenant_kind IN ('organization', 'workspace', 'personal')
    ),
  provider_tenant_id TEXT NOT NULL
    CHECK (length(trim(provider_tenant_id)) > 0),
  provider_subject_kind TEXT NOT NULL
    CHECK (provider_subject_kind IN ('human_user', 'service_account')),
  provider_subject_id TEXT NOT NULL
    CHECK (length(trim(provider_subject_id)) > 0),
  granted_scopes_json TEXT NOT NULL
    CHECK (
      json_valid(granted_scopes_json) AND
      json_type(granted_scopes_json) = 'array'
    ),
  granted_scopes_sha256 TEXT NOT NULL,
  verification_attempt_id TEXT NOT NULL UNIQUE
    REFERENCES organization_connection_attempts(connection_attempt_id),
  verification_evidence_sha256 TEXT NOT NULL,
  secret_backend_id TEXT NOT NULL
    CHECK (length(trim(secret_backend_id)) > 0),
  secret_handle_id TEXT NOT NULL CHECK (secret_handle_id GLOB 'sch_*'),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_by_principal_id TEXT NOT NULL
    CHECK (created_by_principal_id GLOB 'prn_*'),
  created_by_membership_id TEXT NOT NULL
    CHECK (created_by_membership_id GLOB 'mem_*'),
  activated_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  CHECK (
    (
      connection_kind = 'human_account' AND
      owner_kind = 'membership' AND
      owner_principal_id IS NOT NULL AND
      owner_membership_id IS NOT NULL AND
      human_identity_link_id IS NOT NULL AND
      provider_subject_kind = 'human_user'
    ) OR (
      connection_kind = 'service_account' AND
      owner_kind = 'organization' AND
      owner_principal_id IS NULL AND
      owner_membership_id IS NULL AND
      human_identity_link_id IS NULL AND
      provider_subject_kind = 'service_account'
    )
  ),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL) OR
    (
      status = 'revoked' AND
      revoked_at IS NOT NULL AND
      revocation_reason IS NOT NULL
    )
  ),
  CHECK (
    unixepoch(activated_at) IS NOT NULL AND
    (revoked_at IS NULL OR unixepoch(revoked_at) >= unixepoch(activated_at))
  ),
  UNIQUE (secret_backend_id, secret_handle_id)
) STRICT;

CREATE UNIQUE INDEX organization_tool_connections_one_active_subject
ON organization_tool_connections(
  organization_id,
  provider,
  provider_issuer,
  provider_tenant_kind,
  provider_tenant_id,
  provider_subject_kind,
  provider_subject_id
)
WHERE status = 'active';

CREATE TRIGGER organization_tool_connections_verified_insert
BEFORE INSERT ON organization_tool_connections
BEGIN
  SELECT CASE WHEN NEW.status != 'active' OR NOT EXISTS (
    SELECT 1
    FROM organization_connection_attempts AS attempt
    WHERE attempt.connection_attempt_id = NEW.verification_attempt_id
      AND attempt.organization_id = NEW.organization_id
      AND attempt.attempt_purpose = 'tool_connection'
      AND attempt.target_owner_kind = NEW.owner_kind
      AND attempt.target_principal_id IS NEW.owner_principal_id
      AND attempt.target_membership_id IS NEW.owner_membership_id
      AND attempt.provider = NEW.provider
      AND attempt.provider_issuer = NEW.provider_issuer
      AND attempt.provider_tenant_kind = NEW.provider_tenant_kind
      AND attempt.provider_tenant_id = NEW.provider_tenant_id
      AND attempt.provider_subject_kind = NEW.provider_subject_kind
      AND attempt.provider_subject_id = NEW.provider_subject_id
      AND attempt.granted_scopes_sha256 = NEW.granted_scopes_sha256
      AND attempt.verification_evidence_sha256 =
        NEW.verification_evidence_sha256
      AND attempt.requested_by_principal_id = NEW.created_by_principal_id
      AND attempt.requested_by_membership_id = NEW.created_by_membership_id
      AND attempt.status = 'succeeded'
      AND attempt.consumed_at = NEW.activated_at
  ) THEN RAISE(
    ABORT,
    'tool connection does not match a completed connect attempt'
  ) END;
  SELECT CASE WHEN NEW.connection_kind = 'human_account' AND NOT EXISTS (
    SELECT 1
    FROM organization_external_identity_links AS identity
    WHERE identity.identity_link_id = NEW.human_identity_link_id
      AND identity.organization_id = NEW.organization_id
      AND identity.principal_id = NEW.owner_principal_id
      AND identity.membership_id = NEW.owner_membership_id
      AND identity.provider = NEW.provider
      AND identity.provider_issuer = NEW.provider_issuer
      AND identity.provider_tenant_kind = NEW.provider_tenant_kind
      AND identity.provider_tenant_id = NEW.provider_tenant_id
      AND identity.provider_subject_id = NEW.provider_subject_id
      AND identity.status = 'active'
  ) THEN RAISE(
    ABORT,
    'human tool connection requires its active verified identity link'
  ) END;
END;

CREATE TRIGGER organization_tool_connections_revoke_only
BEFORE UPDATE ON organization_tool_connections
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'active' AND
    NEW.status = 'revoked' AND
    NEW.revoked_at IS NOT NULL AND
    NEW.revocation_reason IS NOT NULL AND
    NEW.connection_id = OLD.connection_id AND
    NEW.organization_id = OLD.organization_id AND
    NEW.connection_kind = OLD.connection_kind AND
    NEW.owner_kind = OLD.owner_kind AND
    NEW.owner_principal_id IS OLD.owner_principal_id AND
    NEW.owner_membership_id IS OLD.owner_membership_id AND
    NEW.human_identity_link_id IS OLD.human_identity_link_id AND
    NEW.provider = OLD.provider AND
    NEW.provider_issuer = OLD.provider_issuer AND
    NEW.provider_tenant_kind = OLD.provider_tenant_kind AND
    NEW.provider_tenant_id = OLD.provider_tenant_id AND
    NEW.provider_subject_kind = OLD.provider_subject_kind AND
    NEW.provider_subject_id = OLD.provider_subject_id AND
    NEW.granted_scopes_json = OLD.granted_scopes_json AND
    NEW.granted_scopes_sha256 = OLD.granted_scopes_sha256 AND
    NEW.verification_attempt_id = OLD.verification_attempt_id AND
    NEW.verification_evidence_sha256 = OLD.verification_evidence_sha256 AND
    NEW.secret_backend_id = OLD.secret_backend_id AND
    NEW.secret_handle_id = OLD.secret_handle_id AND
    NEW.created_by_principal_id = OLD.created_by_principal_id AND
    NEW.created_by_membership_id = OLD.created_by_membership_id AND
    NEW.activated_at = OLD.activated_at
  ) THEN RAISE(ABORT, 'tool connections may only be revoked') END;
END;

CREATE TRIGGER organization_tool_connections_immutable_delete
BEFORE DELETE ON organization_tool_connections
BEGIN
  SELECT RAISE(ABORT, 'tool connections cannot be deleted');
END;

-- A binding says which exact enrolled installation and adapter may use a
-- connection. It is not a general credential-sharing permission.
CREATE TABLE organization_adapter_bindings (
  adapter_binding_id TEXT PRIMARY KEY CHECK (adapter_binding_id GLOB 'bnd_*'),
  organization_id TEXT NOT NULL
    REFERENCES organization_control_plane_metadata(organization_id),
  product_namespace TEXT NOT NULL
    CHECK (length(trim(product_namespace)) > 0),
  installation_id TEXT NOT NULL CHECK (installation_id GLOB 'ins_*'),
  installation_key_id TEXT NOT NULL
    CHECK (
      length(installation_key_id) = 71 AND
      substr(installation_key_id, 1, 7) = 'sha256:'
    ),
  adapter_kind TEXT NOT NULL CHECK (
    adapter_kind IN (
      'meeting-source',
      'decision-processor',
      'approval-surface',
      'delivery-surface'
    )
  ),
  adapter_id TEXT NOT NULL CHECK (length(trim(adapter_id)) > 0),
  adapter_instance_id TEXT NOT NULL
    CHECK (length(trim(adapter_instance_id)) > 0),
  adapter_version TEXT NOT NULL CHECK (length(trim(adapter_version)) > 0),
  connection_id TEXT NOT NULL
    REFERENCES organization_tool_connections(connection_id),
  public_configuration_json TEXT NOT NULL
    CHECK (
      json_valid(public_configuration_json) AND
      json_type(public_configuration_json) = 'object'
    ),
  public_configuration_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_by_principal_id TEXT NOT NULL
    CHECK (created_by_principal_id GLOB 'prn_*'),
  created_by_membership_id TEXT NOT NULL
    CHECK (created_by_membership_id GLOB 'mem_*'),
  bound_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL) OR
    (
      status = 'revoked' AND
      revoked_at IS NOT NULL AND
      revocation_reason IS NOT NULL
    )
  ),
  CHECK (
    unixepoch(bound_at) IS NOT NULL AND
    (revoked_at IS NULL OR unixepoch(revoked_at) >= unixepoch(bound_at))
  )
) STRICT;

CREATE UNIQUE INDEX organization_adapter_bindings_one_active_target
ON organization_adapter_bindings(
  organization_id,
  product_namespace,
  installation_id,
  installation_key_id,
  adapter_kind,
  adapter_id,
  adapter_instance_id
)
WHERE status = 'active';

CREATE TRIGGER organization_adapter_bindings_active_connection_insert
BEFORE INSERT ON organization_adapter_bindings
BEGIN
  SELECT CASE WHEN NEW.status != 'active' OR NOT EXISTS (
    SELECT 1
    FROM organization_tool_connections AS connection
    WHERE connection.connection_id = NEW.connection_id
      AND connection.organization_id = NEW.organization_id
      AND connection.status = 'active'
  ) THEN RAISE(
    ABORT,
    'adapter binding requires an active organization connection'
  ) END;
END;

CREATE TRIGGER organization_adapter_bindings_revoke_only
BEFORE UPDATE ON organization_adapter_bindings
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'active' AND
    NEW.status = 'revoked' AND
    NEW.revoked_at IS NOT NULL AND
    NEW.revocation_reason IS NOT NULL AND
    NEW.adapter_binding_id = OLD.adapter_binding_id AND
    NEW.organization_id = OLD.organization_id AND
    NEW.product_namespace = OLD.product_namespace AND
    NEW.installation_id = OLD.installation_id AND
    NEW.installation_key_id = OLD.installation_key_id AND
    NEW.adapter_kind = OLD.adapter_kind AND
    NEW.adapter_id = OLD.adapter_id AND
    NEW.adapter_instance_id = OLD.adapter_instance_id AND
    NEW.adapter_version = OLD.adapter_version AND
    NEW.connection_id = OLD.connection_id AND
    NEW.public_configuration_json = OLD.public_configuration_json AND
    NEW.public_configuration_sha256 = OLD.public_configuration_sha256 AND
    NEW.created_by_principal_id = OLD.created_by_principal_id AND
    NEW.created_by_membership_id = OLD.created_by_membership_id AND
    NEW.bound_at = OLD.bound_at
  ) THEN RAISE(ABORT, 'adapter bindings may only be revoked') END;
END;

CREATE TRIGGER organization_adapter_bindings_immutable_delete
BEFORE DELETE ON organization_adapter_bindings
BEGIN
  SELECT RAISE(ABORT, 'adapter bindings cannot be deleted');
END;

-- V1 permissions are intentionally direct grants. Groups, quorum, inherited
-- policy, and frozen candidate snapshots are deferred until a live milestone
-- requires them.
CREATE TABLE organization_permission_grants (
  permission_grant_id TEXT PRIMARY KEY
    CHECK (permission_grant_id GLOB 'pgr_*'),
  organization_id TEXT NOT NULL
    REFERENCES organization_control_plane_metadata(organization_id),
  adapter_binding_id TEXT NOT NULL
    REFERENCES organization_adapter_bindings(adapter_binding_id),
  principal_id TEXT NOT NULL CHECK (principal_id GLOB 'prn_*'),
  membership_id TEXT NOT NULL CHECK (membership_id GLOB 'mem_*'),
  action TEXT NOT NULL
    CHECK (action IN ('view', 'approve', 'reject')),
  resource_scope_json TEXT NOT NULL
    CHECK (
      json_valid(resource_scope_json) AND
      json_type(resource_scope_json) = 'object'
    ),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_by_principal_id TEXT NOT NULL
    CHECK (granted_by_principal_id GLOB 'prn_*'),
  granted_by_membership_id TEXT NOT NULL
    CHECK (granted_by_membership_id GLOB 'mem_*'),
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL) OR
    (
      status = 'revoked' AND
      revoked_at IS NOT NULL AND
      revocation_reason IS NOT NULL
    )
  ),
  CHECK (
    unixepoch(granted_at) IS NOT NULL AND
    (revoked_at IS NULL OR unixepoch(revoked_at) >= unixepoch(granted_at))
  )
) STRICT;

CREATE UNIQUE INDEX organization_permission_grants_one_active_action
ON organization_permission_grants(
  organization_id,
  adapter_binding_id,
  membership_id,
  action
)
WHERE status = 'active';

CREATE TRIGGER organization_permission_grants_active_binding_insert
BEFORE INSERT ON organization_permission_grants
BEGIN
  SELECT CASE WHEN NEW.status != 'active' OR NOT EXISTS (
    SELECT 1
    FROM organization_adapter_bindings AS binding
    JOIN organization_tool_connections AS connection
      ON connection.connection_id = binding.connection_id
    WHERE binding.adapter_binding_id = NEW.adapter_binding_id
      AND binding.organization_id = NEW.organization_id
      AND binding.status = 'active'
      AND connection.organization_id = NEW.organization_id
      AND connection.status = 'active'
      AND binding.adapter_kind = 'approval-surface'
  ) THEN RAISE(
    ABORT,
    'permission grant requires an active compatible adapter binding'
  ) END;
END;

CREATE TRIGGER organization_permission_grants_revoke_only
BEFORE UPDATE ON organization_permission_grants
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'active' AND
    NEW.status = 'revoked' AND
    NEW.revoked_at IS NOT NULL AND
    NEW.revocation_reason IS NOT NULL AND
    NEW.permission_grant_id = OLD.permission_grant_id AND
    NEW.organization_id = OLD.organization_id AND
    NEW.adapter_binding_id = OLD.adapter_binding_id AND
    NEW.principal_id = OLD.principal_id AND
    NEW.membership_id = OLD.membership_id AND
    NEW.action = OLD.action AND
    NEW.resource_scope_json = OLD.resource_scope_json AND
    NEW.granted_by_principal_id = OLD.granted_by_principal_id AND
    NEW.granted_by_membership_id = OLD.granted_by_membership_id AND
    NEW.granted_at = OLD.granted_at
  ) THEN RAISE(ABORT, 'permission grants may only be revoked') END;
END;

CREATE TRIGGER organization_permission_grants_immutable_delete
BEFORE DELETE ON organization_permission_grants
BEGIN
  SELECT RAISE(ABORT, 'permission grants cannot be deleted');
END;

-- The tool layer writes one append-only record in the same transaction as
-- each mutation or permission evaluation. Provider-event identity is indexed
-- for correlation, but is deliberately not an authorization-result cache:
-- every retry must recheck current Authority, grant, and provider state.
CREATE TABLE organization_integration_audit (
  audit_sequence INTEGER PRIMARY KEY CHECK (audit_sequence > 0),
  audit_event_id TEXT NOT NULL UNIQUE CHECK (audit_event_id GLOB 'aud_*'),
  previous_entry_sha256 TEXT,
  entry_sha256 TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL
    REFERENCES organization_control_plane_metadata(organization_id),
  occurred_at TEXT NOT NULL CHECK (unixepoch(occurred_at) IS NOT NULL),
  actor_kind TEXT NOT NULL
    CHECK (
      actor_kind IN (
        'membership',
        'provider_identity',
        'installation',
        'system'
      )
    ),
  actor_principal_id TEXT,
  actor_membership_id TEXT,
  actor_identity_link_id TEXT
    REFERENCES organization_external_identity_links(identity_link_id),
  actor_installation_id TEXT,
  command_id TEXT NOT NULL UNIQUE,
  provider_event_sha256 TEXT,
  action TEXT NOT NULL CHECK (length(trim(action)) > 0),
  subject_kind TEXT NOT NULL CHECK (length(trim(subject_kind)) > 0),
  subject_id TEXT NOT NULL CHECK (length(trim(subject_id)) > 0),
  membership_id TEXT,
  identity_link_id TEXT
    REFERENCES organization_external_identity_links(identity_link_id),
  connection_id TEXT
    REFERENCES organization_tool_connections(connection_id),
  adapter_binding_id TEXT
    REFERENCES organization_adapter_bindings(adapter_binding_id),
  permission_grant_id TEXT
    REFERENCES organization_permission_grants(permission_grant_id),
  outcome TEXT NOT NULL
    CHECK (outcome IN ('allowed', 'denied', 'succeeded', 'failed')),
  reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  authority_checked_at TEXT,
  authority_evidence_sha256 TEXT,
  correlation_id TEXT NOT NULL,
  detail_json TEXT NOT NULL
    CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object'),
  detail_sha256 TEXT NOT NULL,
  CHECK (
    (audit_sequence = 1 AND previous_entry_sha256 IS NULL) OR
    (audit_sequence > 1 AND previous_entry_sha256 IS NOT NULL)
  ),
  CHECK (
    actor_principal_id IS NULL OR actor_principal_id GLOB 'prn_*'
  ),
  CHECK (
    actor_membership_id IS NULL OR actor_membership_id GLOB 'mem_*'
  ),
  CHECK (
    actor_installation_id IS NULL OR actor_installation_id GLOB 'ins_*'
  ),
  CHECK (
    membership_id IS NULL OR membership_id GLOB 'mem_*'
  ),
  CHECK (
    authority_checked_at IS NULL OR
    unixepoch(authority_checked_at) IS NOT NULL
  )
) STRICT;

CREATE INDEX organization_integration_audit_by_provider_event
ON organization_integration_audit(provider_event_sha256)
WHERE provider_event_sha256 IS NOT NULL;

CREATE TRIGGER organization_integration_audit_contiguous
BEFORE INSERT ON organization_integration_audit
BEGIN
  SELECT CASE WHEN NEW.audit_sequence != COALESCE(
    (SELECT MAX(audit_sequence) + 1 FROM organization_integration_audit),
    1
  ) THEN RAISE(ABORT, 'organization audit sequence must be contiguous') END;
  SELECT CASE WHEN NEW.audit_sequence > 1 AND NEW.previous_entry_sha256 != (
    SELECT entry_sha256
    FROM organization_integration_audit
    ORDER BY audit_sequence DESC
    LIMIT 1
  ) THEN RAISE(ABORT, 'organization audit predecessor is invalid') END;
END;

CREATE TRIGGER organization_integration_audit_immutable_update
BEFORE UPDATE ON organization_integration_audit
BEGIN
  SELECT RAISE(ABORT, 'organization integration audit is append-only');
END;

CREATE TRIGGER organization_integration_audit_immutable_delete
BEFORE DELETE ON organization_integration_audit
BEGIN
  SELECT RAISE(ABORT, 'organization integration audit cannot be deleted');
END;
