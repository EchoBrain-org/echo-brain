-- Approval-delivery quarantine for the Authority V4 fresh lineage.
--
-- This companion is additive over the frozen V3 assembly. A quarantine is a
-- durable terminal delivery disposition for a candidate whose approval package
-- cannot be represented by the selected delivery surface. The outbox remains
-- the source of its delivery state; once quarantined it may only be superseded.

CREATE TABLE authority_live_approval_delivery_quarantines_v1 (
  candidate_id TEXT PRIMARY KEY
    REFERENCES authority_live_approval_outbox_v2(candidate_id),
  reason_code TEXT NOT NULL CHECK (
    reason_code = 'approval_package_unrepresentable'
  ),
  quarantined_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', quarantined_at) IS NOT NULL AND
    quarantined_at = strftime('%Y-%m-%dT%H:%M:%fZ', quarantined_at)
  )
) STRICT;

CREATE TRIGGER authority_live_approval_delivery_quarantines_v1_immutable_update
BEFORE UPDATE ON authority_live_approval_delivery_quarantines_v1
BEGIN SELECT RAISE(ABORT, 'approval delivery quarantine is immutable'); END;

CREATE TRIGGER authority_live_approval_delivery_quarantines_v1_delete_denied
BEFORE DELETE ON authority_live_approval_delivery_quarantines_v1
BEGIN SELECT RAISE(ABORT, 'approval delivery quarantine deletion is denied'); END;

CREATE TRIGGER authority_live_approval_outbox_v2_quarantine_transition_fence
BEFORE UPDATE ON authority_live_approval_outbox_v2
WHEN EXISTS (
  SELECT 1
  FROM authority_live_approval_delivery_quarantines_v1
  WHERE candidate_id = OLD.candidate_id
)
  AND NOT (OLD.state <> 'superseded' AND NEW.state = 'superseded')
BEGIN SELECT RAISE(ABORT, 'quarantined approval outbox only permits supersession'); END;
