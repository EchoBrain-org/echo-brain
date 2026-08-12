-- Append-atomic, text-free facts for the closed schema-v3
-- `organization-member-readable-v1` admission family.  This is a parallel
-- fact family, never a nullable extension of reviewer facts and never a
-- reader list or a broad-derived projection.  Existing rows are not backfilled.

CREATE TABLE organization_member_readable_policy_fact (
  log_position INTEGER NOT NULL CHECK (log_position > 0),
  record_hash TEXT NOT NULL CHECK (length(record_hash) = 71 AND substr(record_hash, 1, 7) = 'sha256:'),
  organization_id TEXT NOT NULL CHECK (organization_id GLOB 'org_*'),
  envelope_sha256 TEXT NOT NULL CHECK (length(envelope_sha256) = 71 AND substr(envelope_sha256, 1, 7) = 'sha256:'),
  atom_order INTEGER NOT NULL CHECK (atom_order BETWEEN 0 AND 9),
  atom_id TEXT NOT NULL PRIMARY KEY CHECK (length(atom_id) = 71 AND substr(atom_id, 1, 7) = 'sha256:'),
  signal_id_sha256 TEXT NOT NULL CHECK (length(signal_id_sha256) = 71 AND substr(signal_id_sha256, 1, 7) = 'sha256:'),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('decision', 'action', 'rationale')),
  policy_id TEXT NOT NULL CHECK (policy_id = 'organization-member-readable-v1'),
  policy_contract_sha256 TEXT NOT NULL CHECK (length(policy_contract_sha256) = 71 AND substr(policy_contract_sha256, 1, 7) = 'sha256:'),
  approving_principal_id TEXT NOT NULL CHECK (approving_principal_id GLOB 'prn_*'),
  approving_membership_id TEXT NOT NULL CHECK (approving_membership_id GLOB 'mem_*'),
  release_draft_sha256 TEXT NOT NULL CHECK (length(release_draft_sha256) = 71 AND substr(release_draft_sha256, 1, 7) = 'sha256:'),
  approval_presentation_sha256 TEXT NOT NULL CHECK (length(approval_presentation_sha256) = 71 AND substr(approval_presentation_sha256, 1, 7) = 'sha256:'),
  semantic_intent_sha256 TEXT NOT NULL CHECK (length(semantic_intent_sha256) = 71 AND substr(semantic_intent_sha256, 1, 7) = 'sha256:'),
  message_presentation_sha256 TEXT NOT NULL CHECK (length(message_presentation_sha256) = 71 AND substr(message_presentation_sha256, 1, 7) = 'sha256:'),
  authorization_audit_event_id TEXT NOT NULL CHECK (authorization_audit_event_id GLOB 'aud_*'),
  authorization_audit_entry_sha256 TEXT NOT NULL CHECK (length(authorization_audit_entry_sha256) = 71 AND substr(authorization_audit_entry_sha256, 1, 7) = 'sha256:'),
  evaluated_at TEXT NOT NULL CHECK (length(evaluated_at) > 0),
  authorization_proof_sha256 TEXT NOT NULL CHECK (length(authorization_proof_sha256) = 71 AND substr(authorization_proof_sha256, 1, 7) = 'sha256:'),
  content_binding_sha256 TEXT NOT NULL CHECK (length(content_binding_sha256) = 71 AND substr(content_binding_sha256, 1, 7) = 'sha256:'),
  provenance_binding_sha256 TEXT NOT NULL CHECK (length(provenance_binding_sha256) = 71 AND substr(provenance_binding_sha256, 1, 7) = 'sha256:'),
  UNIQUE (log_position, atom_order),
  UNIQUE (log_position, signal_id_sha256),
  FOREIGN KEY (log_position, record_hash)
    REFERENCES organization_record_log (position, record_hash)
) STRICT;

CREATE INDEX organization_member_readable_policy_fact_by_record
ON organization_member_readable_policy_fact (log_position, atom_order);

CREATE TRIGGER organization_member_readable_policy_fact_immutable_update
BEFORE UPDATE ON organization_member_readable_policy_fact
BEGIN SELECT RAISE(ABORT, 'organization member readable policy fact is immutable'); END;

CREATE TRIGGER organization_member_readable_policy_fact_immutable_delete
BEFORE DELETE ON organization_member_readable_policy_fact
BEGIN SELECT RAISE(ABORT, 'organization member readable policy fact cannot be deleted'); END;

-- SQLite checks only the exact canonical-record relationship it can prove.
-- Complete fact-set density and all digest/preimage equivalence are proved by
-- pure application projection before these strict inserts run.
CREATE TRIGGER organization_member_readable_policy_fact_bound_insert
BEFORE INSERT ON organization_member_readable_policy_fact
WHEN NOT EXISTS (
  SELECT 1 FROM organization_record_log AS record
  WHERE record.position = NEW.log_position
    AND record.record_hash = NEW.record_hash
    AND record.envelope_sha256 = NEW.envelope_sha256
    AND record.event_type = 'approval'
    AND json_valid(record.canonical_envelope)
    AND json_extract(record.canonical_envelope, '$.kind') = 'echo-organization-record-envelope'
    AND json_extract(record.canonical_envelope, '$.schema_version') = 3
    AND json_extract(record.canonical_envelope, '$.event_type') = 'approval'
    AND json_extract(record.canonical_envelope, '$.intent.policy_id') = 'organization-member-readable-v1'
    AND json_extract(record.canonical_envelope, '$.intent.visibility') = 'organization-member-readable'
)
BEGIN SELECT RAISE(ABORT, 'organization member readable policy fact is not bound to an exact schema-v3 approval'); END;
