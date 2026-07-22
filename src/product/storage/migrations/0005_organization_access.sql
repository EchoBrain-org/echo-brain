CREATE TABLE organization_authority_pins (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL UNIQUE,
  authority_key_id TEXT NOT NULL,
  descriptor_sha256 TEXT NOT NULL,
  trusted_pin_sha256 TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  pinned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (authority_id, organization_id, authority_key_id),
  CHECK (
    descriptor_sha256 = trusted_pin_sha256 AND
    length(descriptor_sha256) = 71 AND
    substr(descriptor_sha256, 1, 7) = 'sha256:' AND
    substr(descriptor_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;

CREATE TABLE organization_enrollments (
  request_sha256 TEXT PRIMARY KEY,
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  authority_id TEXT NOT NULL,
  authority_key_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  installation_key_id TEXT NOT NULL,
  enrollment_grant_sha256 TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'enrolled')),
  enrollment_id TEXT UNIQUE,
  receipt_sha256 TEXT UNIQUE,
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  accepted_access_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_access_sequence >= 0),
  accepted_access_sha256 TEXT,
  trusted_time_high_watermark TEXT,
  prepared_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  enrolled_locally_at TEXT,
  UNIQUE (authority_id, installation_id),
  UNIQUE (request_sha256, authority_id, installation_id, enrollment_id),
  FOREIGN KEY (authority_id, organization_id, authority_key_id)
    REFERENCES organization_authority_pins (
      authority_id, organization_id, authority_key_id
    ),
  CHECK (
    length(request_sha256) = 71 AND
    substr(request_sha256, 1, 7) = 'sha256:' AND
    substr(request_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(enrollment_grant_sha256) = 71 AND
    substr(enrollment_grant_sha256, 1, 7) = 'sha256:' AND
    substr(enrollment_grant_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (status = 'pending' AND enrollment_id IS NULL AND
      receipt_sha256 IS NULL AND receipt_json IS NULL AND
      enrolled_locally_at IS NULL) OR
    (status = 'enrolled' AND enrollment_id IS NOT NULL AND
      receipt_sha256 IS NOT NULL AND receipt_json IS NOT NULL AND
      enrolled_locally_at IS NOT NULL)
  ),
  CHECK (
    (accepted_access_sequence = 0 AND accepted_access_sha256 IS NULL AND
      trusted_time_high_watermark IS NULL) OR
    (accepted_access_sequence > 0 AND accepted_access_sha256 IS NOT NULL AND
      trusted_time_high_watermark IS NOT NULL)
  ),
  CHECK (
    accepted_access_sha256 IS NULL OR (
      length(accepted_access_sha256) = 71 AND
      substr(accepted_access_sha256, 1, 7) = 'sha256:' AND
      substr(accepted_access_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    )
  )
) STRICT;

CREATE TABLE organization_access_high_watermarks (
  request_sha256 TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  access_state_sequence INTEGER NOT NULL CHECK (access_state_sequence > 0),
  state_sha256 TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  revocation_reason TEXT CHECK (
    revocation_reason IS NULL OR
    revocation_reason IN ('membership_revoked', 'installation_revoked')
  ),
  evaluated_at TEXT NOT NULL,
  valid_until TEXT,
  trusted_time_high_watermark TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (authority_id, installation_id),
  FOREIGN KEY (
    request_sha256, authority_id, installation_id, enrollment_id
  ) REFERENCES organization_enrollments (
    request_sha256, authority_id, installation_id, enrollment_id
  ),
  CHECK (
    length(state_sha256) = 71 AND
    substr(state_sha256, 1, 7) = 'sha256:' AND
    substr(state_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    (status = 'active' AND revocation_reason IS NULL AND
      valid_until IS NOT NULL) OR
    (status = 'revoked' AND revocation_reason IS NOT NULL AND
      valid_until IS NULL)
  )
) STRICT;

CREATE TRIGGER organization_authority_pins_are_write_once
BEFORE UPDATE ON organization_authority_pins
BEGIN
  SELECT RAISE(ABORT, 'organization authority pin is write-once');
END;

CREATE TRIGGER organization_authority_pins_cannot_be_deleted
BEFORE DELETE ON organization_authority_pins
BEGIN
  SELECT RAISE(ABORT, 'organization authority pin cannot be deleted');
END;

CREATE TRIGGER organization_enrollment_evidence_is_monotonic
BEFORE UPDATE ON organization_enrollments
WHEN
  NEW.request_sha256 IS NOT OLD.request_sha256 OR
  NEW.authority_id IS NOT OLD.authority_id OR
  NEW.authority_key_id IS NOT OLD.authority_key_id OR
  NEW.organization_id IS NOT OLD.organization_id OR
  NEW.principal_id IS NOT OLD.principal_id OR
  NEW.membership_id IS NOT OLD.membership_id OR
  NEW.installation_id IS NOT OLD.installation_id OR
  NEW.installation_key_id IS NOT OLD.installation_key_id OR
  NEW.enrollment_grant_sha256 IS NOT OLD.enrollment_grant_sha256 OR
  NEW.request_json IS NOT OLD.request_json OR
  (OLD.status = 'enrolled' AND (
    NEW.status IS NOT OLD.status OR
    NEW.enrollment_id IS NOT OLD.enrollment_id OR
    NEW.receipt_sha256 IS NOT OLD.receipt_sha256 OR
    NEW.receipt_json IS NOT OLD.receipt_json
  )) OR
  NEW.accepted_access_sequence < OLD.accepted_access_sequence OR
  (NEW.accepted_access_sequence = OLD.accepted_access_sequence AND
    NEW.accepted_access_sha256 IS NOT OLD.accepted_access_sha256) OR
  (OLD.trusted_time_high_watermark IS NOT NULL AND
    NEW.trusted_time_high_watermark < OLD.trusted_time_high_watermark)
BEGIN
  SELECT RAISE(ABORT, 'organization enrollment evidence cannot regress');
END;

CREATE TRIGGER organization_access_high_watermark_is_monotonic
BEFORE UPDATE ON organization_access_high_watermarks
WHEN
  NEW.request_sha256 IS NOT OLD.request_sha256 OR
  NEW.authority_id IS NOT OLD.authority_id OR
  NEW.installation_id IS NOT OLD.installation_id OR
  NEW.enrollment_id IS NOT OLD.enrollment_id OR
  NEW.access_state_sequence < OLD.access_state_sequence OR
  (NEW.access_state_sequence = OLD.access_state_sequence AND
    NEW.state_sha256 IS NOT OLD.state_sha256) OR
  (OLD.status = 'revoked' AND NEW.state_sha256 IS NOT OLD.state_sha256) OR
  NEW.trusted_time_high_watermark < OLD.trusted_time_high_watermark
BEGIN
  SELECT RAISE(ABORT, 'organization access high-watermark cannot regress');
END;

CREATE TRIGGER organization_access_high_watermark_cannot_be_deleted
BEFORE DELETE ON organization_access_high_watermarks
BEGIN
  SELECT RAISE(ABORT, 'organization access high-watermark cannot be deleted');
END;
