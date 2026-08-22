import { describe, expect, it } from "vitest";
import {
  APPROVED_DECISION_SNAPSHOT_V2_KIND,
  AUTHORITY_HUMAN_ACT_IDEMPOTENCY_V2_KIND,
  HUMAN_ACT_EVENT_COMMITMENT_V1_KIND,
  HUMAN_ACT_RESOLUTION_REF_V1_KIND,
  approvedDecisionSnapshotV2Sha256,
  buildHumanActEventCommitmentV1,
  buildHumanActRecordInputV1,
  humanActEventV1Sha256,
  humanActIdempotencyV2Sha256,
  humanActResolutionRefV1Sha256,
  validateApprovedDecisionSnapshotV2,
  validateHumanActEventV1,
  validateHumanActEventCommitmentV1,
  validateHumanActIdempotencyV2,
  validateHumanActRecordInputV1,
  validateHumanActResolutionRefV1,
} from "../src/human-act-record-input-v1.js";
import {
  ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  organizationMemberReadablePersonConsequenceSha256,
  organizationMemberReadablePersonPolicyContractSha256,
  restrictedReviewerPersonConsequenceSha256,
  restrictedReviewerPersonPolicyContractSha256,
} from "../src/person-content-policy-v2.js";

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

function policy(policyId: string): Record<string, unknown> {
  if (policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID) {
    return {
      policy_id: policyId,
      policy_contract_sha256: restrictedReviewerPersonPolicyContractSha256(),
      policy_consequence_text: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
      policy_consequence_sha256: restrictedReviewerPersonConsequenceSha256(),
    };
  }
  return {
    policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    policy_contract_sha256: organizationMemberReadablePersonPolicyContractSha256(),
    policy_consequence_text: ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
    policy_consequence_sha256: organizationMemberReadablePersonConsequenceSha256(),
  };
}

function reference(action: "approve" | "reject" = "approve"): Record<string, unknown> {
  const selected = policy(RESTRICTED_REVIEWER_PERSON_POLICY_ID);
  return {
    schema_version: 1,
    kind: HUMAN_ACT_RESOLUTION_REF_V1_KIND,
    authority_id: "authority-1",
    organization_id: "organization-1",
    state_lineage_id: "lineage-1",
    approval_id: "approval-1",
    action,
    policy_id: selected.policy_id,
    policy_contract_sha256: selected.policy_contract_sha256,
    audit_event_id: "audit-1",
    audit_sequence: 1,
    audit_entry_sha256: digest("c"),
    provider_action_kind: "echo-provider-human-action-v2",
    provider_action_schema_version: 2,
    provider_action_sha256: digest("d"),
    authorization_proof_sha256: digest("e"),
  };
}

function approvedEvent(
  policyId:
    | typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID
    | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID =
    RESTRICTED_REVIEWER_PERSON_POLICY_ID,
): Record<string, unknown> {
  const selected = policy(policyId);
  const frozenSnapshot = snapshot();
  return {
    kind: "approved",
    approved_snapshot: frozenSnapshot,
    approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(
      validateApprovedDecisionSnapshotV2(frozenSnapshot),
    ),
    ...selected,
  };
}

function rejectedEvent(
  policyId:
    | typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID
    | typeof ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID =
    RESTRICTED_REVIEWER_PERSON_POLICY_ID,
): Record<string, unknown> {
  const selected = policy(policyId);
  return {
    kind: "rejected",
    candidate_sha256: digest("f"),
    approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(
      validateApprovedDecisionSnapshotV2(snapshot()),
    ),
    frozen_card_sha256: digest("0"),
    policy_id: selected.policy_id,
    policy_contract_sha256: selected.policy_contract_sha256,
    policy_consequence_sha256: selected.policy_consequence_sha256,
    action: "reject",
    rejection_payload: {
      source: {
        adapter_id: "meeting-source",
        instance_id: "primary",
        external_id: "meeting-1",
      },
      meeting_id: "meeting-1",
      rejected_at: "2026-08-20T12:02:00.000Z",
      reason: "Needs a clearer owner.",
      reconsider_after: null,
    },
  };
}

