CREATE TABLE core_source_cursors (
  source_adapter_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  source_version     TEXT NOT NULL,
  cursor             TEXT NOT NULL,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (source_adapter_id, source_instance_id)
);

CREATE TABLE core_processed_markers (
  processing_key TEXT PRIMARY KEY,
  marked_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE core_meeting_documents (
  source_adapter_id  TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  meeting_revision   TEXT NOT NULL,
  meeting_id         TEXT NOT NULL,
  document_json      TEXT NOT NULL CHECK (json_valid(document_json)),
  saved_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (
    source_adapter_id,
    source_instance_id,
    external_id,
    meeting_revision
  )
);
CREATE INDEX idx_core_meeting_documents_id
  ON core_meeting_documents(meeting_id, meeting_revision);

CREATE TABLE core_decision_sets (
  source_adapter_id    TEXT NOT NULL,
  source_instance_id   TEXT NOT NULL,
  external_id          TEXT NOT NULL,
  meeting_id           TEXT NOT NULL,
  meeting_revision     TEXT NOT NULL,
  processor_adapter_id TEXT NOT NULL,
  processor_instance_id TEXT NOT NULL,
  processor_version    TEXT NOT NULL,
  document_json        TEXT NOT NULL CHECK (json_valid(document_json)),
  saved_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (
    source_adapter_id,
    source_instance_id,
    external_id,
    meeting_revision,
    processor_adapter_id,
    processor_instance_id,
    processor_version
  )
);

CREATE TABLE core_approvals (
  processing_key TEXT PRIMARY KEY,
  decision_json  TEXT NOT NULL CHECK (json_valid(decision_json)),
  saved_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE core_delivery_receipts (
  idempotency_key TEXT PRIMARY KEY,
  envelope_id     TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (
    status IN ('delivered', 'rejected', 'failed', 'unknown')
  ),
  envelope_json   TEXT NOT NULL CHECK (json_valid(envelope_json)),
  receipt_json    TEXT NOT NULL CHECK (json_valid(receipt_json)),
  saved_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
