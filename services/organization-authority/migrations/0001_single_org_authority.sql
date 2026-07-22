CREATE TABLE authority_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL UNIQUE,
  organization_display_name TEXT NOT NULL,
  authority_pin_sha256 TEXT NOT NULL UNIQUE,
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
  UNIQUE (membership_id, organization_id, principal_id, membership_type),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
) STRICT;

CREATE TABLE authority_enrollment_grants (
  grant_sha256 TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL REFERENCES authority_metadata(authority_id),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  request_sha256 TEXT UNIQUE,
  CHECK (
    (consumed_at IS NULL AND request_sha256 IS NULL) OR
    (consumed_at IS NOT NULL AND request_sha256 IS NOT NULL)
  )
) STRICT;

CREATE INDEX authority_enrollment_grants_membership
  ON authority_enrollment_grants (membership_id, issued_at);

CREATE TABLE authority_enrollments (
  enrollment_id TEXT PRIMARY KEY,
  grant_sha256 TEXT NOT NULL UNIQUE REFERENCES authority_enrollment_grants(grant_sha256),
  request_sha256 TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  receipt_sha256 TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  authority_id TEXT NOT NULL REFERENCES authority_metadata(authority_id),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee')),
  installation_id TEXT NOT NULL UNIQUE,
  installation_key_id TEXT NOT NULL UNIQUE,
  installation_public_key_spki_der_base64 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  enrolled_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_kind TEXT CHECK (
    revocation_kind IS NULL OR
    revocation_kind IN ('membership_revoked', 'installation_revoked')
  ),
  revocation_reason TEXT,
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(
      membership_id, organization_id, principal_id, membership_type
    ),
  CHECK (
    (status = 'active' AND revoked_at IS NULL AND revocation_kind IS NULL AND revocation_reason IS NULL) OR
    (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_kind IS NOT NULL AND revocation_reason IS NOT NULL)
  )
) STRICT;

CREATE INDEX authority_enrollments_membership
  ON authority_enrollments (membership_id, enrolled_at);

CREATE TABLE authority_access_states (
  enrollment_id TEXT NOT NULL REFERENCES authority_enrollments(enrollment_id),
  access_state_sequence INTEGER NOT NULL CHECK (access_state_sequence > 0),
  state_sha256 TEXT NOT NULL UNIQUE,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  evaluated_at TEXT NOT NULL,
  valid_until TEXT,
  revocation_reason TEXT CHECK (
    revocation_reason IS NULL OR
    revocation_reason IN ('membership_revoked', 'installation_revoked')
  ),
  PRIMARY KEY (enrollment_id, access_state_sequence),
  UNIQUE (enrollment_id, state_sha256),
  CHECK (
    (status = 'active' AND valid_until IS NOT NULL AND revocation_reason IS NULL) OR
    (status = 'revoked' AND valid_until IS NULL AND revocation_reason IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX authority_access_states_one_terminal
  ON authority_access_states (enrollment_id)
  WHERE status = 'revoked';

CREATE TRIGGER authority_access_states_contiguous
BEFORE INSERT ON authority_access_states
BEGIN
  SELECT CASE WHEN NEW.access_state_sequence != COALESCE(
    (SELECT MAX(access_state_sequence) + 1
     FROM authority_access_states
     WHERE enrollment_id = NEW.enrollment_id),
    1
  ) THEN RAISE(ABORT, 'authority access-state sequence must be contiguous') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM authority_access_states
    WHERE enrollment_id = NEW.enrollment_id AND status = 'revoked'
  ) THEN RAISE(ABORT, 'revoked authority access state is terminal') END;
END;

CREATE TABLE authority_access_lease_requests (
  request_sha256 TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  enrollment_id TEXT NOT NULL REFERENCES authority_enrollments(enrollment_id),
  previous_access_state_sha256 TEXT NOT NULL,
  resulting_state_sha256 TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (enrollment_id, request_id),
  FOREIGN KEY (enrollment_id, previous_access_state_sha256)
    REFERENCES authority_access_states(enrollment_id, state_sha256),
  FOREIGN KEY (enrollment_id, resulting_state_sha256)
    REFERENCES authority_access_states(enrollment_id, state_sha256)
) STRICT;

CREATE TABLE authority_audit_log (
  audit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (
    actor_kind IN ('admin', 'enrollment_grant', 'installation')
  ),
  action TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json))
) STRICT;

CREATE INDEX authority_audit_log_time
  ON authority_audit_log (occurred_at, audit_sequence);
