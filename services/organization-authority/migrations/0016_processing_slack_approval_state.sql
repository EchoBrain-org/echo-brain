-- Durable state required by the Slack approval adapter. Approval requests and
-- terminal core decisions remain in the v11 tables; these sidecars freeze the
-- exact Slack presentation, its provider reference, and authorization evidence.

CREATE TABLE authority_processing_approval_presentation_contracts (
  processing_key TEXT PRIMARY KEY
    REFERENCES authority_processing_candidates(processing_key) ON DELETE CASCADE,
  approval_id TEXT NOT NULL UNIQUE CHECK (
    length(approval_id) = 64 AND
    approval_id NOT GLOB '*[^0-9a-f]*'
  ),
  contract_mode TEXT NOT NULL CHECK (
    contract_mode IN ('restricted-reviewer-v1', 'organization-member-readable-v1')
  ),
  contract_sha256 TEXT NOT NULL CHECK (
    length(contract_sha256) = 71 AND
    substr(contract_sha256, 1, 7) = 'sha256:' AND
    substr(contract_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  contract_json TEXT NOT NULL CHECK (
    json_valid(contract_json) AND json_type(contract_json) = 'object'
  ),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  )
) STRICT;

CREATE TRIGGER authority_processing_approval_presentation_contracts_immutable
BEFORE UPDATE ON authority_processing_approval_presentation_contracts
BEGIN
  SELECT RAISE(ABORT, 'authority processing approval presentation contract is create-once');
END;

CREATE TABLE authority_processing_approval_publications (
  processing_key TEXT NOT NULL
    REFERENCES authority_processing_candidates(processing_key) ON DELETE CASCADE,
  approval_id TEXT NOT NULL CHECK (
    length(approval_id) = 64 AND
    approval_id NOT GLOB '*[^0-9a-f]*'
  ),
  surface TEXT NOT NULL CHECK (length(surface) BETWEEN 1 AND 128),
  reference_sha256 TEXT NOT NULL CHECK (
    length(reference_sha256) = 71 AND
    substr(reference_sha256, 1, 7) = 'sha256:' AND
    substr(reference_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  reference_json TEXT NOT NULL CHECK (
    json_valid(reference_json) AND json_type(reference_json) = 'object'
  ),
  published_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', published_at) IS NOT NULL AND
    published_at = strftime('%Y-%m-%dT%H:%M:%fZ', published_at)
  ),
  PRIMARY KEY (processing_key, surface),
  UNIQUE (approval_id, surface)
) STRICT;

CREATE TRIGGER authority_processing_approval_publications_immutable
BEFORE UPDATE ON authority_processing_approval_publications
BEGIN
  SELECT RAISE(ABORT, 'authority processing approval publication is create-once');
END;

CREATE TABLE authority_processing_approval_resolution_metadata (
  processing_key TEXT PRIMARY KEY
    REFERENCES authority_processing_resolutions(processing_key) ON DELETE CASCADE,
  approval_id TEXT NOT NULL UNIQUE CHECK (
    length(approval_id) = 64 AND
    approval_id NOT GLOB '*[^0-9a-f]*'
  ),
  surface TEXT NOT NULL CHECK (length(surface) BETWEEN 1 AND 128),
  metadata_sha256 TEXT NOT NULL CHECK (
    length(metadata_sha256) = 71 AND
    substr(metadata_sha256, 1, 7) = 'sha256:' AND
    substr(metadata_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  metadata_json TEXT NOT NULL CHECK (
    json_valid(metadata_json) AND json_type(metadata_json) = 'object'
  ),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  )
) STRICT;

CREATE TRIGGER authority_processing_approval_resolution_metadata_immutable
BEFORE UPDATE ON authority_processing_approval_resolution_metadata
BEGIN
  SELECT RAISE(ABORT, 'authority processing approval resolution metadata is create-once');
END;
