-- Operational compatibility for envelope v2 in the landed derived follower.
--
-- Reviewer V1 does not serve content from `record-derived.sqlite`, but the
-- follower still has to say something deterministic when the log gains a
-- reviewer-v2 record. It writes exactly one text-free exclusion row and
-- advances the cursor in the same transaction. No reviewer-v2 text, title,
-- subject, evidence, snapshot, observation, or edge reaches the broad v1
-- tables.
--
-- This row is not a visibility fact, not a candidate, and not a B generation.
-- A never reads it while serving. B later rebuilds from canonical Layer 1
-- records under its own contract and does not reinterpret this row.

CREATE TABLE organization_derived_reviewer_policy_exclusion (
  log_position INTEGER PRIMARY KEY CHECK (log_position > 0),
  record_hash TEXT NOT NULL UNIQUE CHECK (
    length(record_hash) = 71 AND
    substr(record_hash, 1, 7) = 'sha256:' AND
    substr(record_hash, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 2),
  policy_id TEXT NOT NULL CHECK (policy_id = 'restricted-reviewer-v1'),
  outcome TEXT NOT NULL CHECK (
    outcome = 'deferred-to-permission-aware-retrieval'
  )
) STRICT;

CREATE TRIGGER organization_derived_reviewer_policy_exclusion_immutable_update
BEFORE UPDATE ON organization_derived_reviewer_policy_exclusion
BEGIN
  SELECT RAISE(ABORT, 'organization derived reviewer policy exclusion is immutable');
END;

CREATE TRIGGER organization_derived_reviewer_policy_exclusion_immutable_delete
BEFORE DELETE ON organization_derived_reviewer_policy_exclusion
BEGIN
  SELECT RAISE(ABORT, 'organization derived reviewer policy exclusion cannot be deleted');
END;
