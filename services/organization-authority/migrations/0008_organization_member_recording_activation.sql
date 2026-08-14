-- One-way, stopped activation of organization-member-readable recording.
--
-- The immutable initialization manifest remains the baseline intent. This
-- singleton records the only additive policy activation currently supported;
-- it is Authority state (not integration/provider state) and is committed in
-- the same transaction as its generic Authority audit receipt.

CREATE TABLE authority_organization_member_recording_activation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  command_id TEXT NOT NULL UNIQUE CHECK (
    command_id GLOB 'rpa_????????-????-4???-[89ab]???-????????????'
  ),
  command_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(command_sha256) = 71 AND
    substr(command_sha256, 1, 7) = 'sha256:' AND
    substr(command_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  command_json TEXT NOT NULL UNIQUE CHECK (
    json_valid(command_json) AND json_type(command_json) = 'object'
  ),
  authority_id TEXT NOT NULL REFERENCES authority_metadata(authority_id),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  initialized_runtime_config_sha256 TEXT NOT NULL CHECK (
    length(initialized_runtime_config_sha256) = 71 AND
    substr(initialized_runtime_config_sha256, 1, 7) = 'sha256:' AND
    substr(initialized_runtime_config_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  initialization_manifest_sha256 TEXT NOT NULL CHECK (
    length(initialization_manifest_sha256) = 71 AND
    substr(initialization_manifest_sha256, 1, 7) = 'sha256:' AND
    substr(initialization_manifest_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  owner_principal_id TEXT NOT NULL CHECK (owner_principal_id GLOB 'prn_*'),
  owner_membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  decision_processor_adapter_instance_id TEXT NOT NULL CHECK (
    length(decision_processor_adapter_instance_id) BETWEEN 1 AND 128
  ),
  approval_surface_adapter_instance_id TEXT NOT NULL CHECK (
    length(approval_surface_adapter_instance_id) BETWEEN 1 AND 128
  ),
  policy_contract_sha256 TEXT NOT NULL CHECK (
    length(policy_contract_sha256) = 71 AND
    substr(policy_contract_sha256, 1, 7) = 'sha256:' AND
    substr(policy_contract_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  activated_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', activated_at) IS NOT NULL AND
    activated_at = strftime('%Y-%m-%dT%H:%M:%fZ', activated_at)
  ),
  activation_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(activation_sha256) = 71 AND
    substr(activation_sha256, 1, 7) = 'sha256:' AND
    substr(activation_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  audit_sequence INTEGER NOT NULL UNIQUE REFERENCES authority_audit_log(audit_sequence)
) STRICT;

CREATE TRIGGER authority_organization_member_recording_activation_immutable_update
BEFORE UPDATE ON authority_organization_member_recording_activation
BEGIN
  SELECT RAISE(ABORT, 'organization-member recording activation is immutable');
END;

CREATE TRIGGER authority_organization_member_recording_activation_delete_denied
BEFORE DELETE ON authority_organization_member_recording_activation
BEGIN
  SELECT RAISE(ABORT, 'organization-member recording activation cannot be deleted');
END;

CREATE TRIGGER authority_audit_log_recording_activation_immutable_update
BEFORE UPDATE ON authority_audit_log
WHEN OLD.action = 'configuration.organization_member_recording_activated'
  OR NEW.action = 'configuration.organization_member_recording_activated'
BEGIN
  SELECT RAISE(ABORT, 'organization-member recording activation audit is immutable');
END;

CREATE TRIGGER authority_audit_log_recording_activation_delete_denied
BEFORE DELETE ON authority_audit_log
WHEN OLD.action = 'configuration.organization_member_recording_activated'
BEGIN
  SELECT RAISE(ABORT, 'organization-member recording activation audit cannot be deleted');
END;
