-- Minimum internal-live release distribution state.
--
-- One administrator approval appends one immutable, exact release-manifest
-- pointer. The greatest directive_sequence is the sole internal-live pointer;
-- there are no rollout rings or executable remote commands. Active enrolled
-- installations may fetch that pointer and append only installation-signed,
-- redacted terminal receipts.

CREATE TABLE authority_internal_live_releases (
  directive_sequence INTEGER PRIMARY KEY AUTOINCREMENT
    CHECK (directive_sequence > 0),
  command_id TEXT NOT NULL UNIQUE
    CHECK (
      length(command_id) = 40 AND
      substr(command_id, 1, 4) = 'adm_' AND
      length(replace(substr(command_id, 5), '-', '')) = 32 AND
      replace(substr(command_id, 5), '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  command_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(command_sha256) = 71 AND
      substr(command_sha256, 1, 7) = 'sha256:' AND
      substr(command_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  manifest_url TEXT NOT NULL UNIQUE
    CHECK (
      length(manifest_url) BETWEEN 1 AND 1000 AND
      manifest_url NOT GLOB '*[[:space:]]*'
    ),
  manifest_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(manifest_sha256) = 64 AND
      manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  manifest_json TEXT NOT NULL UNIQUE CHECK (json_valid(manifest_json)),
  release_version TEXT NOT NULL UNIQUE
    CHECK (length(release_version) BETWEEN 1 AND 128),
  release_tag TEXT NOT NULL UNIQUE
    CHECK (release_tag = 'internal-v' || release_version),
  source_sha TEXT NOT NULL
    CHECK (
      length(source_sha) = 40 AND
      source_sha NOT GLOB '*[^0-9a-f]*'
    ),
  artifact_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(artifact_sha256) = 64 AND
      artifact_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  approved_at TEXT NOT NULL CHECK (unixepoch(approved_at) IS NOT NULL),
  CHECK (
    json_extract(manifest_json, '$.schema_version') = 1 AND
    json_extract(manifest_json, '$.kind') = 'echo-internal-live-release' AND
    json_extract(manifest_json, '$.channel') = 'internal-live' AND
    json_extract(manifest_json, '$.release_version') = release_version AND
    json_extract(manifest_json, '$.release_tag') = release_tag AND
    json_extract(manifest_json, '$.source.sha') = source_sha AND
    json_extract(manifest_json, '$.source.kind') = 'materialized-commit' AND
    json_extract(manifest_json, '$.artifact.sha256') = artifact_sha256 AND
    json_extract(manifest_json, '$.artifact.package') = 'echo-brain' AND
    json_extract(manifest_json, '$.compatibility.os') = 'darwin' AND
    json_extract(manifest_json, '$.compatibility.arch') = 'arm64' AND
    json_extract(manifest_json, '$.build.workflow') =
      'internal-live-release.yml' AND
    manifest_url =
      'https://github.com/' ||
      json_extract(manifest_json, '$.build.repository') ||
      '/releases/download/' || replace(release_tag, '+', '%2B') ||
      '/internal-live-release-manifest.v1.json'
  )
) STRICT;

CREATE TRIGGER authority_internal_live_releases_immutable_update
BEFORE UPDATE ON authority_internal_live_releases
BEGIN
  SELECT RAISE(ABORT, 'internal-live releases are immutable');
END;

CREATE TRIGGER authority_internal_live_releases_immutable_delete
BEFORE DELETE ON authority_internal_live_releases
BEGIN
  SELECT RAISE(ABORT, 'internal-live releases cannot be deleted');
END;

CREATE TABLE authority_internal_live_update_receipts (
  receipt_sequence INTEGER PRIMARY KEY AUTOINCREMENT
    CHECK (receipt_sequence > 0),
  transaction_id TEXT NOT NULL UNIQUE
    CHECK (
      length(transaction_id) = 40 AND
      substr(transaction_id, 1, 4) = 'upd_' AND
      length(replace(substr(transaction_id, 5), '-', '')) = 32 AND
      replace(substr(transaction_id, 5), '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
  payload_sha256 TEXT NOT NULL UNIQUE
    CHECK (
      length(payload_sha256) = 71 AND
      substr(payload_sha256, 1, 7) = 'sha256:' AND
      substr(payload_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  receipt_json TEXT NOT NULL UNIQUE CHECK (json_valid(receipt_json)),
  installation_id TEXT NOT NULL CHECK (installation_id GLOB 'ins_*'),
  directive_sequence INTEGER NOT NULL
    REFERENCES authority_internal_live_releases(directive_sequence),
  outcome TEXT NOT NULL CHECK (outcome IN ('healthy', 'rolled_back', 'failed')),
  finished_at TEXT NOT NULL CHECK (unixepoch(finished_at) IS NOT NULL),
  received_at TEXT NOT NULL CHECK (unixepoch(received_at) IS NOT NULL),
  CHECK (
    json_extract(receipt_json, '$.schema_version') = 1 AND
    json_extract(receipt_json, '$.kind') =
      'echo-internal-live-update-receipt' AND
    json_extract(receipt_json, '$.channel') = 'internal-live' AND
    json_extract(receipt_json, '$.transaction_id') = transaction_id AND
    json_extract(receipt_json, '$.installation_id') = installation_id AND
    json_extract(receipt_json, '$.directive_sequence') = directive_sequence AND
    json_extract(receipt_json, '$.outcome') = outcome AND
    json_extract(receipt_json, '$.finished_at') = finished_at AND
    json_extract(receipt_json, '$.integrity.payload_sha256') = payload_sha256
  )
) STRICT;

CREATE INDEX authority_internal_live_update_receipts_rollout
ON authority_internal_live_update_receipts (
  directive_sequence,
  installation_id,
  receipt_sequence DESC
);

CREATE TRIGGER authority_internal_live_update_receipts_immutable_update
BEFORE UPDATE ON authority_internal_live_update_receipts
BEGIN
  SELECT RAISE(ABORT, 'internal-live update receipts are immutable');
END;

CREATE TRIGGER authority_internal_live_update_receipts_immutable_delete
BEFORE DELETE ON authority_internal_live_update_receipts
BEGIN
  SELECT RAISE(ABORT, 'internal-live update receipts cannot be deleted');
END;
