-- New-lineage baseline v1 for the readable-search lexical plane database role.
-- One exact baseline replaces the historical migration chain: the applier
-- stamps application_id and user_version = 1 on an empty database and this
-- file creates the complete behavior schema. The legacy migration-ledger
-- objects are deliberately absent; new-lineage schema identity is carried by
-- the state-lineage manifest digest and the pre-open guard's exact-version
-- check. Never edit this file in place; a schema change is a new dated
-- baseline or a new-lineage migration with its own disposition.

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
