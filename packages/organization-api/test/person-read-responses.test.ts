import { describe, expect, it } from "vitest";
import {
  ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
  ORGANIZATION_RECENT_DECISIONS_WITNESS,
  validateOrganizationRecentDecisionsResponse,
} from "../src/index.js";

const item = {
  atom_id: "sha256:" + "a".repeat(64),
  kind: "decision",
  text: "Keep the response boundary strict.",
  record_hash: "sha256:" + "b".repeat(64),
} as const;

function responseWith(items: unknown): Record<string, unknown> {
  return {
    schema_version: 1,
    policy_id: ORGANIZATION_RECENT_DECISIONS_POLICY_ID,
    witness: ORGANIZATION_RECENT_DECISIONS_WITNESS,
    items,
  };
}

describe("organization Person read responses", () => {
  it("rejects sparse, non-enumerable, and accessor item slots without reading them", () => {
    const sparse = new Array(1);
    const nonEnumerable = [item];
    Object.defineProperty(nonEnumerable, "0", {
      value: item,
      enumerable: false,
    });
    let accessorRead = false;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        accessorRead = true;
        return item;
      },
    });

    for (const malformed of [sparse, nonEnumerable, accessor]) {
      expect(() =>
        validateOrganizationRecentDecisionsResponse(responseWith(malformed)),
      ).toThrow("must be a dense array");
    }
    expect(accessorRead).toBe(false);
  });
});