function idempotency(action: "approve" | "reject" = "approve"): Record<string, unknown> {
  const resolved = reference(action);
  const event = action === "approve" ? approvedEvent() : rejectedEvent();
  return {
    schema_version: 2,
    kind: AUTHORITY_HUMAN_ACT_IDEMPOTENCY_V2_KIND,
    authority_id: resolved.authority_id,
    organization_id: resolved.organization_id,
    state_lineage_id: resolved.state_lineage_id,
    approval_id: resolved.approval_id,
    action,
    human_act_resolution_ref_sha256: humanActResolutionRefV1Sha256(
      validateHumanActResolutionRefV1(resolved),
    ),
    human_act_event_sha256: humanActEventV1Sha256(validateHumanActEventV1(event)),
  };
}

function mutate<T extends Record<string, unknown>>(
  value: T,
  key: string,
  replacement: unknown,
): T {
  return { ...structuredClone(value), [key]: replacement } as T;
}

describe("D3 human-act record input v1", () => {
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

  it("closes the resolution reference and binds every D3 coordinate", () => {
    const input = reference();
    const baseline = humanActResolutionRefV1Sha256(validateHumanActResolutionRefV1(input));
    expect(baseline).toBe(
      "sha256:4582055582081a65c22e6f33cc0a44a090e17562196b565955d38c034ec4cd8f",
    );
    const changes: Record<string, unknown> = {
      schema_version: 2,
      kind: "wrong",
      authority_id: "authority-2",
      organization_id: "organization-2",
      state_lineage_id: "lineage-2",
      approval_id: "approval-2",
      action: "reject",
      policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
      policy_contract_sha256: digest("9"),
      audit_event_id: "audit-2",
      audit_sequence: 2,
      audit_entry_sha256: digest("1"),
      provider_action_kind: "wrong",
      provider_action_schema_version: 1,
      provider_action_sha256: digest("2"),
      authorization_proof_sha256: digest("3"),
    };
    for (const [key, replacement] of Object.entries(changes)) {
      const changed = mutate(input, key, replacement);
      if (key === "policy_id" || key === "policy_contract_sha256" || key === "schema_version" || key === "kind" || key === "provider_action_kind" || key === "provider_action_schema_version") {
        expect(() => validateHumanActResolutionRefV1(changed)).toThrow();
      } else {
        expect(humanActResolutionRefV1Sha256(validateHumanActResolutionRefV1(changed))).not.toBe(baseline);
      }
    }
    const memberPolicy = policy(ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID);
    const memberReference = {
      ...input,
      policy_id: memberPolicy.policy_id,
      policy_contract_sha256: memberPolicy.policy_contract_sha256,
    };
    expect(validateHumanActResolutionRefV1(memberReference)).toMatchObject({
      policy_id: memberPolicy.policy_id,
      policy_contract_sha256: memberPolicy.policy_contract_sha256,
    });
    expect(() => validateHumanActResolutionRefV1({ ...input, policy_id: memberPolicy.policy_id })).toThrow();
  });

  it("admits each exact Person-v2 approved event and rejects policy swaps or mixed events", () => {
    for (const policyId of [
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    ]) {
      const event = approvedEvent(policyId);
      const validatedEvent = validateHumanActEventV1(event);
      const commitment = buildHumanActEventCommitmentV1(validatedEvent);
      expect(commitment).toEqual({
        schema_version: 1,
        kind: HUMAN_ACT_EVENT_COMMITMENT_V1_KIND,
        event: validatedEvent,
      });
      expect(
        validateHumanActEventCommitmentV1(commitment),
      ).toEqual(commitment);
      expect(() =>
        validateHumanActEventCommitmentV1({ ...commitment, extra: true }),
      ).toThrow();
      expect(() =>
        validateHumanActEventCommitmentV1({ ...commitment, schema_version: 2 }),
      ).toThrow();
      expect(() =>
        validateHumanActEventCommitmentV1({ ...commitment, kind: "wrong" }),
      ).toThrow();
      const baseline = humanActEventV1Sha256(validatedEvent);
      if (policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID) {
        expect(baseline).toBe(
          "sha256:4eb245ba3334254afcbaaf06596cd8eba6a4fb57ff581bb00f4339277f7dac29",
        );
      }
      const modifiedSnapshot = structuredClone(event.approved_snapshot) as Record<string, unknown>;
      modifiedSnapshot.approval_id = "approval-2";
      const changed = {
        ...event,
        approved_snapshot: modifiedSnapshot,
        approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(
          validateApprovedDecisionSnapshotV2(modifiedSnapshot),
        ),
      };
      expect(humanActEventV1Sha256(validateHumanActEventV1(changed))).not.toBe(baseline);
      const changes: Record<string, unknown> = {
        kind: "rejected",
        approved_snapshot: modifiedSnapshot,
        approved_snapshot_sha256: digest("9"),
        policy_id: policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID ? ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID : RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        policy_contract_sha256: digest("8"),
        policy_consequence_text: "altered",
        policy_consequence_sha256: digest("7"),
      };
      for (const [key, replacement] of Object.entries(changes)) {
        const candidate = mutate(event, key, replacement);
        expect(() => validateHumanActEventV1(candidate)).toThrow();
      }
      expect(() => validateHumanActEventV1({ ...event, policy_id: "restricted-reviewer-v1" })).toThrow();
      expect(() => validateHumanActEventV1({ ...event, delivery: "forbidden" })).toThrow();
    }
  });

  it("keeps rejected acts bounded, validates the retained payload, and refuses all approved semantics", () => {
    for (const policyId of [
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    ]) {
      const event = rejectedEvent(policyId);
      const baseline = humanActEventV1Sha256(validateHumanActEventV1(event));
      const changes: Record<string, unknown> = {
        kind: "approved",
        candidate_sha256: digest("1"),
        approved_snapshot_sha256: digest("2"),
        frozen_card_sha256: digest("3"),
        policy_id: policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID ? ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID : RESTRICTED_REVIEWER_PERSON_POLICY_ID,
        policy_contract_sha256: digest("4"),
        policy_consequence_sha256: digest("5"),
        action: "approve",
        rejection_payload: { ...event.rejection_payload as Record<string, unknown>, reason: "Different reason." },
      };
      for (const [key, replacement] of Object.entries(changes)) {
        const changed = mutate(event, key, replacement);
        if (key === "kind" || key.startsWith("policy_") || key === "action") {
          expect(() => validateHumanActEventV1(changed)).toThrow();
        } else {
          expect(humanActEventV1Sha256(validateHumanActEventV1(changed))).not.toBe(baseline);
        }
      }
      const reasonAtLimit = structuredClone(event) as Record<string, unknown>;
      (reasonAtLimit.rejection_payload as Record<string, unknown>).reason = "x".repeat(2048);
      expect(validateHumanActEventV1(reasonAtLimit)).toBeDefined();
      (reasonAtLimit.rejection_payload as Record<string, unknown>).reason = "x".repeat(2049);
      expect(() => validateHumanActEventV1(reasonAtLimit)).toThrow();
      for (const forbidden of ["approved_snapshot", "approved_payload", "delivery", "policy_fact", "content"]) {
        expect(() => validateHumanActEventV1({ ...event, [forbidden]: "forbidden" })).toThrow();
      }
    }
  });

  it("hashes every semantic idempotency join and accepts neither accessors nor symbols", () => {
    for (const action of ["approve", "reject"] as const) {
      const input = idempotency(action);
      const baseline = humanActIdempotencyV2Sha256(validateHumanActIdempotencyV2(input));
      if (action === "approve") {
        expect(baseline).toBe(
          "sha256:c6ad64b79d96c72ca17f2909e18a0e872410606149576332d27b805aef661db2",
        );
      }
      const changes: Record<string, unknown> = {
        schema_version: 1,
        kind: "wrong",
        authority_id: "authority-2",
        organization_id: "organization-2",
        state_lineage_id: "lineage-2",
        approval_id: "approval-2",
        action: action === "approve" ? "reject" : "approve",
        human_act_resolution_ref_sha256: digest("7"),
        human_act_event_sha256: digest("8"),
      };
      for (const [key, replacement] of Object.entries(changes)) {
        const changed = mutate(input, key, replacement);
        if (key === "schema_version" || key === "kind") {
          expect(() => validateHumanActIdempotencyV2(changed)).toThrow();
        } else {
          expect(humanActIdempotencyV2Sha256(validateHumanActIdempotencyV2(changed))).not.toBe(baseline);
        }
      }
    }
    const accessor = snapshot();
    Object.defineProperty(accessor, "approval_id", { enumerable: true, get: () => "approval-1" });
    expect(() => validateApprovedDecisionSnapshotV2(accessor)).toThrow();
    const symbol = Symbol("hidden");
    const withSymbol = snapshot();
    Object.defineProperty(withSymbol, symbol, { value: "hidden" });
    expect(() => validateApprovedDecisionSnapshotV2(withSymbol)).toThrow();
    let commitmentReads = 0;
    const accessorCommitment = {
      schema_version: 1,
      kind: HUMAN_ACT_EVENT_COMMITMENT_V1_KIND,
      event: approvedEvent(),
    };
    Object.defineProperty(accessorCommitment, "event", {
      enumerable: true,
      get: () => {
        commitmentReads += 1;
        return approvedEvent();
      },
    });
    expect(() =>
      validateHumanActEventCommitmentV1(accessorCommitment),
    ).toThrow();
    expect(commitmentReads).toBe(0);
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
    for (const version of [1, 2, 3]) {
      expect(() =>
        validateApprovedDecisionSnapshotV2({
          schema_version: version,
          kind: `echo-organization-record-envelope-v${version}`,
          envelope_id: "legacy-envelope",
        }),
      ).toThrow();
    }
  });

  it("recomputes and joins the reference, event, and semantic idempotency digests", () => {
    const resolved = reference("approve");
    const event = approvedEvent();
    const input = {
      human_act_resolution_ref: resolved,
      event,
      idempotency: {
        ...idempotency(),
        human_act_resolution_ref_sha256: humanActResolutionRefV1Sha256(
          validateHumanActResolutionRefV1(resolved),
        ),
        human_act_event_sha256: humanActEventV1Sha256(validateHumanActEventV1(event)),
      },
    };
    const validated = validateHumanActRecordInputV1(input);
    expect(validated.semantic_idempotency_key).toBe(
      humanActIdempotencyV2Sha256(validated.idempotency),
    );
    expect(
      buildHumanActRecordInputV1({
        human_act_resolution_ref: resolved as never,
        event: event as never,
      }),
    ).toMatchObject({
      human_act_resolution_ref_sha256: input.idempotency.human_act_resolution_ref_sha256,
      human_act_event_sha256: input.idempotency.human_act_event_sha256,
    });
    expect(() =>
      validateHumanActRecordInputV1({
        ...input,
        event: { ...event, policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID },
      }),
    ).toThrow();
    expect(() =>
      validateHumanActRecordInputV1({
        ...input,
        idempotency: { ...input.idempotency, approval_id: "approval-2" },
      }),
    ).toThrow();
    expect(() =>
      validateHumanActRecordInputV1({
        ...input,
        event: { ...event, approved_snapshot: { ...event.approved_snapshot as Record<string, unknown>, approval_id: "approval-2" } },
      }),
    ).toThrow();
    const rejectedReference = reference("reject");
    const rejected = rejectedEvent();
    const rejectedInput = {
      human_act_resolution_ref: rejectedReference,
      event: rejected,
      idempotency: {
        ...idempotency("reject"),
        human_act_resolution_ref_sha256: humanActResolutionRefV1Sha256(
          validateHumanActResolutionRefV1(rejectedReference),
        ),
        human_act_event_sha256: humanActEventV1Sha256(validateHumanActEventV1(rejected)),
      },
    };
    expect(validateHumanActRecordInputV1(rejectedInput).event.kind).toBe("rejected");
  });
});
