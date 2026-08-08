-- The immutable organization decision record log. Truth.
--
-- Every row is one human act a member machine submitted and the authority
-- verified. Nothing here is derived, and nothing here is ever rewritten: the
-- update and delete triggers reject mutation through ordinary code paths, and
-- the record hash chain detects mutation performed out of band.

CREATE TABLE organization_record_log_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  organization_id TEXT NOT NULL CHECK (length(organization_id) > 0),
  authority_id TEXT NOT NULL CHECK (length(authority_id) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
) STRICT;

CREATE TRIGGER organization_record_log_metadata_immutable_update
BEFORE UPDATE ON organization_record_log_metadata
BEGIN
  SELECT RAISE(ABORT, 'organization record log metadata is immutable');
END;

CREATE TRIGGER organization_record_log_metadata_immutable_delete
BEFORE DELETE ON organization_record_log_metadata
BEGIN
  SELECT RAISE(ABORT, 'organization record log metadata cannot be deleted');
END;

-- `canonical_envelope` holds the exact RFC 8785 canonical bytes of the signed
-- envelope the submitter froze. `receipt_payload` holds the deterministic
-- receipt payload committed with the row, so a crash between append and
-- receipt signing loses no receipt content.
CREATE TABLE organization_record_log (
  position INTEGER PRIMARY KEY CHECK (position > 0),
  envelope_id TEXT NOT NULL UNIQUE CHECK (length(envelope_id) > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('approval', 'rejection')),
  installation_id TEXT NOT NULL CHECK (length(installation_id) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  canonical_envelope TEXT NOT NULL CHECK (length(canonical_envelope) > 0),
  envelope_sha256 TEXT NOT NULL CHECK (envelope_sha256 LIKE 'sha256:%'),
  receipt_payload TEXT NOT NULL CHECK (length(receipt_payload) > 0),
  previous_record_hash TEXT CHECK (
    previous_record_hash IS NULL OR previous_record_hash LIKE 'sha256:%'
  ),
  record_hash TEXT NOT NULL UNIQUE CHECK (record_hash LIKE 'sha256:%'),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) > 0),
  UNIQUE (installation_id, idempotency_key)
) STRICT;

CREATE TRIGGER organization_record_log_immutable_update
BEFORE UPDATE ON organization_record_log
BEGIN
  SELECT RAISE(ABORT, 'organization record log is append-only');
END;

CREATE TRIGGER organization_record_log_immutable_delete
BEFORE DELETE ON organization_record_log
BEGIN
  SELECT RAISE(ABORT, 'organization record log rows cannot be deleted');
END;

CREATE TRIGGER organization_record_log_contiguous_insert
BEFORE INSERT ON organization_record_log
WHEN NEW.position <>
  COALESCE((SELECT MAX(position) FROM organization_record_log), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'organization record log positions must be contiguous');
END;

CREATE TRIGGER organization_record_log_chain_link_insert
BEFORE INSERT ON organization_record_log
WHEN NEW.previous_record_hash IS NOT (
  SELECT record_hash FROM organization_record_log WHERE position = NEW.position - 1
)
BEGIN
  SELECT RAISE(ABORT, 'organization record log predecessor hash must match');
END;

-- The signed receipt is materialized after the append transaction commits, so
-- it cannot live on the append-only row without an UPDATE. It is create-once
-- in its own table: a retry after a crash in that window materializes the
-- receipt from the stored payload without appending a second record.
CREATE TABLE organization_record_signed_receipt (
  position INTEGER PRIMARY KEY
    REFERENCES organization_record_log (position),
  signed_receipt TEXT NOT NULL CHECK (length(signed_receipt) > 0),
  materialized_at TEXT NOT NULL CHECK (length(materialized_at) > 0)
) STRICT;

CREATE TRIGGER organization_record_signed_receipt_immutable_update
BEFORE UPDATE ON organization_record_signed_receipt
BEGIN
  SELECT RAISE(ABORT, 'organization record signed receipt is create-once');
END;

CREATE TRIGGER organization_record_signed_receipt_immutable_delete
BEFORE DELETE ON organization_record_signed_receipt
BEGIN
  SELECT RAISE(ABORT, 'organization record signed receipt cannot be deleted');
END;
