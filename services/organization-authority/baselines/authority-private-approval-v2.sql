-- Private-approval additions for Authority baseline v2.
--
-- This file is intentionally an append-only companion to authority baseline
-- v1.  It is installed only by the v2 fresh-lineage applier and is not a
-- migration for a V1 database.

CREATE TABLE authority_private_approval_assignments_v2 (
  approval_id TEXT NOT NULL UNIQUE CHECK (approval_id GLOB 'apr_*'),
  candidate_id TEXT NOT NULL UNIQUE
    REFERENCES authority_clean_live_candidates_v1(candidate_id),
  candidate_sha256 TEXT NOT NULL CHECK (candidate_sha256 LIKE 'sha256:%'),
  frozen_card_sha256 TEXT NOT NULL CHECK (frozen_card_sha256 LIKE 'sha256:%'),
  approved_snapshot_sha256 TEXT NOT NULL CHECK (approved_snapshot_sha256 LIKE 'sha256:%'),
  connection_id TEXT NOT NULL CHECK (connection_id GLOB 'con_*'),
  connection_contract_sha256 TEXT NOT NULL CHECK (connection_contract_sha256 LIKE 'sha256:%'),
  connection_state_sha256 TEXT NOT NULL CHECK (connection_state_sha256 LIKE 'sha256:%'),
  external_identity_link_id TEXT NOT NULL CHECK (external_identity_link_id GLOB 'clm_*'),
  external_identity_link_contract_sha256 TEXT NOT NULL CHECK (external_identity_link_contract_sha256 LIKE 'sha256:%'),
  assignee_principal_id TEXT NOT NULL CHECK (assignee_principal_id GLOB 'prn_*'),
  assignee_membership_id TEXT NOT NULL CHECK (assignee_membership_id GLOB 'mem_*'),
  slack_workspace_id TEXT NOT NULL CHECK (length(trim(slack_workspace_id)) > 0),
  slack_enterprise_id TEXT CHECK (
    slack_enterprise_id IS NULL OR length(trim(slack_enterprise_id)) > 0
  ),
  slack_subject_id TEXT NOT NULL CHECK (length(trim(slack_subject_id)) > 0),
  slack_dm_channel_id TEXT NOT NULL CHECK (
    length(trim(slack_dm_channel_id)) > 0 AND substr(slack_dm_channel_id, 1, 1) = 'D'
  ),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL),
  PRIMARY KEY (approval_id, candidate_id)
) STRICT;

CREATE TRIGGER authority_private_approval_assignments_v2_immutable_update
BEFORE UPDATE ON authority_private_approval_assignments_v2
BEGIN SELECT RAISE(ABORT, 'private approval assignment is immutable'); END;

CREATE TRIGGER authority_private_approval_assignments_v2_delete_denied
BEFORE DELETE ON authority_private_approval_assignments_v2
BEGIN SELECT RAISE(ABORT, 'private approval assignment cannot be deleted'); END;

-- A terminal receipt is Authority's durable fence around the one terminal
-- D2 decision. Rejection intentionally has no V4 receipt. The only mutable
-- part is the idempotent final-card rendering acknowledgement.
CREATE TABLE authority_private_approval_terminal_receipts_v2 (
  approval_id TEXT PRIMARY KEY CHECK (approval_id GLOB 'apr_*'),
  candidate_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'rejected')),
  resolution_json TEXT NOT NULL UNIQUE CHECK (
    json_valid(resolution_json) AND json_type(resolution_json) = 'object'
  ),
  resolution_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(resolution_sha256) = 71 AND
    substr(resolution_sha256, 1, 7) = 'sha256:' AND
    substr(resolution_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  v4_receipt_json TEXT UNIQUE CHECK (
    v4_receipt_json IS NULL OR
    (json_valid(v4_receipt_json) AND json_type(v4_receipt_json) = 'object')
  ),
  v4_receipt_sha256 TEXT UNIQUE CHECK (
    v4_receipt_sha256 IS NULL OR (
      length(v4_receipt_sha256) = 71 AND
      substr(v4_receipt_sha256, 1, 7) = 'sha256:' AND
      substr(v4_receipt_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  card_render_state TEXT NOT NULL CHECK (card_render_state IN ('unrendered', 'rendered')),
  card_rendered_at TEXT CHECK (
    card_rendered_at IS NULL OR unixepoch(card_rendered_at) IS NOT NULL
  ),
  recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
  FOREIGN KEY (approval_id, candidate_id)
    REFERENCES authority_private_approval_assignments_v2(approval_id, candidate_id),
  CHECK (
    (outcome = 'approved' AND v4_receipt_json IS NOT NULL AND v4_receipt_sha256 IS NOT NULL) OR
    (outcome = 'rejected' AND v4_receipt_json IS NULL AND v4_receipt_sha256 IS NULL)
  ),
  CHECK (
    (card_render_state = 'unrendered' AND card_rendered_at IS NULL) OR
    (card_render_state = 'rendered' AND card_rendered_at IS NOT NULL)
  )
) STRICT;

CREATE TRIGGER authority_private_approval_terminal_receipts_v2_guarded_render_update
BEFORE UPDATE ON authority_private_approval_terminal_receipts_v2
WHEN NEW.approval_id != OLD.approval_id
  OR NEW.candidate_id != OLD.candidate_id
  OR NEW.outcome != OLD.outcome
  OR NEW.resolution_json != OLD.resolution_json
  OR NEW.resolution_sha256 != OLD.resolution_sha256
  OR NEW.v4_receipt_json IS NOT OLD.v4_receipt_json
  OR NEW.v4_receipt_sha256 IS NOT OLD.v4_receipt_sha256
  OR NEW.recorded_at != OLD.recorded_at
  OR OLD.card_render_state != 'unrendered'
  OR NEW.card_render_state != 'rendered'
  OR NEW.card_rendered_at IS NULL
BEGIN SELECT RAISE(ABORT, 'private approval terminal receipt only permits final card render acknowledgement'); END;

CREATE TRIGGER authority_private_approval_terminal_receipts_v2_delete_denied
BEFORE DELETE ON authority_private_approval_terminal_receipts_v2
BEGIN SELECT RAISE(ABORT, 'private approval terminal receipt cannot be deleted'); END;
