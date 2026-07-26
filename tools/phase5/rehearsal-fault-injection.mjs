// Rehearsal-only fault injection. The executable stays outside the product
// boundary, while its private-schema statement is owned beside the state store.
import Database from "better-sqlite3";
import { REHEARSAL_CORRUPT_ACCESS_STATE_SQL } from "../../src/product/organization/state/rehearsal-corrupt-access-state.mjs";

export function corruptStoredOrganizationAccessStateForRehearsal(
  databasePath,
) {
  const database = new Database(databasePath);
  try {
    const result = database.prepare(REHEARSAL_CORRUPT_ACCESS_STATE_SQL).run();
    if (result.changes !== 1) {
      throw new Error("organization database has no access state to corrupt");
    }
  } finally {
    database.close();
  }
}
