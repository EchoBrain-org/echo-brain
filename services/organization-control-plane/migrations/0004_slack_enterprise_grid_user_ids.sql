-- Slack user IDs, including bot user IDs returned by auth.test, can use the
-- Enterprise Grid W namespace as well as the workspace U namespace. Replace
-- only the two Slack configuration guards that encoded the narrower prefix;
-- every other readiness and immutable-promotion invariant is retained.

DROP TRIGGER organization_tool_connections_slack_configuration_insert;

CREATE TRIGGER organization_tool_connections_slack_configuration_insert
BEFORE INSERT ON organization_tool_connections
WHEN
  NEW.provider = 'slack' AND
  NEW.owner_kind = 'organization'
BEGIN
  SELECT CASE WHEN COALESCE((
    NEW.provider_issuer = 'https://slack.com' AND
    NEW.connection_kind = 'service_account' AND
    NEW.provider_tenant_kind = 'workspace' AND
    NEW.provider_subject_kind = 'service_account' AND
    json_type(
      NEW.public_configuration_json,
      '$.organization_tool_profile'
    ) = 'text' AND
    json_extract(
      NEW.public_configuration_json,
      '$.organization_tool_profile'
    ) = 'slack-organization-tool-v1' AND
    json_type(NEW.public_configuration_json, '$.schema_version') = 'integer' AND
    json_extract(NEW.public_configuration_json, '$.schema_version') = 1 AND
    json_type(NEW.public_configuration_json, '$.channel_id') = 'text' AND
    length(json_extract(
      NEW.public_configuration_json,
      '$.channel_id'
    )) >= 3 AND
    substr(json_extract(
      NEW.public_configuration_json,
      '$.channel_id'
    ), 1, 1) = 'C' AND
    substr(json_extract(
      NEW.public_configuration_json,
      '$.channel_id'
    ), 2) NOT GLOB '*[^A-Z0-9]*' AND
    json_type(NEW.public_configuration_json, '$.slack_bot_id') = 'text' AND
    length(json_extract(
      NEW.public_configuration_json,
      '$.slack_bot_id'
    )) >= 3 AND
    substr(json_extract(
      NEW.public_configuration_json,
      '$.slack_bot_id'
    ), 1, 1) = 'B' AND
    substr(json_extract(
      NEW.public_configuration_json,
      '$.slack_bot_id'
    ), 2) NOT GLOB '*[^A-Z0-9]*' AND
    json_type(
      NEW.public_configuration_json,
      '$.slack_bot_user_id'
    ) = 'text' AND
    json_extract(
      NEW.public_configuration_json,
      '$.slack_bot_user_id'
    ) = NEW.provider_subject_id AND
    length(NEW.provider_subject_id) >= 3 AND
    substr(NEW.provider_subject_id, 1, 1) IN ('U', 'W') AND
    substr(NEW.provider_subject_id, 2) NOT GLOB '*[^A-Z0-9]*' AND
    (
      json_type(NEW.public_configuration_json, '$.slack_app_id') = 'null' OR (
        json_type(
          NEW.public_configuration_json,
          '$.slack_app_id'
        ) = 'text' AND
        length(json_extract(
          NEW.public_configuration_json,
          '$.slack_app_id'
        )) >= 3 AND
        substr(json_extract(
          NEW.public_configuration_json,
          '$.slack_app_id'
        ), 1, 1) = 'A' AND
        substr(json_extract(
          NEW.public_configuration_json,
          '$.slack_app_id'
        ), 2) NOT GLOB '*[^A-Z0-9]*'
      )
    ) AND
    (
      json_type(
        NEW.public_configuration_json,
        '$.slack_enterprise_id'
      ) = 'null' OR (
        json_type(
          NEW.public_configuration_json,
          '$.slack_enterprise_id'
        ) = 'text' AND
        length(json_extract(
          NEW.public_configuration_json,
          '$.slack_enterprise_id'
        )) >= 3 AND
        substr(json_extract(
          NEW.public_configuration_json,
          '$.slack_enterprise_id'
        ), 1, 1) = 'E' AND
        substr(json_extract(
          NEW.public_configuration_json,
          '$.slack_enterprise_id'
        ), 2) NOT GLOB '*[^A-Z0-9]*'
      )
    ) AND
    EXISTS (
      SELECT 1
      FROM json_each(NEW.granted_scopes_json)
      WHERE value = 'channels:history'
    ) AND
    EXISTS (
      SELECT 1
      FROM json_each(NEW.granted_scopes_json)
      WHERE value = 'channels:read'
    ) AND
    EXISTS (
      SELECT 1
      FROM json_each(NEW.granted_scopes_json)
      WHERE value = 'chat:write'
    ) AND
    EXISTS (
      SELECT 1
      FROM json_each(NEW.granted_scopes_json)
      WHERE value = 'reactions:read'
    ) AND
    EXISTS (
      SELECT 1
      FROM json_each(NEW.granted_scopes_json)
      WHERE value = 'users:read'
    )
  ), 0) != 1 THEN RAISE(
    ABORT,
    'active Slack organization connection configuration is incomplete'
  ) END;
