-- A Slack auth.test response can omit app_id even though the installation is
-- otherwise ready. Permit the existing onboarding command to fill that one
-- identity field after a later provider re-verification. The repository writes
-- the audit record first, then updates the connection once. That guarded
-- connection statement cascades every exact active Slack reaction binding;
-- any invalid binding or audit mapping aborts the whole statement.

-- Existing null-app rows are migration input, not a shape that v5 may create.
CREATE TRIGGER organization_tool_connections_slack_app_identity_required_insert
BEFORE INSERT ON organization_tool_connections
WHEN
  NEW.status = 'active' AND
  NEW.provider = 'slack' AND
  NEW.provider_issuer = 'https://slack.com' AND
  NEW.owner_kind = 'organization' AND
  json_type(NEW.public_configuration_json, '$.slack_app_id') IS NOT 'text'
BEGIN
  SELECT RAISE(
    ABORT,
    'active Slack organization connection configuration is incomplete'
  );
END;

CREATE TRIGGER organization_adapter_bindings_slack_app_identity_required_insert
BEFORE INSERT ON organization_adapter_bindings
WHEN
  NEW.status = 'active' AND
  NEW.product_namespace = 'echo-brain' AND
  NEW.adapter_kind = 'approval-surface' AND
  NEW.adapter_id = 'slack-reactions'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM organization_tool_connections AS connection
    WHERE connection.connection_id = NEW.connection_id
      AND connection.organization_id = NEW.organization_id
      AND connection.status = 'active'
  ) THEN RAISE(
    ABORT,
    'adapter binding requires an active organization connection'
  ) END;
  SELECT CASE WHEN COALESCE((
    json_type(NEW.public_configuration_json, '$.slack_app_id') = 'text' AND
    length(json_extract(NEW.public_configuration_json, '$.slack_app_id')) >= 3 AND
    substr(json_extract(NEW.public_configuration_json, '$.slack_app_id'), 1, 1) = 'A' AND
    substr(json_extract(NEW.public_configuration_json, '$.slack_app_id'), 2)
      NOT GLOB '*[^A-Z0-9]*' AND
    EXISTS (
      SELECT 1
      FROM organization_tool_connections AS connection
      WHERE connection.connection_id = NEW.connection_id
        AND connection.organization_id = NEW.organization_id
        AND connection.status = 'active'
        AND connection.provider = 'slack'
        AND connection.provider_issuer = 'https://slack.com'
        AND connection.owner_kind = 'organization'
        AND json_extract(connection.public_configuration_json, '$.slack_app_id') =
          json_extract(NEW.public_configuration_json, '$.slack_app_id')
    )
  ), 0) != 1 THEN RAISE(
    ABORT,
    'new Slack reaction bindings require the verified connection app identity'
  ) END;
END;

DROP TRIGGER organization_adapter_bindings_revoke_only;

