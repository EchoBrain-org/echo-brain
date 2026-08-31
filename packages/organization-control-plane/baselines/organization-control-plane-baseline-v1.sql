-- New-lineage baseline v1 for the organization control-plane database role.
--
-- This is a fresh D2 persistence model. It stores each frozen canonical body
-- with its independently recomputed digest, keeps mutable currentness apart
-- from historical proof, and contains no legacy schema ledger.

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

-- The stable Slack tool identity never changes. Credential and verification
-- state is intentionally held in its own current-state table below.
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

CREATE TRIGGER organization_tool_connection_contracts_immutable_update
BEFORE UPDATE ON organization_tool_connection_contracts
BEGIN SELECT RAISE(ABORT, 'tool connection contract is immutable'); END;

CREATE TRIGGER organization_tool_connection_contracts_immutable_delete
BEFORE DELETE ON organization_tool_connection_contracts
BEGIN SELECT RAISE(ABORT, 'tool connection contract cannot be deleted'); END;

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

CREATE UNIQUE INDEX organization_tool_connection_one_active
ON organization_tool_connection_current_state(current_status)
WHERE current_status = 'active';

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

-- A link body is versioned so re-verification never overwrites the body that
-- an already committed provider action must rehash.
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

CREATE TRIGGER organization_external_human_link_contracts_immutable_update
BEFORE UPDATE ON organization_external_human_link_contracts
BEGIN SELECT RAISE(ABORT, 'external human link contract is immutable'); END;

CREATE TRIGGER organization_external_human_link_contracts_immutable_delete
BEFORE DELETE ON organization_external_human_link_contracts
BEGIN SELECT RAISE(ABORT, 'external human link contract cannot be deleted'); END;

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

CREATE TABLE organization_approval_binding_contracts (
  approval_binding_id TEXT PRIMARY KEY CHECK (approval_binding_id GLOB 'bnd_*'),
  contract_json TEXT NOT NULL CHECK (
    json_valid(contract_json) AND json_type(contract_json) = 'object'
  ),
  contract_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(contract_sha256) = 71 AND substr(contract_sha256, 1, 7) = 'sha256:'
  ),
  connection_id TEXT NOT NULL
    REFERENCES organization_tool_connection_contracts(connection_id),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_approval_binding_contracts_immutable_update
BEFORE UPDATE ON organization_approval_binding_contracts
BEGIN SELECT RAISE(ABORT, 'approval binding contract is immutable'); END;

CREATE TRIGGER organization_approval_binding_contracts_immutable_delete
BEFORE DELETE ON organization_approval_binding_contracts
BEGIN SELECT RAISE(ABORT, 'approval binding contract cannot be deleted'); END;

CREATE TABLE organization_approval_binding_current (
  approval_binding_id TEXT PRIMARY KEY
    REFERENCES organization_approval_binding_contracts(approval_binding_id),
  contract_sha256 TEXT NOT NULL UNIQUE
    REFERENCES organization_approval_binding_contracts(contract_sha256),
  current_status TEXT NOT NULL CHECK (current_status IN ('active', 'revoked')),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_approval_binding_current_exact_contract
BEFORE INSERT ON organization_approval_binding_current
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM organization_approval_binding_contracts
    WHERE approval_binding_id = NEW.approval_binding_id
      AND contract_sha256 = NEW.contract_sha256
  ) THEN RAISE(ABORT, 'approval binding current state does not match its contract') END;
END;

CREATE TRIGGER organization_approval_binding_current_exact_contract_update
BEFORE UPDATE OF approval_binding_id, contract_sha256
ON organization_approval_binding_current
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM organization_approval_binding_contracts
    WHERE approval_binding_id = NEW.approval_binding_id
      AND contract_sha256 = NEW.contract_sha256
  ) THEN RAISE(ABORT, 'approval binding current state does not match its contract') END;
END;

