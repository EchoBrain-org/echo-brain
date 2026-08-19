-- Authority-owned processing and governed pre-record state.
--
-- A meeting source is permanently bound to one exact Authority membership.
-- Raw candidate content is admitted only while that membership is active and
-- only after the owning member's exact source/meeting exclusion is checked on
-- first admission in the same BEGIN IMMEDIATE transaction. Candidate content
-- is retained for 30 days after its first approved/rejected resolution;
-- processed markers deliberately live outside the candidate cascade so
-- cleanup cannot make work repeat.

CREATE TABLE authority_processing_source_owner_bindings (
  source_adapter_id TEXT NOT NULL CHECK (length(source_adapter_id) BETWEEN 1 AND 128),
  source_instance_id TEXT NOT NULL CHECK (length(source_instance_id) BETWEEN 1 AND 128),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee')),
  bound_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', bound_at) IS NOT NULL AND
    bound_at = strftime('%Y-%m-%dT%H:%M:%fZ', bound_at)
  ),
  PRIMARY KEY (source_adapter_id, source_instance_id),
  UNIQUE (
    source_adapter_id, source_instance_id, organization_id, principal_id,
    membership_id, membership_type
  ),
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(
      membership_id, organization_id, principal_id, membership_type
    )
) STRICT;

CREATE TRIGGER authority_processing_source_owner_bindings_immutable_update
BEFORE UPDATE ON authority_processing_source_owner_bindings
BEGIN
  SELECT RAISE(ABORT, 'authority processing source-owner binding is immutable');
END;

CREATE TRIGGER authority_processing_source_owner_bindings_delete_denied
BEFORE DELETE ON authority_processing_source_owner_bindings
BEGIN
  SELECT RAISE(ABORT, 'authority processing source-owner binding cannot be deleted');
END;

CREATE TABLE authority_processing_source_cursors (
  source_adapter_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  cursor TEXT NOT NULL CHECK (length(cursor) BETWEEN 1 AND 8192),
  updated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL AND
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
  ),
  PRIMARY KEY (source_adapter_id, source_instance_id),
  FOREIGN KEY (source_adapter_id, source_instance_id)
    REFERENCES authority_processing_source_owner_bindings(
      source_adapter_id, source_instance_id
    )
) STRICT;

CREATE TABLE authority_processing_candidates (
  processing_key TEXT PRIMARY KEY CHECK (length(processing_key) BETWEEN 1 AND 8192),
  source_adapter_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 4096),
  meeting_revision TEXT NOT NULL CHECK (length(meeting_revision) BETWEEN 1 AND 4096),
  meeting_id TEXT NOT NULL CHECK (length(meeting_id) BETWEEN 1 AND 4096),
  raw_document_sha256 TEXT NOT NULL CHECK (
    length(raw_document_sha256) = 71 AND
    substr(raw_document_sha256, 1, 7) = 'sha256:' AND
    substr(raw_document_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  raw_document_json TEXT NOT NULL CHECK (
    json_valid(raw_document_json) AND json_type(raw_document_json) = 'object'
  ),
  admitted_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at) IS NOT NULL AND
    admitted_at = strftime('%Y-%m-%dT%H:%M:%fZ', admitted_at)
  ),
  FOREIGN KEY (source_adapter_id, source_instance_id)
    REFERENCES authority_processing_source_owner_bindings(
      source_adapter_id, source_instance_id
    )
) STRICT;

CREATE TRIGGER authority_processing_candidates_immutable_update
BEFORE UPDATE ON authority_processing_candidates
BEGIN
  SELECT RAISE(ABORT, 'authority processing raw candidate is immutable');
END;

