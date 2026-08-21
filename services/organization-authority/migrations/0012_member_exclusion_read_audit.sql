-- Isolated INV-10 evidence for the only two application reads of exclusion
-- coordinates: the owning Person and the explicit administrator break-glass
-- operation. The selected coordinates never enter this table.

CREATE TABLE authority_member_exclusion_read_audit (
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
  actor_kind TEXT NOT NULL CHECK (
    actor_kind IN ('person', 'admin_break_glass')
  ),
  actor_binding_version INTEGER NOT NULL CHECK (actor_binding_version = 1),
  actor_binding_sha256 TEXT CHECK (
    actor_binding_sha256 IS NULL OR (
      length(actor_binding_sha256) = 71 AND
      substr(actor_binding_sha256, 1, 7) = 'sha256:' AND
      substr(actor_binding_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    )
  ),
  operation TEXT NOT NULL CHECK (
    operation IN (
      'member_exclusions',
      'member_exclusions_break_glass'
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
  result_count INTEGER NOT NULL CHECK (result_count >= 0),
  asserted_subject_principal_id TEXT CHECK (
    asserted_subject_principal_id IS NULL OR (
      length(asserted_subject_principal_id) = 40 AND
      asserted_subject_principal_id GLOB
        'prn_????????-????-4???-[89ab]???-????????????' AND
      replace(substr(asserted_subject_principal_id, 5), '-', '')
        NOT GLOB '*[^0-9a-f]*'
    )
  ),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason_code TEXT NOT NULL CHECK (
    (decision = 'allow' AND reason_code IN (
      'active_person_session',
      'break_glass_authorized'
    )) OR
    (decision = 'deny' AND reason_code IN (
      'person_or_session_inactive',
      'caller_subject_mismatch',
      'authorization_state_changed',
      'operation_not_permitted',
      'break_glass_target_unavailable'
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
  CHECK (decision = 'allow' OR result_count = 0),
  CHECK (
    (actor_kind = 'person' AND operation = 'member_exclusions' AND
      asserted_subject_principal_id IS NOT NULL) OR
    (actor_kind = 'admin_break_glass' AND
      operation = 'member_exclusions_break_glass' AND
      asserted_subject_principal_id IS NULL)
  ),
  CHECK (
    (
      actor_kind = 'admin_break_glass' AND
      actor_binding_sha256 IS NOT NULL AND
      authenticated_principal_id IS NULL AND
      authenticated_membership_id IS NULL AND
      authenticated_membership_type IS NULL AND
      identity_binding_id IS NULL AND session_family_id IS NULL AND
      access_credential_sha256 IS NULL AND caller_binding_sha256 IS NULL AND
      person_state_sha256 IS NULL AND session_state_sha256 IS NULL AND
      (
        (decision = 'allow' AND reason_code = 'break_glass_authorized') OR
        (decision = 'deny' AND
          reason_code = 'break_glass_target_unavailable')
      )
    ) OR
    (
      actor_kind = 'person' AND actor_binding_sha256 IS NULL AND
      authenticated_principal_id IS NULL AND
      authenticated_membership_id IS NULL AND
      authenticated_membership_type IS NULL AND
      identity_binding_id IS NULL AND session_family_id IS NULL AND
      access_credential_sha256 IS NULL AND caller_binding_sha256 IS NULL AND
      person_state_sha256 IS NULL AND session_state_sha256 IS NULL AND
      decision = 'deny' AND reason_code = 'person_or_session_inactive'
    ) OR
    (
      actor_kind = 'person' AND actor_binding_sha256 IS NOT NULL AND
      authenticated_principal_id IS NOT NULL AND
      authenticated_membership_id IS NOT NULL AND
      authenticated_membership_type IS NOT NULL AND
      identity_binding_id IS NOT NULL AND session_family_id IS NOT NULL AND
      access_credential_sha256 IS NOT NULL AND
      caller_binding_sha256 IS NOT NULL AND
      actor_binding_sha256 = caller_binding_sha256 AND
      person_state_sha256 IS NOT NULL AND session_state_sha256 IS NOT NULL AND
      (
        (reason_code = 'caller_subject_mismatch' AND
          asserted_subject_principal_id <> authenticated_principal_id) OR
        (reason_code <> 'caller_subject_mismatch' AND
          asserted_subject_principal_id = authenticated_principal_id)
      ) AND
      reason_code NOT IN (
        'break_glass_authorized',
        'break_glass_target_unavailable'
      )
    )
  )
) STRICT;

CREATE INDEX authority_member_exclusion_read_audit_retention
  ON authority_member_exclusion_read_audit (retain_until, audit_sequence);

CREATE TRIGGER authority_member_exclusion_read_audit_immutable_update
BEFORE UPDATE ON authority_member_exclusion_read_audit
BEGIN
  SELECT RAISE(ABORT, 'member exclusion read audit is immutable');
END;

CREATE TRIGGER authority_member_exclusion_read_audit_delete_denied
BEFORE DELETE ON authority_member_exclusion_read_audit
BEGIN
  SELECT RAISE(ABORT, 'member exclusion read audit deletion is denied');
END;
