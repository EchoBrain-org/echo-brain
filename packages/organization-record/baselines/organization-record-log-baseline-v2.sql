-- New-lineage baseline v2 for immutable Organization Record truth.
--
-- The signed v4 record is its own hash-chain frame.  A receipt seed is
-- committed with that record so a post-commit retry can materialize the same
-- receipt rather than sample a new receipt timestamp.

CREATE TABLE organization_record_log_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_id TEXT NOT NULL CHECK (length(authority_id) > 0),
  organization_id TEXT NOT NULL CHECK (length(organization_id) > 0),
  state_lineage_id TEXT NOT NULL CHECK (length(state_lineage_id) > 0),
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

CREATE TABLE organization_record_log (
  position INTEGER PRIMARY KEY CHECK (position > 0),
  envelope_id TEXT NOT NULL UNIQUE CHECK (length(envelope_id) > 0),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('approved', 'rejected')),
  approval_id TEXT NOT NULL CHECK (length(approval_id) > 0),
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject')),
  semantic_idempotency_key TEXT NOT NULL UNIQUE CHECK (
    length(semantic_idempotency_key) = 71 AND
    substr(semantic_idempotency_key, 1, 7) = 'sha256:' AND
    substr(semantic_idempotency_key, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  canonical_envelope TEXT NOT NULL CHECK (length(canonical_envelope) > 0),
  envelope_sha256 TEXT NOT NULL CHECK (
    length(envelope_sha256) = 71 AND
    substr(envelope_sha256, 1, 7) = 'sha256:' AND
    substr(envelope_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  predecessor_position INTEGER CHECK (
    predecessor_position IS NULL OR predecessor_position > 0
  ),
  predecessor_record_sha256 TEXT CHECK (
    predecessor_record_sha256 IS NULL OR (
      length(predecessor_record_sha256) = 71 AND
      substr(predecessor_record_sha256, 1, 7) = 'sha256:' AND
      substr(predecessor_record_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  record_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(record_sha256) = 71 AND
    substr(record_sha256, 1, 7) = 'sha256:' AND
    substr(record_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_payload TEXT NOT NULL CHECK (length(receipt_payload) > 0),
  receipt_issued_at TEXT NOT NULL CHECK (length(receipt_issued_at) > 0),
  UNIQUE (approval_id, action),
  CHECK (
    (predecessor_position IS NULL AND predecessor_record_sha256 IS NULL) OR
    (predecessor_position IS NOT NULL AND predecessor_record_sha256 IS NOT NULL)
  ),
  CHECK (
    (event_kind = 'approved' AND action = 'approve') OR
    (event_kind = 'rejected' AND action = 'reject')
  )
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
WHEN NEW.position <> COALESCE((SELECT MAX(position) FROM organization_record_log), 0) + 1
BEGIN
  SELECT RAISE(ABORT, 'organization record log positions must be contiguous');
END;

CREATE TRIGGER organization_record_log_chain_link_insert
BEFORE INSERT ON organization_record_log
WHEN NOT (
  (NEW.position = 1 AND
   NEW.predecessor_position IS NULL AND
   NEW.predecessor_record_sha256 IS NULL) OR
  (NEW.position > 1 AND
   NEW.predecessor_position = NEW.position - 1 AND
   NEW.predecessor_record_sha256 IS (
     SELECT record_sha256 FROM organization_record_log WHERE position = NEW.position - 1
   ))
)
BEGIN
  SELECT RAISE(ABORT, 'organization record log predecessor must match the current head');
END;

CREATE TRIGGER organization_record_log_v4_bound_insert
BEFORE INSERT ON organization_record_log
WHEN NOT EXISTS (
  SELECT 1
  FROM organization_record_log_metadata AS metadata
  WHERE metadata.singleton = 1
    AND json_valid(NEW.canonical_envelope)
    AND json_extract(NEW.canonical_envelope, '$.body.schema_version') = 4
    AND json_extract(NEW.canonical_envelope, '$.body.kind') =
      'echo-organization-record-envelope-v4'
    AND json_extract(NEW.canonical_envelope, '$.body.authority_id') = metadata.authority_id
    AND json_extract(NEW.canonical_envelope, '$.body.organization_id') = metadata.organization_id
    AND json_extract(NEW.canonical_envelope, '$.body.state_lineage_id') = metadata.state_lineage_id
    AND json_extract(NEW.canonical_envelope, '$.body.envelope_id') = NEW.envelope_id
    AND json_extract(NEW.canonical_envelope, '$.body.event.kind') = NEW.event_kind
    AND json_extract(NEW.canonical_envelope, '$.body.semantic_idempotency_key') =
      NEW.semantic_idempotency_key
    AND json_extract(NEW.canonical_envelope, '$.body.human_act_resolution_ref.approval_id') =
      NEW.approval_id
    AND json_extract(NEW.canonical_envelope, '$.body.human_act_resolution_ref.action') = NEW.action
    AND json_extract(NEW.canonical_envelope, '$.body.predecessor_position') IS NEW.predecessor_position
    AND json_extract(NEW.canonical_envelope, '$.body.predecessor_record_sha256') IS
      NEW.predecessor_record_sha256
    AND json_extract(NEW.canonical_envelope, '$.record_sha256') = NEW.record_sha256
    AND json_valid(NEW.receipt_payload)
    AND json_extract(NEW.receipt_payload, '$.schema_version') = 2
    AND json_extract(NEW.receipt_payload, '$.kind') =
      'echo-organization-record-receipt-v2'
    AND json_extract(NEW.receipt_payload, '$.authority_id') = metadata.authority_id
    AND json_extract(NEW.receipt_payload, '$.organization_id') = metadata.organization_id
    AND json_extract(NEW.receipt_payload, '$.state_lineage_id') = metadata.state_lineage_id
    AND json_extract(NEW.receipt_payload, '$.envelope_id') = NEW.envelope_id
    AND json_extract(NEW.receipt_payload, '$.semantic_idempotency_key') =
      NEW.semantic_idempotency_key
    AND json_extract(NEW.receipt_payload, '$.event_kind') = NEW.event_kind
    AND json_extract(NEW.receipt_payload, '$.record_position') = NEW.position
    AND json_extract(NEW.receipt_payload, '$.record_sha256') = NEW.record_sha256
    AND json_extract(NEW.receipt_payload, '$.predecessor_record_sha256') IS
      NEW.predecessor_record_sha256
    AND json_extract(NEW.receipt_payload, '$.record_head_position') = NEW.position
    AND json_extract(NEW.receipt_payload, '$.record_head_sha256') = NEW.record_sha256
    AND json_extract(NEW.receipt_payload, '$.issued_at') = NEW.receipt_issued_at
)
BEGIN
  SELECT RAISE(ABORT, 'organization record log row is not bound to its v4 envelope and receipt');
END;

CREATE UNIQUE INDEX organization_record_log_position_record_sha256
ON organization_record_log (position, record_sha256);

-- The signed receipt is create-once.  Its unsigned canonical body is already
-- committed in the log row, so a failed signing attempt cannot create a second
-- record or change the stable receipt body.
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

CREATE TABLE organization_record_restricted_reviewer_person_fact (
  authority_id TEXT NOT NULL CHECK (length(authority_id) > 0),
  organization_id TEXT NOT NULL CHECK (length(organization_id) > 0),
  state_lineage_id TEXT NOT NULL CHECK (length(state_lineage_id) > 0),
  approval_id TEXT NOT NULL CHECK (length(approval_id) > 0),
  action TEXT NOT NULL CHECK (action = 'approve'),
  policy_id TEXT NOT NULL CHECK (policy_id = 'restricted-reviewer-person-v2'),
  policy_contract_sha256 TEXT NOT NULL CHECK (policy_contract_sha256 LIKE 'sha256:%'),
  record_position INTEGER NOT NULL CHECK (record_position > 0),
  record_sha256 TEXT NOT NULL CHECK (record_sha256 LIKE 'sha256:%'),
  atom_order INTEGER NOT NULL CHECK (atom_order >= 0),
  signal_id_sha256 TEXT NOT NULL CHECK (signal_id_sha256 LIKE 'sha256:%'),
  atom_id TEXT NOT NULL PRIMARY KEY CHECK (atom_id LIKE 'sha256:%'),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('decision', 'action', 'rationale')),
  audit_event_id TEXT NOT NULL CHECK (length(audit_event_id) > 0),
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 0),
  audit_entry_sha256 TEXT NOT NULL CHECK (audit_entry_sha256 LIKE 'sha256:%'),
  provider_action_sha256 TEXT NOT NULL CHECK (provider_action_sha256 LIKE 'sha256:%'),
  authorization_proof_sha256 TEXT NOT NULL CHECK (authorization_proof_sha256 LIKE 'sha256:%'),
  reviewer_principal_id TEXT NOT NULL CHECK (length(reviewer_principal_id) > 0),
  reviewer_membership_id TEXT NOT NULL CHECK (length(reviewer_membership_id) > 0),
  UNIQUE (record_position, atom_order),
  UNIQUE (record_position, signal_id_sha256),
  FOREIGN KEY (record_position, record_sha256)
    REFERENCES organization_record_log (position, record_sha256)
) STRICT;

CREATE INDEX organization_record_restricted_reviewer_person_fact_by_reviewer
ON organization_record_restricted_reviewer_person_fact (
  reviewer_principal_id,
  reviewer_membership_id,
  record_position DESC,
  atom_order ASC
);

CREATE TRIGGER organization_record_restricted_reviewer_person_fact_immutable_update
BEFORE UPDATE ON organization_record_restricted_reviewer_person_fact
BEGIN
  SELECT RAISE(ABORT, 'organization record restricted reviewer Person fact is immutable');
END;

CREATE TRIGGER organization_record_restricted_reviewer_person_fact_immutable_delete
BEFORE DELETE ON organization_record_restricted_reviewer_person_fact
BEGIN
  SELECT RAISE(ABORT, 'organization record restricted reviewer Person fact cannot be deleted');
END;

CREATE TRIGGER organization_record_restricted_reviewer_person_fact_bound_insert
BEFORE INSERT ON organization_record_restricted_reviewer_person_fact
WHEN NOT EXISTS (
  SELECT 1 FROM organization_record_log AS record
  WHERE record.position = NEW.record_position
    AND record.record_sha256 = NEW.record_sha256
    AND record.event_kind = 'approved'
    AND json_extract(record.canonical_envelope, '$.body.authority_id') = NEW.authority_id
    AND json_extract(record.canonical_envelope, '$.body.organization_id') = NEW.organization_id
    AND json_extract(record.canonical_envelope, '$.body.state_lineage_id') = NEW.state_lineage_id
    AND json_extract(record.canonical_envelope, '$.body.human_act_resolution_ref.approval_id') =
      NEW.approval_id
    AND json_extract(record.canonical_envelope, '$.body.human_act_resolution_ref.action') = NEW.action
    AND COALESCE(
      json_extract(record.canonical_envelope, '$.body.human_act_resolution_ref.policy_id'),
      json_extract(record.canonical_envelope, '$.body.human_act_resolution_ref.selected_policy_id')
    ) = NEW.policy_id
    AND json_extract(record.canonical_envelope, '$.body.human_act_resolution_ref.policy_contract_sha256') =
      NEW.policy_contract_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'restricted reviewer Person fact is not bound to an exact v4 approval');
END;

CREATE TABLE organization_record_member_readable_person_fact (
  authority_id TEXT NOT NULL CHECK (length(authority_id) > 0),
  organization_id TEXT NOT NULL CHECK (length(organization_id) > 0),
  state_lineage_id TEXT NOT NULL CHECK (length(state_lineage_id) > 0),
  approval_id TEXT NOT NULL CHECK (length(approval_id) > 0),
  action TEXT NOT NULL CHECK (action = 'approve'),
  policy_id TEXT NOT NULL CHECK (policy_id = 'organization-member-readable-person-v2'),
  policy_contract_sha256 TEXT NOT NULL CHECK (policy_contract_sha256 LIKE 'sha256:%'),
  record_position INTEGER NOT NULL CHECK (record_position > 0),
  record_sha256 TEXT NOT NULL CHECK (record_sha256 LIKE 'sha256:%'),
  atom_order INTEGER NOT NULL CHECK (atom_order >= 0),
  signal_id_sha256 TEXT NOT NULL CHECK (signal_id_sha256 LIKE 'sha256:%'),
  atom_id TEXT NOT NULL PRIMARY KEY CHECK (atom_id LIKE 'sha256:%'),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('decision', 'action', 'rationale')),
  audit_event_id TEXT NOT NULL CHECK (length(audit_event_id) > 0),
  audit_sequence INTEGER NOT NULL CHECK (audit_sequence > 0),
  audit_entry_sha256 TEXT NOT NULL CHECK (audit_entry_sha256 LIKE 'sha256:%'),
  provider_action_sha256 TEXT NOT NULL CHECK (provider_action_sha256 LIKE 'sha256:%'),
  authorization_proof_sha256 TEXT NOT NULL CHECK (authorization_proof_sha256 LIKE 'sha256:%'),
  UNIQUE (record_position, atom_order),
  UNIQUE (record_position, signal_id_sha256),
  FOREIGN KEY (record_position, record_sha256)
    REFERENCES organization_record_log (position, record_sha256)
) STRICT;

CREATE INDEX organization_record_member_readable_person_fact_by_record
ON organization_record_member_readable_person_fact (record_position, atom_order);

CREATE TRIGGER organization_record_member_readable_person_fact_immutable_update
BEFORE UPDATE ON organization_record_member_readable_person_fact
BEGIN
  SELECT RAISE(ABORT, 'organization record member readable Person fact is immutable');
END;

CREATE TRIGGER organization_record_member_readable_person_fact_immutable_delete
BEFORE DELETE ON organization_record_member_readable_person_fact
BEGIN
  SELECT RAISE(ABORT, 'organization record member readable Person fact cannot be deleted');
END;

CREATE TRIGGER organization_record_member_readable_person_fact_bound_insert
BEFORE INSERT ON organization_record_member_readable_person_fact
WHEN NOT EXISTS (
  SELECT 1 FROM organization_record_log AS record
  WHERE record.position = NEW.record_position
    AND record.record_sha256 = NEW.record_sha256
    AND record.event_kind = 'approved'
    AND json_extract(record.canonical_envelope, '$.body.authority_id') = NEW.authority_id
    AND json_extract(record.canonical_envelope, '$.body.organization_id') = NEW.organization_id
    AND json_extract(record.canonical_envelope, '$.body.state_lineage_id') = NEW.state_lineage_id
    AND json_extract(record.canonical_envelope, '$.body.human_act_resolution_ref.approval_id') =
      NEW.approval_id
    AND json_extract(record.canonical_envelope, '$.body.human_act_resolution_ref.action') = NEW.action
    AND COALESCE(
      json_extract(record.canonical_envelope, '$.body.human_act_resolution_ref.policy_id'),
      json_extract(record.canonical_envelope, '$.body.human_act_resolution_ref.selected_policy_id')
    ) = NEW.policy_id
    AND json_extract(record.canonical_envelope, '$.body.human_act_resolution_ref.policy_contract_sha256') =
      NEW.policy_contract_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'member readable Person fact is not bound to an exact v4 approval');
END;
