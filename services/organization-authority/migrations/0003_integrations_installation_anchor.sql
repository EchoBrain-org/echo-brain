ALTER TABLE authority_metadata
  ADD COLUMN integrations_control_plane_id TEXT;

ALTER TABLE authority_metadata
  ADD COLUMN integrations_marker_sha256 TEXT;

ALTER TABLE authority_metadata
  ADD COLUMN integrations_installed_at TEXT
  CHECK (
    (
      integrations_control_plane_id IS NULL AND
      integrations_marker_sha256 IS NULL AND
      integrations_installed_at IS NULL
    ) OR (
      integrations_control_plane_id IS NOT NULL AND
      integrations_marker_sha256 IS NOT NULL AND
      integrations_installed_at IS NOT NULL
    )
  );

CREATE UNIQUE INDEX authority_metadata_integrations_control_plane
  ON authority_metadata (integrations_control_plane_id)
  WHERE integrations_control_plane_id IS NOT NULL;

CREATE TRIGGER authority_metadata_integrations_anchor_valid
BEFORE UPDATE OF
  integrations_control_plane_id,
  integrations_marker_sha256,
  integrations_installed_at
ON authority_metadata
WHEN
  NEW.integrations_control_plane_id IS NULL OR
  length(NEW.integrations_control_plane_id) != 40 OR
  substr(NEW.integrations_control_plane_id, 1, 4) != 'ocp_' OR
  length(replace(substr(NEW.integrations_control_plane_id, 5), '-', '')) != 32 OR
  replace(substr(NEW.integrations_control_plane_id, 5), '-', '') GLOB '*[^0-9a-f]*' OR
  NEW.integrations_marker_sha256 IS NULL OR
  length(NEW.integrations_marker_sha256) != 71 OR
  substr(NEW.integrations_marker_sha256, 1, 7) != 'sha256:' OR
  substr(NEW.integrations_marker_sha256, 8) GLOB '*[^0-9a-f]*' OR
  NEW.integrations_installed_at IS NULL OR
  datetime(NEW.integrations_installed_at) IS NULL
BEGIN
  SELECT RAISE(
    ABORT,
    'authority integrations installation anchor is invalid'
  );
END;

CREATE TRIGGER authority_metadata_integrations_anchor_immutable
BEFORE UPDATE OF
  integrations_control_plane_id,
  integrations_marker_sha256,
  integrations_installed_at
ON authority_metadata
WHEN OLD.integrations_control_plane_id IS NOT NULL
BEGIN
  SELECT RAISE(
    ABORT,
    'authority integrations installation anchor is immutable'
  );
END;
