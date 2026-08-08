-- The durable proof that this authority already published an organization
-- record store.
--
-- It lives here, in `authority.sqlite`, precisely because it must survive the
-- deletion of everything it describes: the log, the derived store, and the
-- state-directory marker. Without it, maintenance cannot tell a state
-- published before the record databases existed from one whose immutable log
-- was deleted, and the safe-looking answer — recreate the pair — silently
-- resets an organization's history.
--
-- Only the marker digest and the installation instant are stored. The record
-- databases carry their own organization binding, and duplicating it here
-- would create a second place for it to drift.

ALTER TABLE authority_metadata
  ADD COLUMN record_marker_sha256 TEXT;

ALTER TABLE authority_metadata
  ADD COLUMN record_installed_at TEXT
  CHECK (
    (
      record_marker_sha256 IS NULL AND
      record_installed_at IS NULL
    ) OR (
      record_marker_sha256 IS NOT NULL AND
      record_installed_at IS NOT NULL
    )
  );

CREATE TRIGGER authority_metadata_record_anchor_valid
BEFORE UPDATE OF
  record_marker_sha256,
  record_installed_at
ON authority_metadata
WHEN
  NEW.record_marker_sha256 IS NULL OR
  length(NEW.record_marker_sha256) != 71 OR
  substr(NEW.record_marker_sha256, 1, 7) != 'sha256:' OR
  substr(NEW.record_marker_sha256, 8) GLOB '*[^0-9a-f]*' OR
  NEW.record_installed_at IS NULL OR
  datetime(NEW.record_installed_at) IS NULL
BEGIN
  SELECT RAISE(
    ABORT,
    'authority record installation anchor is invalid'
  );
END;

CREATE TRIGGER authority_metadata_record_anchor_immutable
BEFORE UPDATE OF
  record_marker_sha256,
  record_installed_at
ON authority_metadata
WHEN OLD.record_marker_sha256 IS NOT NULL
BEGIN
  SELECT RAISE(
    ABORT,
    'authority record installation anchor is immutable'
  );
END;
