CREATE TABLE IF NOT EXISTS organization_sync_authorities (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL UNIQUE,
  authority_key_id TEXT NOT NULL,
  descriptor_sha256 TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json))
) STRICT;

CREATE TABLE IF NOT EXISTS organization_sync_enrollments (
  enrollment_id TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  enrollment_receipt_sha256 TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  FOREIGN KEY (authority_id) REFERENCES organization_sync_authorities(authority_id),
  UNIQUE (authority_id, installation_id)
) STRICT;

CREATE TABLE IF NOT EXISTS organization_sync_states (
  authority_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  enrollment_id TEXT NOT NULL,
  enrollment_receipt_sha256 TEXT NOT NULL,
  acknowledged_sequence INTEGER NOT NULL DEFAULT 0
    CHECK (acknowledged_sequence >= 0),
  acknowledged_event_hash TEXT,
  terminal_status TEXT NOT NULL DEFAULT 'active'
    CHECK (terminal_status IN ('active', 'revoked')),
  PRIMARY KEY (authority_id, installation_id),
  FOREIGN KEY (enrollment_id) REFERENCES organization_sync_enrollments(enrollment_id),
  CHECK (
    (acknowledged_sequence = 0 AND acknowledged_event_hash IS NULL) OR
    (acknowledged_sequence > 0 AND acknowledged_event_hash IS NOT NULL)
  )
) STRICT;

CREATE TABLE IF NOT EXISTS organization_sync_batch_receipts (
  receipt_id TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  batch_sha256 TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL
    CHECK (status IN ('accepted', 'duplicate', 'rejected')),
  receipt_sha256 TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  FOREIGN KEY (authority_id, installation_id)
    REFERENCES organization_sync_states(authority_id, installation_id)
) STRICT;

CREATE INDEX IF NOT EXISTS organization_sync_batch_receipts_installation
  ON organization_sync_batch_receipts (authority_id, installation_id);
