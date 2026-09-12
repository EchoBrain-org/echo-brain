-- Control plane baseline V3: active schema after retired-storage cleanup.
-- Frozen once released. Fresh initialization only; existing state uses the
-- explicit offline schema-cleanup transition, never this file as an upgrade.

CREATE TABLE organization_control_plane_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  control_plane_id TEXT NOT NULL UNIQUE CHECK (control_plane_id GLOB 'ocp_*'),
  organization_id TEXT NOT NULL UNIQUE CHECK (organization_id GLOB 'org_*'),
  authority_id TEXT NOT NULL UNIQUE CHECK (authority_id GLOB 'oau_*'),
  authority_descriptor_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(authority_descriptor_sha256) = 71 AND
    substr(authority_descriptor_sha256, 1, 7) = 'sha256:' AND
    substr(authority_descriptor_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TABLE organization_tool_connection_contracts (
  connection_id TEXT PRIMARY KEY CHECK (connection_id GLOB 'con_*'),
  contract_json TEXT NOT NULL CHECK (
    json_valid(contract_json) AND json_type(contract_json) = 'object'
  ),
  contract_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(contract_sha256) = 71 AND substr(contract_sha256, 1, 7) = 'sha256:'
  ),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TABLE organization_tool_connection_current_state (
  connection_id TEXT PRIMARY KEY
    REFERENCES organization_tool_connection_contracts(connection_id),
  connection_contract_sha256 TEXT NOT NULL
    REFERENCES organization_tool_connection_contracts(contract_sha256),
  state_json TEXT NOT NULL CHECK (
    json_valid(state_json) AND json_type(state_json) = 'object'
  ),
  state_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(state_sha256) = 71 AND substr(state_sha256, 1, 7) = 'sha256:'
  ),
  current_status TEXT NOT NULL CHECK (current_status IN ('active', 'revoked')),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL)
) STRICT;

CREATE TABLE organization_external_human_link_contracts (
  external_identity_link_id TEXT NOT NULL CHECK (external_identity_link_id GLOB 'clm_*'),
  contract_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(contract_sha256) = 71 AND substr(contract_sha256, 1, 7) = 'sha256:'
  ),
  contract_json TEXT NOT NULL CHECK (
    json_valid(contract_json) AND json_type(contract_json) = 'object'
  ),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  PRIMARY KEY (external_identity_link_id, contract_sha256)
) STRICT;

CREATE TABLE organization_external_human_link_current (
  external_identity_link_id TEXT PRIMARY KEY,
  contract_sha256 TEXT NOT NULL UNIQUE,
  provider_issuer TEXT NOT NULL,
  provider_tenant_kind TEXT NOT NULL CHECK (provider_tenant_kind = 'workspace'),
  provider_tenant_id TEXT NOT NULL,
  provider_enterprise_id TEXT CHECK (
    provider_enterprise_id IS NULL OR length(trim(provider_enterprise_id)) > 0
  ),
  provider_subject_id TEXT NOT NULL,
  principal_id TEXT NOT NULL CHECK (principal_id GLOB 'prn_*'),
  membership_id TEXT NOT NULL CHECK (membership_id GLOB 'mem_*'),
  current_status TEXT NOT NULL CHECK (current_status IN ('active', 'revoked')),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  FOREIGN KEY (external_identity_link_id, contract_sha256)
    REFERENCES organization_external_human_link_contracts(
      external_identity_link_id, contract_sha256
    )
) STRICT;

