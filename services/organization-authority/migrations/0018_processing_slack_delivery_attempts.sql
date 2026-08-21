-- Durable claim and outcome state around Slack's non-idempotent message write.
-- An unknown row is inserted before provider I/O. Only that claimer may call
-- Slack; every concurrent or restarted caller observes the existing row.

CREATE TABLE authority_processing_slack_delivery_attempts (
  idempotency_key TEXT NOT NULL PRIMARY KEY CHECK (
    length(trim(idempotency_key)) >= 1 AND length(idempotency_key) <= 8192
  ),
  status TEXT NOT NULL CHECK (status IN ('unknown', 'delivered')),
  channel_id TEXT,
  message_ts TEXT,
  recorded_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS NOT NULL AND
    recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at)
  ),
  message TEXT,
  CHECK (
    (
      status = 'unknown' AND
      channel_id IS NULL AND
      message_ts IS NULL AND
      message IS NOT NULL AND
      length(trim(message)) >= 1 AND length(message) <= 4096
    ) OR (
      status = 'delivered' AND
      channel_id IS NOT NULL AND
      message_ts IS NOT NULL AND
      length(trim(channel_id)) >= 1 AND length(channel_id) <= 4096 AND
      length(trim(message_ts)) >= 1 AND length(message_ts) <= 4096 AND
      message IS NULL
    )
  )
) STRICT;

CREATE TRIGGER authority_processing_slack_delivery_delivered_immutable
BEFORE UPDATE ON authority_processing_slack_delivery_attempts
WHEN OLD.status = 'delivered'
BEGIN
  SELECT RAISE(ABORT, 'delivered Slack outcome is immutable');
END;

CREATE TRIGGER authority_processing_slack_delivery_delivered_delete_denied
BEFORE DELETE ON authority_processing_slack_delivery_attempts
WHEN OLD.status = 'delivered'
BEGIN
  SELECT RAISE(ABORT, 'delivered Slack outcome deletion is denied');
END;
