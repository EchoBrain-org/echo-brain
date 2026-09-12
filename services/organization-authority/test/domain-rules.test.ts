import { describe, expect, it } from "vitest";
import {
  assertDisplayName,
  timestampMillis,
} from "@echo-brain/organization-authority-kernel/domain/rules";

describe("organization authority domain rules", () => {
  it("accepts only canonical UTC millisecond timestamps", () => {
    expect(timestampMillis("2026-07-22T00:00:00.000Z", "fixture")).toBe(
      Date.parse("2026-07-22T00:00:00.000Z"),
    );
    expect(() => timestampMillis("2026-07-22T00:00:00Z", "fixture")).toThrow();
  });

  it("validates display names independently of transport DTOs", () => {
    expect(() => assertDisplayName("Echo Team")).not.toThrow();
    for (const name of [" Echo Team", "", "x".repeat(201), "Echo\nTeam"]) {
      expect(() => assertDisplayName(name)).toThrowError(
        expect.objectContaining({ code: "invalid_request" }),
      );
    }
  });
});
