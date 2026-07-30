-- Promote the organization-owned provider configuration from an exact
-- installation binding onto the organization tool connection itself.
--
-- The pre-organization-onboarding Slack bootstrap always created one active
-- binding together with one active organization connection. Refuse to guess
-- when an older database does not have that exact shape.

CREATE TABLE organization_tool_configuration_upgrade_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  compatible INTEGER NOT NULL CHECK (compatible = 1)
) STRICT;

INSERT INTO organization_tool_configuration_upgrade_guard (
  singleton,
  compatible
)
SELECT
  1,
  CASE WHEN EXISTS (
    SELECT 1
    FROM organization_tool_connections AS connection
    LEFT JOIN organization_adapter_bindings AS binding
      ON binding.organization_id = connection.organization_id
     AND binding.connection_id = connection.connection_id
     AND binding.status = 'active'
    WHERE connection.provider = 'slack'
      AND connection.provider_issuer = 'https://slack.com'
      AND connection.owner_kind = 'organization'
      AND connection.status = 'active'
    GROUP BY connection.connection_id
    HAVING
      COUNT(binding.adapter_binding_id) != 1 OR
      COALESCE(
        MIN(json_type(binding.public_configuration_json)),
        ''
      ) != 'object' OR
      COALESCE(MIN(
        json_type(binding.public_configuration_json, '$.channel_id')
      ), '') != 'text' OR
      length(MIN(
        json_extract(binding.public_configuration_json, '$.channel_id')
      )) < 3 OR
      substr(MIN(
        json_extract(binding.public_configuration_json, '$.channel_id')
      ), 1, 1) NOT IN ('C', 'G', 'D') OR
      substr(MIN(
        json_extract(binding.public_configuration_json, '$.channel_id')
      ), 2) GLOB '*[^A-Z0-9]*' OR
      COALESCE(MIN(
        json_type(binding.public_configuration_json, '$.slack_bot_id')
      ), '') != 'text' OR
      length(MIN(
        json_extract(binding.public_configuration_json, '$.slack_bot_id')
      )) < 3 OR
      substr(MIN(
        json_extract(binding.public_configuration_json, '$.slack_bot_id')
      ), 1, 1) != 'B' OR
      substr(MIN(
        json_extract(binding.public_configuration_json, '$.slack_bot_id')
      ), 2) GLOB '*[^A-Z0-9]*' OR
      COALESCE(MIN(
        json_extract(
          binding.public_configuration_json,
          '$.slack_bot_user_id'
        )
      ), '') != connection.provider_subject_id OR
      COUNT(DISTINCT binding.public_configuration_sha256) != 1 OR
      length(MIN(binding.public_configuration_sha256)) != 71 OR
      substr(MIN(binding.public_configuration_sha256), 1, 7) != 'sha256:' OR
      substr(MIN(binding.public_configuration_sha256), 8)
        GLOB '*[^0-9a-f]*'
  ) THEN 0 ELSE 1 END;

DROP TABLE organization_tool_configuration_upgrade_guard;

DROP TRIGGER organization_tool_connections_revoke_only;

ALTER TABLE organization_tool_connections
ADD COLUMN public_configuration_json TEXT NOT NULL DEFAULT '{}'
  CHECK (
    json_valid(public_configuration_json) AND
    json_type(public_configuration_json) = 'object'
  );

ALTER TABLE organization_tool_connections
ADD COLUMN public_configuration_sha256 TEXT NOT NULL
  DEFAULT 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'
  CHECK (
    length(public_configuration_sha256) = 71 AND
    substr(public_configuration_sha256, 1, 7) = 'sha256:' AND
    substr(public_configuration_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  );

UPDATE organization_tool_connections
SET
  public_configuration_json = (
    SELECT binding.public_configuration_json
    FROM organization_adapter_bindings AS binding
    WHERE
      binding.organization_id =
        organization_tool_connections.organization_id AND
      binding.connection_id =
        organization_tool_connections.connection_id AND
      binding.status = 'active'
  ),
  public_configuration_sha256 = (
    SELECT binding.public_configuration_sha256
    FROM organization_adapter_bindings AS binding
    WHERE
      binding.organization_id =
        organization_tool_connections.organization_id AND
      binding.connection_id =
        organization_tool_connections.connection_id AND
      binding.status = 'active'
  )
WHERE
  provider = 'slack' AND
  provider_issuer = 'https://slack.com' AND
  owner_kind = 'organization' AND
  status = 'active';

CREATE TRIGGER organization_tool_connections_revoke_only
BEFORE UPDATE ON organization_tool_connections
BEGIN
  SELECT CASE WHEN NOT (
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
  ) THEN RAISE(ABORT, 'tool connections may only be revoked') END;
END;

-- Every new Slack organization connection must carry the explicit readiness
-- profile, all provider proof inputs, and one public C-channel before it can
-- become active. Backfilled legacy rows predate this insert trigger and remain
-- compatibility-only without gaining the readiness profile.
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
    substr(NEW.provider_subject_id, 1, 1) = 'U' AND
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

-- The pre-v2 subject uniqueness rule did not distinguish a backfilled
-- compatibility connection from the new, explicitly ready organization-tool
-- profile. Keep exact-subject uniqueness for every nonlegacy active
-- connection while permitting one ready successor beside the sole legacy row.
DROP INDEX organization_tool_connections_one_active_subject;

CREATE UNIQUE INDEX organization_tool_connections_one_active_subject
ON organization_tool_connections(
  organization_id,
  provider,
  provider_issuer,
  provider_tenant_kind,
  provider_tenant_id,
  provider_subject_kind,
  provider_subject_id
)
WHERE
  status = 'active' AND (
    owner_kind != 'organization' OR
    provider != 'slack' OR
    COALESCE(
      json_extract(
        public_configuration_json,
        '$.organization_tool_profile'
      ),
      ''
    ) = 'slack-organization-tool-v1'
  );

-- An organization may have one employee-connectable Slack tool. A profileless
-- pre-v2 compatibility row is deliberately not counted as ready.
CREATE UNIQUE INDEX organization_tool_connections_one_active_ready_org_slack
ON organization_tool_connections(organization_id, provider)
WHERE
  owner_kind = 'organization' AND
  provider = 'slack' AND
  status = 'active' AND
  json_extract(
    public_configuration_json,
    '$.organization_tool_profile'
  ) = 'slack-organization-tool-v1';