CREATE TRIGGER organization_adapter_bindings_revoke_only
BEFORE UPDATE ON organization_adapter_bindings
BEGIN
  SELECT CASE WHEN COALESCE((
    (
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
    ) OR (
      OLD.status = 'active' AND
      NEW.status = 'active' AND
      OLD.revoked_at IS NULL AND
      NEW.revoked_at IS NULL AND
      OLD.revocation_reason IS NULL AND
      NEW.revocation_reason IS NULL AND
      OLD.product_namespace = 'echo-brain' AND
      OLD.adapter_kind = 'approval-surface' AND
      OLD.adapter_id = 'slack-reactions' AND
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
      NEW.created_by_principal_id = OLD.created_by_principal_id AND
      NEW.created_by_membership_id = OLD.created_by_membership_id AND
      NEW.bound_at = OLD.bound_at AND
      NEW.public_configuration_sha256 != OLD.public_configuration_sha256 AND
      json_type(OLD.public_configuration_json) = 'object' AND
      json_type(NEW.public_configuration_json) = 'object' AND
      (
        (
          (SELECT COUNT(*) FROM json_each(OLD.public_configuration_json)) = 7 AND
          (SELECT COUNT(*) FROM json_each(NEW.public_configuration_json)) = 7 AND
          json_type(OLD.public_configuration_json, '$.organization_tool_profile') IS NULL AND
          json_type(NEW.public_configuration_json, '$.organization_tool_profile') IS NULL AND
          json_type(OLD.public_configuration_json, '$.schema_version') IS NULL AND
          json_type(NEW.public_configuration_json, '$.schema_version') IS NULL
        ) OR (
          (SELECT COUNT(*) FROM json_each(OLD.public_configuration_json)) = 9 AND
          (SELECT COUNT(*) FROM json_each(NEW.public_configuration_json)) = 9 AND
          json_extract(OLD.public_configuration_json, '$.organization_tool_profile') =
            'slack-organization-tool-v1' AND
          json_extract(NEW.public_configuration_json, '$.organization_tool_profile') =
            'slack-organization-tool-v1' AND
          json_type(OLD.public_configuration_json, '$.schema_version') = 'integer' AND
          json_extract(OLD.public_configuration_json, '$.schema_version') = 1 AND
          json_type(NEW.public_configuration_json, '$.schema_version') = 'integer' AND
          json_extract(NEW.public_configuration_json, '$.schema_version') = 1
        )
      ) AND
      json_type(OLD.public_configuration_json, '$.slack_app_id') = 'null' AND
      json_type(NEW.public_configuration_json, '$.slack_app_id') = 'text' AND
      length(json_extract(NEW.public_configuration_json, '$.slack_app_id')) >= 3 AND
      substr(json_extract(NEW.public_configuration_json, '$.slack_app_id'), 1, 1) = 'A' AND
      substr(json_extract(NEW.public_configuration_json, '$.slack_app_id'), 2)
        NOT GLOB '*[^A-Z0-9]*' AND
      json_extract(NEW.public_configuration_json, '$.approve_reaction') IS
        json_extract(OLD.public_configuration_json, '$.approve_reaction') AND
      json_extract(NEW.public_configuration_json, '$.reject_reaction') IS
        json_extract(OLD.public_configuration_json, '$.reject_reaction') AND
      json_extract(NEW.public_configuration_json, '$.channel_id') IS
        json_extract(OLD.public_configuration_json, '$.channel_id') AND
      json_extract(NEW.public_configuration_json, '$.slack_bot_id') IS
        json_extract(OLD.public_configuration_json, '$.slack_bot_id') AND
      json_extract(NEW.public_configuration_json, '$.slack_bot_user_id') IS
        json_extract(OLD.public_configuration_json, '$.slack_bot_user_id') AND
      json_extract(NEW.public_configuration_json, '$.slack_enterprise_id') IS
        json_extract(OLD.public_configuration_json, '$.slack_enterprise_id') AND
      EXISTS (
        SELECT 1
        FROM organization_tool_connections AS connection
        WHERE connection.connection_id = OLD.connection_id
          AND connection.organization_id = OLD.organization_id
          AND connection.status = 'active'
          AND connection.provider = 'slack'
          AND connection.provider_issuer = 'https://slack.com'
          AND connection.owner_kind = 'organization'
          AND json_extract(connection.public_configuration_json, '$.slack_app_id') =
            json_extract(NEW.public_configuration_json, '$.slack_app_id')
          AND json_extract(connection.public_configuration_json, '$.approve_reaction') IS
            json_extract(OLD.public_configuration_json, '$.approve_reaction')
          AND json_extract(connection.public_configuration_json, '$.reject_reaction') IS
            json_extract(OLD.public_configuration_json, '$.reject_reaction')
          AND json_extract(connection.public_configuration_json, '$.channel_id') IS
            json_extract(OLD.public_configuration_json, '$.channel_id')
          AND json_extract(connection.public_configuration_json, '$.slack_bot_id') IS
            json_extract(OLD.public_configuration_json, '$.slack_bot_id')
          AND json_extract(connection.public_configuration_json, '$.slack_bot_user_id') IS
            json_extract(OLD.public_configuration_json, '$.slack_bot_user_id')
          AND json_extract(connection.public_configuration_json, '$.slack_enterprise_id') IS
            json_extract(OLD.public_configuration_json, '$.slack_enterprise_id')
      ) AND
      EXISTS (
        SELECT 1
        FROM organization_integration_audit AS audit,
             json_each(
               audit.detail_json,
               '$.app_identity_promotion.binding_updates'
             ) AS binding_update
        WHERE audit.organization_id = OLD.organization_id
          AND audit.action = 'organization_tool.slack.onboarded'
          AND audit.subject_kind = 'tool_connection'
          AND audit.subject_id = OLD.connection_id
          AND audit.connection_id = OLD.connection_id
          AND audit.outcome = 'succeeded'
          AND audit.reason_code = 'null_app_identity_reverified_and_promoted'
          AND json_extract(audit.detail_json, '$.app_identity_promotion.schema_version') = 1
          AND json_extract(audit.detail_json, '$.app_identity_promotion.kind') =
            'slack-null-app-identity-promotion-v1'
          AND json_extract(audit.detail_json, '$.app_identity_promotion.app_id') =
            json_extract(NEW.public_configuration_json, '$.slack_app_id')
          AND json_extract(binding_update.value, '$.adapter_binding_id') =
            OLD.adapter_binding_id
          AND json_extract(
            binding_update.value,
            '$.previous_public_configuration_sha256'
          ) = OLD.public_configuration_sha256
          AND json_extract(
            binding_update.value,
            '$.public_configuration_sha256'
          ) = NEW.public_configuration_sha256
      )
    )
  ), 0) != 1 THEN RAISE(
    ABORT,
    'adapter bindings may only be revoked or receive an audited Slack app identity'
  ) END;
