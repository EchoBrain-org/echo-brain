import { Buffer } from "node:buffer";
import {
  generateKeyPairSync,
  sign as signMessage,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonBytes,
  decodeStrictP256DerSignature,
  encodeP256DerSignature,
  normalizeP256LowS,
  p256KeyId,
} from "@echo-brain/federation-protocol";
import type {
  P256SigningKeyDescriptor,
  Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  organizationAuthorityPinSha256,
  verifyOrganizationAuthorityPin,
} from "../src/authority-descriptor.js";
import type { PinnedOrganizationAuthority } from "../src/authority-descriptor.js";
import {
  APPROVED_DECISION_SNAPSHOT_V2_KIND,
  HUMAN_ACT_RESOLUTION_REF_V1_KIND,
  approvedDecisionSnapshotV2Sha256,
  buildHumanActRecordInputV1,
  validateApprovedDecisionSnapshotV2,
} from "../src/human-act-record-input-v1.js";
import type {
  HumanActEventV1,
  HumanActRecordInputV1,
  PersonContentPolicyIdV2,
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
import {
  DECISION_PROCESSOR_PROVENANCE_V1_KIND,
  MEETING_SOURCE_PROVENANCE_V1_KIND,
  ORGANIZATION_RECORD_ENVELOPE_V4_KIND,
  ORGANIZATION_RECORD_SIGNATURE_V4_KIND,
  buildOrganizationRecordSignatureInputV4,
  createOrganizationRecordEnvelopeV4,
  decisionProcessorProvenanceV1Sha256,
  meetingSourceProvenanceV1Sha256,
  organizationRecordEnvelopeBodyV4Sha256,
  organizationRecordSignatureInputV4Bytes,
  validateDecisionProcessorProvenanceV1,
  validateMeetingSourceProvenanceV1,
  validateOrganizationRecordEnvelopeBodyV4,
  validateOrganizationRecordEnvelopeV4,
  validateOrganizationRecordSignatureInputV4,
  verifyOrganizationRecordEnvelopeV4,
} from "../src/record-envelope-v4.js";
import type {
  AuthorityDetachedSigner,
  CreateOrganizationRecordEnvelopeV4Input,
  DecisionProcessorProvenanceV1,
  MeetingSourceProvenanceV1,
  OrganizationRecordEnvelopeBodyV4,
  OrganizationRecordEnvelopeV4,
} from "../src/record-envelope-v4.js";

const AUTHORITY_ID = "oau_00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "org_00000000-0000-4000-8000-000000000002";
const STATE_LINEAGE_ID = "state-lineage-1";
const P256_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);

const digest = (letter: string): Sha256Digest =>
  `sha256:${letter.repeat(64)}`;

