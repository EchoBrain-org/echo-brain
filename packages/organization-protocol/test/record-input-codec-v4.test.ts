import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { APPROVAL_DECISION_RECORD_INPUT_CODEC_V2 } from "../src/approval-decision-record-input-v2.js";
import { createRecordInputCodecRegistryV4, type RecordInputCodecV4, type RecordHumanActEventV4, type ValidatedRecordInputV4 } from "../src/record-input-codec-v4.js";

const reference = { schema_version: 1, kind: "fixture-resolution-v1", authority_id: "authority", organization_id: "organization",
  state_lineage_id: "lineage", approval_id: "approval", action: "approve" as const, audit_event_id: "audit", audit_sequence: 1,
  audit_entry_sha256: canonicalSha256("audit"), provider_action_kind: "fixture-action-v1", provider_action_schema_version: 1,
  provider_action_sha256: canonicalSha256("action"), authorization_proof_sha256: canonicalSha256("authorization") };

/** The registry reads only an event's kind; the codec owns the rest of its exact event. */
const approved = { kind: "approved" } as unknown as RecordHumanActEventV4;

function alternate(): RecordInputCodecV4 {
  const expected = { ...reference };
  const result: ValidatedRecordInputV4 = { human_act_resolution_ref: expected, event: approved, semantic_idempotency_key: canonicalSha256(expected) };
  const decode = (ref: unknown, event: unknown) => {
    if (canonicalSha256(ref) !== canonicalSha256(expected) || canonicalSha256(event) !== canonicalSha256(result.event)) throw new Error("fixture exact contract mismatch");
    return result;
  };
  return { input_reference_field: "fixture_resolution_ref", reference_kind: expected.kind, reference_schema_version: 1,
    validateInput(value) { const input = value as { fixture_resolution_ref: unknown; event: unknown }; return decode(input.fixture_resolution_ref, input.event); },
    fromReference: decode,
  };
}

describe("the one V4 record codec", () => {
  it("joins the codec's own exact contract to its field, kind and version", () => {
    const registry = createRecordInputCodecRegistryV4([alternate()]);
    const input = { fixture_resolution_ref: reference, event: { kind: "approved" } };
    expect(registry.validateInput(input)).toEqual(registry.fromReference(reference, input.event));
    expect(() => registry.fromReference({ ...reference, schema_version: 2 }, input.event)).toThrow("unknown");
    expect(() => registry.validateInput({ unknown_resolution_ref: reference, event: input.event })).toThrow("unknown");
    expect(() => registry.validateInput([input])).toThrow("must be an object");
    expect(() => registry.fromReference({ ...reference, approval_id: "changed" }, input.event)).toThrow("exact contract");
    const decision = createRecordInputCodecRegistryV4([APPROVAL_DECISION_RECORD_INPUT_CODEC_V2]);
    expect(() => decision.validateInput(input)).toThrow("unknown");
    expect(() => decision.fromReference(reference, input.event)).toThrow("unknown");
  });

  it("reads its descriptor once instead of admitting later registration or mutation", () => {
    const codec = alternate();
    const registry = createRecordInputCodecRegistryV4([codec]);
    Object.assign(codec, { reference_kind: "changed", fromReference: () => { throw new Error("mutated"); } });
    expect(registry.fromReference(reference, { kind: "approved" }).human_act_resolution_ref).toEqual(reference);
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("rejects a decoder returning a different contract or a rejection", () => {
    const codec = alternate();
    const original = codec.fromReference(reference, { kind: "approved" });
    const registry = createRecordInputCodecRegistryV4([{ ...codec, fromReference: () => ({ ...original, human_act_resolution_ref: { ...reference, kind: "other-kind" } }) }]);
    expect(() => registry.fromReference(reference, { kind: "approved" })).toThrow("different contract");
    // Every record is an approval: a codec that returns a rejection is refused.
    const rejecting = createRecordInputCodecRegistryV4([{ ...codec, fromReference: () => ({ ...original, event: { kind: "rejected" } as unknown as RecordHumanActEventV4 }) }]);
    expect(() => rejecting.fromReference(reference, { kind: "approved" })).toThrow("different contract");
  });
});
