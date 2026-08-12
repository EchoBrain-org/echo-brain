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
  plane TEXT NOT NULL CHECK (plane = 'lexical'),
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

CREATE TRIGGER retrieval_lexical_migration_ledger_immutable_update
BEFORE UPDATE ON retrieval_schema_migrations
BEGIN SELECT RAISE(ABORT, 'readable-search lexical migration ledger is immutable'); END;
CREATE TRIGGER retrieval_lexical_migration_ledger_immutable_delete
BEFORE DELETE ON retrieval_schema_migrations
BEGIN SELECT RAISE(ABORT, 'readable-search lexical migration ledger cannot be deleted'); END;

CREATE TABLE retrieval_lexical_document (
  atom_id TEXT PRIMARY KEY,
  log_position INTEGER NOT NULL CHECK (log_position > 0),
  atom_order INTEGER NOT NULL CHECK (atom_order >= 0),
  content_binding_sha256 TEXT NOT NULL,
  UNIQUE(log_position, atom_order)
) STRICT;

CREATE TABLE retrieval_term_posting (
  term TEXT NOT NULL,
  atom_id TEXT NOT NULL REFERENCES retrieval_lexical_document(atom_id),
  term_frequency INTEGER NOT NULL CHECK (term_frequency > 0),
  PRIMARY KEY (term, atom_id)
) STRICT;

CREATE TRIGGER retrieval_lexical_metadata_immutable_update
BEFORE UPDATE ON retrieval_plane_metadata
WHEN OLD.finalized = 1
BEGIN SELECT RAISE(ABORT, 'readable-search lexical plane is finalized'); END;
CREATE TRIGGER retrieval_lexical_documents_immutable_insert
BEFORE INSERT ON retrieval_lexical_document
WHEN (SELECT finalized FROM retrieval_plane_metadata WHERE singleton = 1) = 1
BEGIN SELECT RAISE(ABORT, 'readable-search lexical plane is finalized'); END;
CREATE TRIGGER retrieval_lexical_postings_immutable_insert
BEFORE INSERT ON retrieval_term_posting
WHEN (SELECT finalized FROM retrieval_plane_metadata WHERE singleton = 1) = 1
BEGIN SELECT RAISE(ABORT, 'readable-search lexical plane is finalized'); END;
CREATE TRIGGER retrieval_lexical_documents_immutable_update
BEFORE UPDATE ON retrieval_lexical_document
BEGIN SELECT RAISE(ABORT, 'readable-search lexical documents are immutable'); END;
CREATE TRIGGER retrieval_lexical_documents_immutable_delete
BEFORE DELETE ON retrieval_lexical_document
BEGIN SELECT RAISE(ABORT, 'readable-search lexical documents cannot be deleted'); END;
CREATE TRIGGER retrieval_lexical_postings_immutable_update
BEFORE UPDATE ON retrieval_term_posting
BEGIN SELECT RAISE(ABORT, 'readable-search lexical postings are immutable'); END;
CREATE TRIGGER retrieval_lexical_postings_immutable_delete
BEFORE DELETE ON retrieval_term_posting
BEGIN SELECT RAISE(ABORT, 'readable-search lexical postings cannot be deleted'); END;