END;

DROP TRIGGER organization_tool_connections_slack_legacy_promotion;

CREATE TRIGGER organization_tool_connections_slack_legacy_promotion
BEFORE UPDATE ON organization_tool_connections
WHEN
  OLD.status = 'active' AND
  OLD.provider = 'slack' AND
  OLD.provider_issuer = 'https://slack.com' AND
  OLD.owner_kind = 'organization' AND
  json_type(
    OLD.public_configuration_json,
    '$.organization_tool_profile'
  ) IS NULL AND
  json_extract(
    NEW.public_configuration_json,
    '$.organization_tool_profile'
  ) = 'slack-organization-tool-v1'
BEGIN
  SELECT CASE WHEN COALESCE((
    NEW.connection_kind = 'service_account' AND
    NEW.provider_tenant_kind = 'workspace' AND
    NEW.provider_subject_kind = 'service_account' AND
    NEW.secret_backend_id = 'authority-file-v1' AND
    json_type(NEW.public_configuration_json) = 'object' AND
    (
      SELECT COUNT(*) FROM json_each(NEW.public_configuration_json)
    ) = 9 AND
    json_type(NEW.public_configuration_json, '$.schema_version') = 'integer' AND
    json_extract(NEW.public_configuration_json, '$.schema_version') = 1 AND
    json_type(
      NEW.public_configuration_json,
      '$.organization_tool_profile'
    ) = 'text' AND
    json_type(NEW.public_configuration_json, '$.approve_reaction') = 'text' AND
    json_type(NEW.public_configuration_json, '$.reject_reaction') = 'text' AND
    json_extract(
      NEW.public_configuration_json,
      '$.approve_reaction'
    ) = json_extract(
      OLD.public_configuration_json,
      '$.approve_reaction'
    ) AND
    json_extract(
      NEW.public_configuration_json,
      '$.reject_reaction'
    ) = json_extract(
      OLD.public_configuration_json,
      '$.reject_reaction'
    ) AND
    json_extract(
      NEW.public_configuration_json,
      '$.approve_reaction'
    ) != json_extract(
      NEW.public_configuration_json,
      '$.reject_reaction'
    ) AND
    length(json_extract(
      NEW.public_configuration_json,
      '$.approve_reaction'
    )) BETWEEN 1 AND 64 AND
    json_extract(
      NEW.public_configuration_json,
      '$.approve_reaction'
    ) NOT GLOB '*[^a-z0-9_+-]*' AND
    length(json_extract(
      NEW.public_configuration_json,
      '$.reject_reaction'
    )) BETWEEN 1 AND 64 AND
    json_extract(
      NEW.public_configuration_json,
      '$.reject_reaction'
    ) NOT GLOB '*[^a-z0-9_+-]*' AND
    json_type(NEW.public_configuration_json, '$.channel_id') = 'text' AND
    json_extract(
      NEW.public_configuration_json,
      '$.channel_id'
    ) = json_extract(
      OLD.public_configuration_json,
      '$.channel_id'
    ) AND
    length(json_extract(
      NEW.public_configuration_json,
      '$.channel_id'
    )) >= 3 AND
    substr(json_extract(
      NEW.public_configuration_json,
      '$.channel_id'
    ), 1, 1) = 'C' AND
    substr(json_extract(
      NEW.public_configuration_json,
      '$.channel_id'
    ), 2) NOT GLOB '*[^A-Z0-9]*' AND
    json_type(NEW.public_configuration_json, '$.slack_bot_id') = 'text' AND
    json_extract(
      NEW.public_configuration_json,
      '$.slack_bot_id'
    ) = json_extract(
      OLD.public_configuration_json,
      '$.slack_bot_id'
    ) AND
    length(json_extract(
      NEW.public_configuration_json,
      '$.slack_bot_id'
    )) >= 3 AND
    substr(json_extract(
      NEW.public_configuration_json,
      '$.slack_bot_id'
    ), 1, 1) = 'B' AND
    substr(json_extract(
      NEW.public_configuration_json,
      '$.slack_bot_id'
    ), 2) NOT GLOB '*[^A-Z0-9]*' AND
    json_type(
      NEW.public_configuration_json,
      '$.slack_bot_user_id'
    ) = 'text' AND
    json_extract(
      NEW.public_configuration_json,
      '$.slack_bot_user_id'
    ) = OLD.provider_subject_id AND
    json_extract(
      NEW.public_configuration_json,
      '$.slack_bot_user_id'
    ) = json_extract(
      OLD.public_configuration_json,
      '$.slack_bot_user_id'
    ) AND
    length(NEW.provider_subject_id) >= 3 AND
    substr(NEW.provider_subject_id, 1, 1) IN ('U', 'W') AND
    substr(NEW.provider_subject_id, 2) NOT GLOB '*[^A-Z0-9]*' AND
    (
      json_type(NEW.public_configuration_json, '$.slack_app_id') = 'null' OR (
        json_type(
          NEW.public_configuration_json,
          '$.slack_app_id'
        ) = 'text' AND
        length(json_extract(
          NEW.public_configuration_json,
          '$.slack_app_id'
        )) >= 3 AND
        substr(json_extract(
          NEW.public_configuration_json,
          '$.slack_app_id'
        ), 1, 1) = 'A' AND
        substr(json_extract(
          NEW.public_configuration_json,
          '$.slack_app_id'
        ), 2) NOT GLOB '*[^A-Z0-9]*'
      )
    ) AND
    json_extract(
      NEW.public_configuration_json,
      '$.slack_app_id'
    ) IS json_extract(
      OLD.public_configuration_json,
      '$.slack_app_id'
    ) AND
    (
      json_type(
        NEW.public_configuration_json,
        '$.slack_enterprise_id'
      ) = 'null' OR (
        json_type(
          NEW.public_configuration_json,
          '$.slack_enterprise_id'
        ) = 'text' AND
        length(json_extract(
          NEW.public_configuration_json,
          '$.slack_enterprise_id'
        )) >= 3 AND
        substr(json_extract(
          NEW.public_configuration_json,
          '$.slack_enterprise_id'
        ), 1, 1) = 'E' AND
        substr(json_extract(
          NEW.public_configuration_json,
          '$.slack_enterprise_id'
        ), 2) NOT GLOB '*[^A-Z0-9]*'
      )
    ) AND
    json_extract(
      NEW.public_configuration_json,
      '$.slack_enterprise_id'
    ) IS json_extract(
      OLD.public_configuration_json,
      '$.slack_enterprise_id'
    ) AND
    EXISTS (
      SELECT 1 FROM json_each(NEW.granted_scopes_json)
      WHERE value = 'channels:history'
    ) AND
    EXISTS (
      SELECT 1 FROM json_each(NEW.granted_scopes_json)
      WHERE value = 'channels:read'
    ) AND
    EXISTS (
      SELECT 1 FROM json_each(NEW.granted_scopes_json)
      WHERE value = 'chat:write'
    ) AND
    EXISTS (
      SELECT 1 FROM json_each(NEW.granted_scopes_json)
      WHERE value = 'reactions:read'
    ) AND
    EXISTS (
      SELECT 1 FROM json_each(NEW.granted_scopes_json)
      WHERE value = 'users:read'
    ) AND
    EXISTS (
      SELECT 1
      FROM organization_connection_attempts AS attempt
      WHERE
        attempt.connection_attempt_id = NEW.verification_attempt_id AND
        attempt.organization_id = NEW.organization_id AND
        attempt.attempt_purpose = 'tool_connection' AND
        attempt.target_owner_kind = 'organization' AND
        attempt.target_principal_id IS NULL AND
        attempt.target_membership_id IS NULL AND
        attempt.provider = NEW.provider AND
        attempt.provider_issuer = NEW.provider_issuer AND
        attempt.provider_tenant_kind = NEW.provider_tenant_kind AND
        attempt.provider_tenant_id = NEW.provider_tenant_id AND
        attempt.provider_subject_kind = NEW.provider_subject_kind AND
        attempt.provider_subject_id = NEW.provider_subject_id AND
        attempt.granted_scopes_json = NEW.granted_scopes_json AND
        attempt.granted_scopes_sha256 = NEW.granted_scopes_sha256 AND
        attempt.verification_evidence_sha256 =
          NEW.verification_evidence_sha256 AND
        attempt.status = 'succeeded'
    )
  ), 0) != 1 THEN RAISE(
    ABORT,
    'legacy Slack organization connection promotion is invalid'
  ) END;
END;