END;

DROP TRIGGER organization_tool_connections_revoke_only;

CREATE TRIGGER organization_tool_connections_revoke_only
BEFORE UPDATE ON organization_tool_connections
BEGIN
  SELECT CASE WHEN COALESCE((
    (
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
      NEW.activated_at = OLD.activated_at AND
      NEW.public_configuration_json = OLD.public_configuration_json AND
      NEW.public_configuration_sha256 = OLD.public_configuration_sha256
    ) OR (
      OLD.status = 'active' AND
      NEW.status = 'active' AND
      OLD.revoked_at IS NULL AND
      NEW.revoked_at IS NULL AND
      OLD.revocation_reason IS NULL AND
      NEW.revocation_reason IS NULL AND
      OLD.provider = 'slack' AND
      OLD.provider_issuer = 'https://slack.com' AND
      OLD.owner_kind = 'organization' AND
      json_type(OLD.public_configuration_json, '$.organization_tool_profile') IS NULL AND
      json_extract(NEW.public_configuration_json, '$.organization_tool_profile') =
        'slack-organization-tool-v1' AND
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
      NEW.verification_attempt_id != OLD.verification_attempt_id AND
      NEW.secret_backend_id = OLD.secret_backend_id AND
      NEW.secret_handle_id = OLD.secret_handle_id AND
      NEW.created_by_principal_id = OLD.created_by_principal_id AND
      NEW.created_by_membership_id = OLD.created_by_membership_id AND
      NEW.activated_at = OLD.activated_at
    ) OR (
      OLD.status = 'active' AND
      NEW.status = 'active' AND
      OLD.revoked_at IS NULL AND
      NEW.revoked_at IS NULL AND
      OLD.revocation_reason IS NULL AND
      NEW.revocation_reason IS NULL AND
      OLD.provider = 'slack' AND
      OLD.provider_issuer = 'https://slack.com' AND
      OLD.owner_kind = 'organization' AND
      json_extract(OLD.public_configuration_json, '$.organization_tool_profile') =
        'slack-organization-tool-v1' AND
      json_type(OLD.public_configuration_json, '$.slack_app_id') = 'null' AND
      json_extract(NEW.public_configuration_json, '$.organization_tool_profile') =
        'slack-organization-tool-v1' AND
      json_type(NEW.public_configuration_json, '$.slack_app_id') = 'text' AND
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
      NEW.verification_attempt_id != OLD.verification_attempt_id AND
      NEW.secret_backend_id = OLD.secret_backend_id AND
      NEW.secret_handle_id = OLD.secret_handle_id AND
      NEW.created_by_principal_id = OLD.created_by_principal_id AND
      NEW.created_by_membership_id = OLD.created_by_membership_id AND
      NEW.activated_at = OLD.activated_at
    )
  ), 0) != 1 THEN RAISE(
    ABORT,
    'tool connections may only be revoked or promoted'
  ) END;
END;

-- The earlier legacy guard treats app_id as immutable. Keep that exact path
-- for ordinary legacy promotion, but route legacy null-to-canonical app
-- promotion through the audited guard below.
DROP TRIGGER organization_tool_connections_slack_legacy_promotion;

CREATE TRIGGER organization_tool_connections_slack_legacy_promotion
BEFORE UPDATE ON organization_tool_connections
WHEN
  OLD.status = 'active' AND
  OLD.provider = 'slack' AND
  OLD.provider_issuer = 'https://slack.com' AND
  OLD.owner_kind = 'organization' AND
  json_type(OLD.public_configuration_json, '$.organization_tool_profile') IS NULL AND
  json_extract(NEW.public_configuration_json, '$.organization_tool_profile') =
    'slack-organization-tool-v1' AND
  NOT (
    json_type(OLD.public_configuration_json, '$.slack_app_id') = 'null' AND
    json_type(NEW.public_configuration_json, '$.slack_app_id') = 'text' AND
    length(json_extract(NEW.public_configuration_json, '$.slack_app_id')) >= 3 AND
    substr(json_extract(NEW.public_configuration_json, '$.slack_app_id'), 1, 1) = 'A' AND
    substr(json_extract(NEW.public_configuration_json, '$.slack_app_id'), 2)
      NOT GLOB '*[^A-Z0-9]*'
  )
