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
  ORGANIZATION_RECORD_RECEIPT_SIGNATURE_V2_KIND,
  ORGANIZATION_RECORD_RECEIPT_V2_KIND,
  buildOrganizationRecordReceiptSignatureInputV2,
  createOrganizationRecordReceiptV2,
  organizationRecordReceiptBodyV2Sha256,
  organizationRecordReceiptSignatureInputV2Bytes,
  validateOrganizationRecordReceiptBodyV2,
  validateOrganizationRecordReceiptSignatureInputV2,
  validateOrganizationRecordReceiptV2,
  verifyOrganizationRecordReceiptV2,
} from "../src/organization-record-receipt-v2.js";
import type {
  CreateOrganizationRecordReceiptV2Input,
  OrganizationRecordReceiptBodyV2,
  OrganizationRecordReceiptV2,
} from "../src/organization-record-receipt-v2.js";
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
  ORGANIZATION_RECORD_SIGNATURE_V4_KIND,
  buildOrganizationRecordSignatureInputV4,
  createOrganizationRecordEnvelopeV4,
  organizationRecordSignatureInputV4Bytes,
} from "../src/record-envelope-v4.js";
import type {
  AuthorityDetachedSigner,
  CreateOrganizationRecordEnvelopeV4Input,
  DecisionProcessorProvenanceV1,
  MeetingSourceProvenanceV1,
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

function sourceProvenance(): MeetingSourceProvenanceV1 {
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
  };
}

function processorProvenance(): DecisionProcessorProvenanceV1 {
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
  };
}

