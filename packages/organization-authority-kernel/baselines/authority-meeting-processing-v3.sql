-- Provider-neutral live-source state for the Authority V3 fresh lineage.
--
-- The Authority V1 baseline is frozen. A V3 fresh assembly first creates
-- that shared identity/session foundation, then this companion removes the
-- legacy provider-specific live-source objects and installs their
-- provider-neutral successors. This is not a migration: it is only valid
-- while constructing a completely empty V3 Authority database.

DROP TABLE authority_clean_live_v4_receipts_v1;
DROP TABLE authority_clean_live_approval_outbox_v1;
DROP TABLE authority_clean_live_review_lineage_heads_v1;
DROP TABLE authority_clean_live_candidates_v1;
DROP TABLE authority_clean_granola_source_progress_v1;
DROP TABLE authority_clean_granola_source_admission_v1;

-- Admission is the immutable custody/configuration commitment.  Provider
-- cursors are opaque here: only the selected source boundary may validate
-- their syntax.  This keeps Authority state vendor-neutral.
CREATE TABLE authority_live_source_admission_v2 (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  membership_type TEXT NOT NULL CHECK (membership_type = 'owner'),
  source_adapter_id TEXT NOT NULL CHECK (length(trim(source_adapter_id)) BETWEEN 1 AND 128),
  source_adapter_version TEXT NOT NULL CHECK (length(trim(source_adapter_version)) BETWEEN 1 AND 128),
  source_adapter_instance_id TEXT NOT NULL CHECK (
    source_adapter_instance_id GLOB '[a-z][a-z0-9-]*' AND
    length(source_adapter_instance_id) <= 128
  ),
  normalizer_version TEXT NOT NULL CHECK (length(trim(normalizer_version)) BETWEEN 1 AND 128),
  source_custodian_sha256 TEXT NOT NULL CHECK (source_custodian_sha256 LIKE 'sha256:%'),
  source_custodian_assurance TEXT NOT NULL CHECK (
    length(trim(source_custodian_assurance)) BETWEEN 1 AND 128
  ),
  source_custodian_observed_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', source_custodian_observed_at) IS NOT NULL AND
    source_custodian_observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', source_custodian_observed_at)
  ),
  source_credential_reference_sha256 TEXT NOT NULL CHECK (source_credential_reference_sha256 LIKE 'sha256:%'),
  initial_cursor TEXT NOT NULL UNIQUE CHECK (length(initial_cursor) BETWEEN 1 AND 65536),
  cutoff_at TEXT NOT NULL CHECK (unixepoch(cutoff_at) IS NOT NULL),
  processor_adapter_id TEXT NOT NULL CHECK (length(trim(processor_adapter_id)) BETWEEN 1 AND 128),
  processor_adapter_version TEXT NOT NULL CHECK (length(trim(processor_adapter_version)) BETWEEN 1 AND 128),
  processor_instance_id TEXT NOT NULL CHECK (
    processor_instance_id GLOB '[a-z][a-z0-9-]*' AND
    length(processor_instance_id) <= 128
  ),
  processor_configuration_sha256 TEXT NOT NULL CHECK (processor_configuration_sha256 LIKE 'sha256:%'),
  processor_credential_reference_sha256 TEXT NOT NULL CHECK (processor_credential_reference_sha256 LIKE 'sha256:%'),
  semantic_input_sha256 TEXT NOT NULL UNIQUE CHECK (semantic_input_sha256 LIKE 'sha256:%'),
  admitted_at TEXT NOT NULL CHECK (unixepoch(admitted_at) IS NOT NULL),
  FOREIGN KEY (membership_id, organization_id, principal_id, membership_type)
    REFERENCES authority_memberships(membership_id, organization_id, principal_id, membership_type)
) STRICT;

CREATE TRIGGER authority_live_source_admission_v2_immutable
BEFORE UPDATE ON authority_live_source_admission_v2
BEGIN SELECT RAISE(ABORT, 'live source admission is immutable'); END;

