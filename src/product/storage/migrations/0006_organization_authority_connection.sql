CREATE TABLE organization_authority_connections (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL UNIQUE,
  authority_base_url TEXT NOT NULL,
  configured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (authority_id)
    REFERENCES organization_authority_pins (authority_id),
  FOREIGN KEY (organization_id)
    REFERENCES organization_authority_pins (organization_id),
  CHECK (
    authority_base_url = rtrim(authority_base_url, '/') AND
    (
      substr(authority_base_url, 1, 8) = 'https://' OR
      authority_base_url = 'http://127.0.0.1' OR
      substr(authority_base_url, 1, 17) = 'http://127.0.0.1:' OR
      authority_base_url = 'http://[::1]' OR
      substr(authority_base_url, 1, 13) = 'http://[::1]:'
    )
  )
) STRICT;

CREATE TRIGGER organization_authority_connections_are_write_once
BEFORE UPDATE ON organization_authority_connections
BEGIN
  SELECT RAISE(ABORT, 'organization authority connection is write-once');
END;

CREATE TRIGGER organization_authority_connections_cannot_be_deleted
BEFORE DELETE ON organization_authority_connections
BEGIN
  SELECT RAISE(ABORT, 'organization authority connection cannot be deleted');
END;
