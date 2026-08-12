CREATE TABLE retrieval_schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  filename TEXT NOT NULL UNIQUE,
  migration_sha256 TEXT NOT NULL,
  schema_sha256 TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE retrieval_plane_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  plane TEXT NOT NULL CHECK (plane = 'content'),
  organization_id TEXT NOT NULL,
  segment_id TEXT NOT NULL UNIQUE,
  segment_kind TEXT NOT NULL CHECK (segment_kind IN ('organization-member', 'reviewer')),
  policy_id TEXT NOT NULL CHECK (policy_id IN ('organization-member-readable-v1', 'restricted-reviewer-v1')),
  policy_contract_sha256 TEXT NOT NULL,
  reviewer_principal_id TEXT,
  reviewer_membership_id TEXT,
  analyzer_contract_sha256 TEXT NOT NULL,
  finalized INTEGER NOT NULL DEFAULT 0 CHECK (finalized IN (0, 1)),
  CHECK (
    (segment_kind = 'organization-member' AND policy_id = 'organization-member-readable-v1' AND reviewer_principal_id IS NULL AND reviewer_membership_id IS NULL) OR
    (segment_kind = 'reviewer' AND policy_id = 'restricted-reviewer-v1' AND reviewer_principal_id IS NOT NULL AND reviewer_membership_id IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER retrieval_content_migration_ledger_immutable_update
BEFORE UPDATE ON retrieval_schema_migrations
BEGIN SELECT RAISE(ABORT, 'readable-search content migration ledger is immutable'); END;
CREATE TRIGGER retrieval_content_migration_ledger_immutable_delete
BEFORE DELETE ON retrieval_schema_migrations
BEGIN SELECT RAISE(ABORT, 'readable-search content migration ledger cannot be deleted'); END;

CREATE TABLE retrieval_content_atom (
  atom_id TEXT PRIMARY KEY,
  log_position INTEGER NOT NULL CHECK (log_position > 0),
  record_hash TEXT NOT NULL,
  atom_order INTEGER NOT NULL CHECK (atom_order >= 0),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('decision', 'action', 'rationale')),
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  content_binding_sha256 TEXT NOT NULL,
  provenance_binding_sha256 TEXT NOT NULL,
  UNIQUE(log_position, atom_order)
) STRICT;

CREATE TRIGGER retrieval_content_metadata_immutable_update
BEFORE UPDATE ON retrieval_plane_metadata
WHEN OLD.finalized = 1
BEGIN SELECT RAISE(ABORT, 'readable-search content plane is finalized'); END;
CREATE TRIGGER retrieval_content_rows_immutable_insert
BEFORE INSERT ON retrieval_content_atom
WHEN (SELECT finalized FROM retrieval_plane_metadata WHERE singleton = 1) = 1
BEGIN SELECT RAISE(ABORT, 'readable-search content plane is finalized'); END;
CREATE TRIGGER retrieval_content_rows_immutable_update
BEFORE UPDATE ON retrieval_content_atom
BEGIN SELECT RAISE(ABORT, 'readable-search content is immutable'); END;
CREATE TRIGGER retrieval_content_rows_immutable_delete
BEFORE DELETE ON retrieval_content_atom
BEGIN SELECT RAISE(ABORT, 'readable-search content is immutable'); END;