CREATE TABLE organization_approval_action_capability_contracts (
  action_capability_id TEXT PRIMARY KEY CHECK (action_capability_id GLOB 'cap_*'),
  contract_json TEXT NOT NULL CHECK (
    json_valid(contract_json) AND json_type(contract_json) = 'object'
  ),
  contract_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(contract_sha256) = 71 AND substr(contract_sha256, 1, 7) = 'sha256:'
  ),
  approval_binding_id TEXT NOT NULL
    REFERENCES organization_approval_binding_contracts(approval_binding_id),
  external_identity_link_id TEXT NOT NULL,
  policy_id TEXT NOT NULL CHECK (policy_id IN (
    'organization-member-readable-person-v2',
    'restricted-reviewer-person-v2'
  )),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject')),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_approval_action_capability_contracts_immutable_update
BEFORE UPDATE ON organization_approval_action_capability_contracts
BEGIN SELECT RAISE(ABORT, 'approval capability contract is immutable'); END;

CREATE TRIGGER organization_approval_action_capability_contracts_immutable_delete
BEFORE DELETE ON organization_approval_action_capability_contracts
BEGIN SELECT RAISE(ABORT, 'approval capability contract cannot be deleted'); END;

CREATE UNIQUE INDEX organization_approval_action_capability_exact_edge
ON organization_approval_action_capability_contracts(
  approval_binding_id, external_identity_link_id, policy_id, action
);

CREATE TABLE organization_approval_action_capability_current (
  action_capability_id TEXT PRIMARY KEY
    REFERENCES organization_approval_action_capability_contracts(action_capability_id),
  contract_sha256 TEXT NOT NULL UNIQUE
    REFERENCES organization_approval_action_capability_contracts(contract_sha256),
  current_status TEXT NOT NULL CHECK (current_status IN ('active', 'revoked')),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_approval_action_capability_current_exact_contract
BEFORE INSERT ON organization_approval_action_capability_current
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM organization_approval_action_capability_contracts
    WHERE action_capability_id = NEW.action_capability_id
      AND contract_sha256 = NEW.contract_sha256
  ) THEN RAISE(ABORT, 'approval capability current state does not match its contract') END;
END;

CREATE TRIGGER organization_approval_action_capability_current_exact_contract_update
BEFORE UPDATE OF action_capability_id, contract_sha256
ON organization_approval_action_capability_current
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM organization_approval_action_capability_contracts
    WHERE action_capability_id = NEW.action_capability_id
      AND contract_sha256 = NEW.contract_sha256
  ) THEN RAISE(ABORT, 'approval capability current state does not match its contract') END;
END;