function envelopeInput(
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

async function createEnvelope(
  authority: TestAuthority,
  action: "approve" | "reject" = "approve",
  policyId: PersonContentPolicyIdV2 = RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  predecessor: { position: number; sha256: Sha256Digest } | null = null,
): Promise<OrganizationRecordEnvelopeV4> {
  return createOrganizationRecordEnvelopeV4(
    envelopeInput(action, policyId, predecessor),
    authority.pinned,
    STATE_LINEAGE_ID,
    authority.sign,
  );
}

function receiptInput(
  envelope: OrganizationRecordEnvelopeV4,
  recordPosition: number,
): CreateOrganizationRecordReceiptV2Input {
  return {
    envelope,
    record_position: recordPosition,
    issued_at: "2026-08-20T12:04:00.000Z",
  };
}

async function signReceiptBody(
  body: OrganizationRecordReceiptBodyV2,
  authority: TestAuthority,
): Promise<OrganizationRecordReceiptV2> {
  const receiptSha256 = organizationRecordReceiptBodyV2Sha256(body);
  const signatureInput = buildOrganizationRecordReceiptSignatureInputV2(
    body,
    authority.descriptor.signing_key.key_id,
  );
  const signature = await authority.sign(
    organizationRecordReceiptSignatureInputV2Bytes(signatureInput),
    authority.descriptor.signing_key.key_id,
  );
  return {
    body,
    receipt_sha256: receiptSha256,
    signing_key_descriptor: authority.descriptor.signing_key,
    signature: signature.toString("base64"),
  };
}

function replaceBody(
  body: OrganizationRecordReceiptBodyV2,
  patch: Record<string, unknown>,
): OrganizationRecordReceiptBodyV2 {
  return {
    ...structuredClone(body),
    ...patch,
  } as OrganizationRecordReceiptBodyV2;
}

describe("private D3-3 organization record receipt v2", () => {
  it("freezes exact body, wrapper, digest, and signature-input shapes", async () => {
    const authority = testAuthority();
    const envelope = await createEnvelope(authority);
    const receipt = await createOrganizationRecordReceiptV2(
      receiptInput(envelope, 1),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    expect(Object.keys(receipt.body).sort()).toEqual([
      "authority_id",
      "envelope_id",
      "event_kind",
      "issued_at",
      "kind",
      "organization_id",
      "policy_fact_outcome",
      "predecessor_record_sha256",
      "record_head_position",
      "record_head_sha256",
      "record_position",
      "record_sha256",
      "schema_version",
      "semantic_idempotency_key",
      "state_lineage_id",
    ]);
    expect(Object.keys(receipt).sort()).toEqual([
      "body",
      "receipt_sha256",
      "signature",
      "signing_key_descriptor",
    ]);
    expect(receipt.body).toMatchObject({
      schema_version: 2,
      kind: ORGANIZATION_RECORD_RECEIPT_V2_KIND,
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: STATE_LINEAGE_ID,
      envelope_id: envelope.body.envelope_id,
      semantic_idempotency_key: envelope.body.semantic_idempotency_key,
      event_kind: "approved",
      record_position: 1,
      record_sha256: envelope.record_sha256,
      predecessor_record_sha256: null,
      record_head_position: 1,
      record_head_sha256: envelope.record_sha256,
      issued_at: "2026-08-20T12:04:00.000Z",
      policy_fact_outcome: {
        kind: "appended",
        policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      },
    });
    expect(receipt.receipt_sha256).toBe(
      organizationRecordReceiptBodyV2Sha256(receipt.body),
    );
    expect(receipt.receipt_sha256).toBe(
      "sha256:022c53dc27233a3f2414aae163b7e63376ba74582794d5cd70a5cc138d0c5ad3",
    );

    const signatureInput = buildOrganizationRecordReceiptSignatureInputV2(
      receipt.body,
      digest("9"),
    );
    expect(signatureInput).toEqual({
      schema_version: 2,
      kind: ORGANIZATION_RECORD_RECEIPT_SIGNATURE_V2_KIND,
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: STATE_LINEAGE_ID,
      signing_key_id: digest("9"),
      receipt_sha256: receipt.receipt_sha256,
    });
    expect(
      organizationRecordReceiptSignatureInputV2Bytes(signatureInput).toString(
        "utf8",
      ),
    ).toBe(
      '{"authority_id":"oau_00000000-0000-4000-8000-000000000001","kind":"echo-organization-record-receipt-signature-v2","organization_id":"org_00000000-0000-4000-8000-000000000002","receipt_sha256":"sha256:022c53dc27233a3f2414aae163b7e63376ba74582794d5cd70a5cc138d0c5ad3","schema_version":2,"signing_key_id":"sha256:9999999999999999999999999999999999999999999999999999999999999999","state_lineage_id":"state-lineage-1"}',
    );
  });

  it("derives both policy outcomes for both actions and verifies the exact envelope", async () => {
    const authority = testAuthority();
    for (const [action, policyId] of [
      ["approve", RESTRICTED_REVIEWER_PERSON_POLICY_ID],
      ["approve", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID],
      ["reject", RESTRICTED_REVIEWER_PERSON_POLICY_ID],
      ["reject", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID],
    ] as const) {
      const predecessor = { position: 7, sha256: digest("7") };
      const envelope = await createEnvelope(
        authority,
        action,
        policyId,
        predecessor,
      );
      const receipt = await createOrganizationRecordReceiptV2(
        receiptInput(envelope, 8),
        authority.pinned,
        STATE_LINEAGE_ID,
        authority.sign,
      );
      expect(
        verifyOrganizationRecordReceiptV2(
          receipt,
          envelope,
          authority.pinned,
          STATE_LINEAGE_ID,
        ),
      ).toEqual(receipt);
      expect(receipt.body.event_kind).toBe(
        action === "approve" ? "approved" : "rejected",
      );
      expect(receipt.body.predecessor_record_sha256).toBe(digest("7"));
      expect(receipt.body.record_head_position).toBe(8);
      expect(receipt.body.record_head_sha256).toBe(envelope.record_sha256);
      expect(receipt.body.policy_fact_outcome).toEqual(
        action === "approve"
          ? { kind: "appended", policy_id: policyId }
          : { kind: "none" },
      );
    }
  });

  it("accepts only the exact next append allocation", async () => {
    const authority = testAuthority();
    const genesis = await createEnvelope(authority);
    await expect(
      createOrganizationRecordReceiptV2(
        receiptInput(genesis, 2),
        authority.pinned,
        STATE_LINEAGE_ID,
        authority.sign,
      ),
    ).rejects.toThrow("does not continue the envelope predecessor");
    const chained = await createEnvelope(
      authority,
      "approve",
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      { position: 9, sha256: digest("9") },
    );
    await expect(
      createOrganizationRecordReceiptV2(
        receiptInput(chained, 9),
        authority.pinned,
        STATE_LINEAGE_ID,
        authority.sign,
      ),
    ).rejects.toThrow("does not continue the envelope predecessor");
    await expect(
      createOrganizationRecordReceiptV2(
        receiptInput(chained, 10),
        authority.pinned,
        STATE_LINEAGE_ID,
        authority.sign,
      ),
    ).resolves.toBeDefined();

    const exhausted = await createEnvelope(
      authority,
      "approve",
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      { position: Number.MAX_SAFE_INTEGER, sha256: digest("8") },
    );
    await expect(
      createOrganizationRecordReceiptV2(
        receiptInput(exhausted, Number.MAX_SAFE_INTEGER),
        authority.pinned,
        STATE_LINEAGE_ID,
        authority.sign,
      ),
    ).rejects.toThrow("does not continue the envelope predecessor");
  });

  it("rejects mixed outcomes, head drift, chain drift, and body shape drift", async () => {
    const authority = testAuthority();
    const envelope = await createEnvelope(authority);
    const receipt = await createOrganizationRecordReceiptV2(
      receiptInput(envelope, 1),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    for (const [patch, message] of [
      [{ policy_fact_outcome: { kind: "none" } }, "must append policy facts"],
      [
        {
          policy_fact_outcome: {
            kind: "appended",
            policy_id: "legacy-installation-policy-v1",
          },
        },
        "unsupported Person policy",
      ],
      [{ record_head_position: 2 }, "resulting head"],
      [{ record_head_sha256: digest("0") }, "resulting head"],
      [{ predecessor_record_sha256: digest("1") }, "null only at genesis"],
      [{ record_position: 0, record_head_position: 0 }, "positive safe integer"],
    ] as const) {
      expect(() =>
        validateOrganizationRecordReceiptBodyV2(
          replaceBody(receipt.body, patch),
        ),
      ).toThrow(message);
    }
    expect(() =>
      validateOrganizationRecordReceiptBodyV2({
        ...receipt.body,
        checkpoint_sha256: digest("2"),
      }),
    ).toThrow("unexpected shape");

    const rejectionEnvelope = await createEnvelope(authority, "reject");
    const rejection = await createOrganizationRecordReceiptV2(
      receiptInput(rejectionEnvelope, 1),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    expect(() =>
      validateOrganizationRecordReceiptBodyV2(
        replaceBody(rejection.body, {
          policy_fact_outcome: {
            kind: "appended",
            policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
          },
        }),
      ),
    ).toThrow("must not append policy facts");
    expect(() =>
      validateOrganizationRecordReceiptBodyV2(
        replaceBody(rejection.body, { predecessor_record_sha256: digest("1") }),
      ),
    ).toThrow("null only at genesis");
  });

  it("denies every re-signed receipt-to-envelope binding mutation", async () => {
    const authority = testAuthority();
    const envelope = await createEnvelope(authority);
    const receipt = await createOrganizationRecordReceiptV2(
      receiptInput(envelope, 1),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    const mutations: readonly Record<string, unknown>[] = [
      { authority_id: "oau_00000000-0000-4000-8000-000000000003" },
      { organization_id: "org_00000000-0000-4000-8000-000000000004" },
      { state_lineage_id: "another-lineage" },
      { envelope_id: "another-envelope" },
      { semantic_idempotency_key: digest("1") },
      { event_kind: "rejected", policy_fact_outcome: { kind: "none" } },
      {
        policy_fact_outcome: {
          kind: "appended",
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
        },
      },
      { record_sha256: digest("2"), record_head_sha256: digest("2") },
    ];
    for (const patch of mutations) {
      const body = validateOrganizationRecordReceiptBodyV2(
        replaceBody(receipt.body, patch),
      );
      const candidate = await signReceiptBody(body, authority);
      expect(() =>
        verifyOrganizationRecordReceiptV2(
          candidate,
          envelope,
          authority.pinned,
          STATE_LINEAGE_ID,
        ),
      ).toThrow();
    }

    const anotherEnvelope = await createEnvelope(
      authority,
      "approve",
      ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID,
    );
    expect(() =>
      verifyOrganizationRecordReceiptV2(
        receipt,
        anotherEnvelope,
        authority.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("does not bind the exact record envelope v4");

    const chainedEnvelope = await createEnvelope(
      authority,
      "approve",
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      { position: 5, sha256: digest("5") },
    );
    const chainedReceipt = await createOrganizationRecordReceiptV2(
      receiptInput(chainedEnvelope, 6),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    const wrongPositionBody = validateOrganizationRecordReceiptBodyV2(
      replaceBody(chainedReceipt.body, {
        record_position: 999,
        record_head_position: 999,
      }),
    );
    const wrongPosition = await signReceiptBody(wrongPositionBody, authority);
    expect(() =>
      verifyOrganizationRecordReceiptV2(
        wrongPosition,
        chainedEnvelope,
        authority.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("does not continue the envelope predecessor");
    const wrongPredecessorBody = validateOrganizationRecordReceiptBodyV2(
      replaceBody(chainedReceipt.body, {
        predecessor_record_sha256: digest("4"),
      }),
    );
    const wrongPredecessor = await signReceiptBody(
      wrongPredecessorBody,
      authority,
    );
    expect(() =>
      verifyOrganizationRecordReceiptV2(
        wrongPredecessor,
        chainedEnvelope,
        authority.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("does not bind the exact record envelope v4");
  });

  it("snapshots caller-owned input before awaiting the detached signer", async () => {
    const authority = testAuthority();
    const envelope = await createEnvelope(authority);
    const input = receiptInput(envelope, 1);
    const mutatingSigner: AuthorityDetachedSigner = async (bytes, keyId) => {
      mutable(input).record_position = 2;
      mutable(input).issued_at = "2026-08-20T13:00:00.000Z";
      mutable(input.envelope.body).envelope_id = "mutated-envelope";
      mutable(input.envelope.body.event).policy_id =
        ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID;
      return authority.sign(bytes, keyId);
    };
    const receipt = await createOrganizationRecordReceiptV2(
      input,
      authority.pinned,
      STATE_LINEAGE_ID,
      mutatingSigner,
    );
    expect(receipt.body.record_position).toBe(1);
    expect(receipt.body.issued_at).toBe("2026-08-20T12:04:00.000Z");
    expect(receipt.body.envelope_id).not.toBe(input.envelope.body.envelope_id);
    expect(receipt.body.policy_fact_outcome).toEqual({
      kind: "appended",
      policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID,
    });
  });

  it("pins the exact Authority key and explicit lineage", async () => {
    const authority = testAuthority();
    const envelope = await createEnvelope(authority);
    const receipt = await createOrganizationRecordReceiptV2(
      receiptInput(envelope, 1),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    expect(() =>
      verifyOrganizationRecordReceiptV2(
        receipt,
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
      verifyOrganizationRecordReceiptV2(
        receipt,
        envelope,
        foreign.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("pinned Authority");

    const alternateSameAuthority = testAuthority();
    const alternateSignatureInput =
      buildOrganizationRecordReceiptSignatureInputV2(
        receipt.body,
        alternateSameAuthority.descriptor.signing_key.key_id,
      );
    const alternateSignature = await alternateSameAuthority.sign(
      organizationRecordReceiptSignatureInputV2Bytes(alternateSignatureInput),
      alternateSameAuthority.descriptor.signing_key.key_id,
    );
    expect(() =>
      verifyOrganizationRecordReceiptV2(
        {
          ...receipt,
          signing_key_descriptor:
            alternateSameAuthority.descriptor.signing_key,
          signature: alternateSignature.toString("base64"),
        },
        envelope,
        authority.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("signing key does not match the pinned Authority");
  });

  it("rejects v1 receipt and v4 record signature-domain substitution", async () => {
    const authority = testAuthority();
    const envelope = await createEnvelope(authority);
    const receipt = await createOrganizationRecordReceiptV2(
      receiptInput(envelope, 1),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    expect(() =>
      validateOrganizationRecordReceiptBodyV2({
        ...receipt.body,
        schema_version: 1,
        kind: "echo-organization-record-receipt",
      }),
    ).toThrow("unsupported envelope");
    expect(() => validateOrganizationRecordReceiptV2(envelope)).toThrow(
      "unexpected shape",
    );

    const v1DomainSignature = await authority.sign(
      canonicalJsonBytes({
        schema_version: 1,
        kind: "echo-organization-record-receipt-signature-v1",
        authority_id: AUTHORITY_ID,
        organization_id: ORGANIZATION_ID,
        state_lineage_id: STATE_LINEAGE_ID,
        signing_key_id: receipt.signing_key_descriptor.key_id,
        receipt_sha256: receipt.receipt_sha256,
      }),
      receipt.signing_key_descriptor.key_id,
    );
    expect(() =>
      verifyOrganizationRecordReceiptV2(
        { ...receipt, signature: v1DomainSignature.toString("base64") },
        envelope,
        authority.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("signature is invalid");

    const v4Input = buildOrganizationRecordSignatureInputV4(
      envelope.body,
      receipt.signing_key_descriptor.key_id,
    );
    expect(v4Input.kind).toBe(ORGANIZATION_RECORD_SIGNATURE_V4_KIND);
    const v4DomainSignature = await authority.sign(
      organizationRecordSignatureInputV4Bytes(v4Input),
      receipt.signing_key_descriptor.key_id,
    );
    expect(() =>
      verifyOrganizationRecordReceiptV2(
        { ...receipt, signature: v4DomainSignature.toString("base64") },
        envelope,
        authority.pinned,
        STATE_LINEAGE_ID,
      ),
    ).toThrow("signature is invalid");
  });

  it("rejects malformed/high-S signatures and hostile in-memory objects", async () => {
    const authority = testAuthority();
    const envelope = await createEnvelope(authority);
    const receipt = await createOrganizationRecordReceiptV2(
      receiptInput(envelope, 1),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    expect(() =>
      validateOrganizationRecordReceiptV2({
        ...receipt,
        signature: "not+canonical=",
      }),
    ).toThrow("canonical base64");
    expect(() =>
      validateOrganizationRecordReceiptV2({
        ...receipt,
        signature: Buffer.from("not DER").toString("base64"),
      }),
    ).toThrow("strict DER low-S");
    const decoded = decodeStrictP256DerSignature(
      Buffer.from(receipt.signature, "base64"),
    );
    const highS = encodeP256DerSignature(decoded.r, P256_ORDER - decoded.s);
    expect(() =>
      validateOrganizationRecordReceiptV2({
        ...receipt,
        signature: highS.toString("base64"),
      }),
    ).toThrow("strict DER low-S");

    let bodyReads = 0;
    const accessor = { ...receipt } as Record<string, unknown>;
    Object.defineProperty(accessor, "body", {
      enumerable: true,
      get: () => {
        bodyReads += 1;
        return receipt.body;
      },
    });
    expect(() => validateOrganizationRecordReceiptV2(accessor)).toThrow(
      "enumerable data properties",
    );
    expect(bodyReads).toBe(0);

    const withSymbol = structuredClone(receipt);
    Object.defineProperty(withSymbol.body, Symbol("hidden"), {
      value: "hidden",
    });
    expect(() => validateOrganizationRecordReceiptV2(withSymbol)).toThrow(
      "symbol properties",
    );
    const customPrototype = structuredClone(receipt);
    Object.setPrototypeOf(customPrototype.body.policy_fact_outcome, null);
    expect(() => validateOrganizationRecordReceiptV2(customPrototype)).toThrow(
      "plain object",
    );
    const cyclic = structuredClone(receipt) as OrganizationRecordReceiptV2 & {
      cycle?: unknown;
    };
    cyclic.cycle = cyclic;
    expect(() => validateOrganizationRecordReceiptV2(cyclic)).toThrow("cycle");
  });

  it("rejects wrapper/signature-input drift and non-Buffer signer output", async () => {
    const authority = testAuthority();
    const envelope = await createEnvelope(authority);
    const receipt = await createOrganizationRecordReceiptV2(
      receiptInput(envelope, 1),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
    );
    expect(() =>
      validateOrganizationRecordReceiptV2({ ...receipt, checkpoint_id: "x" }),
    ).toThrow("unexpected shape");
    expect(() =>
      validateOrganizationRecordReceiptV2({
        ...receipt,
        receipt_sha256: digest("0"),
      }),
    ).toThrow("digest does not match");
    expect(() =>
      validateOrganizationRecordReceiptSignatureInputV2({
        ...buildOrganizationRecordReceiptSignatureInputV2(
          receipt.body,
          receipt.signing_key_descriptor.key_id,
        ),
        record_sha256: envelope.record_sha256,
      }),
    ).toThrow("unexpected shape");
    await expect(
      createOrganizationRecordReceiptV2(
        receiptInput(envelope, 1),
        authority.pinned,
        STATE_LINEAGE_ID,
        (async () => "not-a-buffer") as unknown as AuthorityDetachedSigner,
      ),
    ).rejects.toThrow("signature bytes");
  });
});
