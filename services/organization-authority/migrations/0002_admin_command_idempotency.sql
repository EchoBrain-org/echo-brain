ALTER TABLE authority_memberships
  ADD COLUMN admin_command_id TEXT;

ALTER TABLE authority_memberships
  ADD COLUMN admin_command_sha256 TEXT;

CREATE UNIQUE INDEX authority_memberships_admin_command
  ON authority_memberships (admin_command_id)
  WHERE admin_command_id IS NOT NULL;

CREATE TRIGGER authority_memberships_admin_command_pair_insert
BEFORE INSERT ON authority_memberships
BEGIN
  SELECT CASE WHEN
    NEW.admin_command_id IS NULL OR
    NEW.admin_command_sha256 IS NULL OR
    length(NEW.admin_command_id) != 40 OR
    NEW.admin_command_id NOT GLOB 'adm_????????-????-4???-[89ab]???-????????????' OR
    length(replace(substr(NEW.admin_command_id, 5), '-', '')) != 32 OR
    replace(substr(NEW.admin_command_id, 5), '-', '') GLOB '*[^0-9a-f]*' OR
    length(NEW.admin_command_sha256) != 71 OR
    substr(NEW.admin_command_sha256, 1, 7) != 'sha256:' OR
    substr(NEW.admin_command_sha256, 8) GLOB '*[^0-9a-f]*'
  THEN RAISE(ABORT, 'membership admin command metadata is invalid') END;
END;

CREATE TRIGGER authority_memberships_admin_command_immutable
BEFORE UPDATE OF admin_command_id, admin_command_sha256 ON authority_memberships
BEGIN
  SELECT RAISE(ABORT, 'membership admin command metadata is immutable');
END;

ALTER TABLE authority_enrollment_grants
  ADD COLUMN admin_command_id TEXT;

ALTER TABLE authority_enrollment_grants
  ADD COLUMN admin_command_sha256 TEXT;

CREATE UNIQUE INDEX authority_enrollment_grants_admin_command
  ON authority_enrollment_grants (admin_command_id)
  WHERE admin_command_id IS NOT NULL;

CREATE TRIGGER authority_enrollment_grants_admin_command_pair_insert
BEFORE INSERT ON authority_enrollment_grants
BEGIN
  SELECT CASE WHEN
    NEW.admin_command_id IS NULL OR
    NEW.admin_command_sha256 IS NULL OR
    length(NEW.admin_command_id) != 40 OR
    NEW.admin_command_id NOT GLOB 'adm_????????-????-4???-[89ab]???-????????????' OR
    length(replace(substr(NEW.admin_command_id, 5), '-', '')) != 32 OR
    replace(substr(NEW.admin_command_id, 5), '-', '') GLOB '*[^0-9a-f]*' OR
    length(NEW.admin_command_sha256) != 71 OR
    substr(NEW.admin_command_sha256, 1, 7) != 'sha256:' OR
    substr(NEW.admin_command_sha256, 8) GLOB '*[^0-9a-f]*'
  THEN RAISE(ABORT, 'enrollment grant admin command metadata is invalid') END;
END;

CREATE TRIGGER authority_enrollment_grants_admin_command_immutable
BEFORE UPDATE OF admin_command_id, admin_command_sha256
ON authority_enrollment_grants
BEGIN
  SELECT RAISE(ABORT, 'enrollment grant admin command metadata is immutable');
END;
