-- 0017 froze approval envelopes only. Keep every existing frozen byte and
-- widen the immutable slot so the same core act can append a schema-v1
-- rejection before terminalization.

DROP TRIGGER authority_processing_frozen_record_envelopes_immutable;
ALTER TABLE authority_processing_frozen_record_envelopes
  RENAME TO authority_processing_frozen_record_envelopes_0017;

CREATE TABLE authority_processing_frozen_record_envelopes (
  processing_key TEXT PRIMARY KEY
    REFERENCES authority_processing_candidates(processing_key) ON DELETE CASCADE,
  approval_id TEXT NOT NULL UNIQUE CHECK (
    length(approval_id) = 64 AND
    approval_id NOT GLOB '*[^0-9a-f]*'
  ),
  envelope_id TEXT NOT NULL UNIQUE CHECK (length(envelope_id) BETWEEN 1 AND 256),
  event_type TEXT NOT NULL CHECK (event_type IN ('approval', 'rejection')),
  envelope_sha256 TEXT NOT NULL CHECK (
    length(envelope_sha256) = 71 AND
    substr(envelope_sha256, 1, 7) = 'sha256:' AND
    substr(envelope_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  envelope_json TEXT NOT NULL CHECK (
    json_valid(envelope_json) AND json_type(envelope_json) = 'object'
  ),
  created_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL AND
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
  )
) STRICT;

INSERT INTO authority_processing_frozen_record_envelopes (
  processing_key, approval_id, envelope_id, event_type,
  envelope_sha256, envelope_json, created_at
)
SELECT processing_key, approval_id, envelope_id, event_type,
       envelope_sha256, envelope_json, created_at
  FROM authority_processing_frozen_record_envelopes_0017;

DROP TABLE authority_processing_frozen_record_envelopes_0017;

CREATE TRIGGER authority_processing_frozen_record_envelopes_immutable
BEFORE UPDATE ON authority_processing_frozen_record_envelopes
BEGIN
  SELECT RAISE(ABORT, 'authority processing frozen record envelope is create-once');
END;