function mutable(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

interface TestAuthority {
  readonly descriptor: {
    readonly schema_version: 1;
    readonly kind: "echo-organization-authority";
    readonly authority_id: string;
    readonly organization_id: string;
    readonly signing_key: P256SigningKeyDescriptor;
  };
  readonly pinned: PinnedOrganizationAuthority;
  readonly sign: AuthorityDetachedSigner;
}

function testAuthority(
  authorityId: string = AUTHORITY_ID,
  organizationId: string = ORGANIZATION_ID,
): TestAuthority {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  if (!Buffer.isBuffer(publicKeyDer)) throw new Error("unexpected key export");
  const signingKey: P256SigningKeyDescriptor = {
    key_id: p256KeyId(publicKeyDer),
    algorithm: "ecdsa-p256-sha256-der-low-s",
    public_key_spki_der_base64: publicKeyDer.toString("base64"),
  };
  const descriptor = {
    schema_version: 1 as const,
    kind: "echo-organization-authority" as const,
    authority_id: authorityId,
    organization_id: organizationId,
    signing_key: signingKey,
  };
  return {
    descriptor,
    pinned: verifyOrganizationAuthorityPin(
      descriptor,
      organizationAuthorityPinSha256(descriptor),
    ),
    sign: async (message, expectedKeyId) => {
      expect(expectedKeyId).toBe(signingKey.key_id);
      return normalizeP256LowS(
        signMessage("sha256", message, {
          key: privateKey,
          dsaEncoding: "der",
        }),
      );
    },
  };
}

function selectedPolicy(policyId: PersonContentPolicyIdV2): {
  policy_id: PersonContentPolicyIdV2;
  policy_contract_sha256: Sha256Digest;
  policy_consequence_text: string;
  policy_consequence_sha256: Sha256Digest;
} {
  if (policyId === RESTRICTED_REVIEWER_PERSON_POLICY_ID) {
    return {
      policy_id: policyId,
      policy_contract_sha256: restrictedReviewerPersonPolicyContractSha256(),
      policy_consequence_text: RESTRICTED_REVIEWER_PERSON_CONSEQUENCE_TEXT,
      policy_consequence_sha256: restrictedReviewerPersonConsequenceSha256(),
    };
  }
  return {
    policy_id: policyId,
    policy_contract_sha256:
      organizationMemberReadablePersonPolicyContractSha256(),
    policy_consequence_text:
      ORGANIZATION_MEMBER_READABLE_PERSON_CONSEQUENCE_TEXT,
    policy_consequence_sha256:
      organizationMemberReadablePersonConsequenceSha256(),
  };
}

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
          adapter_id: "llm",
          instance_id: "primary",
          version: "1.3.0+processing.0123456789abcdef",
        },
        generated_at: "2026-08-20T12:00:00.000Z",
      },
    },
    source: {
      adapter_id: "granola",
      instance_id: "primary",
      external_id: "meeting-external-1",
    },
    alternatives: [],
    links: null,
    reviewed_at: "2026-08-20T12:01:00.000Z",
    surface: "person-approval",
  };
}

