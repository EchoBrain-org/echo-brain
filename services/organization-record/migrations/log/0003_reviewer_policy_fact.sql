-- The append-atomic, text-free reviewer access index for
-- `restricted-reviewer-v1`.
--
-- This is a Layer 1 adjunct, not Layer 2, not a permission-effect ledger, and
-- not an authorization decision. Each row is an address hint plus a frozen
-- policy assertion: it says which reviewer principal and membership approved
-- one released item of one exact canonical record, and nothing else. Every
-- positive candidate is re-proved from its canonical Layer 1 envelope before
-- any content is released.
--
-- The table name and the insert contract fix the policy, so no constant policy
-- column is stored or indexed. There is no text, title, subject, evidence,
-- source locator, meeting or participant field, score, current membership
-- status, or resolved reader here.
--
-- This migration creates an empty table. It backfills nothing: not v1, not the
-- pilot, not legacy, rejection, unknown-version, or prior records.

-- The fact's composite foreign key must bind one exact canonical row rather
-- than a position and a hash that happen to exist separately.
CREATE UNIQUE INDEX organization_record_log_position_record_hash
ON organization_record_log (position, record_hash);

CREATE TABLE organization_record_reviewer_policy_fact (
  reviewer_principal_id TEXT NOT NULL CHECK (
    reviewer_principal_id GLOB 'prn_*' AND length(reviewer_principal_id) > 4
  ),
  reviewer_membership_id TEXT NOT NULL CHECK (
    reviewer_membership_id GLOB 'mem_*' AND length(reviewer_membership_id) > 4
  ),
  log_position INTEGER NOT NULL CHECK (log_position > 0),
  record_hash TEXT NOT NULL CHECK (
    length(record_hash) = 71 AND
    substr(record_hash, 1, 7) = 'sha256:' AND
    substr(record_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  -- Zero-based canonical draft/projector order. The frozen release draft is
  -- bounded to ten items, so a wider order is impossible input.
  atom_order INTEGER NOT NULL CHECK (atom_order BETWEEN 0 AND 9),
  signal_id_sha256 TEXT NOT NULL CHECK (
    length(signal_id_sha256) = 71 AND
    substr(signal_id_sha256, 1, 7) = 'sha256:' AND
    substr(signal_id_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  atom_id TEXT NOT NULL PRIMARY KEY CHECK (
    length(atom_id) = 71 AND
    substr(atom_id, 1, 7) = 'sha256:' AND
    substr(atom_id, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  semantic_intent_sha256 TEXT NOT NULL CHECK (
    length(semantic_intent_sha256) = 71 AND
    substr(semantic_intent_sha256, 1, 7) = 'sha256:' AND
    substr(semantic_intent_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  authorization_audit_event_id TEXT NOT NULL CHECK (
    authorization_audit_event_id GLOB 'aud_*' AND
    length(authorization_audit_event_id) > 4
  ),
  authorization_audit_entry_sha256 TEXT NOT NULL CHECK (
    length(authorization_audit_entry_sha256) = 71 AND
    substr(authorization_audit_entry_sha256, 1, 7) = 'sha256:' AND
    substr(authorization_audit_entry_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  authorization_proof_sha256 TEXT NOT NULL CHECK (
    length(authorization_proof_sha256) = 71 AND
    substr(authorization_proof_sha256, 1, 7) = 'sha256:' AND
    substr(authorization_proof_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE (log_position, atom_order),
  UNIQUE (log_position, signal_id_sha256),
  FOREIGN KEY (log_position, record_hash)
    REFERENCES organization_record_log (position, record_hash)
) STRICT;

-- The serving index. The exact reviewer query names it with `INDEXED BY`, so a
-- planner change can never silently widen the candidate set into another
-- reviewer's facts or into a table scan.
CREATE INDEX organization_record_reviewer_policy_fact_by_reviewer
ON organization_record_reviewer_policy_fact (
  reviewer_principal_id,
  reviewer_membership_id,
  log_position DESC,
  atom_order ASC
);

-- Immutable after insert. There is no fact repair, reconstruction, backfill,
-- or mutable shadow index in V1: an incomplete or corrupt fact state keeps
-- reviewer reads and new reviewer-v2 ingest unavailable until a complete
-- known-good restore and its operator reconciliation gate.
CREATE TRIGGER organization_record_reviewer_policy_fact_immutable_update
BEFORE UPDATE ON organization_record_reviewer_policy_fact
BEGIN
  SELECT RAISE(ABORT, 'organization record reviewer policy fact is immutable');
END;

CREATE TRIGGER organization_record_reviewer_policy_fact_immutable_delete
BEFORE DELETE ON organization_record_reviewer_policy_fact
BEGIN
  SELECT RAISE(ABORT, 'organization record reviewer policy fact cannot be deleted');
END;

-- SQLite has no hashing function, so it does not pretend to prove the digests.
-- What it can prove without one is enforced here: a fact must bind an exact
-- canonical approval row at the same position and hash, whose envelope frame is
-- the reviewer-v2 approval family, and whose reviewer actor, semantic digest,
-- reason, and audit event id are exactly the ones the fact claims. Complete
-- item count, signal/order/atom derivation, audit-entry and proof digests, and
-- capability validity are proved by pure application code before insert.
CREATE TRIGGER organization_record_reviewer_policy_fact_bound_insert
BEFORE INSERT ON organization_record_reviewer_policy_fact
WHEN NOT EXISTS (
  SELECT 1
  FROM organization_record_log AS record
  WHERE record.position = NEW.log_position
    AND record.record_hash = NEW.record_hash
    AND record.event_type = 'approval'
    AND json_valid(record.canonical_envelope)
    AND json_extract(record.canonical_envelope, '$.schema_version') = 2
    AND json_extract(record.canonical_envelope, '$.kind') =
      'echo-organization-record-envelope'
    AND json_extract(record.canonical_envelope, '$.event_type') = 'approval'
    AND json_extract(record.canonical_envelope, '$.intent.policy_id') =
      'restricted-reviewer-v1'
    AND json_extract(record.canonical_envelope, '$.intent.visibility') =
      'restricted'
    AND json_extract(record.canonical_envelope, '$.reviewer.principal_id') =
      NEW.reviewer_principal_id
    AND json_extract(record.canonical_envelope, '$.reviewer.membership_id') =
      NEW.reviewer_membership_id
    AND json_extract(
      record.canonical_envelope,
      '$.reviewer.authorization.semantic_intent_sha256'
    ) = NEW.semantic_intent_sha256
    AND json_extract(
      record.canonical_envelope,
      '$.intent.provenance.semantic_intent_sha256'
    ) = NEW.semantic_intent_sha256
    AND json_extract(
      record.canonical_envelope,
      '$.reviewer.authorization.reason_code'
    ) = 'active_reviewer_restricted_notice_v1'
    AND json_extract(
      record.canonical_envelope,
      '$.reviewer.authorization.allowed'
    ) = 1
    AND json_extract(
      record.canonical_envelope,
      '$.reviewer.authorization.action'
    ) = 'approve'
    AND json_extract(
      record.canonical_envelope,
      '$.reviewer.authorization.authorization_audit_event_id'
    ) = NEW.authorization_audit_event_id
    AND json_extract(
      record.canonical_envelope,
      '$.reviewer.authorization.authorization_audit_entry_sha256'
    ) = NEW.authorization_audit_entry_sha256
)
BEGIN
  SELECT RAISE(
    ABORT,
    'organization record reviewer policy fact is not bound to an exact verified reviewer-v2 approval'
  );
END;
