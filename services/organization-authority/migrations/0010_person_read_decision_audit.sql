-- One isolated, append-only audit for V2 Person reads. All three read
-- operations share this closed row shape; installation-era query-audit rows
-- retain their original tables and meanings.

CREATE TABLE authority_person_read_decision_audit (
  audit_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (audit_sequence > 0),
  occurred_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS NOT NULL AND
    occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at)
  ),
  retain_until TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+180 days') IS NOT NULL AND
    retain_until = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at, '+180 days')
  ),
  authority_id TEXT NOT NULL REFERENCES authority_metadata(authority_id),
  organization_id TEXT NOT NULL REFERENCES authority_metadata(organization_id),
  operation TEXT NOT NULL CHECK (
    operation IN (
      'recent_decisions',
      'reviewer_recent_decisions',
      'readable_search'
    )
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 71 AND
    substr(request_sha256, 1, 7) = 'sha256:' AND
    substr(request_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  response_sha256 TEXT NOT NULL CHECK (
    length(response_sha256) = 71 AND
    substr(response_sha256, 1, 7) = 'sha256:' AND
    substr(response_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  asserted_subject_principal_id TEXT NOT NULL CHECK (
    length(asserted_subject_principal_id) = 40 AND
    asserted_subject_principal_id GLOB
      'prn_????????-????-4???-[89ab]???-????????????' AND
    replace(substr(asserted_subject_principal_id, 5), '-', '')
      NOT GLOB '*[^0-9a-f]*'
  ),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason_code TEXT NOT NULL CHECK (
    (decision = 'allow' AND reason_code = 'active_person_session') OR
    (decision = 'deny' AND reason_code IN (
      'person_or_session_inactive',
      'caller_subject_mismatch',
      'authorization_state_changed',
      'operation_not_permitted'
    ))
  ),
  authenticated_principal_id TEXT CHECK (
    authenticated_principal_id IS NULL OR (
      length(authenticated_principal_id) = 40 AND
      authenticated_principal_id GLOB
        'prn_????????-????-4???-[89ab]???-????????????' AND
      replace(substr(authenticated_principal_id, 5), '-', '')
        NOT GLOB '*[^0-9a-f]*'
    )
  ),
  authenticated_membership_id TEXT CHECK (
    authenticated_membership_id IS NULL OR (
      length(authenticated_membership_id) = 40 AND
      authenticated_membership_id GLOB
        'mem_????????-????-4???-[89ab]???-????????????' AND
      replace(substr(authenticated_membership_id, 5), '-', '')
        NOT GLOB '*[^0-9a-f]*'
    )
  ),
  authenticated_membership_type TEXT CHECK (
    authenticated_membership_type IS NULL OR
    authenticated_membership_type IN ('owner', 'employee')
  ),
  identity_binding_id TEXT CHECK (
    identity_binding_id IS NULL OR (
      length(identity_binding_id) = 40 AND
      identity_binding_id GLOB
        'oib_????????-????-4???-[89ab]???-????????????' AND
      replace(substr(identity_binding_id, 5), '-', '')
        NOT GLOB '*[^0-9a-f]*'
    )
  ),
  session_family_id TEXT CHECK (
    session_family_id IS NULL OR (
      length(session_family_id) = 40 AND
      session_family_id GLOB
        'psf_????????-????-4???-[89ab]???-????????????' AND
      replace(substr(session_family_id, 5), '-', '')
        NOT GLOB '*[^0-9a-f]*'
    )
  ),
  access_credential_sha256 TEXT CHECK (
    access_credential_sha256 IS NULL OR (
      length(access_credential_sha256) = 71 AND
      substr(access_credential_sha256, 1, 7) = 'sha256:' AND
      substr(access_credential_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  caller_binding_sha256 TEXT CHECK (
    caller_binding_sha256 IS NULL OR (
      length(caller_binding_sha256) = 71 AND
      substr(caller_binding_sha256, 1, 7) = 'sha256:' AND
      substr(caller_binding_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  person_state_sha256 TEXT CHECK (
    person_state_sha256 IS NULL OR (
      length(person_state_sha256) = 71 AND
      substr(person_state_sha256, 1, 7) = 'sha256:' AND
      substr(person_state_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  session_state_sha256 TEXT CHECK (
    session_state_sha256 IS NULL OR (
      length(session_state_sha256) = 71 AND
      substr(session_state_sha256, 1, 7) = 'sha256:' AND
      substr(session_state_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    (
      authenticated_principal_id IS NULL AND
      authenticated_membership_id IS NULL AND
      authenticated_membership_type IS NULL AND
      identity_binding_id IS NULL AND session_family_id IS NULL AND
      access_credential_sha256 IS NULL AND caller_binding_sha256 IS NULL AND
      person_state_sha256 IS NULL AND session_state_sha256 IS NULL AND
      decision = 'deny' AND
      reason_code = 'person_or_session_inactive'
    ) OR
    (
      authenticated_principal_id IS NOT NULL AND
      authenticated_membership_id IS NOT NULL AND
      authenticated_membership_type IS NOT NULL AND
      identity_binding_id IS NOT NULL AND session_family_id IS NOT NULL AND
      access_credential_sha256 IS NOT NULL AND
      caller_binding_sha256 IS NOT NULL AND
      person_state_sha256 IS NOT NULL AND session_state_sha256 IS NOT NULL AND
      (
        (reason_code = 'caller_subject_mismatch' AND
          asserted_subject_principal_id <> authenticated_principal_id) OR
        (reason_code <> 'caller_subject_mismatch' AND
          asserted_subject_principal_id = authenticated_principal_id)
      )
    )
  )
) STRICT;

CREATE INDEX authority_person_read_decision_audit_retention
  ON authority_person_read_decision_audit (retain_until, audit_sequence);

CREATE TRIGGER authority_person_read_decision_audit_immutable_update
BEFORE UPDATE ON authority_person_read_decision_audit
BEGIN
  SELECT RAISE(ABORT, 'Person read decision audit is immutable');
END;

CREATE TRIGGER authority_person_read_decision_audit_delete_denied
BEFORE DELETE ON authority_person_read_decision_audit
BEGIN
  SELECT RAISE(ABORT, 'Person read decision audit entry deletion is denied');
END;
