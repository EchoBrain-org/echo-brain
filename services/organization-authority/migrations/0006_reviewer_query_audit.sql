-- The separate reviewer query-decision audit.
--
-- Reviewer reads are audited here, not in the landed generic
-- `authority_audit_log`. That table lists and counts every action for the
-- admin overview and has no selective retention contract; reviewer query rows
-- need the opposite of both. Keeping them apart is what lets generic admin
-- listing stay blind to reviewer read behavior while these rows carry a real
-- 180-day retention their own governed command enforces.
--
-- Entries are immutable while retained. Direct deletion is denied outright and
-- unconditionally: the schema alone can never be talked into removing a row.
-- The stopped-state expiry command is the only production code with delete
-- access, and it earns that access transactionally -- it verifies this exact
-- deny trigger, replaces it with a retention guard bound to its own
-- transaction time, deletes only entries whose Authority-computed retention has
-- already elapsed, then restores this trigger before releasing. Any failure
-- rolls the savepoint back, which restores both the rows and this guard.
--
-- Every timestamp is a canonical UTC millisecond instant. The checks compare
-- each value with SQLite's own re-rendering of it, so a normalizing parse
-- (`2026-02-29`), a truncated fraction (`.000` for `.123`), a second-precision
-- form, or an unparsable value all fail. `strftime` returns NULL for garbage,
-- and a NULL comparison would satisfy a bare CHECK, so each check states
-- `IS NOT NULL` first.

CREATE TABLE authority_query_decision_audit (
  audit_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (audit_sequence > 0),
  occurred_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS NOT NULL AND
    occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at)
  ),
  -- Authority-computed, never caller-supplied: `occurred_at + 180 days`, to
  -- the exact millisecond. SQLite's day modifier is exact millisecond
  -- arithmetic, so `.123Z` stays `.123Z` 180 days later.
  retain_until TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+180 days') IS NOT NULL AND
    retain_until = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+180 days')
  ),
  operation TEXT NOT NULL CHECK (
    operation = 'permission.reviewer_recent_decisions_decided'
  ),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  -- The reason is bound to its decision: an allow can only be the one allow
  -- reason, and a denial can only be one of the two closed denial reasons.
  reason_code TEXT NOT NULL CHECK (
    (decision = 'allow' AND reason_code = 'active_exact_reviewer_membership') OR
    (decision = 'deny' AND reason_code IN (
      'installation_access_expired',
      'inactive_or_unbound_reviewer_membership'
    ))
  ),
  detail_json TEXT NOT NULL CHECK (
    json_valid(detail_json) AND json_type(detail_json) = 'object'
  )
) STRICT;

-- The retention scan order. Expiry walks `(retain_until, audit_sequence)` and
-- never needs to read `detail_json` to decide what has elapsed.
CREATE INDEX authority_query_decision_audit_retention
ON authority_query_decision_audit (retain_until, audit_sequence);

CREATE TRIGGER authority_query_decision_audit_immutable_update
BEFORE UPDATE ON authority_query_decision_audit
BEGIN
  SELECT RAISE(ABORT, 'authority query decision audit is immutable');
END;

-- No condition, no escape hatch, and no state a statement can set to weaken
-- it. Governed expiry is the only path that may remove this trigger, and only
-- inside its own savepoint while it holds the write fence.
CREATE TRIGGER authority_query_decision_audit_delete_denied
BEFORE DELETE ON authority_query_decision_audit
BEGIN
  SELECT RAISE(ABORT, 'authority query decision audit entry deletion is denied');
END;

-- The two governed control events are the maintenance receipt for an export or
-- an expiry. Once written they are as immutable as the query rows they account
-- for: they cannot be edited, deleted, or forged by relabelling some other
-- generic audit row into a control action.
CREATE TRIGGER authority_audit_log_reviewer_query_control_immutable_update
BEFORE UPDATE ON authority_audit_log
WHEN OLD.action IN (
       'permission.reviewer_query_audit_export_authorized',
       'permission.reviewer_query_audit_expired'
     )
  OR NEW.action IN (
       'permission.reviewer_query_audit_export_authorized',
       'permission.reviewer_query_audit_expired'
     )
BEGIN
  SELECT RAISE(ABORT, 'reviewer query audit control event is immutable');
END;

CREATE TRIGGER authority_audit_log_reviewer_query_control_delete_denied
BEFORE DELETE ON authority_audit_log
WHEN OLD.action IN (
       'permission.reviewer_query_audit_export_authorized',
       'permission.reviewer_query_audit_expired'
     )
BEGIN
  SELECT RAISE(ABORT, 'reviewer query audit control event cannot be deleted');
END;

-- One `qac_*` command id is unique across both governed control operations, so
-- an export can never reuse an expiry's id or the reverse. The partial
-- expression index puts that guarantee on the landed generic audit without
-- adding a command-id column to the online query rows.
CREATE UNIQUE INDEX authority_audit_log_reviewer_query_control_command_id_unique
ON authority_audit_log (json_extract(detail_json, '$.command_id'))
WHERE action IN (
  'permission.reviewer_query_audit_export_authorized',
  'permission.reviewer_query_audit_expired'
);
