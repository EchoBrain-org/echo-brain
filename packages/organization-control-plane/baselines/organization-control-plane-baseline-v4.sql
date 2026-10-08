-- Control plane baseline V4: the V3 schema without the private Slack approval
-- tables. Frozen once released. Fresh initialization only; no migration
-- reaches it, and existing state is reset rather than upgraded.

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
