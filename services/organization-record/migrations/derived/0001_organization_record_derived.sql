-- The derived organization decision graph. Disposable and rebuildable.
--
-- Every row here is a pure function of log content. Deleting this database and
-- replaying the log from position zero must reproduce the same canonical
-- content digest, so no row may carry authority state, wall-clock derivation
-- time, or any resolved reader list.

CREATE TABLE organization_derived_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  organization_id TEXT NOT NULL CHECK (length(organization_id) > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0)
) STRICT;

-- One cursor. The last log position whose rows and edges are fully committed.
CREATE TABLE organization_derived_cursor (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  last_position INTEGER NOT NULL CHECK (last_position >= 0),
  updated_at TEXT NOT NULL CHECK (length(updated_at) > 0)
) STRICT;

CREATE TABLE organization_derived_atom (
  atom_id TEXT PRIMARY KEY CHECK (atom_id LIKE 'sha256:%'),
  log_position INTEGER NOT NULL CHECK (log_position > 0),
  record_hash TEXT NOT NULL CHECK (record_hash LIKE 'sha256:%'),
  approval_group TEXT NOT NULL CHECK (approval_group LIKE 'sha256:%'),
  signal_id TEXT NOT NULL CHECK (length(signal_id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'action', 'rationale')),
  text TEXT NOT NULL,
  subject TEXT,
  status TEXT,
  owner TEXT,
  due_at TEXT,
  confidence REAL,
  evidence TEXT NOT NULL CHECK (length(evidence) > 0),
  restricted INTEGER NOT NULL CHECK (restricted IN (0, 1)),
  reviewer_principal_id TEXT NOT NULL CHECK (length(reviewer_principal_id) > 0),
  reviewer_display_name TEXT,
  reviewed_at TEXT NOT NULL CHECK (length(reviewed_at) > 0),
  UNIQUE (log_position, signal_id)
) STRICT;

-- One approval-scoped snapshot. V1 deliberately does not merge snapshots
-- across records: two approvals of the same meeting produce two snapshots.
CREATE TABLE organization_derived_meeting_snapshot (
  snapshot_id TEXT PRIMARY KEY CHECK (snapshot_id LIKE 'sha256:%'),
  log_position INTEGER NOT NULL CHECK (log_position > 0),
  record_hash TEXT NOT NULL CHECK (record_hash LIKE 'sha256:%'),
  meeting_id TEXT NOT NULL CHECK (length(meeting_id) > 0),
  meeting_revision TEXT NOT NULL CHECK (length(meeting_revision) > 0),
  source_adapter_id TEXT NOT NULL CHECK (length(source_adapter_id) > 0),
  source_instance_id TEXT NOT NULL CHECK (length(source_instance_id) > 0),
  source_external_id TEXT NOT NULL CHECK (length(source_external_id) > 0),
  title TEXT,
  meeting_time TEXT,
  UNIQUE (log_position, meeting_id, meeting_revision)
) STRICT;

-- An observation stays an observation. No principal binding happens here:
-- resolving a participant against current membership is query-time gatekeeper
-- work and would read state that is not log content.
CREATE TABLE organization_derived_participant_observation (
  observation_id TEXT PRIMARY KEY CHECK (observation_id LIKE 'sha256:%'),
  snapshot_id TEXT NOT NULL
    REFERENCES organization_derived_meeting_snapshot (snapshot_id),
  participant_id TEXT NOT NULL CHECK (length(participant_id) > 0),
  display_name TEXT,
  identities TEXT NOT NULL,
  roles TEXT NOT NULL,
  response_status TEXT,
  attendance TEXT
) STRICT;

CREATE INDEX organization_derived_participant_observation_by_snapshot
ON organization_derived_participant_observation (snapshot_id);

CREATE TABLE organization_derived_rejection (
  rejection_id TEXT PRIMARY KEY CHECK (rejection_id LIKE 'sha256:%'),
  log_position INTEGER NOT NULL UNIQUE CHECK (log_position > 0),
  record_hash TEXT NOT NULL CHECK (record_hash LIKE 'sha256:%'),
  meeting_id TEXT NOT NULL CHECK (length(meeting_id) > 0),
  source_adapter_id TEXT NOT NULL CHECK (length(source_adapter_id) > 0),
  source_instance_id TEXT NOT NULL CHECK (length(source_instance_id) > 0),
  source_external_id TEXT NOT NULL CHECK (length(source_external_id) > 0),
  reviewer_principal_id TEXT NOT NULL CHECK (length(reviewer_principal_id) > 0),
  reviewer_display_name TEXT,
  rejected_at TEXT NOT NULL CHECK (length(rejected_at) > 0),
  reason TEXT,
  reconsider_after TEXT
) STRICT;

CREATE TABLE organization_derived_edge (
  edge_type TEXT NOT NULL CHECK (
    edge_type IN (
      'derived-from',
      'from-meeting',
      'listed-participant',
      'attended-by',
      'supports'
    )
  ),
  from_id TEXT NOT NULL CHECK (length(from_id) > 0),
  to_id TEXT NOT NULL CHECK (length(to_id) > 0),
  log_position INTEGER NOT NULL CHECK (log_position > 0),
  PRIMARY KEY (edge_type, from_id, to_id)
) STRICT;

CREATE INDEX organization_derived_edge_by_position
ON organization_derived_edge (log_position);
