CREATE TABLE federated_source_attributions (
  source_adapter_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  meeting_revision TEXT NOT NULL,
  identity_manifest_id TEXT NOT NULL,
  adapter_binding_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_generation INTEGER NOT NULL CHECK (connection_generation > 0),
  attribution_json TEXT NOT NULL CHECK (json_valid(attribution_json)),
  captured_at TEXT NOT NULL,
  PRIMARY KEY (
    source_adapter_id,
    source_instance_id,
    external_id,
    meeting_revision
  )
) STRICT;

CREATE TABLE federated_processor_attributions (
  source_adapter_id TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  meeting_revision TEXT NOT NULL,
  processor_adapter_id TEXT NOT NULL,
  processor_instance_id TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  identity_manifest_id TEXT NOT NULL,
  adapter_binding_id TEXT NOT NULL,
  attribution_json TEXT NOT NULL CHECK (json_valid(attribution_json)),
  captured_at TEXT NOT NULL,
  PRIMARY KEY (
    source_adapter_id,
    source_instance_id,
    external_id,
    meeting_revision,
    processor_adapter_id,
    processor_instance_id,
    processor_version
  )
) STRICT;

CREATE TABLE federated_chain_heads (
  installation_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  last_event_hash TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE federated_outbox_events (
  event_id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  local_subject_key TEXT NOT NULL,
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  created_at TEXT NOT NULL,
  UNIQUE (installation_id, sequence),
  UNIQUE (installation_id, event_type, local_subject_key)
) STRICT;

CREATE INDEX federated_outbox_events_type_sequence
  ON federated_outbox_events (event_type, installation_id, sequence);
