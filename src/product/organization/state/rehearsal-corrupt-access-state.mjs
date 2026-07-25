// Owned beside sqlite-organization-state-store.ts because this deliberate
// corruption depends on its private organization_access_high_watermarks schema.
// It is unreachable from product entry points and never ships.
export const REHEARSAL_CORRUPT_ACCESS_STATE_SQL = `
UPDATE organization_access_high_watermarks
SET state_json = json_set(
  state_json,
  '$.evaluated_at',
  '2000-01-01T00:00:00.000Z'
)
WHERE request_sha256 = (
  SELECT request_sha256
  FROM organization_access_high_watermarks
  LIMIT 1
)`;
