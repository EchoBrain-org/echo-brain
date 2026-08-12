-- Schema-v3 organization-member-readable records remain outside the broad
-- v1 derived graph.  The follower records exactly one text-free compatibility
-- exclusion and advances its cursor in the same transaction.
CREATE TABLE organization_derived_member_readable_policy_exclusion (
  log_position INTEGER PRIMARY KEY CHECK (log_position > 0),
  record_hash TEXT NOT NULL UNIQUE CHECK (length(record_hash) = 71 AND substr(record_hash, 1, 7) = 'sha256:'),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 3),
  policy_id TEXT NOT NULL CHECK (policy_id = 'organization-member-readable-v1'),
  outcome TEXT NOT NULL CHECK (outcome = 'deferred-to-permission-aware-retrieval')
) STRICT;
CREATE TRIGGER organization_derived_member_readable_policy_exclusion_immutable_update
BEFORE UPDATE ON organization_derived_member_readable_policy_exclusion
BEGIN SELECT RAISE(ABORT, 'organization derived member readable exclusion is immutable'); END;
CREATE TRIGGER organization_derived_member_readable_policy_exclusion_immutable_delete
BEFORE DELETE ON organization_derived_member_readable_policy_exclusion
BEGIN SELECT RAISE(ABORT, 'organization derived member readable exclusion cannot be deleted'); END;