CREATE TABLE authority_processing_slots (
  processing_key TEXT NOT NULL REFERENCES authority_processing_candidates(processing_key)
    ON DELETE CASCADE,
  slot_name TEXT NOT NULL CHECK (
    slot_name IN ('decision-set', 'approval-request')
  ),
  document_sha256 TEXT NOT NULL CHECK (
    length(document_sha256) = 71 AND
    substr(document_sha256, 1, 7) = 'sha256:' AND
    substr(document_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  request_order_at TEXT,
  request_approval_id TEXT,
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  ),
  PRIMARY KEY (processing_key, slot_name),
  CHECK (
    (slot_name = 'approval-request' AND
      request_order_at IS NOT NULL AND
      strftime('%Y-%m-%dT%H:%M:%fZ', request_order_at) IS NOT NULL AND
      request_order_at = strftime('%Y-%m-%dT%H:%M:%fZ', request_order_at) AND
      request_approval_id IS NOT NULL AND
      length(request_approval_id) = 64 AND
      request_approval_id NOT GLOB '*[^0-9a-f]*') OR
    (slot_name = 'decision-set' AND
      request_order_at IS NULL AND request_approval_id IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX authority_processing_slots_pending_order
  ON authority_processing_slots (
    request_order_at, request_approval_id, processing_key
  )
  WHERE slot_name = 'approval-request';

CREATE TRIGGER authority_processing_slots_immutable_update
BEFORE UPDATE ON authority_processing_slots
BEGIN
  SELECT RAISE(ABORT, 'authority processing slot is create-once');
END;

CREATE TABLE authority_processing_resolutions (
  processing_key TEXT PRIMARY KEY REFERENCES authority_processing_candidates(processing_key)
    ON DELETE CASCADE,
  terminal_status TEXT NOT NULL CHECK (
    terminal_status IN ('approved', 'rejected')
  ),
  resolution_sha256 TEXT NOT NULL CHECK (
    length(resolution_sha256) = 71 AND
    substr(resolution_sha256, 1, 7) = 'sha256:' AND
    substr(resolution_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  resolution_json TEXT NOT NULL CHECK (json_valid(resolution_json)),
  resolved_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at) IS NOT NULL AND
    resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at)
  ),
  retain_until TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', retain_until) IS NOT NULL AND
    retain_until = strftime('%Y-%m-%dT%H:%M:%fZ', retain_until) AND
    retain_until = strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+30 days')
  )
) STRICT;

CREATE INDEX authority_processing_resolutions_retention
  ON authority_processing_resolutions (retain_until, processing_key);

CREATE TRIGGER authority_processing_resolutions_immutable_update
BEFORE UPDATE ON authority_processing_resolutions
BEGIN
  SELECT RAISE(ABORT, 'authority processing terminal resolution is immutable');
END;

CREATE TABLE authority_processing_processed_markers (
  processing_key TEXT PRIMARY KEY CHECK (length(processing_key) BETWEEN 1 AND 8192),
  source_adapter_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  processed_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', processed_at) IS NOT NULL AND
    processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', processed_at)
  ),
  FOREIGN KEY (source_adapter_id, source_instance_id)
    REFERENCES authority_processing_source_owner_bindings(
      source_adapter_id, source_instance_id
    )
) STRICT;

CREATE TRIGGER authority_processing_processed_markers_immutable_update
BEFORE UPDATE ON authority_processing_processed_markers
BEGIN
  SELECT RAISE(ABORT, 'authority processing processed marker is immutable');
END;

CREATE TRIGGER authority_processing_processed_markers_delete_denied
BEFORE DELETE ON authority_processing_processed_markers
BEGIN
  SELECT RAISE(ABORT, 'authority processing processed marker cannot be deleted');
END;

-- Delivery payloads and provider messages are deliberately absent. The row
-- retains only routing identifiers, fixed outcome fields, and canonical
-- digests of the envelope and receipt that were already validated by core.
CREATE TABLE authority_processing_delivery_receipts (
  receipt_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL CHECK (length(envelope_id) BETWEEN 1 AND 4096),
  processing_key TEXT NOT NULL REFERENCES authority_processing_candidates(processing_key)
    ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 8192),
  envelope_sha256 TEXT NOT NULL CHECK (
    length(envelope_sha256) = 71 AND
    substr(envelope_sha256, 1, 7) = 'sha256:' AND
    substr(envelope_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_sha256 TEXT NOT NULL CHECK (
    length(receipt_sha256) = 71 AND
    substr(receipt_sha256, 1, 7) = 'sha256:' AND
    substr(receipt_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('delivered', 'rejected', 'failed', 'unknown')),
  recorded_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS NOT NULL AND
    recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at)
  ),
  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  UNIQUE (processing_key, idempotency_key, envelope_id, receipt_sha256)
) STRICT;

CREATE TRIGGER authority_processing_delivery_receipts_immutable_update
BEFORE UPDATE ON authority_processing_delivery_receipts
BEGIN
  SELECT RAISE(ABORT, 'authority processing delivery receipt is create-once');
END;

-- No title, reason, display label, transcript, or other meeting content is
-- stored here. Empty external_id denotes the exact whole-source exclusion;
-- a meeting exclusion carries the exact source-owned external identifier.
CREATE TABLE authority_processing_member_exclusions (
  organization_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee')),
  source_adapter_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('source', 'meeting')),
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  ),
  PRIMARY KEY (
    membership_id, source_adapter_id, source_instance_id, scope_kind,
    external_id
  ),
  FOREIGN KEY (
    source_adapter_id, source_instance_id, organization_id, principal_id,
    membership_id, membership_type
  ) REFERENCES authority_processing_source_owner_bindings(
    source_adapter_id, source_instance_id, organization_id, principal_id,
    membership_id, membership_type
  ),
  CHECK (
    (scope_kind = 'source' AND external_id = '') OR
    (scope_kind = 'meeting' AND length(external_id) BETWEEN 1 AND 4096)
  )
) STRICT;

CREATE TRIGGER authority_processing_member_exclusions_immutable_update
BEFORE UPDATE ON authority_processing_member_exclusions
BEGIN
  SELECT RAISE(ABORT, 'authority processing member exclusion must be replaced explicitly');
END;
