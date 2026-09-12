import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { createRecordInputCodecRegistryV4, HUMAN_ACT_RECORD_INPUT_CODEC_V1, type RecordInputCodecV4, type ValidatedRecordInputV4 } from "../src/record-input-codec-v4.js";

function alternate(): RecordInputCodecV4 {
  const reference = { schema_version: 1, kind: "fixture-resolution-v1", authority_id: "authority", organization_id: "organization",
    state_lineage_id: "lineage", approval_id: "approval", action: "reject" as const, audit_event_id: "audit", audit_sequence: 1,
    audit_entry_sha256: canonicalSha256("audit"), provider_action_kind: "fixture-action-v1", provider_action_schema_version: 1,
    provider_action_sha256: canonicalSha256("action"), authorization_proof_sha256: canonicalSha256("authorization") };
  const result: ValidatedRecordInputV4 = { human_act_resolution_ref: reference, event: { kind: "rejected" }, semantic_idempotency_key: canonicalSha256(reference) };
  const decode = (ref: unknown, event: unknown) => {
    if (canonicalSha256(ref) !== canonicalSha256(reference) || canonicalSha256(event) !== canonicalSha256(result.event)) throw new Error("fixture exact contract mismatch");
    return result;
  };
  return { input_reference_field: "fixture_resolution_ref", reference_kind: reference.kind, reference_schema_version: 1,
    validateInput(value) { const input = value as { fixture_resolution_ref: unknown; event: unknown }; return decode(input.fixture_resolution_ref, input.event); },
    fromReference: decode,
  };
}

const reference = { schema_version: 1, kind: "fixture-resolution-v1", authority_id: "authority", organization_id: "organization",
  state_lineage_id: "lineage", approval_id: "approval", action: "reject", audit_event_id: "audit", audit_sequence: 1,
  audit_entry_sha256: canonicalSha256("audit"), provider_action_kind: "fixture-action-v1", provider_action_schema_version: 1,
  provider_action_sha256: canonicalSha256("action"), authorization_proof_sha256: canonicalSha256("authorization") };

describe("closed V4 record codec composition", () => {
  it("selects an independent exact contract without changing the envelope or generic decoder", () => {
    const registry = createRecordInputCodecRegistryV4([HUMAN_ACT_RECORD_INPUT_CODEC_V1, alternate()]);
    const input = { fixture_resolution_ref: reference, event: { kind: "rejected" } };
    expect(registry.validateInput(input)).toEqual(registry.fromReference(reference, input.event));
    expect(() => registry.fromReference({ ...reference, schema_version: 2 }, input.event)).toThrow("unknown");
    expect(() => registry.validateInput({ ...input, human_act_resolution_ref: reference })).toThrow("ambiguous");
    expect(() => registry.validateInput({ unknown_resolution_ref: reference, event: input.event })).toThrow("unknown");
    expect(() => registry.fromReference({ ...reference, approval_id: "changed" }, input.event)).toThrow("exact contract");
  });

  it("rejects duplicate selectors and snapshots descriptors instead of admitting later registration or mutation", () => {
    const codec = alternate();
    expect(() => createRecordInputCodecRegistryV4([codec, { ...codec, reference_kind: "different-kind" }])).toThrow("ambiguous");
    expect(() => createRecordInputCodecRegistryV4([codec, { ...codec, input_reference_field: "different_field" }])).toThrow("ambiguous");
    const list = [codec];
    const registry = createRecordInputCodecRegistryV4(list);
    list.length = 0;
    Object.assign(codec, { reference_kind: "changed", fromReference: () => { throw new Error("mutated"); } });
    expect(registry.fromReference(reference, { kind: "rejected" }).human_act_resolution_ref).toEqual(reference);
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("rejects a decoder returning a different registered contract", () => {
    const codec = alternate();
    const original = codec.fromReference(reference, { kind: "rejected" });
    const registry = createRecordInputCodecRegistryV4([{ ...codec, fromReference: () => ({ ...original, human_act_resolution_ref: { ...reference, action: "reject", kind: "other-kind" } }) }]);
    expect(() => registry.fromReference(reference, { kind: "rejected" })).toThrow("different contract");
  });
});
