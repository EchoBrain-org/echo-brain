-- Permission-aware readable-search state is intentionally separate from the
-- generic authority audit and the reviewer-recent query audit. The active
-- pointer is mutable only as one whole generation publication; query
-- decisions are immutable for their full Authority-computed retention.

CREATE TABLE authority_readable_search_active_generation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  organization_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  retrieval_contract_sha256 TEXT NOT NULL,
  record_head_position INTEGER NOT NULL CHECK (
    record_head_position >= 0
  ),
  record_head_hash TEXT CHECK (
    (record_head_position = 0 AND record_head_hash IS NULL) OR
    (record_head_position > 0 AND record_head_hash IS NOT NULL)
  ),
  published_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', published_at) IS NOT NULL AND
    published_at = strftime('%Y-%m-%dT%H:%M:%fZ', published_at)
  )
) STRICT;

CREATE TABLE authority_readable_search_query_audit (
  audit_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (audit_sequence > 0),
  occurred_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS NOT NULL AND
    occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at)
  ),
  retain_until TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+180 days') IS NOT NULL AND
    retain_until = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+180 days')
  ),
  operation TEXT NOT NULL CHECK (
    operation = 'permission.readable_search_decided'
  ),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason_code TEXT NOT NULL CHECK (
    (decision = 'allow' AND reason_code =
      'active_member_with_scoped_policy_paths') OR
    (decision = 'deny' AND reason_code IN (
      'installation_access_expired',
      'inactive_or_unbound_organization_membership',
      'inactive_or_revoked_installation_enrollment'
    ))
  ),
  detail_json TEXT NOT NULL CHECK (
    json_valid(detail_json) AND json_type(detail_json) = 'object'
  )
) STRICT;

CREATE INDEX authority_readable_search_query_audit_retention
ON authority_readable_search_query_audit (retain_until, audit_sequence);

CREATE TRIGGER authority_readable_search_query_audit_immutable_update
BEFORE UPDATE ON authority_readable_search_query_audit
BEGIN
  SELECT RAISE(ABORT, 'readable search query audit is immutable');
END;

CREATE TRIGGER authority_readable_search_query_audit_delete_denied
BEFORE DELETE ON authority_readable_search_query_audit
BEGIN
  SELECT RAISE(ABORT, 'readable search query audit entry deletion is denied');
END;

-- Governed stopped-state export/expiry receipts are immutable generic audit
-- rows.  Their shared `sqa_*` command namespace is unique across both
-- actions, closing a concurrent first-execution race without adding mutable
-- maintenance state to the online query-audit table.
CREATE TRIGGER authority_audit_log_readable_search_query_control_immutable_update
BEFORE UPDATE ON authority_audit_log
WHEN OLD.action IN (
       'permission.readable_search_query_audit_export_authorized',
       'permission.readable_search_query_audit_expired'
     )
  OR NEW.action IN (
       'permission.readable_search_query_audit_export_authorized',
       'permission.readable_search_query_audit_expired'
     )
BEGIN
  SELECT RAISE(ABORT, 'readable search query audit control event is immutable');
END;

CREATE TRIGGER authority_audit_log_readable_search_query_control_delete_denied
BEFORE DELETE ON authority_audit_log
WHEN OLD.action IN (
       'permission.readable_search_query_audit_export_authorized',
       'permission.readable_search_query_audit_expired'
     )
BEGIN
  SELECT RAISE(ABORT, 'readable search query audit control event cannot be deleted');
END;

CREATE UNIQUE INDEX authority_audit_log_readable_search_query_control_command_id_unique
ON authority_audit_log (json_extract(detail_json, '$.command_id'))
WHERE action IN (
  'permission.readable_search_query_audit_export_authorized',
  'permission.readable_search_query_audit_expired'
);