CREATE TABLE organization_person_slack_link_challenges (
  -- #166: exact private delivery coordinates, never a public-channel fallback.
  dm_channel_id TEXT CHECK (dm_channel_id IS NULL OR (dm_channel_id GLOB 'D*' AND length(dm_channel_id) BETWEEN 3 AND 128)),
  recipient_user_id TEXT CHECK (recipient_user_id IS NULL OR (substr(recipient_user_id, 1, 1) IN ('U', 'W') AND length(recipient_user_id) BETWEEN 3 AND 128)),
  challenge_attempt_id TEXT PRIMARY KEY CHECK (challenge_attempt_id GLOB 'cat_*'),
  connection_id TEXT NOT NULL
    REFERENCES organization_tool_connection_contracts(connection_id),
  principal_id TEXT NOT NULL CHECK (principal_id GLOB 'prn_*'),
  membership_id TEXT NOT NULL CHECK (membership_id GLOB 'mem_*'),
  challenge_code_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(challenge_code_sha256) = 71 AND substr(challenge_code_sha256, 1, 7) = 'sha256:'
  ),
  person_session_sha256 TEXT NOT NULL CHECK (
    length(person_session_sha256) = 71 AND substr(person_session_sha256, 1, 7) = 'sha256:'
  ),
  organization_tool_sha256 TEXT NOT NULL CHECK (
    length(organization_tool_sha256) = 71 AND substr(organization_tool_sha256, 1, 7) = 'sha256:'
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired')),
  completion_sha256 TEXT UNIQUE CHECK (
    completion_sha256 IS NULL OR (
      length(completion_sha256) = 71 AND substr(completion_sha256, 1, 7) = 'sha256:'
    )
  ),
  challenge_message_ts TEXT,
  reply_message_ts TEXT,
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (unixepoch(expires_at) IS NOT NULL),
  completed_at TEXT,
  CHECK (unixepoch(expires_at) > unixepoch(created_at)),
  CHECK (
    (status = 'pending' AND completion_sha256 IS NULL AND completed_at IS NULL) OR
    (status = 'expired' AND completion_sha256 IS NULL AND completed_at IS NOT NULL) OR
    (status = 'completed' AND completion_sha256 IS NOT NULL AND completed_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE organization_person_slack_link_commands (
  command_id TEXT PRIMARY KEY CHECK (
    command_id GLOB 'psb_*' OR command_id GLOB 'psc_*'
  ),
  command_kind TEXT NOT NULL CHECK (command_kind IN ('begin', 'completion')),
  command_semantic_sha256 TEXT NOT NULL CHECK (
    length(command_semantic_sha256) = 71 AND
    substr(command_semantic_sha256, 1, 7) = 'sha256:'
  ),
  challenge_attempt_id TEXT NOT NULL
    REFERENCES organization_person_slack_link_challenges(challenge_attempt_id),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

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

CREATE UNIQUE INDEX organization_tool_connection_one_active
ON organization_tool_connection_current_state(current_status)
WHERE current_status = 'active';

CREATE UNIQUE INDEX organization_external_human_link_one_active_subject
ON organization_external_human_link_current(
  provider_issuer, provider_tenant_kind, provider_tenant_id,
  COALESCE(provider_enterprise_id, ''), provider_subject_id
) WHERE current_status = 'active';

CREATE UNIQUE INDEX organization_external_human_link_one_active_membership
ON organization_external_human_link_current(
  membership_id, provider_issuer, provider_tenant_kind, provider_tenant_id,
  COALESCE(provider_enterprise_id, '')
) WHERE current_status = 'active';

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

CREATE TRIGGER organization_tool_connection_contracts_immutable_update
BEFORE UPDATE ON organization_tool_connection_contracts
BEGIN SELECT RAISE(ABORT, 'tool connection contract is immutable'); END;

CREATE TRIGGER organization_tool_connection_contracts_immutable_delete
BEFORE DELETE ON organization_tool_connection_contracts
BEGIN SELECT RAISE(ABORT, 'tool connection contract cannot be deleted'); END;

CREATE TRIGGER organization_tool_connection_current_state_exact_contract
BEFORE INSERT ON organization_tool_connection_current_state
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM organization_tool_connection_contracts
    WHERE connection_id = NEW.connection_id
      AND contract_sha256 = NEW.connection_contract_sha256
  ) THEN RAISE(ABORT, 'tool connection current state does not match its contract') END;
END;

CREATE TRIGGER organization_tool_connection_current_state_exact_contract_update
BEFORE UPDATE OF connection_id, connection_contract_sha256
ON organization_tool_connection_current_state
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM organization_tool_connection_contracts
    WHERE connection_id = NEW.connection_id
      AND contract_sha256 = NEW.connection_contract_sha256
  ) THEN RAISE(ABORT, 'tool connection current state does not match its contract') END;
END;

CREATE TRIGGER organization_external_human_link_contracts_immutable_update
BEFORE UPDATE ON organization_external_human_link_contracts
BEGIN SELECT RAISE(ABORT, 'external human link contract is immutable'); END;

CREATE TRIGGER organization_external_human_link_contracts_immutable_delete
BEFORE DELETE ON organization_external_human_link_contracts
BEGIN SELECT RAISE(ABORT, 'external human link contract cannot be deleted'); END;

CREATE TRIGGER organization_person_slack_link_challenges_terminal_update
BEFORE UPDATE ON organization_person_slack_link_challenges
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'pending' AND
    NEW.dm_channel_id IS OLD.dm_channel_id AND
    NEW.recipient_user_id IS OLD.recipient_user_id AND
    NEW.challenge_attempt_id = OLD.challenge_attempt_id AND
    NEW.connection_id = OLD.connection_id AND
    NEW.principal_id = OLD.principal_id AND
    NEW.membership_id = OLD.membership_id AND
    NEW.challenge_code_sha256 = OLD.challenge_code_sha256 AND
    NEW.person_session_sha256 = OLD.person_session_sha256 AND
    NEW.organization_tool_sha256 = OLD.organization_tool_sha256 AND
    NEW.created_at = OLD.created_at AND
    NEW.expires_at = OLD.expires_at AND
    (
      (NEW.status = 'pending' AND NEW.completion_sha256 IS NULL AND
       NEW.reply_message_ts IS NULL AND NEW.completed_at IS NULL) OR
      (NEW.status = 'expired' AND NEW.completion_sha256 IS NULL AND
       NEW.reply_message_ts IS NULL AND NEW.completed_at IS NOT NULL) OR
      (NEW.status = 'completed' AND NEW.completion_sha256 IS NOT NULL AND
       NEW.challenge_message_ts IS NOT NULL AND NEW.reply_message_ts IS NOT NULL AND
       NEW.completed_at IS NOT NULL)
    )
  ) THEN RAISE(ABORT, 'Person Slack link challenge transition is invalid') END;
END;

CREATE TRIGGER organization_person_slack_link_challenges_immutable_delete
BEFORE DELETE ON organization_person_slack_link_challenges
BEGIN SELECT RAISE(ABORT, 'Person Slack link challenge cannot be deleted'); END;

CREATE TRIGGER organization_person_slack_link_commands_immutable_update
BEFORE UPDATE ON organization_person_slack_link_commands
BEGIN SELECT RAISE(ABORT, 'Person Slack link command is immutable'); END;

CREATE TRIGGER organization_person_slack_link_commands_immutable_delete
BEFORE DELETE ON organization_person_slack_link_commands
BEGIN SELECT RAISE(ABORT, 'Person Slack link command cannot be deleted'); END;

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