BEGIN
  SELECT CASE WHEN COALESCE((
    NEW.connection_kind = 'service_account' AND
    NEW.provider_tenant_kind = 'workspace' AND
    NEW.provider_subject_kind = 'service_account' AND
    NEW.secret_backend_id = 'authority-file-v1' AND
    json_type(NEW.public_configuration_json) = 'object' AND
    (SELECT COUNT(*) FROM json_each(NEW.public_configuration_json)) = 9 AND
    json_extract(NEW.public_configuration_json, '$.organization_tool_profile') =
      'slack-organization-tool-v1' AND
    json_type(NEW.public_configuration_json, '$.schema_version') = 'integer' AND
    json_extract(NEW.public_configuration_json, '$.schema_version') = 1 AND
    json_type(NEW.public_configuration_json, '$.approve_reaction') = 'text' AND
    json_type(NEW.public_configuration_json, '$.reject_reaction') = 'text' AND
    json_extract(NEW.public_configuration_json, '$.approve_reaction') =
      json_extract(OLD.public_configuration_json, '$.approve_reaction') AND
    json_extract(NEW.public_configuration_json, '$.reject_reaction') =
      json_extract(OLD.public_configuration_json, '$.reject_reaction') AND
    json_extract(NEW.public_configuration_json, '$.approve_reaction') !=
      json_extract(NEW.public_configuration_json, '$.reject_reaction') AND
    length(json_extract(NEW.public_configuration_json, '$.approve_reaction')) BETWEEN 1 AND 64 AND
    json_extract(NEW.public_configuration_json, '$.approve_reaction')
      NOT GLOB '*[^a-z0-9_+-]*' AND
    length(json_extract(NEW.public_configuration_json, '$.reject_reaction')) BETWEEN 1 AND 64 AND
    json_extract(NEW.public_configuration_json, '$.reject_reaction')
      NOT GLOB '*[^a-z0-9_+-]*' AND
    json_type(NEW.public_configuration_json, '$.channel_id') = 'text' AND
    json_extract(NEW.public_configuration_json, '$.channel_id') =
      json_extract(OLD.public_configuration_json, '$.channel_id') AND
    length(json_extract(NEW.public_configuration_json, '$.channel_id')) >= 3 AND
    substr(json_extract(NEW.public_configuration_json, '$.channel_id'), 1, 1) = 'C' AND
    substr(json_extract(NEW.public_configuration_json, '$.channel_id'), 2)
      NOT GLOB '*[^A-Z0-9]*' AND
    json_type(NEW.public_configuration_json, '$.slack_bot_id') = 'text' AND
    json_extract(NEW.public_configuration_json, '$.slack_bot_id') =
      json_extract(OLD.public_configuration_json, '$.slack_bot_id') AND
    length(json_extract(NEW.public_configuration_json, '$.slack_bot_id')) >= 3 AND
    substr(json_extract(NEW.public_configuration_json, '$.slack_bot_id'), 1, 1) = 'B' AND
    substr(json_extract(NEW.public_configuration_json, '$.slack_bot_id'), 2)
      NOT GLOB '*[^A-Z0-9]*' AND
    json_extract(NEW.public_configuration_json, '$.slack_bot_user_id') =
      OLD.provider_subject_id AND
    json_extract(NEW.public_configuration_json, '$.slack_bot_user_id') =
      json_extract(OLD.public_configuration_json, '$.slack_bot_user_id') AND
    length(NEW.provider_subject_id) >= 3 AND
    substr(NEW.provider_subject_id, 1, 1) IN ('U', 'W') AND
    substr(NEW.provider_subject_id, 2) NOT GLOB '*[^A-Z0-9]*' AND
    json_extract(NEW.public_configuration_json, '$.slack_app_id') IS
      json_extract(OLD.public_configuration_json, '$.slack_app_id') AND
    json_extract(NEW.public_configuration_json, '$.slack_enterprise_id') IS
      json_extract(OLD.public_configuration_json, '$.slack_enterprise_id') AND
    EXISTS (SELECT 1 FROM json_each(NEW.granted_scopes_json) WHERE value = 'channels:history') AND
    EXISTS (SELECT 1 FROM json_each(NEW.granted_scopes_json) WHERE value = 'channels:read') AND
    EXISTS (SELECT 1 FROM json_each(NEW.granted_scopes_json) WHERE value = 'chat:write') AND
    EXISTS (SELECT 1 FROM json_each(NEW.granted_scopes_json) WHERE value = 'reactions:read') AND
    EXISTS (SELECT 1 FROM json_each(NEW.granted_scopes_json) WHERE value = 'users:read') AND
    EXISTS (
      SELECT 1
      FROM organization_connection_attempts AS attempt
      WHERE attempt.connection_attempt_id = NEW.verification_attempt_id
        AND attempt.organization_id = NEW.organization_id
        AND attempt.attempt_purpose = 'tool_connection'
        AND attempt.target_owner_kind = 'organization'
        AND attempt.target_principal_id IS NULL
        AND attempt.target_membership_id IS NULL
        AND attempt.provider = NEW.provider
        AND attempt.provider_issuer = NEW.provider_issuer
        AND attempt.provider_tenant_kind = NEW.provider_tenant_kind
        AND attempt.provider_tenant_id = NEW.provider_tenant_id
        AND attempt.provider_subject_kind = NEW.provider_subject_kind
        AND attempt.provider_subject_id = NEW.provider_subject_id
        AND attempt.granted_scopes_json = NEW.granted_scopes_json
        AND attempt.granted_scopes_sha256 = NEW.granted_scopes_sha256
        AND attempt.verification_evidence_sha256 = NEW.verification_evidence_sha256
        AND attempt.status = 'succeeded'
    )
  ), 0) != 1 THEN RAISE(
    ABORT,
    'legacy Slack organization connection promotion is invalid'
  ) END;