CREATE TRIGGER authority_live_source_admission_v2_delete_denied
BEFORE DELETE ON authority_live_source_admission_v2
BEGIN SELECT RAISE(ABORT, 'live source admission deletion is denied'); END;

CREATE TABLE authority_live_source_progress_v2 (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  admission_semantic_input_sha256 TEXT NOT NULL UNIQUE
    REFERENCES authority_live_source_admission_v2(semantic_input_sha256),
  cursor TEXT NOT NULL UNIQUE CHECK (length(cursor) BETWEEN 1 AND 65536),
  cursor_version INTEGER NOT NULL CHECK (cursor_version >= 0),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER authority_live_source_progress_v2_only_advances
BEFORE UPDATE ON authority_live_source_progress_v2
WHEN NEW.singleton != OLD.singleton
  OR NEW.admission_semantic_input_sha256 != OLD.admission_semantic_input_sha256
  OR NEW.cursor = OLD.cursor
  OR NEW.cursor_version != OLD.cursor_version + 1
BEGIN SELECT RAISE(ABORT, 'live source progress only permits ordered cursor advances'); END;

CREATE TRIGGER authority_live_source_progress_v2_delete_denied
BEFORE DELETE ON authority_live_source_progress_v2
BEGIN SELECT RAISE(ABORT, 'live source progress deletion is denied'); END;

-- Candidate payloads remain append-only.  The review policy fields are kept
-- as frozen compatibility/audit facts, never as a source-specific selector.
CREATE TABLE authority_live_source_candidates_v2 (
  candidate_id TEXT PRIMARY KEY CHECK (candidate_id GLOB 'cnd_*'),
  candidate_semantic_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(candidate_semantic_sha256) = 71 AND substr(candidate_semantic_sha256, 1, 7) = 'sha256:'
  ),
  admission_semantic_input_sha256 TEXT NOT NULL
    REFERENCES authority_live_source_admission_v2(semantic_input_sha256),
  review_lineage_id TEXT NOT NULL CHECK (review_lineage_id GLOB 'rli_*'),
  review_input_sha256 TEXT NOT NULL CHECK (review_input_sha256 LIKE 'sha256:%'),
  review_semantic_sha256 TEXT NOT NULL CHECK (review_semantic_sha256 LIKE 'sha256:%'),
  review_policy_id TEXT NOT NULL CHECK (length(review_policy_id) BETWEEN 1 AND 256),
  review_policy_contract_sha256 TEXT NOT NULL CHECK (review_policy_contract_sha256 LIKE 'sha256:%'),
  review_policy_consequence_text TEXT NOT NULL CHECK (length(review_policy_consequence_text) BETWEEN 1 AND 8192),
  review_policy_consequence_sha256 TEXT NOT NULL CHECK (review_policy_consequence_sha256 LIKE 'sha256:%'),
  disposition TEXT NOT NULL CHECK (disposition IN ('actionable', 'coalesced', 'no_signals')),
  source_cursor TEXT NOT NULL CHECK (length(source_cursor) BETWEEN 1 AND 65536),
  meeting_sha256 TEXT NOT NULL CHECK (meeting_sha256 LIKE 'sha256:%'),
  meeting_json TEXT NOT NULL UNIQUE CHECK (json_valid(meeting_json) AND json_type(meeting_json) = 'object'),
  decisions_sha256 TEXT NOT NULL CHECK (decisions_sha256 LIKE 'sha256:%'),
  decisions_json TEXT NOT NULL UNIQUE CHECK (json_valid(decisions_json) AND json_type(decisions_json) = 'object'),
  created_at TEXT NOT NULL CHECK (unixepoch(created_at) IS NOT NULL)
) STRICT;

CREATE INDEX authority_live_source_candidates_v2_review_input
ON authority_live_source_candidates_v2(review_lineage_id, review_input_sha256, created_at);

