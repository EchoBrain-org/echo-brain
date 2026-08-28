-- Private-approval additions for the Control Plane baseline v2.
-- This companion is composed with the V1 baseline by the V2 fresh-state-only
-- applier. It is deliberately not executable as an in-place upgrade.

-- The private approval surface is deliberately distinct from the stopped
-- reaction approval capability. Its immutable contract binds this versioned
-- Slack Block Kit route and schema to one exact Slack connection contract;
-- the current row carries the separately versioned observed connection state.
CREATE TABLE organization_private_approval_surface_binding_contracts_v2 (
  approval_binding_id TEXT PRIMARY KEY CHECK (approval_binding_id GLOB 'bnd_*'),
  contract_json TEXT NOT NULL UNIQUE CHECK (
    json_valid(contract_json) AND json_type(contract_json) = 'object'
  ),
  contract_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(contract_sha256) = 71 AND
    substr(contract_sha256, 1, 7) = 'sha256:' AND
    substr(contract_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  connection_id TEXT NOT NULL
    REFERENCES organization_tool_connection_contracts(connection_id),
  connection_contract_sha256 TEXT NOT NULL
    REFERENCES organization_tool_connection_contracts(contract_sha256),
  interaction_kind TEXT NOT NULL CHECK (interaction_kind = 'slack-block-actions'),
  interaction_route TEXT NOT NULL CHECK (
    length(interaction_route) BETWEEN 1 AND 2048 AND
    substr(interaction_route, 1, 1) = '/'
  ),
  interaction_schema_version INTEGER NOT NULL CHECK (interaction_schema_version = 1),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_private_approval_surface_binding_contracts_v2_exact_connection
BEFORE INSERT ON organization_private_approval_surface_binding_contracts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM organization_tool_connection_contracts
   WHERE connection_id = NEW.connection_id
     AND contract_sha256 = NEW.connection_contract_sha256
)
BEGIN SELECT RAISE(ABORT, 'private approval surface binding contract does not match its connection'); END;

CREATE TRIGGER organization_private_approval_surface_binding_contracts_v2_immutable_update
BEFORE UPDATE ON organization_private_approval_surface_binding_contracts_v2
BEGIN SELECT RAISE(ABORT, 'private approval surface binding contract is immutable'); END;

CREATE TRIGGER organization_private_approval_surface_binding_contracts_v2_delete_denied
BEFORE DELETE ON organization_private_approval_surface_binding_contracts_v2
BEGIN SELECT RAISE(ABORT, 'private approval surface binding contract cannot be deleted'); END;

CREATE TABLE organization_private_approval_surface_binding_current_v2 (
  approval_binding_id TEXT PRIMARY KEY
    REFERENCES organization_private_approval_surface_binding_contracts_v2(approval_binding_id),
  contract_sha256 TEXT NOT NULL UNIQUE
    REFERENCES organization_private_approval_surface_binding_contracts_v2(contract_sha256),
  connection_state_sha256 TEXT NOT NULL
    REFERENCES organization_tool_connection_current_state(state_sha256),
  current_status TEXT NOT NULL CHECK (current_status IN ('active', 'revoked')),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_private_approval_surface_binding_current_v2_exact_fence_insert
BEFORE INSERT ON organization_private_approval_surface_binding_current_v2
WHEN NOT EXISTS (
  SELECT 1
    FROM organization_private_approval_surface_binding_contracts_v2 AS binding
    JOIN organization_tool_connection_current_state AS connection_state
      ON connection_state.connection_id = binding.connection_id
     AND connection_state.connection_contract_sha256 = binding.connection_contract_sha256
   WHERE binding.approval_binding_id = NEW.approval_binding_id
     AND binding.contract_sha256 = NEW.contract_sha256
     AND connection_state.state_sha256 = NEW.connection_state_sha256
     AND (NEW.current_status = 'revoked' OR connection_state.current_status = 'active')
)
BEGIN SELECT RAISE(ABORT, 'private approval surface binding current state does not match its contract'); END;

CREATE TRIGGER organization_private_approval_surface_binding_current_v2_exact_fence_update
BEFORE UPDATE OF approval_binding_id, contract_sha256, connection_state_sha256
ON organization_private_approval_surface_binding_current_v2
WHEN NOT EXISTS (
  SELECT 1
    FROM organization_private_approval_surface_binding_contracts_v2 AS binding
    JOIN organization_tool_connection_current_state AS connection_state
      ON connection_state.connection_id = binding.connection_id
     AND connection_state.connection_contract_sha256 = binding.connection_contract_sha256
   WHERE binding.approval_binding_id = NEW.approval_binding_id
     AND binding.contract_sha256 = NEW.contract_sha256
     AND connection_state.state_sha256 = NEW.connection_state_sha256
     AND (NEW.current_status = 'revoked' OR connection_state.current_status = 'active')
)
BEGIN SELECT RAISE(ABORT, 'private approval surface binding current state does not match its contract'); END;

CREATE TRIGGER organization_private_approval_surface_binding_current_v2_ordered_update
BEFORE UPDATE ON organization_private_approval_surface_binding_current_v2
WHEN NEW.approval_binding_id != OLD.approval_binding_id
  OR NEW.contract_sha256 != OLD.contract_sha256
  OR (NEW.connection_state_sha256 = OLD.connection_state_sha256
      AND NEW.current_status = OLD.current_status)
  OR unixepoch(NEW.updated_at) <= unixepoch(OLD.updated_at)
  OR (OLD.current_status = 'revoked' AND NEW.current_status != 'revoked')
  OR (OLD.current_status = 'revoked' AND NEW.connection_state_sha256 != OLD.connection_state_sha256)
BEGIN SELECT RAISE(ABORT, 'private approval surface binding current state only permits ordered revocation'); END;

CREATE TRIGGER organization_private_approval_surface_binding_current_v2_delete_denied
BEFORE DELETE ON organization_private_approval_surface_binding_current_v2
BEGIN SELECT RAISE(ABORT, 'private approval surface binding current state cannot be deleted'); END;

CREATE TABLE organization_private_approval_pending_contracts_v2 (
  approval_id TEXT PRIMARY KEY CHECK (approval_id GLOB 'apr_*'),
  candidate_id TEXT NOT NULL CHECK (candidate_id GLOB 'cnd_*'),
  organization_id TEXT NOT NULL REFERENCES organization_control_plane_metadata(organization_id),
  authority_id TEXT NOT NULL REFERENCES organization_control_plane_metadata(authority_id),
  assignment_version INTEGER NOT NULL CHECK (assignment_version = 1),
  pending_json TEXT NOT NULL UNIQUE CHECK (
    json_valid(pending_json) AND json_type(pending_json) = 'object'
  ),
  pending_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(pending_sha256) = 71 AND substr(pending_sha256, 1, 7) = 'sha256:' AND
    substr(pending_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  stage_command_id TEXT NOT NULL UNIQUE CHECK (stage_command_id GLOB 'pas_*'),
  stage_command_semantic_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(stage_command_semantic_sha256) = 71 AND
    substr(stage_command_semantic_sha256, 1, 7) = 'sha256:' AND
    substr(stage_command_semantic_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  connection_id TEXT NOT NULL REFERENCES organization_tool_connection_contracts(connection_id),
  connection_contract_sha256 TEXT NOT NULL REFERENCES organization_tool_connection_contracts(contract_sha256),
  connection_state_sha256 TEXT NOT NULL REFERENCES organization_tool_connection_current_state(state_sha256),
  approval_binding_id TEXT NOT NULL REFERENCES organization_private_approval_surface_binding_contracts_v2(approval_binding_id),
  approval_binding_contract_sha256 TEXT NOT NULL REFERENCES organization_private_approval_surface_binding_contracts_v2(contract_sha256),
  external_identity_link_id TEXT NOT NULL,
  external_identity_link_contract_sha256 TEXT NOT NULL REFERENCES organization_external_human_link_contracts(contract_sha256),
  assignee_principal_id TEXT NOT NULL CHECK (assignee_principal_id GLOB 'prn_*'),
  assignee_membership_id TEXT NOT NULL CHECK (assignee_membership_id GLOB 'mem_*'),
  slack_workspace_id TEXT NOT NULL CHECK (length(trim(slack_workspace_id)) > 0),
  slack_enterprise_id TEXT CHECK (slack_enterprise_id IS NULL OR length(trim(slack_enterprise_id)) > 0),
  slack_subject_id TEXT NOT NULL CHECK (length(trim(slack_subject_id)) > 0),
  canonical_record_policy_id TEXT CHECK (canonical_record_policy_id IS NULL),
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
  SELECT 1 FROM organization_private_approval_surface_binding_current_v2
   WHERE approval_binding_id = NEW.approval_binding_id
     AND contract_sha256 = NEW.approval_binding_contract_sha256
     AND connection_state_sha256 = NEW.connection_state_sha256
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

CREATE TABLE organization_private_approval_card_bindings_v2 (
  approval_id TEXT PRIMARY KEY REFERENCES organization_private_approval_pending_contracts_v2(approval_id),
  assignment_version INTEGER NOT NULL CHECK (assignment_version = 1),
  binding_json TEXT NOT NULL UNIQUE CHECK (json_valid(binding_json) AND json_type(binding_json) = 'object'),
  binding_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(binding_sha256) = 71 AND substr(binding_sha256, 1, 7) = 'sha256:' AND
    substr(binding_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  connection_id TEXT NOT NULL REFERENCES organization_tool_connection_contracts(connection_id),
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

CREATE TRIGGER organization_private_approval_card_bindings_v2_exact_pending
BEFORE INSERT ON organization_private_approval_card_bindings_v2
WHEN NOT EXISTS (
  SELECT 1 FROM organization_private_approval_pending_contracts_v2
   WHERE approval_id = NEW.approval_id
     AND assignment_version = NEW.assignment_version
     AND connection_id = NEW.connection_id
     AND slack_workspace_id = NEW.slack_workspace_id
     AND slack_enterprise_id IS NEW.slack_enterprise_id
     AND slack_subject_id = NEW.slack_subject_id
)
BEGIN SELECT RAISE(ABORT, 'private approval card binding does not match pending contract'); END;

CREATE TRIGGER organization_private_approval_card_bindings_v2_immutable_update
BEFORE UPDATE ON organization_private_approval_card_bindings_v2
BEGIN SELECT RAISE(ABORT, 'private approval card binding is immutable'); END;

CREATE TRIGGER organization_private_approval_card_bindings_v2_delete_denied
BEFORE DELETE ON organization_private_approval_card_bindings_v2
BEGIN SELECT RAISE(ABORT, 'private approval card binding cannot be deleted'); END;

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
  assignment_version INTEGER NOT NULL CHECK (assignment_version = 1),
  action_id TEXT NOT NULL CHECK (length(trim(action_id)) > 0),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('approve', 'reject', 'delegate')),
  received_at TEXT NOT NULL CHECK (unixepoch(received_at) IS NOT NULL),
  verified_at TEXT NOT NULL CHECK (unixepoch(verified_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_private_approval_signed_action_receipts_v2_exact_card
BEFORE INSERT ON organization_private_approval_signed_action_receipts_v2
WHEN NOT EXISTS (
  SELECT 1 FROM organization_private_approval_card_bindings_v2
   WHERE approval_id = NEW.approval_id
     AND assignment_version = NEW.assignment_version
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
  resolution_command_id TEXT NOT NULL UNIQUE CHECK (resolution_command_id GLOB 'prc_*'),
  resolution_command_semantic_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(resolution_command_semantic_sha256) = 71 AND
    substr(resolution_command_semantic_sha256, 1, 7) = 'sha256:' AND
    substr(resolution_command_semantic_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  resolution_json TEXT NOT NULL UNIQUE CHECK (json_valid(resolution_json) AND json_type(resolution_json) = 'object'),
  resolution_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(resolution_sha256) = 71 AND substr(resolution_sha256, 1, 7) = 'sha256:' AND
    substr(resolution_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  signed_action_receipt_sha256 TEXT NOT NULL UNIQUE
    REFERENCES organization_private_approval_signed_action_receipts_v2(normalized_receipt_sha256),
  authorization_allow_json TEXT NOT NULL UNIQUE CHECK (json_valid(authorization_allow_json) AND json_type(authorization_allow_json) = 'object'),
  authorization_allow_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(authorization_allow_sha256) = 71 AND
    substr(authorization_allow_sha256, 1, 7) = 'sha256:' AND
    substr(authorization_allow_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
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
