CREATE TABLE authority_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL UNIQUE,
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE authority_organizations (
  organization_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  provisioned_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE TABLE authority_principals (
  principal_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES authority_organizations(organization_id),
  display_name TEXT NOT NULL,
  provisioned_at TEXT NOT NULL,
  UNIQUE (organization_id, principal_id)
) STRICT;

CREATE TABLE authority_memberships (
  membership_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES authority_organizations(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_type TEXT NOT NULL CHECK (membership_type IN ('owner', 'employee', 'contractor')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  version INTEGER NOT NULL CHECK (version > 0),
  provisioned_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  UNIQUE (organization_id, membership_id)
) STRICT;

CREATE TABLE authority_enrollment_grants (
  grant_sha256 TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL REFERENCES authority_metadata(authority_id),
  organization_id TEXT NOT NULL REFERENCES authority_organizations(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  challenge_id TEXT UNIQUE
) STRICT;

CREATE INDEX authority_enrollment_grants_membership
  ON authority_enrollment_grants (membership_id, issued_at);

CREATE TABLE authority_identity_manifests (
  manifest_id TEXT PRIMARY KEY,
  manifest_sha256 TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL REFERENCES authority_organizations(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  installation_id TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  registered_at TEXT NOT NULL,
  UNIQUE (manifest_id, manifest_sha256)
) STRICT;

CREATE TABLE authority_publication_policies (
  policy_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  policy_sha256 TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL REFERENCES authority_organizations(organization_id),
  manifest_id TEXT NOT NULL REFERENCES authority_identity_manifests(manifest_id),
  installation_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  registered_at TEXT NOT NULL,
  PRIMARY KEY (policy_id, version)
) STRICT;

CREATE TABLE authority_enrollment_challenges (
  challenge_id TEXT PRIMARY KEY,
  grant_sha256 TEXT NOT NULL UNIQUE REFERENCES authority_enrollment_grants(grant_sha256),
  authority_id TEXT NOT NULL,
  organization_id TEXT NOT NULL REFERENCES authority_organizations(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  installation_id TEXT NOT NULL,
  installation_key_id TEXT NOT NULL,
  identity_manifest_id TEXT NOT NULL,
  identity_manifest_sha256 TEXT NOT NULL,
  publication_policy_id TEXT NOT NULL,
  publication_policy_version INTEGER NOT NULL CHECK (publication_policy_version > 0),
  publication_policy_sha256 TEXT NOT NULL,
  publication_policy_json TEXT NOT NULL CHECK (json_valid(publication_policy_json)),
  challenge_sha256 TEXT NOT NULL UNIQUE,
  challenge_json TEXT NOT NULL CHECK (json_valid(challenge_json)),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  proof_sha256 TEXT,
  proof_json TEXT CHECK (proof_json IS NULL OR json_valid(proof_json)),
  enrollment_receipt_sha256 TEXT,
  enrollment_receipt_json TEXT CHECK (
    enrollment_receipt_json IS NULL OR json_valid(enrollment_receipt_json)
  )
) STRICT;

CREATE INDEX authority_challenges_installation
  ON authority_enrollment_challenges (installation_id, issued_at);

CREATE TABLE authority_installations (
  installation_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES authority_organizations(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  key_id TEXT NOT NULL UNIQUE,
  public_key_spki_der_base64 TEXT NOT NULL,
  identity_manifest_id TEXT NOT NULL UNIQUE,
  identity_manifest_sha256 TEXT NOT NULL UNIQUE,
  identity_manifest_json TEXT NOT NULL CHECK (json_valid(identity_manifest_json)),
  publication_policy_id TEXT NOT NULL,
  publication_policy_version INTEGER NOT NULL CHECK (publication_policy_version > 0),
  publication_policy_sha256 TEXT NOT NULL,
  enrollment_receipt_sha256 TEXT NOT NULL UNIQUE,
  enrollment_receipt_json TEXT NOT NULL CHECK (json_valid(enrollment_receipt_json)),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  version INTEGER NOT NULL CHECK (version > 0),
  enrolled_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  last_event_hash TEXT,
  CHECK ((last_sequence = 0) = (last_event_hash IS NULL)),
  UNIQUE (organization_id, installation_id),
  FOREIGN KEY (identity_manifest_id, identity_manifest_sha256)
    REFERENCES authority_identity_manifests(manifest_id, manifest_sha256),
  FOREIGN KEY (publication_policy_id, publication_policy_version)
    REFERENCES authority_publication_policies(policy_id, version)
) STRICT;

CREATE TABLE authority_accepted_events (
  event_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL REFERENCES authority_organizations(organization_id),
  principal_id TEXT NOT NULL REFERENCES authority_principals(principal_id),
  membership_id TEXT NOT NULL REFERENCES authority_memberships(membership_id),
  installation_id TEXT NOT NULL REFERENCES authority_installations(installation_id),
  local_subject_key TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  previous_event_hash TEXT,
  event_sha256 TEXT NOT NULL,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  accepted_at TEXT NOT NULL,
  UNIQUE (installation_id, sequence),
  UNIQUE (installation_id, event_sha256),
  UNIQUE (installation_id, local_subject_key)
) STRICT;

CREATE TABLE authority_ingest_receipts (
  receipt_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('accepted', 'duplicate', 'rejected', 'quarantined')
  ),
  receipt_sha256 TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  server_received_at TEXT NOT NULL
) STRICT;

CREATE INDEX authority_receipts_event
  ON authority_ingest_receipts (event_id, server_received_at);