CREATE TRIGGER authority_live_source_candidates_v2_immutable_update
BEFORE UPDATE ON authority_live_source_candidates_v2
BEGIN SELECT RAISE(ABORT, 'live source candidate is immutable'); END;

CREATE TRIGGER authority_live_source_candidates_v2_delete_denied
BEFORE DELETE ON authority_live_source_candidates_v2
BEGIN SELECT RAISE(ABORT, 'live source candidate deletion is denied'); END;

CREATE TABLE authority_live_source_review_lineage_heads_v2 (
  review_lineage_id TEXT PRIMARY KEY CHECK (review_lineage_id GLOB 'rli_*'),
  candidate_id TEXT NOT NULL UNIQUE REFERENCES authority_live_source_candidates_v2(candidate_id),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER authority_live_source_review_lineage_heads_v2_candidate_matches_lineage_insert
BEFORE INSERT ON authority_live_source_review_lineage_heads_v2
WHEN NOT EXISTS (
  SELECT 1 FROM authority_live_source_candidates_v2
   WHERE candidate_id = NEW.candidate_id AND review_lineage_id = NEW.review_lineage_id
)
BEGIN SELECT RAISE(ABORT, 'live source review lineage head candidate must match its lineage'); END;

CREATE TRIGGER authority_live_source_review_lineage_heads_v2_candidate_matches_lineage_update
BEFORE UPDATE ON authority_live_source_review_lineage_heads_v2
WHEN NOT EXISTS (
  SELECT 1 FROM authority_live_source_candidates_v2
   WHERE candidate_id = NEW.candidate_id AND review_lineage_id = NEW.review_lineage_id
)
BEGIN SELECT RAISE(ABORT, 'live source review lineage head candidate must match its lineage'); END;

CREATE TRIGGER authority_live_source_review_lineage_heads_v2_delete_denied
BEFORE DELETE ON authority_live_source_review_lineage_heads_v2
BEGIN SELECT RAISE(ABORT, 'live source review lineage head deletion is denied'); END;

CREATE TRIGGER authority_live_source_review_lineage_heads_v2_ordered_update
BEFORE UPDATE ON authority_live_source_review_lineage_heads_v2
WHEN NEW.review_lineage_id != OLD.review_lineage_id
  OR NEW.candidate_id = OLD.candidate_id
  OR unixepoch(NEW.updated_at) < unixepoch(OLD.updated_at)
BEGIN SELECT RAISE(ABORT, 'live source review lineage head only permits ordered successor advances'); END;

CREATE TABLE authority_live_approval_outbox_v2 (
  candidate_id TEXT PRIMARY KEY REFERENCES authority_live_source_candidates_v2(candidate_id),
  approval_id TEXT NOT NULL UNIQUE CHECK (approval_id GLOB 'apr_*'),
  stage_command_id TEXT NOT NULL UNIQUE CHECK (stage_command_id GLOB 'pas_*'),
  state TEXT NOT NULL CHECK (state IN ('queued', 'posting', 'posted', 'staged', 'superseded')),
  provider_message_ts TEXT UNIQUE,
  frozen_card_sha256 TEXT CHECK (frozen_card_sha256 LIKE 'sha256:%'),
  approved_snapshot_json TEXT CHECK (approved_snapshot_json IS NULL OR (json_valid(approved_snapshot_json) AND json_type(approved_snapshot_json) = 'object')),
  approved_snapshot_sha256 TEXT CHECK (approved_snapshot_sha256 LIKE 'sha256:%'),
  post_started_at TEXT CHECK (post_started_at IS NULL OR unixepoch(post_started_at) IS NOT NULL),
  control_approval_sha256 TEXT UNIQUE CHECK (control_approval_sha256 LIKE 'sha256:%'),
  superseded_by_candidate_id TEXT REFERENCES authority_live_source_candidates_v2(candidate_id),
  superseded_at TEXT CHECK (superseded_at IS NULL OR unixepoch(superseded_at) IS NOT NULL),
  tombstoned_at TEXT CHECK (tombstoned_at IS NULL OR unixepoch(tombstoned_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (unixepoch(updated_at) IS NOT NULL),
  CHECK (
    (state = 'queued' AND provider_message_ts IS NULL AND frozen_card_sha256 IS NULL AND approved_snapshot_json IS NULL AND approved_snapshot_sha256 IS NULL AND post_started_at IS NULL AND control_approval_sha256 IS NULL AND superseded_by_candidate_id IS NULL AND superseded_at IS NULL AND tombstoned_at IS NULL) OR
    (state = 'posting' AND provider_message_ts IS NULL AND frozen_card_sha256 IS NOT NULL AND approved_snapshot_json IS NOT NULL AND approved_snapshot_sha256 IS NOT NULL AND post_started_at IS NOT NULL AND control_approval_sha256 IS NULL AND superseded_by_candidate_id IS NULL AND superseded_at IS NULL AND tombstoned_at IS NULL) OR
    (state = 'posted' AND provider_message_ts IS NOT NULL AND frozen_card_sha256 IS NOT NULL AND approved_snapshot_json IS NOT NULL AND approved_snapshot_sha256 IS NOT NULL AND post_started_at IS NOT NULL AND control_approval_sha256 IS NULL AND superseded_by_candidate_id IS NULL AND superseded_at IS NULL AND tombstoned_at IS NULL) OR
    (state = 'staged' AND provider_message_ts IS NOT NULL AND frozen_card_sha256 IS NOT NULL AND approved_snapshot_json IS NOT NULL AND approved_snapshot_sha256 IS NOT NULL AND post_started_at IS NOT NULL AND control_approval_sha256 IS NOT NULL AND superseded_by_candidate_id IS NULL AND superseded_at IS NULL AND tombstoned_at IS NULL) OR
    (state = 'superseded' AND ((provider_message_ts IS NULL AND frozen_card_sha256 IS NULL AND approved_snapshot_json IS NULL AND approved_snapshot_sha256 IS NULL AND post_started_at IS NULL AND control_approval_sha256 IS NULL) OR (frozen_card_sha256 IS NOT NULL AND approved_snapshot_json IS NOT NULL AND approved_snapshot_sha256 IS NOT NULL AND post_started_at IS NOT NULL)) AND superseded_by_candidate_id IS NOT NULL AND superseded_at IS NOT NULL AND (tombstoned_at IS NULL OR provider_message_ts IS NOT NULL))
  )
) STRICT;

CREATE TRIGGER authority_live_approval_outbox_v2_ordered_transition
BEFORE UPDATE ON authority_live_approval_outbox_v2
WHEN NEW.candidate_id != OLD.candidate_id
  OR NEW.approval_id != OLD.approval_id
  OR NEW.stage_command_id != OLD.stage_command_id
  OR (OLD.state = 'queued' AND NEW.state NOT IN ('posting', 'superseded'))
  OR (OLD.state = 'posting' AND NEW.state NOT IN ('queued', 'posted', 'superseded'))
  OR (OLD.state = 'posted' AND NEW.state NOT IN ('staged', 'superseded'))
  OR (OLD.state = 'staged' AND NEW.state NOT IN ('superseded'))
  -- A provider or approval result can land after another runner supersedes
  -- the outbox. Permit each missing external witness to be filled once while
  -- preserving every already-known field.
  OR (OLD.state = 'superseded' AND NOT (
      NEW.state = 'superseded'
      AND NEW.superseded_by_candidate_id IS OLD.superseded_by_candidate_id
      AND NEW.superseded_at IS OLD.superseded_at
      AND (NEW.post_started_at IS OLD.post_started_at OR
           (OLD.provider_message_ts IS NULL AND
            OLD.post_started_at IS NOT NULL AND NEW.post_started_at IS NULL))
      AND (
        (NEW.provider_message_ts IS OLD.provider_message_ts
         AND NEW.frozen_card_sha256 IS OLD.frozen_card_sha256
         AND NEW.approved_snapshot_json IS OLD.approved_snapshot_json
         AND NEW.approved_snapshot_sha256 IS OLD.approved_snapshot_sha256
         AND NEW.control_approval_sha256 IS OLD.control_approval_sha256
         AND NEW.tombstoned_at IS OLD.tombstoned_at)
        OR
        (OLD.provider_message_ts IS NULL
         AND NEW.provider_message_ts IS NOT NULL
         AND NEW.frozen_card_sha256 IS OLD.frozen_card_sha256
         AND NEW.approved_snapshot_json IS OLD.approved_snapshot_json
         AND NEW.approved_snapshot_sha256 IS OLD.approved_snapshot_sha256
         AND NEW.control_approval_sha256 IS OLD.control_approval_sha256
         AND NEW.tombstoned_at IS OLD.tombstoned_at)
        OR
        (OLD.control_approval_sha256 IS NULL
         AND NEW.control_approval_sha256 IS NOT NULL
         AND NEW.provider_message_ts IS OLD.provider_message_ts
         AND NEW.frozen_card_sha256 IS OLD.frozen_card_sha256
         AND NEW.approved_snapshot_json IS OLD.approved_snapshot_json
         AND NEW.approved_snapshot_sha256 IS OLD.approved_snapshot_sha256
         AND NEW.tombstoned_at IS OLD.tombstoned_at)
        OR
        (OLD.tombstoned_at IS NULL
         AND NEW.tombstoned_at IS NOT NULL
         AND OLD.provider_message_ts IS NOT NULL
         AND OLD.frozen_card_sha256 IS NOT NULL
         AND OLD.approved_snapshot_json IS NOT NULL
         AND OLD.approved_snapshot_sha256 IS NOT NULL
         AND NEW.provider_message_ts IS OLD.provider_message_ts
         AND NEW.frozen_card_sha256 IS OLD.frozen_card_sha256
         AND NEW.approved_snapshot_json IS OLD.approved_snapshot_json
         AND NEW.approved_snapshot_sha256 IS OLD.approved_snapshot_sha256
         AND NEW.control_approval_sha256 IS OLD.control_approval_sha256
         AND NEW.updated_at = NEW.tombstoned_at)
        OR
        (OLD.provider_message_ts IS NULL
         AND OLD.frozen_card_sha256 IS NOT NULL
         AND OLD.approved_snapshot_json IS NOT NULL
         AND OLD.approved_snapshot_sha256 IS NOT NULL
         AND OLD.post_started_at IS NOT NULL
         AND OLD.control_approval_sha256 IS NULL
         AND NEW.provider_message_ts IS NULL
         AND NEW.frozen_card_sha256 IS NULL
         AND NEW.approved_snapshot_json IS NULL
         AND NEW.approved_snapshot_sha256 IS NULL
         AND NEW.post_started_at IS NULL
         AND NEW.control_approval_sha256 IS NULL
         AND NEW.tombstoned_at IS NULL)
      )
    ))
  OR (OLD.provider_message_ts IS NOT NULL AND NEW.provider_message_ts IS NOT OLD.provider_message_ts)
  OR (OLD.frozen_card_sha256 IS NOT NULL AND NEW.frozen_card_sha256 IS NOT OLD.frozen_card_sha256
      AND NOT (OLD.state = 'posting' AND NEW.state = 'queued')
      AND NOT (OLD.state = 'superseded' AND NEW.state = 'superseded'
               AND OLD.provider_message_ts IS NULL AND NEW.post_started_at IS NULL))
  OR (OLD.approved_snapshot_json IS NOT NULL AND NEW.approved_snapshot_json IS NOT OLD.approved_snapshot_json
      AND NOT (OLD.state = 'posting' AND NEW.state = 'queued')
      AND NOT (OLD.state = 'superseded' AND NEW.state = 'superseded'
               AND OLD.provider_message_ts IS NULL AND NEW.post_started_at IS NULL))
  OR (OLD.approved_snapshot_sha256 IS NOT NULL AND NEW.approved_snapshot_sha256 IS NOT OLD.approved_snapshot_sha256
      AND NOT (OLD.state = 'posting' AND NEW.state = 'queued')
      AND NOT (OLD.state = 'superseded' AND NEW.state = 'superseded'
               AND OLD.provider_message_ts IS NULL AND NEW.post_started_at IS NULL))
  OR (OLD.post_started_at IS NOT NULL AND NEW.post_started_at IS NOT OLD.post_started_at
      AND NOT (OLD.state = 'posting' AND NEW.state = 'queued')
      AND NOT (OLD.state = 'superseded' AND NEW.state = 'superseded'
               AND OLD.provider_message_ts IS NULL AND NEW.post_started_at IS NULL))
  OR (OLD.control_approval_sha256 IS NOT NULL AND NEW.control_approval_sha256 IS NOT OLD.control_approval_sha256)
  OR (OLD.state = 'queued' AND NEW.state = 'superseded' AND (NEW.provider_message_ts IS NOT NULL OR NEW.frozen_card_sha256 IS NOT NULL OR NEW.approved_snapshot_json IS NOT NULL OR NEW.approved_snapshot_sha256 IS NOT NULL OR NEW.post_started_at IS NOT NULL OR NEW.control_approval_sha256 IS NOT NULL))
  OR (OLD.state = 'posting' AND NEW.state = 'superseded' AND (NEW.provider_message_ts IS NOT OLD.provider_message_ts OR NEW.frozen_card_sha256 IS NOT OLD.frozen_card_sha256 OR NEW.approved_snapshot_json IS NOT OLD.approved_snapshot_json OR NEW.approved_snapshot_sha256 IS NOT OLD.approved_snapshot_sha256 OR NEW.post_started_at IS NOT OLD.post_started_at OR NEW.control_approval_sha256 IS NOT NULL))
  OR (OLD.state = 'posted' AND NEW.state = 'superseded' AND NEW.control_approval_sha256 IS NOT NULL)
  OR (OLD.state != 'superseded' AND NEW.tombstoned_at IS NOT NULL)
  OR (OLD.tombstoned_at IS NOT NULL AND NEW.tombstoned_at IS NOT OLD.tombstoned_at)
  OR (NEW.state = 'superseded' AND (NEW.superseded_by_candidate_id IS NULL OR NEW.superseded_at IS NULL))
  OR (NEW.state != 'superseded' AND (NEW.superseded_by_candidate_id IS NOT NULL OR NEW.superseded_at IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'live approval outbox only permits queued-posting-posted-staged-superseded'); END;

CREATE TRIGGER authority_live_approval_outbox_v2_delete_denied
BEFORE DELETE ON authority_live_approval_outbox_v2
BEGIN SELECT RAISE(ABORT, 'live approval outbox deletion is denied'); END;

CREATE TABLE authority_live_v4_receipts_v2 (
  approval_id TEXT PRIMARY KEY REFERENCES authority_live_approval_outbox_v2(approval_id),
  control_approval_sha256 TEXT NOT NULL CHECK (control_approval_sha256 LIKE 'sha256:%'),
  receipt_sha256 TEXT NOT NULL UNIQUE CHECK (receipt_sha256 LIKE 'sha256:%'),
  receipt_json TEXT NOT NULL UNIQUE CHECK (json_valid(receipt_json) AND json_type(receipt_json) = 'object'),
  recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL)
) STRICT;

CREATE TRIGGER authority_live_v4_receipts_v2_immutable_update
BEFORE UPDATE ON authority_live_v4_receipts_v2
BEGIN SELECT RAISE(ABORT, 'live V4 receipt is immutable'); END;

CREATE TRIGGER authority_live_v4_receipts_v2_delete_denied
BEFORE DELETE ON authority_live_v4_receipts_v2
BEGIN SELECT RAISE(ABORT, 'live V4 receipt deletion is denied'); END;

-- Private Slack delivery is a dependent V3 table family.  This sprint makes
-- the source lineage provider-neutral; it intentionally preserves the
-- existing Slack presentation commitment exactly.
CREATE TABLE authority_private_approval_assignments_v3 (
  approval_id TEXT NOT NULL UNIQUE CHECK (approval_id GLOB 'apr_*'),
  candidate_id TEXT NOT NULL UNIQUE REFERENCES authority_live_source_candidates_v2(candidate_id),
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

CREATE TRIGGER authority_private_approval_assignments_v3_immutable_update
BEFORE UPDATE ON authority_private_approval_assignments_v3
BEGIN SELECT RAISE(ABORT, 'private approval assignment is immutable'); END;

CREATE TRIGGER authority_private_approval_assignments_v3_delete_denied
BEFORE DELETE ON authority_private_approval_assignments_v3
BEGIN SELECT RAISE(ABORT, 'private approval assignment cannot be deleted'); END;

CREATE TABLE authority_private_approval_terminal_receipts_v3 (
  approval_id TEXT PRIMARY KEY CHECK (approval_id GLOB 'apr_*'),
  candidate_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'rejected')),
  resolution_json TEXT NOT NULL UNIQUE CHECK (json_valid(resolution_json) AND json_type(resolution_json) = 'object'),
  resolution_sha256 TEXT NOT NULL UNIQUE CHECK (length(resolution_sha256) = 71 AND substr(resolution_sha256, 1, 7) = 'sha256:' AND substr(resolution_sha256, 8) NOT GLOB '*[^0-9a-f]*'),
  v4_receipt_json TEXT UNIQUE CHECK (v4_receipt_json IS NULL OR (json_valid(v4_receipt_json) AND json_type(v4_receipt_json) = 'object')),
  v4_receipt_sha256 TEXT UNIQUE CHECK (v4_receipt_sha256 IS NULL OR (length(v4_receipt_sha256) = 71 AND substr(v4_receipt_sha256, 1, 7) = 'sha256:' AND substr(v4_receipt_sha256, 8) NOT GLOB '*[^0-9a-f]*')),
  card_render_state TEXT NOT NULL CHECK (card_render_state IN ('unrendered', 'rendered')),
  card_rendered_at TEXT CHECK (card_rendered_at IS NULL OR unixepoch(card_rendered_at) IS NOT NULL),
  recorded_at TEXT NOT NULL CHECK (unixepoch(recorded_at) IS NOT NULL),
  FOREIGN KEY (approval_id, candidate_id) REFERENCES authority_private_approval_assignments_v3(approval_id, candidate_id),
  CHECK ((outcome = 'approved' AND v4_receipt_json IS NOT NULL AND v4_receipt_sha256 IS NOT NULL) OR (outcome = 'rejected' AND v4_receipt_json IS NULL AND v4_receipt_sha256 IS NULL)),
  CHECK ((card_render_state = 'unrendered' AND card_rendered_at IS NULL) OR (card_render_state = 'rendered' AND card_rendered_at IS NOT NULL))
) STRICT;

CREATE TRIGGER authority_private_approval_terminal_receipts_v3_guarded_render_update
BEFORE UPDATE ON authority_private_approval_terminal_receipts_v3
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

CREATE TRIGGER authority_private_approval_terminal_receipts_v3_delete_denied
BEFORE DELETE ON authority_private_approval_terminal_receipts_v3
BEGIN SELECT RAISE(ABORT, 'private approval terminal receipt cannot be deleted'); END;
