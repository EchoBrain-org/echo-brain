import { describe, expect, it } from "vitest";
import {
  APPROVED_DECISION_SNAPSHOT_V2_KIND,
  approvedDecisionSnapshotV2Sha256,
  validateApprovedDecisionSnapshotV2,
} from "../src/approved-decision-snapshot-v2.js";

const digest = (letter: string): `sha256:${string}` =>
  `sha256:${letter.repeat(64)}`;

function approvedPayload(): Record<string, unknown> {
  return {
    brief: {
      schema_version: 1,
      id: "brief-1",
      meeting: { id: "meeting-1", participants: [] },
      decisions: [
        {
          id: "decision-1",
          kind: "decision",
          text: "Ship the pilot.",
          subject: null,
          confidence: null,
          evidence: [{ meeting_id: "meeting-1", block_id: "block-1" }],
          status: "decided",
        },
      ],
      actions: [],
      rationales: [],
      provenance: {
        meeting_revision: "revision-1",
        processor: {
          kind: "decision-processor",
          adapter_id: "structured-text",
          instance_id: "default",
          version: "1.0.0",
        },
        generated_at: "2026-08-20T12:00:00.000Z",
      },
    },
    source: {
      adapter_id: "meeting-source",
      instance_id: "primary",
      external_id: "meeting-1",
    },
    alternatives: [],
    links: null,
    reviewed_at: "2026-08-20T12:01:00.000Z",
    surface: "person-approval",
  };
}

function snapshot(): Record<string, unknown> {
  return {
    schema_version: 2,
    kind: APPROVED_DECISION_SNAPSHOT_V2_KIND,
    approval_id: "approval-1",
    staged_content_sha256: digest("a"),
    final_content_sha256: digest("b"),
    payload_contract_id: "organization-record-approval-payload-v1",
    approved_payload: approvedPayload(),
  };
}

function mutate<T extends Record<string, unknown>>(
  value: T,
  key: string,
  replacement: unknown,
): T {
  return { ...structuredClone(value), [key]: replacement } as T;
}

// Moved unchanged from the retired human-act record input V1 test: the snapshot outlived it, and approval-decision V2 input carries it.
describe("approved decision snapshot v2", () => {
  it("closes and hashes the approved snapshot without claiming to derive frozen content digests", () => {
    const input = snapshot();
    const validated = validateApprovedDecisionSnapshotV2(input);
    expect(validated).not.toBe(input);
    expect(validated.approved_payload.alternatives).toEqual([]);
    expect(validated.approved_payload.links).toBeNull();
    const baseline = approvedDecisionSnapshotV2Sha256(validated);
    expect(baseline).toBe(
      "sha256:2a802f8fc219e71dcbb052148c82b775d8348664a8d16d9f84eb4ae9f491d0ed",
    );
    const changes: Record<string, unknown> = {
      schema_version: 3,
      kind: "wrong",
      approval_id: "approval-2",
      staged_content_sha256: digest("1"),
      final_content_sha256: digest("2"),
      payload_contract_id: "wrong",
      approved_payload: { ...approvedPayload(), surface: "another-surface" },
    };
    for (const [key, replacement] of Object.entries(changes)) {
      const changed = mutate(input, key, replacement);
      if (key === "staged_content_sha256" || key === "final_content_sha256" || key === "approval_id" || key === "approved_payload") {
        expect(approvedDecisionSnapshotV2Sha256(validateApprovedDecisionSnapshotV2(changed))).not.toBe(baseline);
      } else {
        expect(() => validateApprovedDecisionSnapshotV2(changed)).toThrow();
      }
    }
    expect(() => validateApprovedDecisionSnapshotV2({ ...input, delivery_binding_id: "forbidden" })).toThrow();
    const zeroSignal = approvedPayload();
    const zeroBrief = zeroSignal.brief as Record<string, unknown>;
    zeroBrief.decisions = [];
    zeroBrief.actions = [];
    zeroBrief.rationales = [];
    expect(
      validateApprovedDecisionSnapshotV2({
        ...snapshot(),
        approved_payload: zeroSignal,
      }).approved_payload.brief.decisions,
    ).toEqual([]);
  });

  it("accepts neither accessors nor symbols, a null prototype, non-enumerable keys, NaN nor an unpaired surrogate", () => {
    const accessor = snapshot();
    Object.defineProperty(accessor, "approval_id", { enumerable: true, get: () => "approval-1" });
    expect(() => validateApprovedDecisionSnapshotV2(accessor)).toThrow();
    const symbol = Symbol("hidden");
    const withSymbol = snapshot();
    Object.defineProperty(withSymbol, symbol, { value: "hidden" });
    expect(() => validateApprovedDecisionSnapshotV2(withSymbol)).toThrow();
    const customPrototype = snapshot();
    Object.setPrototypeOf(customPrototype, null);
    expect(() => validateApprovedDecisionSnapshotV2(customPrototype)).toThrow();
    const nonEnumerable = snapshot();
    Object.defineProperty(nonEnumerable, "hidden", {
      enumerable: false,
      value: "hidden",
    });
    expect(() => validateApprovedDecisionSnapshotV2(nonEnumerable)).toThrow();
    const nonFinite = snapshot();
    ((nonFinite.approved_payload as Record<string, unknown>).brief as Record<string, unknown>).schema_version = Number.NaN;
    expect(() => validateApprovedDecisionSnapshotV2(nonFinite)).toThrow();
    const unpairedSurrogate = snapshot();
    unpairedSurrogate.approval_id = "approval-\ud800";
    expect(() => validateApprovedDecisionSnapshotV2(unpairedSurrogate)).toThrow();
  });
});