END;

CREATE TRIGGER organization_tool_connections_slack_app_identity_promotion
BEFORE UPDATE ON organization_tool_connections
WHEN
  OLD.status = 'active' AND
  OLD.provider = 'slack' AND
  OLD.provider_issuer = 'https://slack.com' AND
  OLD.owner_kind = 'organization' AND
  json_type(OLD.public_configuration_json, '$.slack_app_id') = 'null' AND
  json_type(NEW.public_configuration_json, '$.slack_app_id') = 'text'
BEGIN
  SELECT CASE WHEN COALESCE((
    NEW.status = 'active' AND
    NEW.connection_kind = 'service_account' AND
    NEW.provider_tenant_kind = 'workspace' AND
    NEW.provider_subject_kind = 'service_account' AND
    NEW.secret_backend_id = 'authority-file-v1' AND
    json_type(OLD.public_configuration_json) = 'object' AND
    (
      (
        (SELECT COUNT(*) FROM json_each(OLD.public_configuration_json)) = 7 AND
        json_type(OLD.public_configuration_json, '$.organization_tool_profile') IS NULL AND
        json_type(OLD.public_configuration_json, '$.schema_version') IS NULL
      ) OR (
        (SELECT COUNT(*) FROM json_each(OLD.public_configuration_json)) = 9 AND
        json_extract(OLD.public_configuration_json, '$.organization_tool_profile') =
          'slack-organization-tool-v1' AND
        json_type(OLD.public_configuration_json, '$.schema_version') = 'integer' AND
        json_extract(OLD.public_configuration_json, '$.schema_version') = 1
      )
    ) AND
    json_type(OLD.public_configuration_json, '$.approve_reaction') = 'text' AND
    json_type(OLD.public_configuration_json, '$.reject_reaction') = 'text' AND
    json_type(OLD.public_configuration_json, '$.channel_id') = 'text' AND
    json_type(OLD.public_configuration_json, '$.slack_bot_id') = 'text' AND
    json_type(OLD.public_configuration_json, '$.slack_bot_user_id') = 'text' AND
    json_type(OLD.public_configuration_json, '$.slack_app_id') = 'null' AND
    json_type(OLD.public_configuration_json, '$.slack_enterprise_id') IN (
      'null',
      'text'
    ) AND
    json_type(NEW.public_configuration_json) = 'object' AND
    (SELECT COUNT(*) FROM json_each(NEW.public_configuration_json)) = 9 AND
    json_extract(NEW.public_configuration_json, '$.organization_tool_profile') =
      'slack-organization-tool-v1' AND
    json_type(NEW.public_configuration_json, '$.schema_version') = 'integer' AND
    json_extract(NEW.public_configuration_json, '$.schema_version') = 1 AND
    length(json_extract(NEW.public_configuration_json, '$.slack_app_id')) >= 3 AND
    substr(json_extract(NEW.public_configuration_json, '$.slack_app_id'), 1, 1) = 'A' AND
    substr(json_extract(NEW.public_configuration_json, '$.slack_app_id'), 2)
      NOT GLOB '*[^A-Z0-9]*' AND
    json_extract(NEW.public_configuration_json, '$.approve_reaction') IS
      json_extract(OLD.public_configuration_json, '$.approve_reaction') AND
    json_extract(NEW.public_configuration_json, '$.reject_reaction') IS
      json_extract(OLD.public_configuration_json, '$.reject_reaction') AND
    json_extract(NEW.public_configuration_json, '$.channel_id') IS
      json_extract(OLD.public_configuration_json, '$.channel_id') AND
    json_extract(NEW.public_configuration_json, '$.slack_bot_id') IS
      json_extract(OLD.public_configuration_json, '$.slack_bot_id') AND
    json_extract(NEW.public_configuration_json, '$.slack_bot_user_id') IS
      json_extract(OLD.public_configuration_json, '$.slack_bot_user_id') AND
    json_extract(NEW.public_configuration_json, '$.slack_enterprise_id') IS
      json_extract(OLD.public_configuration_json, '$.slack_enterprise_id') AND
    json_extract(NEW.public_configuration_json, '$.slack_bot_user_id') =
      NEW.provider_subject_id AND
    NEW.public_configuration_sha256 != OLD.public_configuration_sha256 AND
    EXISTS (SELECT 1 FROM json_each(NEW.granted_scopes_json) WHERE value = 'channels:history') AND
    EXISTS (SELECT 1 FROM json_each(NEW.granted_scopes_json) WHERE value = 'channels:read') AND
    EXISTS (SELECT 1 FROM json_each(NEW.granted_scopes_json) WHERE value = 'chat:write') AND
    EXISTS (SELECT 1 FROM json_each(NEW.granted_scopes_json) WHERE value = 'reactions:read') AND
    EXISTS (SELECT 1 FROM json_each(NEW.granted_scopes_json) WHERE value = 'users:read') AND
    EXISTS (
      SELECT 1
      FROM organization_connection_attempts AS attempt
      WHERE attempt.connection_attempt_id = NEW.verification_attempt_id
        AND attempt.connection_attempt_id != OLD.verification_attempt_id
        AND attempt.organization_id = NEW.organization_id
        AND attempt.attempt_purpose = 'tool_connection'
        AND attempt.target_owner_kind = 'organization'
        AND attempt.target_principal_id IS NULL
        AND attempt.target_membership_id IS NULL
        AND attempt.provider = NEW.provider
        AND attempt.provider_issuer = NEW.provider_issuer
        AND attempt.provider_tenant_kind = NEW.provider_tenant_kind
        AND attempt.provider_tenant_id = NEW.provider_tenant_id
        AND attempt.provider_subject_kind = NEW.provider_subject_kind
        AND attempt.provider_subject_id = NEW.provider_subject_id
        AND attempt.granted_scopes_json = NEW.granted_scopes_json
        AND attempt.granted_scopes_sha256 = NEW.granted_scopes_sha256
        AND attempt.verification_evidence_sha256 = NEW.verification_evidence_sha256
        AND attempt.status = 'succeeded'
    ) AND
    (
      SELECT COUNT(*)
      FROM organization_integration_audit AS audit
      WHERE audit.organization_id = OLD.organization_id
        AND audit.action = 'organization_tool.slack.onboarded'
        AND audit.subject_kind = 'tool_connection'
        AND audit.subject_id = OLD.connection_id
        AND audit.connection_id = OLD.connection_id
        AND audit.outcome = 'succeeded'
        AND audit.reason_code = 'null_app_identity_reverified_and_promoted'
        AND json_type(audit.detail_json, '$.app_identity_promotion') = 'object'
        AND (
          SELECT COUNT(*)
          FROM json_each(
            audit.detail_json,
            '$.app_identity_promotion'
          )
        ) = 6
        AND json_extract(audit.detail_json, '$.public_configuration_sha256') =
          NEW.public_configuration_sha256
        AND json_extract(audit.detail_json, '$.app_identity_promotion.schema_version') = 1
        AND json_extract(audit.detail_json, '$.app_identity_promotion.kind') =
          'slack-null-app-identity-promotion-v1'
        AND json_extract(audit.detail_json, '$.app_identity_promotion.app_id') =
          json_extract(NEW.public_configuration_json, '$.slack_app_id')
        AND json_extract(
          audit.detail_json,
          '$.app_identity_promotion.previous_public_configuration_sha256'
        ) = OLD.public_configuration_sha256
        AND json_extract(
          audit.detail_json,
          '$.app_identity_promotion.public_configuration_sha256'
        ) = NEW.public_configuration_sha256
        AND json_extract(
          audit.detail_json,
          '$.result.connection_attempt_id'
        ) = NEW.verification_attempt_id
        AND json_extract(audit.detail_json, '$.result.connection_id') =
          OLD.connection_id
        AND json_extract(audit.detail_json, '$.result.organization_id') =
          OLD.organization_id
        AND json_extract(audit.detail_json, '$.result.provider') = 'slack'
        AND json_extract(audit.detail_json, '$.result.status') = 'active'
        AND json_type(
          audit.detail_json,
          '$.app_identity_promotion.binding_updates'
        ) = 'array'
        AND (
          SELECT COUNT(*)
          FROM json_each(
            audit.detail_json,
            '$.app_identity_promotion.binding_updates'
          )
        ) = (
          SELECT COUNT(*)
          FROM organization_adapter_bindings AS binding
          WHERE binding.organization_id = OLD.organization_id
            AND binding.connection_id = OLD.connection_id
            AND binding.product_namespace = 'echo-brain'
            AND binding.adapter_kind = 'approval-surface'
            AND binding.adapter_id = 'slack-reactions'
            AND binding.status = 'active'
        )
        AND (
          SELECT COUNT(DISTINCT json_extract(
            binding_update.value,
            '$.adapter_binding_id'
          ))
          FROM json_each(
            audit.detail_json,
            '$.app_identity_promotion.binding_updates'
          ) AS binding_update
        ) = (
          SELECT COUNT(*)
          FROM json_each(
            audit.detail_json,
            '$.app_identity_promotion.binding_updates'
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM organization_adapter_bindings AS binding
          WHERE binding.organization_id = OLD.organization_id
            AND binding.connection_id = OLD.connection_id
            AND binding.product_namespace = 'echo-brain'
            AND binding.adapter_kind = 'approval-surface'
            AND binding.adapter_id = 'slack-reactions'
            AND binding.status = 'active'
            AND (
              json_type(binding.public_configuration_json) != 'object' OR
              NOT (
                (
                  (SELECT COUNT(*) FROM json_each(
                    binding.public_configuration_json
                  )) = 7 AND
                  json_type(
                    binding.public_configuration_json,
                    '$.organization_tool_profile'
                  ) IS NULL AND
                  json_type(
                    binding.public_configuration_json,
                    '$.schema_version'
                  ) IS NULL
                ) OR (
                  (SELECT COUNT(*) FROM json_each(
                    binding.public_configuration_json
                  )) = 9 AND
                  json_extract(
                    binding.public_configuration_json,
                    '$.organization_tool_profile'
                  ) = 'slack-organization-tool-v1' AND
                  json_type(
                    binding.public_configuration_json,
                    '$.schema_version'
                  ) = 'integer' AND
                  json_extract(
                    binding.public_configuration_json,
                    '$.schema_version'
                  ) = 1
                )
              ) OR
              json_type(
                binding.public_configuration_json,
                '$.slack_app_id'
              ) != 'null' OR
              json_extract(
                binding.public_configuration_json,
                '$.approve_reaction'
              ) IS NOT json_extract(
                OLD.public_configuration_json,
                '$.approve_reaction'
              ) OR
              json_extract(
                binding.public_configuration_json,
                '$.reject_reaction'
              ) IS NOT json_extract(
                OLD.public_configuration_json,
                '$.reject_reaction'
              ) OR
              json_extract(binding.public_configuration_json, '$.channel_id')
                IS NOT json_extract(OLD.public_configuration_json, '$.channel_id') OR
              json_extract(binding.public_configuration_json, '$.slack_bot_id')
                IS NOT json_extract(OLD.public_configuration_json, '$.slack_bot_id') OR
              json_extract(
                binding.public_configuration_json,
                '$.slack_bot_user_id'
              ) IS NOT json_extract(
                OLD.public_configuration_json,
                '$.slack_bot_user_id'
              ) OR
              json_extract(
                binding.public_configuration_json,
                '$.slack_enterprise_id'
              ) IS NOT json_extract(
                OLD.public_configuration_json,
                '$.slack_enterprise_id'
              ) OR
              NOT EXISTS (
                SELECT 1
                FROM json_each(
                  audit.detail_json,
                  '$.app_identity_promotion.binding_updates'
                  ) AS binding_update
                WHERE json_extract(binding_update.value, '$.adapter_binding_id') =
                    binding.adapter_binding_id
                  AND json_type(binding_update.value) = 'object'
                  AND (SELECT COUNT(*) FROM json_each(binding_update.value)) = 3
                  AND json_extract(
                    binding_update.value,
                    '$.previous_public_configuration_sha256'
                  ) = binding.public_configuration_sha256
                  AND json_type(
                    binding_update.value,
                    '$.public_configuration_sha256'
                  ) = 'text'
                  AND length(json_extract(
                    binding_update.value,
                    '$.public_configuration_sha256'
                  )) = 71
                  AND substr(json_extract(
                    binding_update.value,
                    '$.public_configuration_sha256'
                  ), 1, 7) = 'sha256:'
                  AND substr(json_extract(
                    binding_update.value,
                    '$.public_configuration_sha256'
                  ), 8) NOT GLOB '*[^0-9a-f]*'
                  AND json_extract(
                    binding_update.value,
                    '$.public_configuration_sha256'
                  ) != binding.public_configuration_sha256
              )
            )
        ) AND
        NOT EXISTS (
          SELECT 1
          FROM json_each(
            audit.detail_json,
            '$.app_identity_promotion.binding_updates'
          ) AS binding_update
          WHERE json_type(binding_update.value) != 'object'
            OR (SELECT COUNT(*) FROM json_each(binding_update.value)) != 3
            OR json_type(
              binding_update.value,
              '$.adapter_binding_id'
            ) != 'text'
            OR json_type(
              binding_update.value,
              '$.previous_public_configuration_sha256'
            ) != 'text'
            OR json_type(
              binding_update.value,
              '$.public_configuration_sha256'
            ) != 'text'
            OR NOT EXISTS (
            SELECT 1
            FROM organization_adapter_bindings AS binding
            WHERE binding.adapter_binding_id =
                json_extract(binding_update.value, '$.adapter_binding_id')
              AND binding.organization_id = OLD.organization_id
              AND binding.connection_id = OLD.connection_id
              AND binding.product_namespace = 'echo-brain'
              AND binding.adapter_kind = 'approval-surface'
              AND binding.adapter_id = 'slack-reactions'
              AND binding.status = 'active'
              AND binding.public_configuration_sha256 = json_extract(
                binding_update.value,
                '$.previous_public_configuration_sha256'
              )
          )
        )
    ) = 1
  ), 0) != 1 THEN RAISE(
    ABORT,
    'Slack app identity promotion is invalid or incomplete'
  ) END;
END;

CREATE TRIGGER organization_tool_connections_slack_app_identity_cascade
AFTER UPDATE ON organization_tool_connections
WHEN
  OLD.status = 'active' AND
  NEW.status = 'active' AND
  OLD.provider = 'slack' AND
  OLD.provider_issuer = 'https://slack.com' AND
  OLD.owner_kind = 'organization' AND
  json_type(OLD.public_configuration_json, '$.slack_app_id') = 'null' AND
  json_type(NEW.public_configuration_json, '$.slack_app_id') = 'text'
BEGIN
  UPDATE organization_adapter_bindings
  SET
    public_configuration_json = json_set(
      public_configuration_json,
      '$.slack_app_id',
      json_extract(NEW.public_configuration_json, '$.slack_app_id')
    ),
    public_configuration_sha256 = (
      SELECT json_extract(
        binding_update.value,
        '$.public_configuration_sha256'
      )
      FROM organization_integration_audit AS audit,
           json_each(
             audit.detail_json,
             '$.app_identity_promotion.binding_updates'
           ) AS binding_update
      WHERE audit.organization_id = NEW.organization_id
        AND audit.action = 'organization_tool.slack.onboarded'
        AND audit.subject_kind = 'tool_connection'
        AND audit.subject_id = NEW.connection_id
        AND audit.connection_id = NEW.connection_id
        AND audit.outcome = 'succeeded'
        AND audit.reason_code = 'null_app_identity_reverified_and_promoted'
        AND json_extract(
          audit.detail_json,
          '$.result.connection_attempt_id'
        ) = NEW.verification_attempt_id
        AND json_extract(
          audit.detail_json,
          '$.app_identity_promotion.app_id'
        ) = json_extract(NEW.public_configuration_json, '$.slack_app_id')
        AND json_extract(binding_update.value, '$.adapter_binding_id') =
          organization_adapter_bindings.adapter_binding_id
    )
  WHERE organization_id = NEW.organization_id
    AND connection_id = NEW.connection_id
    AND product_namespace = 'echo-brain'
    AND adapter_kind = 'approval-surface'
    AND adapter_id = 'slack-reactions'
    AND status = 'active';

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM organization_adapter_bindings AS binding
    WHERE binding.organization_id = NEW.organization_id
      AND binding.connection_id = NEW.connection_id
      AND binding.product_namespace = 'echo-brain'
      AND binding.adapter_kind = 'approval-surface'
      AND binding.adapter_id = 'slack-reactions'
      AND binding.status = 'active'
      AND (
        json_extract(binding.public_configuration_json, '$.slack_app_id') !=
          json_extract(NEW.public_configuration_json, '$.slack_app_id') OR
        NOT EXISTS (
          SELECT 1
          FROM organization_integration_audit AS audit,
               json_each(
                 audit.detail_json,
                 '$.app_identity_promotion.binding_updates'
               ) AS binding_update
          WHERE audit.organization_id = NEW.organization_id
            AND audit.action = 'organization_tool.slack.onboarded'
            AND audit.subject_kind = 'tool_connection'
            AND audit.subject_id = NEW.connection_id
            AND audit.connection_id = NEW.connection_id
            AND audit.outcome = 'succeeded'
            AND audit.reason_code =
              'null_app_identity_reverified_and_promoted'
            AND json_extract(
              audit.detail_json,
              '$.result.connection_attempt_id'
            ) = NEW.verification_attempt_id
            AND json_extract(
              binding_update.value,
              '$.adapter_binding_id'
            ) = binding.adapter_binding_id
            AND json_extract(
              binding_update.value,
              '$.public_configuration_sha256'
            ) = binding.public_configuration_sha256
        )
      )
  ) THEN RAISE(
    ABORT,
    'Slack app identity binding cascade is incomplete'
  ) END;
END;