-- The challenge stores only server-derived hashes and coordinates. It never
-- stores the one-time code, a session credential, or provider token bytes.
CREATE TABLE organization_person_slack_link_challenges (
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

CREATE TRIGGER organization_person_slack_link_challenges_terminal_update
BEFORE UPDATE ON organization_person_slack_link_challenges
BEGIN
  SELECT CASE WHEN NOT (
    OLD.status = 'pending' AND
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

-- Request IDs are an immutable, minimal replay fence. The challenge and its
-- immutable link contract remain the source of the returned begin/result body.
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

CREATE TRIGGER organization_person_slack_link_commands_immutable_update
BEFORE UPDATE ON organization_person_slack_link_commands
BEGIN SELECT RAISE(ABORT, 'Person Slack link command is immutable'); END;

CREATE TRIGGER organization_person_slack_link_commands_immutable_delete
BEFORE DELETE ON organization_person_slack_link_commands
BEGIN SELECT RAISE(ABORT, 'Person Slack link command cannot be deleted'); END;

CREATE TABLE organization_approval_activation_resources (
  resource_sha256 TEXT PRIMARY KEY CHECK (
    length(resource_sha256) = 71 AND substr(resource_sha256, 1, 7) = 'sha256:'
  ),
  approval_binding_id TEXT NOT NULL
    REFERENCES organization_approval_binding_contracts(approval_binding_id),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND json_type(result_json) = 'object'
  ),
  result_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(result_sha256) = 71 AND substr(result_sha256, 1, 7) = 'sha256:'
  ),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_approval_activation_resources_immutable_update
BEFORE UPDATE ON organization_approval_activation_resources
BEGIN SELECT RAISE(ABORT, 'approval activation resource is immutable'); END;

CREATE TRIGGER organization_approval_activation_resources_immutable_delete
BEFORE DELETE ON organization_approval_activation_resources
BEGIN SELECT RAISE(ABORT, 'approval activation resource cannot be deleted'); END;

CREATE TABLE organization_approval_activation_commands (
  command_id TEXT PRIMARY KEY,
  command_semantic_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(command_semantic_sha256) = 71 AND substr(command_semantic_sha256, 1, 7) = 'sha256:'
  ),
  resource_sha256 TEXT NOT NULL
    REFERENCES organization_approval_activation_resources(resource_sha256),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_approval_activation_commands_immutable_update
BEFORE UPDATE ON organization_approval_activation_commands
BEGIN SELECT RAISE(ABORT, 'approval activation command is immutable'); END;

CREATE TRIGGER organization_approval_activation_commands_immutable_delete
BEFORE DELETE ON organization_approval_activation_commands
BEGIN SELECT RAISE(ABORT, 'approval activation command cannot be deleted'); END;

-- A source admission freezes one pending Person approval before Slack is
-- observed.  Its source payload remains outside this role; this table keeps
-- only the compact commitment set required to reprove the human action.
CREATE TABLE organization_person_slack_pending_approvals (
  approval_id TEXT PRIMARY KEY CHECK (approval_id GLOB 'apr_*'),
  approval_json TEXT NOT NULL CHECK (
    json_valid(approval_json) AND json_type(approval_json) = 'object'
  ),
  approval_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(approval_sha256) = 71 AND substr(approval_sha256, 1, 7) = 'sha256:'
  ),
  connection_id TEXT NOT NULL
    REFERENCES organization_tool_connection_contracts(connection_id),
  approval_binding_id TEXT NOT NULL
    REFERENCES organization_approval_binding_contracts(approval_binding_id),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_person_slack_pending_approvals_immutable_update
BEFORE UPDATE ON organization_person_slack_pending_approvals
BEGIN SELECT RAISE(ABORT, 'pending Person Slack approval is immutable'); END;

CREATE TRIGGER organization_person_slack_pending_approvals_immutable_delete
BEFORE DELETE ON organization_person_slack_pending_approvals
BEGIN SELECT RAISE(ABORT, 'pending Person Slack approval cannot be deleted'); END;

-- Commands fence source retries without restoring any retired runtime path.
CREATE TABLE organization_person_slack_pending_approval_commands (
  command_id TEXT PRIMARY KEY CHECK (command_id GLOB 'pas_*'),
  command_semantic_sha256 TEXT NOT NULL CHECK (
    length(command_semantic_sha256) = 71 AND
    substr(command_semantic_sha256, 1, 7) = 'sha256:'
  ),
  approval_id TEXT NOT NULL
    REFERENCES organization_person_slack_pending_approvals(approval_id),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER organization_person_slack_pending_approval_commands_immutable_update
BEFORE UPDATE ON organization_person_slack_pending_approval_commands
BEGIN SELECT RAISE(ABORT, 'pending Person Slack approval command is immutable'); END;

CREATE TRIGGER organization_person_slack_pending_approval_commands_immutable_delete
BEFORE DELETE ON organization_person_slack_pending_approval_commands
BEGIN SELECT RAISE(ABORT, 'pending Person Slack approval command cannot be deleted'); END;

-- One row is the complete restart-reproof package for one durable human act.
CREATE TABLE organization_provider_human_action_evidence (
  approval_id TEXT PRIMARY KEY,
  connection_contract_json TEXT NOT NULL CHECK (json_valid(connection_contract_json) AND json_type(connection_contract_json) = 'object'),
  connection_contract_sha256 TEXT NOT NULL,
  connection_state_json TEXT NOT NULL CHECK (json_valid(connection_state_json) AND json_type(connection_state_json) = 'object'),
  connection_state_sha256 TEXT NOT NULL,
  external_human_link_contract_json TEXT NOT NULL CHECK (json_valid(external_human_link_contract_json) AND json_type(external_human_link_contract_json) = 'object'),
  external_human_link_contract_sha256 TEXT NOT NULL,
  approval_binding_contract_json TEXT NOT NULL CHECK (json_valid(approval_binding_contract_json) AND json_type(approval_binding_contract_json) = 'object'),
  approval_binding_contract_sha256 TEXT NOT NULL,
  action_capability_contract_json TEXT NOT NULL CHECK (json_valid(action_capability_contract_json) AND json_type(action_capability_contract_json) = 'object'),
  action_capability_contract_sha256 TEXT NOT NULL,
  provider_observation_json TEXT NOT NULL CHECK (json_valid(provider_observation_json) AND json_type(provider_observation_json) = 'object'),
  provider_observation_sha256 TEXT NOT NULL,
  provider_message_json TEXT NOT NULL CHECK (json_valid(provider_message_json) AND json_type(provider_message_json) = 'object'),
  provider_message_sha256 TEXT NOT NULL,
  provider_action_json TEXT NOT NULL CHECK (json_valid(provider_action_json) AND json_type(provider_action_json) = 'object'),
  provider_action_sha256 TEXT NOT NULL UNIQUE,
  authorization_allow_json TEXT NOT NULL CHECK (json_valid(authorization_allow_json) AND json_type(authorization_allow_json) = 'object'),
  authorization_proof_sha256 TEXT NOT NULL,
  semantic_action_json TEXT NOT NULL CHECK (json_valid(semantic_action_json) AND json_type(semantic_action_json) = 'object'),
  semantic_action_sha256 TEXT NOT NULL UNIQUE,
  durable_result_json TEXT NOT NULL CHECK (json_valid(durable_result_json) AND json_type(durable_result_json) = 'object'),
  durable_result_sha256 TEXT NOT NULL UNIQUE,
  audit_event_id TEXT NOT NULL UNIQUE CHECK (audit_event_id GLOB 'aud_*'),
  audit_sequence INTEGER NOT NULL UNIQUE CHECK (audit_sequence > 0),
  audit_entry_json TEXT NOT NULL CHECK (json_valid(audit_entry_json) AND json_type(audit_entry_json) = 'object'),
  audit_entry_sha256 TEXT NOT NULL UNIQUE,
  predecessor_entry_sha256 TEXT,
  committed_at TEXT NOT NULL CHECK (unixepoch(committed_at) IS NOT NULL),
  CHECK ((audit_sequence = 1 AND predecessor_entry_sha256 IS NULL) OR
         (audit_sequence > 1 AND predecessor_entry_sha256 IS NOT NULL))
) STRICT;

CREATE TRIGGER organization_provider_human_action_evidence_contiguous
BEFORE INSERT ON organization_provider_human_action_evidence
BEGIN
  SELECT CASE WHEN NEW.audit_sequence != COALESCE(
    (SELECT MAX(audit_sequence) + 1 FROM organization_provider_human_action_evidence),
    1
  ) THEN RAISE(ABORT, 'organization audit sequence must be contiguous') END;
  SELECT CASE WHEN NEW.audit_sequence > 1 AND NEW.predecessor_entry_sha256 != (
    SELECT audit_entry_sha256 FROM organization_provider_human_action_evidence
    ORDER BY audit_sequence DESC LIMIT 1
  ) THEN RAISE(ABORT, 'organization audit predecessor is invalid') END;
END;

CREATE TRIGGER organization_provider_human_action_evidence_immutable_update
BEFORE UPDATE ON organization_provider_human_action_evidence
BEGIN SELECT RAISE(ABORT, 'provider human action evidence is append-only'); END;

CREATE TRIGGER organization_provider_human_action_evidence_immutable_delete
BEFORE DELETE ON organization_provider_human_action_evidence
BEGIN SELECT RAISE(ABORT, 'provider human action evidence cannot be deleted'); END;
