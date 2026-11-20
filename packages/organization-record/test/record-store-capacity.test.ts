import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES } from "../../../packages/organization-protocol/src/record-payload.js";

describe("record store capacity", () => {
  it("bounds a record document by the largest value the record store's SQLite build holds", () => {
    const database = new Database(":memory:");
    try {
      const options = (database.pragma("compile_options") as { compile_options: string }[]).map((row) => row.compile_options);
      expect(options).toContain(`MAX_LENGTH=${MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES}`);
    } finally {
      database.close();
    }
  });
});
