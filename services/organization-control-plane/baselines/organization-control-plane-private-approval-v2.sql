-- Private-approval additions for the Control Plane baseline v2.
-- This companion is composed with the V1 baseline by the V2 fresh-state-only
-- applier. It is deliberately not executable as an in-place upgrade.

CREATE TABLE organization_private_approval_pending_contracts_v2 (
  approval_id TEXT PRIMARY KEY CHECK (approval_id GLOB 'apr_*'),
  candidate_id TEXT NOT NULL CHECK (candidate_id GLOB 'cnd_*'),
  organization_id TEXT NOT NULL REFERENCES organization_control_plane_metadata(organization_id),
  authority_id TEXT NOT NULL REFERENCES organization_control_plane_metadata(authority_id),
  pending_json TEXT NOT NULL UNIQUE CHECK (
    json_valid(pending_json) AND json_type(pending_json) = 'object'
  ),
  pending_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(pending_sha256) = 71 AND substr(pending_sha256, 1, 7) = 'sha256:' AND
    substr(pending_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  card_binding_json TEXT NOT NULL UNIQUE CHECK (
    json_valid(card_binding_json) AND json_type(card_binding_json) = 'object'
  ),
  card_binding_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(card_binding_sha256) = 71 AND
    substr(card_binding_sha256, 1, 7) = 'sha256:' AND
    substr(card_binding_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  stage_command_id TEXT NOT NULL UNIQUE CHECK (stage_command_id GLOB 'pas_*'),
  connection_id TEXT NOT NULL REFERENCES organization_tool_connection_contracts(connection_id),
  connection_contract_sha256 TEXT NOT NULL REFERENCES organization_tool_connection_contracts(contract_sha256),
  connection_state_sha256 TEXT NOT NULL REFERENCES organization_tool_connection_current_state(state_sha256),
  external_identity_link_id TEXT NOT NULL,
  external_identity_link_contract_sha256 TEXT NOT NULL REFERENCES organization_external_human_link_contracts(contract_sha256),
  assignee_principal_id TEXT NOT NULL CHECK (assignee_principal_id GLOB 'prn_*'),
  assignee_membership_id TEXT NOT NULL CHECK (assignee_membership_id GLOB 'mem_*'),
  slack_workspace_id TEXT NOT NULL CHECK (length(trim(slack_workspace_id)) > 0),
  slack_enterprise_id TEXT CHECK (slack_enterprise_id IS NULL OR length(trim(slack_enterprise_id)) > 0),
  slack_subject_id TEXT NOT NULL CHECK (length(trim(slack_subject_id)) > 0),
  dm_channel_id TEXT NOT NULL CHECK (substr(dm_channel_id, 1, 1) = 'D'),
  provider_message_ts TEXT NOT NULL UNIQUE CHECK (length(trim(provider_message_ts)) > 0),
  card_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(card_sha256) = 71 AND substr(card_sha256, 1, 7) = 'sha256:' AND
    substr(card_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_private_approval_pending_contracts_v2_exact_fences
BEFORE INSERT ON organization_private_approval_pending_contracts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM organization_tool_connection_current_state
   WHERE connection_id = NEW.connection_id
     AND connection_contract_sha256 = NEW.connection_contract_sha256
     AND state_sha256 = NEW.connection_state_sha256
     AND current_status = 'active'
)
OR NOT EXISTS (
  SELECT 1 FROM organization_external_human_link_current
   WHERE external_identity_link_id = NEW.external_identity_link_id
     AND contract_sha256 = NEW.external_identity_link_contract_sha256
     AND principal_id = NEW.assignee_principal_id
     AND membership_id = NEW.assignee_membership_id
)
BEGIN SELECT RAISE(ABORT, 'private approval pending contract fences are not exact'); END;

CREATE TRIGGER organization_private_approval_pending_contracts_v2_immutable_update
BEFORE UPDATE ON organization_private_approval_pending_contracts_v2
BEGIN SELECT RAISE(ABORT, 'private approval pending contract is immutable'); END;

CREATE TRIGGER organization_private_approval_pending_contracts_v2_delete_denied
BEFORE DELETE ON organization_private_approval_pending_contracts_v2
BEGIN SELECT RAISE(ABORT, 'private approval pending contract cannot be deleted'); END;

CREATE TABLE organization_private_approval_signed_action_receipts_v2 (
  provider_receipt_id TEXT PRIMARY KEY CHECK (provider_receipt_id GLOB 'sar_*'),
  provider_action_key TEXT NOT NULL UNIQUE,
  raw_payload_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(raw_payload_sha256) = 71 AND substr(raw_payload_sha256, 1, 7) = 'sha256:' AND
    substr(raw_payload_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  normalized_receipt_json TEXT NOT NULL UNIQUE CHECK (
    json_valid(normalized_receipt_json) AND json_type(normalized_receipt_json) = 'object'
  ),
  normalized_receipt_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(normalized_receipt_sha256) = 71 AND
    substr(normalized_receipt_sha256, 1, 7) = 'sha256:' AND
    substr(normalized_receipt_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  approval_id TEXT NOT NULL REFERENCES organization_private_approval_pending_contracts_v2(approval_id),
  action_id TEXT NOT NULL CHECK (length(trim(action_id)) > 0),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('approve', 'reject')),
  received_at TEXT NOT NULL CHECK (unixepoch(received_at) IS NOT NULL),
  verified_at TEXT NOT NULL CHECK (unixepoch(verified_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_private_approval_signed_action_receipts_v2_exact_card
BEFORE INSERT ON organization_private_approval_signed_action_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM organization_private_approval_pending_contracts_v2
   WHERE approval_id = NEW.approval_id
)
BEGIN SELECT RAISE(ABORT, 'private approval action receipt does not match a bound card'); END;

CREATE TRIGGER organization_private_approval_signed_action_receipts_v2_immutable_update
BEFORE UPDATE ON organization_private_approval_signed_action_receipts_v2
BEGIN SELECT RAISE(ABORT, 'private approval signed action receipt is immutable'); END;

CREATE TRIGGER organization_private_approval_signed_action_receipts_v2_delete_denied
BEFORE DELETE ON organization_private_approval_signed_action_receipts_v2
BEGIN SELECT RAISE(ABORT, 'private approval signed action receipt cannot be deleted'); END;

CREATE TABLE organization_private_approval_terminal_evidence_v2 (
  approval_id TEXT PRIMARY KEY REFERENCES organization_private_approval_pending_contracts_v2(approval_id),
  resolution_json TEXT NOT NULL UNIQUE CHECK (json_valid(resolution_json) AND json_type(resolution_json) = 'object'),
  resolution_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(resolution_sha256) = 71 AND substr(resolution_sha256, 1, 7) = 'sha256:' AND
    substr(resolution_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  signed_action_receipt_sha256 TEXT NOT NULL UNIQUE
    REFERENCES organization_private_approval_signed_action_receipts_v2(normalized_receipt_sha256),
  outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'rejected')),
  audit_event_id TEXT NOT NULL UNIQUE CHECK (audit_event_id GLOB 'aud_*'),
  audit_sequence INTEGER NOT NULL UNIQUE CHECK (audit_sequence > 0),
  audit_entry_json TEXT NOT NULL UNIQUE CHECK (json_valid(audit_entry_json) AND json_type(audit_entry_json) = 'object'),
  audit_entry_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(audit_entry_sha256) = 71 AND substr(audit_entry_sha256, 1, 7) = 'sha256:' AND
    substr(audit_entry_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  predecessor_entry_sha256 TEXT UNIQUE CHECK (
    predecessor_entry_sha256 IS NULL OR (
      length(predecessor_entry_sha256) = 71 AND
      substr(predecessor_entry_sha256, 1, 7) = 'sha256:' AND
      substr(predecessor_entry_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  committed_at TEXT NOT NULL CHECK (unixepoch(committed_at) IS NOT NULL),
  CHECK (
    (audit_sequence = 1 AND predecessor_entry_sha256 IS NULL) OR
    (audit_sequence > 1 AND predecessor_entry_sha256 IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER organization_private_approval_terminal_evidence_v2_exact_action
BEFORE INSERT ON organization_private_approval_terminal_evidence_v2
WHEN NOT EXISTS (
  SELECT 1
    FROM organization_private_approval_signed_action_receipts_v2 AS receipt
    JOIN organization_private_approval_pending_contracts_v2 AS pending
      ON pending.approval_id = receipt.approval_id
   WHERE receipt.approval_id = NEW.approval_id
     AND receipt.normalized_receipt_sha256 = NEW.signed_action_receipt_sha256
)
BEGIN SELECT RAISE(ABORT, 'private approval terminal evidence does not match signed action'); END;

CREATE TRIGGER organization_private_approval_terminal_evidence_v2_contiguous
BEFORE INSERT ON organization_private_approval_terminal_evidence_v2
BEGIN
  SELECT CASE WHEN NEW.audit_sequence != COALESCE(
    (SELECT MAX(audit_sequence) + 1 FROM organization_private_approval_terminal_evidence_v2),
    1
  ) THEN RAISE(ABORT, 'private approval audit sequence must be contiguous') END;
  SELECT CASE WHEN NEW.audit_sequence > 1 AND NEW.predecessor_entry_sha256 != (
    SELECT audit_entry_sha256 FROM organization_private_approval_terminal_evidence_v2
    ORDER BY audit_sequence DESC LIMIT 1
  ) THEN RAISE(ABORT, 'private approval audit predecessor is invalid') END;
END;

CREATE TRIGGER organization_private_approval_terminal_evidence_v2_immutable_update
BEFORE UPDATE ON organization_private_approval_terminal_evidence_v2
BEGIN SELECT RAISE(ABORT, 'private approval terminal evidence is immutable'); END;

CREATE TRIGGER organization_private_approval_terminal_evidence_v2_delete_denied
BEFORE DELETE ON organization_private_approval_terminal_evidence_v2
BEGIN SELECT RAISE(ABORT, 'private approval terminal evidence cannot be deleted'); END;

-- A denied/stale signed action is not an approval rejection. It is a durable
-- receipt disposition that removes an un-actionable provider retry from the
-- recovery queue without binding any canonical-record policy.
CREATE TABLE organization_private_approval_denied_action_receipts_v2 (
  provider_action_key TEXT PRIMARY KEY
    REFERENCES organization_private_approval_signed_action_receipts_v2(provider_action_key),
  signed_action_receipt_sha256 TEXT NOT NULL UNIQUE
    REFERENCES organization_private_approval_signed_action_receipts_v2(normalized_receipt_sha256),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN ('authorization_denied', 'state_drift')
  ),
  denied_at TEXT NOT NULL CHECK (unixepoch(denied_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_private_approval_denied_action_receipts_v2_exact_queued
BEFORE INSERT ON organization_private_approval_denied_action_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM organization_private_approval_signed_action_receipts_v2 AS receipt
   WHERE receipt.provider_action_key = NEW.provider_action_key
     AND receipt.normalized_receipt_sha256 = NEW.signed_action_receipt_sha256
)
OR EXISTS (
  SELECT 1 FROM organization_private_approval_terminal_evidence_v2 AS terminal
   WHERE terminal.signed_action_receipt_sha256 = NEW.signed_action_receipt_sha256
)
BEGIN SELECT RAISE(ABORT, 'private approval denied receipt must consume an unresolved signed action'); END;

CREATE TRIGGER organization_private_approval_denied_action_receipts_v2_immutable_update
BEFORE UPDATE ON organization_private_approval_denied_action_receipts_v2
BEGIN SELECT RAISE(ABORT, 'private approval denied receipt is immutable'); END;

CREATE TRIGGER organization_private_approval_denied_action_receipts_v2_delete_denied
BEFORE DELETE ON organization_private_approval_denied_action_receipts_v2
BEGIN SELECT RAISE(ABORT, 'private approval denied receipt cannot be deleted'); END;

CREATE TRIGGER organization_private_approval_terminal_evidence_v2_denied_receipt
BEFORE INSERT ON organization_private_approval_terminal_evidence_v2
WHEN EXISTS (
  SELECT 1 FROM organization_private_approval_denied_action_receipts_v2 AS denied
   WHERE denied.signed_action_receipt_sha256 = NEW.signed_action_receipt_sha256
)
BEGIN SELECT RAISE(ABORT, 'private approval terminal cannot consume a denied receipt'); END;
