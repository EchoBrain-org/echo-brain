// Positive and negative decision-brief cases run against the live organization
// record approval payload validator. The brief validator is private, so each
// case is wrapped in an otherwise valid approval payload.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertOrganizationRecordApprovalPayload } from "../src/record-payload.js";

interface PayloadConformanceFixture {
  fixture_version: number;
  kind: string;
  valid: { name: string; brief: unknown }[];
  invalid: { name: string; reason: string; brief: unknown }[];
}

const conformance = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/organization-record-payload-conformance.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as PayloadConformanceFixture;

function assertBrief(brief: unknown): void {
  assertOrganizationRecordApprovalPayload(
    {
      brief,
      source: {
        adapter_id: "granola",
        instance_id: "default",
        external_id: "meeting-2026-08-07-pricing",
      },
      alternatives: [],
      links: null,
      reviewed_at: "2026-08-07T16:00:00.000Z",
      surface: "slack",
    },
    "approval payload",
  );
}

describe("organization record payload conformance fixture", () => {
  it("reads the versioned fixture", () => {
    expect(conformance.fixture_version).toBe(1);
    expect(conformance.kind).toBe(
      "echo-organization-record-payload-conformance-fixture",
    );
    expect(conformance.valid.length).toBeGreaterThan(0);
    expect(conformance.invalid.length).toBeGreaterThan(0);
  });

  it("accepts every valid brief", () => {
    for (const testCase of conformance.valid) {
      expect(() => assertBrief(testCase.brief), testCase.name).not.toThrow();
    }
  });

  it("rejects every invalid brief", () => {
    for (const testCase of conformance.invalid) {
      expect(
        () => assertBrief(testCase.brief),
        `${testCase.name}: ${testCase.reason}`,
      ).toThrowError(
        expect.objectContaining({
          name: "OrganizationProtocolValidationError",
        }),
      );
    }
  });
});
