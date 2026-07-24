// Rehearsal-only fault injection for the Phase 5 one-machine ceremony.
//
// This module is deliberately unreachable from the product entry points.
// tools/product/build-artifact.mjs compiles the boundary closure, so a module
// no entry point reaches is never compiled into the shipped package and never
// installed on a client machine. The ceremony loads it from the repository
// build instead (see tools/phase5/ceremony-support.mjs).
//
// It still lives beside the store that owns
// organization_access_high_watermarks: a schema change breaks it here, next to
// the code that changed, rather than silently in the Phase 5 driver.
import { openProductDatabase } from '../../storage/open-product-database.js';

/**
 * Tampers with a persisted access-state document so a subsequent read fails
 * closed with an OrganizationStateCorruptionError.
 */
export function corruptStoredOrganizationAccessStateForRehearsal(
  databasePath: string,
): void {
  const database = openProductDatabase(databasePath, {
    durability: 'operational',
  });
  try {
    const row = database
      .prepare(
        `SELECT request_sha256, state_json
         FROM organization_access_high_watermarks
         LIMIT 1`,
      )
      .get() as { request_sha256: string; state_json: string } | undefined;
    if (row === undefined) {
      throw new Error('organization database has no access state to corrupt');
    }
    const state = JSON.parse(row.state_json) as { evaluated_at: string };
    state.evaluated_at = '2000-01-01T00:00:00.000Z';
    database
      .prepare(
        `UPDATE organization_access_high_watermarks
         SET state_json = ?
         WHERE request_sha256 = ?`,
      )
      .run(JSON.stringify(state), row.request_sha256);
  } finally {
    database.close();
  }
}
