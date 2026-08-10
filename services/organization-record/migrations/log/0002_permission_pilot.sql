-- The one immutable activation for the two-member permission pilot, plus the
-- append-maintained index of approval records that proved its exact notice.
--
-- These are deliberately not a generic policy ledger or permission-effect
-- projection. The singleton marker fixes one policy, one exact audience, and
-- one history boundary. The eligibility table contains only immutable
-- pointers whose proof matched that marker when the record append committed.

CREATE TABLE organization_record_permission_pilot_activation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  organization_id TEXT NOT NULL CHECK (length(organization_id) > 0),
  command_id TEXT NOT NULL UNIQUE CHECK (length(command_id) > 0),
  command_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(command_sha256) = 71 AND
    substr(command_sha256, 1, 7) = 'sha256:' AND
    substr(command_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  policy_id TEXT NOT NULL CHECK (policy_id = 'pilot-member-readable-v1'),
  presentation_policy_id TEXT NOT NULL CHECK (
    presentation_policy_id = 'pilot-two-person-audience-v1'
  ),
  audience_json TEXT NOT NULL CHECK (length(audience_json) > 0),
  presentation_descriptor_json TEXT NOT NULL CHECK (
    length(presentation_descriptor_json) > 0
  ),
  audience_notice_sha256 TEXT NOT NULL CHECK (
    length(audience_notice_sha256) = 71 AND
    substr(audience_notice_sha256, 1, 7) = 'sha256:' AND
    substr(audience_notice_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  activated_at TEXT NOT NULL CHECK (length(activated_at) > 0),
  effective_after_position INTEGER NOT NULL CHECK (
    effective_after_position >= 0
  ),
  effective_after_record_hash TEXT CHECK (
    (effective_after_position = 0 AND effective_after_record_hash IS NULL) OR
    (effective_after_position > 0 AND
      length(effective_after_record_hash) = 71 AND
      substr(effective_after_record_hash, 1, 7) = 'sha256:' AND
      substr(effective_after_record_hash, 8) NOT GLOB '*[^0-9a-f]*')
  )
) STRICT;

CREATE TRIGGER organization_record_permission_pilot_activation_head_insert
BEFORE INSERT ON organization_record_permission_pilot_activation
WHEN
  NEW.organization_id IS NOT (
    SELECT organization_id
    FROM organization_record_log_metadata
    WHERE singleton = 1
  ) OR
  NEW.effective_after_position <>
    COALESCE((SELECT MAX(position) FROM organization_record_log), 0) OR
  NEW.effective_after_record_hash IS NOT (
    SELECT record_hash
    FROM organization_record_log
    WHERE position = NEW.effective_after_position
  )
BEGIN
  SELECT RAISE(ABORT, 'organization permission pilot activation must bind the current verified record head');
END;

CREATE TRIGGER organization_record_permission_pilot_activation_immutable_update
BEFORE UPDATE ON organization_record_permission_pilot_activation
BEGIN
  SELECT RAISE(ABORT, 'organization permission pilot activation is immutable');
END;

CREATE TRIGGER organization_record_permission_pilot_activation_immutable_delete
BEFORE DELETE ON organization_record_permission_pilot_activation
BEGIN
  SELECT RAISE(ABORT, 'organization permission pilot activation cannot be deleted');
END;

CREATE TABLE organization_record_permission_pilot_eligibility (
  position INTEGER PRIMARY KEY
    REFERENCES organization_record_log (position),
  record_hash TEXT NOT NULL UNIQUE
    REFERENCES organization_record_log (record_hash),
  policy_id TEXT NOT NULL CHECK (policy_id = 'pilot-member-readable-v1'),
  presentation_policy_id TEXT NOT NULL CHECK (
    presentation_policy_id = 'pilot-two-person-audience-v1'
  ),
  audience_notice_sha256 TEXT NOT NULL CHECK (
    length(audience_notice_sha256) = 71 AND
    substr(audience_notice_sha256, 1, 7) = 'sha256:' AND
    substr(audience_notice_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  message_presentation_sha256 TEXT NOT NULL CHECK (
    length(message_presentation_sha256) = 71 AND
    substr(message_presentation_sha256, 1, 7) = 'sha256:' AND
    substr(message_presentation_sha256, 8) NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;

CREATE TRIGGER organization_record_permission_pilot_eligibility_bound_insert
BEFORE INSERT ON organization_record_permission_pilot_eligibility
WHEN NOT EXISTS (
  SELECT 1
  FROM organization_record_permission_pilot_activation AS activation
  JOIN organization_record_log AS record
    ON record.position = NEW.position
   AND record.record_hash = NEW.record_hash
  WHERE activation.singleton = 1
    AND record.event_type = 'approval'
    AND record.position > activation.effective_after_position
    AND NEW.policy_id = activation.policy_id
    AND NEW.presentation_policy_id = activation.presentation_policy_id
    AND NEW.audience_notice_sha256 = activation.audience_notice_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'organization permission pilot eligibility is not bound to an activated post-boundary approval');
END;

CREATE TRIGGER organization_record_permission_pilot_eligibility_immutable_update
BEFORE UPDATE ON organization_record_permission_pilot_eligibility
BEGIN
  SELECT RAISE(ABORT, 'organization permission pilot eligibility is immutable');
END;

CREATE TRIGGER organization_record_permission_pilot_eligibility_immutable_delete
BEFORE DELETE ON organization_record_permission_pilot_eligibility
BEGIN
  SELECT RAISE(ABORT, 'organization permission pilot eligibility cannot be deleted');
END;