function approvedSnapshot(): Record<string, unknown> {
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

function humanAct(
  action: "approve" | "reject",
  policyId: PersonContentPolicyIdV2,
): HumanActRecordInputV1 {
  const policy = selectedPolicy(policyId);
  const reference = {
    schema_version: 1 as const,
    kind: HUMAN_ACT_RESOLUTION_REF_V1_KIND,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: STATE_LINEAGE_ID,
    approval_id: "approval-1",
    action,
    policy_id: policy.policy_id,
    policy_contract_sha256: policy.policy_contract_sha256,
    audit_event_id: "audit-1",
    audit_sequence: 1,
    audit_entry_sha256: digest("c"),
    provider_action_kind: "echo-provider-human-action-v2" as const,
    provider_action_schema_version: 2 as const,
    provider_action_sha256: digest("d"),
    authorization_proof_sha256: digest("e"),
  };
  const snapshot = approvedSnapshot();
  const event = (action === "approve"
    ? {
        kind: "approved" as const,
        approved_snapshot: snapshot,
        approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(
          validateApprovedDecisionSnapshotV2(snapshot),
        ),
        ...policy,
      }
    : {
        kind: "rejected" as const,
        candidate_sha256: digest("f"),
        approved_snapshot_sha256: approvedDecisionSnapshotV2Sha256(
          validateApprovedDecisionSnapshotV2(snapshot),
        ),
        frozen_card_sha256: digest("0"),
        policy_id: policy.policy_id,
        policy_contract_sha256: policy.policy_contract_sha256,
        policy_consequence_sha256: policy.policy_consequence_sha256,
        action: "reject" as const,
        rejection_payload: {
          source: {
            adapter_id: "granola",
            instance_id: "primary",
            external_id: "meeting-external-1",
          },
          meeting_id: "meeting-1",
          rejected_at: "2026-08-20T12:02:00.000Z",
          reason: "Needs a clearer owner.",
          reconsider_after: null,
        },
      }) as unknown as HumanActEventV1;
  const aggregate = buildHumanActRecordInputV1({
    human_act_resolution_ref: reference,
    event,
  });
  return {
    human_act_resolution_ref: aggregate.human_act_resolution_ref,
    event: aggregate.event,
    idempotency: aggregate.idempotency,
  };
}

function sourceProvenance(
  overrides: Partial<MeetingSourceProvenanceV1> = {},
): MeetingSourceProvenanceV1 {
  return {
    schema_version: 1,
    kind: MEETING_SOURCE_PROVENANCE_V1_KIND,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: STATE_LINEAGE_ID,
    source_adapter_kind: "meeting-source",
    source_adapter_id: "granola",
    source_adapter_instance_id: "primary",
    source_adapter_version: "2.2.0",
    external_id: "meeting-external-1",
    canonical_revision: "revision-1",
    normalizer_version: "2.2.0",
    source_revision: null,
    ...overrides,
  };
}

function processorProvenance(
  overrides: Partial<DecisionProcessorProvenanceV1> = {},
): DecisionProcessorProvenanceV1 {
  return {
    schema_version: 1,
    kind: DECISION_PROCESSOR_PROVENANCE_V1_KIND,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: STATE_LINEAGE_ID,
    processor_adapter_kind: "decision-processor",
    processor_adapter_id: "llm",
    processor_adapter_instance_id: "primary",
    processor_adapter_version: "1.3.0+processing.0123456789abcdef",
    processor_contract_sha256: digest("6"),
    ...overrides,
  };
}

function recordBody(
  action: "approve" | "reject" = "approve",
  policyId: PersonContentPolicyIdV2 = RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  predecessor: { position: number; sha256: Sha256Digest } | null = null,
): OrganizationRecordEnvelopeBodyV4 {
  const aggregate = humanAct(action, policyId);
  const validated = buildHumanActRecordInputV1({
    human_act_resolution_ref: aggregate.human_act_resolution_ref,
    event: aggregate.event,
  });
  const source = sourceProvenance();
  const processor = processorProvenance();
  return {
    schema_version: 4,
    kind: ORGANIZATION_RECORD_ENVELOPE_V4_KIND,
    envelope_id: `envelope-${action}-${policyId}`,
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    state_lineage_id: STATE_LINEAGE_ID,
    semantic_idempotency_key: validated.semantic_idempotency_key,
    issued_at: "2026-08-20T12:03:00.000Z",
    predecessor_position: predecessor?.position ?? null,
    predecessor_record_sha256: predecessor?.sha256 ?? null,
    human_act_resolution_ref: validated.human_act_resolution_ref,
    source_provenance: source,
    source_provenance_sha256: meetingSourceProvenanceV1Sha256(source),
    processor_provenance: processor,
    processor_provenance_sha256:
      decisionProcessorProvenanceV1Sha256(processor),
    event: validated.event,
  };
}

function createInput(
  action: "approve" | "reject" = "approve",
  policyId: PersonContentPolicyIdV2 = RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  predecessor: { position: number; sha256: Sha256Digest } | null = null,
): CreateOrganizationRecordEnvelopeV4Input {
  return {
    envelope_id: `envelope-${action}-${policyId}`,
    issued_at: "2026-08-20T12:03:00.000Z",
    predecessor_position: predecessor?.position ?? null,
    predecessor_record_sha256: predecessor?.sha256 ?? null,
    human_act_record_input: humanAct(action, policyId),
    source_provenance: sourceProvenance(),
    processor_provenance: processorProvenance(),
  };
}

function replaceBody(
  body: OrganizationRecordEnvelopeBodyV4,
  patch: Record<string, unknown>,
): OrganizationRecordEnvelopeBodyV4 {
  return { ...structuredClone(body), ...patch } as OrganizationRecordEnvelopeBodyV4;
}

describe("private D3-2 record envelope v4", () => {
  it("closes and domain-separates exact source and processor provenance", () => {
    const source = sourceProvenance();
    const processor = processorProvenance();
    expect(validateMeetingSourceProvenanceV1(source)).toEqual(source);
    expect(validateDecisionProcessorProvenanceV1(processor)).toEqual(processor);
    expect(meetingSourceProvenanceV1Sha256(source)).toBe(
      "sha256:45e3ffb2727b13f9267161d56661aef29e4ab4befce27e7b6a89cc6c69c68758",
    );
    expect(decisionProcessorProvenanceV1Sha256(processor)).toBe(
      "sha256:4fba753375f26b4715b9b7ffcf20b29f95134fdf85273081558f548c60a0da1d",
    );

    expect(Object.keys(source).sort()).toEqual([
      "authority_id",
      "canonical_revision",
      "external_id",
      "kind",
      "normalizer_version",
      "organization_id",
      "schema_version",
      "source_adapter_id",
      "source_adapter_instance_id",
      "source_adapter_kind",
      "source_adapter_version",
      "source_revision",
      "state_lineage_id",
    ]);
    expect(Object.keys(processor).sort()).toEqual([
      "authority_id",
      "kind",
      "organization_id",
      "processor_adapter_id",
      "processor_adapter_instance_id",
      "processor_adapter_kind",
      "processor_adapter_version",
      "processor_contract_sha256",
      "schema_version",
      "state_lineage_id",
    ]);
    expect(() =>
      validateDecisionProcessorProvenanceV1({
        ...processor,
        processor_configuration: { model: "forbidden" },
      }),
    ).toThrow("unexpected shape");
    expect(() =>
      validateMeetingSourceProvenanceV1({ ...source, schema_version: 2 }),
    ).toThrow("unsupported envelope");
    expect(() =>
      validateDecisionProcessorProvenanceV1({
        ...processor,
        kind: "echo-meeting-source-provenance-v1",
      }),
    ).toThrow("unsupported envelope");

    expect(
      meetingSourceProvenanceV1Sha256(
        sourceProvenance({ source_revision: "provider-revision-2" }),
      ),
    ).not.toBe(meetingSourceProvenanceV1Sha256(source));
    expect(
      decisionProcessorProvenanceV1Sha256(
        processorProvenance({
          processor_adapter_version: "1.3.0+processing.1111111111111111",
        }),
      ),
    ).not.toBe(decisionProcessorProvenanceV1Sha256(processor));
    expect(
      decisionProcessorProvenanceV1Sha256(
        processorProvenance({ processor_contract_sha256: digest("7") }),
      ),
    ).not.toBe(decisionProcessorProvenanceV1Sha256(processor));
  });

  it("preserves opaque source values without trimming or control normalization", () => {
    const opaque = `  provider/${"x".repeat(4080)}\n  `;
    const provenance = sourceProvenance({
      external_id: opaque,
      canonical_revision: " revision\t1 ",
      source_revision: " source\nrevision ",
    });
    const validated = validateMeetingSourceProvenanceV1(provenance);
    expect(validated.external_id).toBe(opaque);
    expect(validated.canonical_revision).toBe(" revision\t1 ");
    expect(validated.source_revision).toBe(" source\nrevision ");
    expect(() =>
      validateMeetingSourceProvenanceV1(
        sourceProvenance({ external_id: "x".repeat(4097) }),
      ),
    ).toThrow("opaque string");
    expect(() =>
      validateMeetingSourceProvenanceV1(
        sourceProvenance({ source_revision: "before\0after" }),
      ),
    ).toThrow("opaque string");
  });

  it("joins the complete D3-1 aggregate and exact approved provenance for both policies", () => {
    for (const policyId of [
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    ] as const) {
      const body = recordBody("approve", policyId);
      const validated = validateOrganizationRecordEnvelopeBodyV4(body);
      expect(validated.event.kind).toBe("approved");
      expect(validated.human_act_resolution_ref.policy_id).toBe(policyId);
      expect(validated.semantic_idempotency_key).toBe(
        buildHumanActRecordInputV1({
          human_act_resolution_ref: body.human_act_resolution_ref,
          event: body.event,
        }).semantic_idempotency_key,
      );
      expect(Object.keys(validated).sort()).toEqual([
        "authority_id",
        "envelope_id",
        "event",
        "human_act_resolution_ref",
        "issued_at",
        "kind",
        "organization_id",
        "predecessor_position",
        "predecessor_record_sha256",
        "processor_provenance",
        "processor_provenance_sha256",
        "schema_version",
        "semantic_idempotency_key",
        "source_provenance",
        "source_provenance_sha256",
        "state_lineage_id",
      ]);
      expect(validated).not.toHaveProperty("authorization_proof_sha256");
      expect(validated).not.toHaveProperty(
        "human_act_resolution_ref_sha256",
      );
      expect(validated).not.toHaveProperty("processor_contract_sha256");
    }
    expect(organizationRecordEnvelopeBodyV4Sha256(recordBody())).toBe(
      "sha256:069c31455565bde8ce19aaa5ae5b809b4d34b07c0ec83f3cc1c14f524d5a4b00",
    );
  });

  it("accepts rejection for both policies while joining its exact source locator", () => {
    for (const policyId of [
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    ] as const) {
      const body = recordBody("reject", policyId, {
        position: 7,
        sha256: digest("7"),
      });
      const validated = validateOrganizationRecordEnvelopeBodyV4(body);
      expect(validated.event.kind).toBe("rejected");
      expect(validated.predecessor_position).toBe(7);
      expect(validated.predecessor_record_sha256).toBe(digest("7"));
      expect(validated.human_act_resolution_ref.policy_id).toBe(policyId);
    }
  });

  it("denies broken D3, coordinate, digest, and payload-provenance joins", () => {
    const body = recordBody();
    expect(() =>
      validateOrganizationRecordEnvelopeBodyV4(
        replaceBody(body, { semantic_idempotency_key: digest("9") }),
      ),
    ).toThrow("semantic idempotency key");
    expect(() =>
      validateOrganizationRecordEnvelopeBodyV4(
        replaceBody(body, {
          human_act_resolution_ref: {
            ...body.human_act_resolution_ref,
            state_lineage_id: "another-lineage",
          },
        }),
      ),
    ).toThrow("does not match the record coordinates");
    expect(() =>
      validateOrganizationRecordEnvelopeBodyV4(
        replaceBody(body, {
          source_provenance_sha256: digest("8"),
        }),
      ),
    ).toThrow("source provenance digest");
    expect(() =>
      validateOrganizationRecordEnvelopeBodyV4(
        replaceBody(body, {
          processor_provenance_sha256: digest("8"),
        }),
      ),
    ).toThrow("processor provenance digest");

    const wrongSource = structuredClone(body);
    if (wrongSource.event.kind !== "approved") throw new Error("expected approval");
    const wrongSourceEvent = mutable(wrongSource.event);
    const wrongSourceSnapshot = mutable(wrongSourceEvent.approved_snapshot);
    const wrongSourcePayload = mutable(wrongSourceSnapshot.approved_payload);
    mutable(wrongSourcePayload.source).external_id = "another-meeting";
    wrongSourceEvent.approved_snapshot_sha256 = approvedDecisionSnapshotV2Sha256(
      validateApprovedDecisionSnapshotV2(
        wrongSourceEvent.approved_snapshot,
      ),
    );
    mutable(wrongSource).semantic_idempotency_key = buildHumanActRecordInputV1({
      human_act_resolution_ref: wrongSource.human_act_resolution_ref,
      event: wrongSource.event,
    }).semantic_idempotency_key;
    expect(() => validateOrganizationRecordEnvelopeBodyV4(wrongSource)).toThrow(
      "does not match source provenance",
    );

    const wrongRevision = structuredClone(body);
    if (wrongRevision.event.kind !== "approved") throw new Error("expected approval");
    const wrongRevisionEvent = mutable(wrongRevision.event);
    const wrongRevisionSnapshot = mutable(wrongRevisionEvent.approved_snapshot);
    const wrongRevisionPayload = mutable(wrongRevisionSnapshot.approved_payload);
    const wrongRevisionBrief = mutable(wrongRevisionPayload.brief);
    mutable(wrongRevisionBrief.provenance).meeting_revision = "another-revision";
    wrongRevisionEvent.approved_snapshot_sha256 = approvedDecisionSnapshotV2Sha256(
      validateApprovedDecisionSnapshotV2(wrongRevisionEvent.approved_snapshot),
    );
    mutable(wrongRevision).semantic_idempotency_key = buildHumanActRecordInputV1({
      human_act_resolution_ref: wrongRevision.human_act_resolution_ref,
      event: wrongRevision.event,
    }).semantic_idempotency_key;
    expect(() => validateOrganizationRecordEnvelopeBodyV4(wrongRevision)).toThrow(
      "meeting revision",
    );

    const wrongProcessor = structuredClone(body);
    if (wrongProcessor.event.kind !== "approved") throw new Error("expected approval");
    const wrongProcessorEvent = mutable(wrongProcessor.event);
    const wrongProcessorSnapshot = mutable(wrongProcessorEvent.approved_snapshot);
    const wrongProcessorPayload = mutable(wrongProcessorSnapshot.approved_payload);
    const wrongProcessorBrief = mutable(wrongProcessorPayload.brief);
    const wrongProcessorBriefProvenance = mutable(wrongProcessorBrief.provenance);
    mutable(wrongProcessorBriefProvenance.processor).version =
      "another-processing-version";
    wrongProcessorEvent.approved_snapshot_sha256 = approvedDecisionSnapshotV2Sha256(
      validateApprovedDecisionSnapshotV2(wrongProcessorEvent.approved_snapshot),
    );
    mutable(wrongProcessor).semantic_idempotency_key = buildHumanActRecordInputV1({
      human_act_resolution_ref: wrongProcessor.human_act_resolution_ref,
      event: wrongProcessor.event,
    }).semantic_idempotency_key;
    expect(() =>
      validateOrganizationRecordEnvelopeBodyV4(wrongProcessor),
    ).toThrow("processor identity");

    const brokenAggregate = humanAct("approve", RESTRICTED_REVIEWER_PERSON_POLICY_ID);
    const brokenHumanAct: HumanActRecordInputV1 = {
      ...brokenAggregate,
      idempotency: {
      ...brokenAggregate.idempotency,
      human_act_event_sha256: digest("9"),
      },
    };
    const authority = testAuthority();
    expect(() =>
      createOrganizationRecordEnvelopeV4(
        { ...createInput(), human_act_record_input: brokenHumanAct },
        authority.pinned,
        STATE_LINEAGE_ID,
        authority.sign,
      ),
    ).rejects.toThrow("idempotency digests");
  });

  it("pins genesis/non-genesis pairing and exact signature-input bytes", () => {
    expect(validateOrganizationRecordEnvelopeBodyV4(recordBody())).toBeDefined();
    expect(
      validateOrganizationRecordEnvelopeBodyV4(
        recordBody("approve", RESTRICTED_REVIEWER_PERSON_POLICY_ID, {
          position: 1,
          sha256: digest("1"),
        }),
      ),
    ).toBeDefined();
    for (const patch of [
      { predecessor_position: null, predecessor_record_sha256: digest("1") },
      { predecessor_position: 1, predecessor_record_sha256: null },
      { predecessor_position: 0, predecessor_record_sha256: digest("1") },
    ]) {
      expect(() =>
        validateOrganizationRecordEnvelopeBodyV4(
          replaceBody(recordBody(), patch),
        ),
      ).toThrow();
    }

    const signatureInput = buildOrganizationRecordSignatureInputV4(
      recordBody(),
      digest("9"),
    );
    expect(signatureInput).toEqual({
      schema_version: 4,
      kind: ORGANIZATION_RECORD_SIGNATURE_V4_KIND,
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: STATE_LINEAGE_ID,
      signing_key_id: digest("9"),
      record_sha256: organizationRecordEnvelopeBodyV4Sha256(recordBody()),
    });
    expect(
      organizationRecordSignatureInputV4Bytes(signatureInput).toString("utf8"),
    ).toBe(
      '{"authority_id":"oau_00000000-0000-4000-8000-000000000001","kind":"echo-organization-record-signature-v4","organization_id":"org_00000000-0000-4000-8000-000000000002","record_sha256":"sha256:069c31455565bde8ce19aaa5ae5b809b4d34b07c0ec83f3cc1c14f524d5a4b00","schema_version":4,"signing_key_id":"sha256:9999999999999999999999999999999999999999999999999999999999999999","state_lineage_id":"state-lineage-1"}',
    );
    expect(() =>
      validateOrganizationRecordSignatureInputV4({
        ...signatureInput,
        schema_version: 3,
      }),
    ).toThrow("unsupported envelope");
    expect(() =>
      validateOrganizationRecordSignatureInputV4({
        ...signatureInput,
        authorization_proof_sha256: digest("0"),
      }),
    ).toThrow("unexpected shape");
  });

  it("creates and verifies both actions and policies with a pinned Authority key and lineage", async () => {
    const authority = testAuthority();
    const cases = [
      ["approve", RESTRICTED_REVIEWER_PERSON_POLICY_ID, null],
      [
        "approve",
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        { position: 1, sha256: digest("1") },
      ],
      ["reject", RESTRICTED_REVIEWER_PERSON_POLICY_ID, null],
      [
        "reject",
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        { position: 2, sha256: digest("2") },
      ],
    ] as const;
    for (const [action, policyId, predecessor] of cases) {
      const envelope = await createOrganizationRecordEnvelopeV4(
        createInput(action, policyId, predecessor),
        authority.pinned,
        STATE_LINEAGE_ID,
        authority.sign,
      );
      expect(
        verifyOrganizationRecordEnvelopeV4(
          envelope,
          authority.pinned,
          STATE_LINEAGE_ID,
        ),
      ).toEqual(envelope);
      expect(envelope.body.event.kind).toBe(
        action === "approve" ? "approved" : "rejected",
      );
      expect(Object.keys(envelope).sort()).toEqual([
        "body",
        "record_sha256",
        "signature",
        "signing_key_descriptor",
      ]);
    }
  });

  it("snapshots all caller-owned state before awaiting the detached signer", async () => {
    const authority = testAuthority();
    const input = createInput();
    const expectedBody = recordBody();
    const mutatingSigner: AuthorityDetachedSigner = async (bytes, keyId) => {
      mutable(input).envelope_id = "mutated-envelope";
      mutable(input.source_provenance).external_id = "mutated-source";
      mutable(input.processor_provenance).processor_adapter_version =
        "mutated-version";
      mutable(input.human_act_record_input.human_act_resolution_ref).approval_id =
        "mutated-approval";
      return authority.sign(bytes, keyId);
    };
    const envelope = await createOrganizationRecordEnvelopeV4(
      input,
      authority.pinned,
      STATE_LINEAGE_ID,
      mutatingSigner,
    );
    expect(envelope.body).toEqual(expectedBody);
    expect(envelope.body.envelope_id).not.toBe(input.envelope_id);
    expect(envelope.body.source_provenance.external_id).not.toBe(
      input.source_provenance.external_id,
    );
  });

  it("rejects record, signature, key, pin, lineage, and cross-version substitution", async () => {
    const authority = testAuthority();
    const envelope = await createOrganizationRecordEnvelopeV4(
      createInput(),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    expect(() =>
      verifyOrganizationRecordEnvelopeV4(
        { ...envelope, record_sha256: digest("0") },
        authority.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("record digest");
    expect(() =>
      verifyOrganizationRecordEnvelopeV4(
        { ...envelope, signature: `${envelope.signature.slice(0, -4)}AAAA` },
        authority.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow();
    expect(() =>
      verifyOrganizationRecordEnvelopeV4(
        envelope,
        authority.pinned,
        "another-lineage",
      ),
    ).toThrow("expected lineage");

    const foreign = testAuthority(
      "oau_00000000-0000-4000-8000-000000000003",
      ORGANIZATION_ID,
    );
    expect(() =>
      verifyOrganizationRecordEnvelopeV4(
        envelope,
        foreign.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("pinned Authority");
    expect(() =>
      verifyOrganizationRecordEnvelopeV4(
        {
          ...envelope,
          signing_key_descriptor: foreign.descriptor.signing_key,
        },
        authority.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("signing key");

    // A self-consistent embedded key and signature are not trust: the exact
    // Authority descriptor remains independently pinned.
    const alternateSameAuthority = testAuthority();
    const alternateSignatureInput = buildOrganizationRecordSignatureInputV4(
      envelope.body,
      alternateSameAuthority.descriptor.signing_key.key_id,
    );
    const alternateSignature = await alternateSameAuthority.sign(
      organizationRecordSignatureInputV4Bytes(alternateSignatureInput),
      alternateSameAuthority.descriptor.signing_key.key_id,
    );
    expect(() =>
      verifyOrganizationRecordEnvelopeV4(
        {
          ...envelope,
          signing_key_descriptor:
            alternateSameAuthority.descriptor.signing_key,
          signature: alternateSignature.toString("base64"),
        },
        authority.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("signing key does not match the pinned Authority");
    expect(() =>
      validateOrganizationRecordEnvelopeV4({
        ...envelope,
        body: { ...envelope.body, schema_version: 3 },
      }),
    ).toThrow("unsupported envelope");

    const oldDomainBytes = canonicalJsonBytes({
      ...buildOrganizationRecordSignatureInputV4(
        envelope.body,
        envelope.signing_key_descriptor.key_id,
      ),
      schema_version: 3,
      kind: "echo-organization-record-signature-v3",
    });
    const oldDomainSignature = await authority.sign(
      oldDomainBytes,
      envelope.signing_key_descriptor.key_id,
    );
    expect(() =>
      verifyOrganizationRecordEnvelopeV4(
        { ...envelope, signature: oldDomainSignature.toString("base64") },
        authority.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("signature is invalid");
  });

  it("rejects malformed/high-S signatures and hostile in-memory objects", async () => {
    const authority = testAuthority();
    const envelope = await createOrganizationRecordEnvelopeV4(
      createInput(),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    expect(() =>
      validateOrganizationRecordEnvelopeV4({
        ...envelope,
        signature: "not+canonical=",
      }),
    ).toThrow("canonical base64");
    expect(() =>
      validateOrganizationRecordEnvelopeV4({
        ...envelope,
        signature: Buffer.from("not DER").toString("base64"),
      }),
    ).toThrow("strict DER low-S");
    const decoded = decodeStrictP256DerSignature(
      Buffer.from(envelope.signature, "base64"),
    );
    const highS = encodeP256DerSignature(decoded.r, P256_ORDER - decoded.s);
    expect(() =>
      validateOrganizationRecordEnvelopeV4({
        ...envelope,
        signature: highS.toString("base64"),
      }),
    ).toThrow("strict DER low-S");

    let bodyReads = 0;
    const accessor = { ...envelope } as Record<string, unknown>;
    Object.defineProperty(accessor, "body", {
      enumerable: true,
      get: () => {
        bodyReads += 1;
        return envelope.body;
      },
    });
    expect(() => validateOrganizationRecordEnvelopeV4(accessor)).toThrow(
      "enumerable data properties",
    );
    expect(bodyReads).toBe(0);

    const withSymbol = structuredClone(envelope);
    Object.defineProperty(withSymbol.body, Symbol("hidden"), {
      value: "hidden",
    });
    expect(() => validateOrganizationRecordEnvelopeV4(withSymbol)).toThrow(
      "symbol properties",
    );
    const nonEnumerable = structuredClone(envelope);
    Object.defineProperty(nonEnumerable.body.source_provenance, "hidden", {
      value: "hidden",
    });
    expect(() => validateOrganizationRecordEnvelopeV4(nonEnumerable)).toThrow(
      "enumerable data properties",
    );
    const customPrototype = structuredClone(envelope);
    Object.setPrototypeOf(customPrototype.body.processor_provenance, null);
    expect(() => validateOrganizationRecordEnvelopeV4(customPrototype)).toThrow(
      "plain object",
    );
    const cyclic = structuredClone(envelope) as OrganizationRecordEnvelopeV4 & {
      cycle?: unknown;
    };
    cyclic.cycle = cyclic;
    expect(() => validateOrganizationRecordEnvelopeV4(cyclic)).toThrow("cycle");
  });

  it("rejects wrapper drift and a non-Buffer detached signer result", async () => {
    const authority = testAuthority();
    const envelope = await createOrganizationRecordEnvelopeV4(
      createInput(),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    for (const candidate of [
      { ...envelope, integrity: {} },
      { ...envelope, authorization_proof_sha256: digest("1") },
      { ...envelope, human_act_resolution_ref_sha256: digest("2") },
    ]) {
      expect(() => validateOrganizationRecordEnvelopeV4(candidate)).toThrow(
        "unexpected shape",
      );
    }
    const missing = { ...envelope } as unknown as Record<string, unknown>;
    delete missing.record_sha256;
    expect(() => validateOrganizationRecordEnvelopeV4(missing)).toThrow(
      "unexpected shape",
    );
    await expect(
      createOrganizationRecordEnvelopeV4(
        createInput(),
        authority.pinned,
        STATE_LINEAGE_ID,
        (async () => "not-a-buffer") as unknown as AuthorityDetachedSigner,
      ),
    ).rejects.toThrow("signature bytes");
  });
});
