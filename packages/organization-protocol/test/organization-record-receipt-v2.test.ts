import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonBytes,
  decodeStrictP256DerSignature,
  encodeP256DerSignature,
} from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { ApprovalDecisionPolicyIdV1 } from "../src/approval-decision-record-input-v2.js";
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
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "../src/person-content-policy-v2.js";
import {
  buildOrganizationRecordSignatureInputV4,
  createOrganizationRecordEnvelopeV4,
  organizationRecordSignatureInputV4Bytes,
} from "../src/record-envelope-v4.js";
import type {
  AuthorityDetachedSigner,
  OrganizationRecordEnvelopeV4,
} from "../src/record-envelope-v4.js";
import {
  AUTHORITY_ID,
  ORGANIZATION_ID,
  P256_ORDER,
  RECORD_INPUT_CODECS,
  STATE_LINEAGE_ID,
  digest,
  envelopeInput,
  mutable,
  testAuthority,
} from "./fixtures/record-v4-fixture.js";
import type { TestAuthority } from "./fixtures/record-v4-fixture.js";

const codecs = RECORD_INPUT_CODECS;

async function createEnvelope(
  authority: TestAuthority,
  policyId: ApprovalDecisionPolicyIdV1 = RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  predecessor: { position: number; sha256: Sha256Digest } | null = null,
): Promise<OrganizationRecordEnvelopeV4> {
  return createOrganizationRecordEnvelopeV4(
    envelopeInput(policyId, predecessor),
    authority.pinned,
    STATE_LINEAGE_ID,
    authority.sign,
    codecs,
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

function issue(
  authority: TestAuthority,
  envelope: OrganizationRecordEnvelopeV4,
  recordPosition: number,
  signer: AuthorityDetachedSigner = authority.sign,
): Promise<OrganizationRecordReceiptV2> {
  return createOrganizationRecordReceiptV2(
    receiptInput(envelope, recordPosition),
    authority.pinned,
    STATE_LINEAGE_ID,
    signer,
    codecs,
  );
}

async function genesisReceipt(): Promise<{
  authority: TestAuthority;
  envelope: OrganizationRecordEnvelopeV4;
  receipt: OrganizationRecordReceiptV2;
}> {
  const authority = testAuthority();
  const envelope = await createEnvelope(authority);
  const receipt = await issue(authority, envelope, 1);
  return { authority, envelope, receipt };
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
    const { envelope, receipt } = await genesisReceipt();
    expect(Object.keys(receipt).sort()).toEqual([
      "body",
      "receipt_sha256",
      "signature",
      "signing_key_descriptor",
    ]);
    expect(receipt.body).toStrictEqual({
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
      '{"authority_id":"oau_00000000-0000-4000-8000-000000000001","kind":"echo-organization-record-receipt-signature-v2","organization_id":"org_00000000-0000-4000-8000-000000000002","receipt_sha256":"sha256:9727e2fec45f0fc9cd99ccb694652d456a207207dae6dfbe9dd21f7537773c14","schema_version":2,"signing_key_id":"sha256:9999999999999999999999999999999999999999999999999999999999999999","state_lineage_id":"state-lineage-1"}',
    );
  });

  it("derives each policy's outcome and verifies the exact envelope", async () => {
    const authority = testAuthority();
    for (const policyId of [
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
    ] as const) {
      const predecessor = { position: 7, sha256: digest("7") };
      const envelope = await createEnvelope(
        authority,
        policyId,
        predecessor,
      );
      const receipt = await issue(authority, envelope, 8);
      expect(
        verifyOrganizationRecordReceiptV2(
          receipt,
          envelope,
          authority.pinned,
          STATE_LINEAGE_ID,
          codecs,
        ),
      ).toEqual(receipt);
      expect(receipt.body.event_kind).toBe("approved");
      expect(receipt.body.predecessor_record_sha256).toBe(digest("7"));
      expect(receipt.body.record_head_position).toBe(8);
      expect(receipt.body.record_head_sha256).toBe(envelope.record_sha256);
      expect(receipt.body.policy_fact_outcome).toEqual({
        kind: "appended",
        policy_id: policyId,
      });
    }
  });

  it("accepts only the exact next append allocation", async () => {
    const authority = testAuthority();
    const genesis = await createEnvelope(authority);
    await expect(
      issue(authority, genesis, 2),
    ).rejects.toThrow("does not continue the envelope predecessor");
    const chained = await createEnvelope(
      authority,
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      { position: 9, sha256: digest("9") },
    );
    await expect(
      issue(authority, chained, 9),
    ).rejects.toThrow("does not continue the envelope predecessor");
    await expect(issue(authority, chained, 10)).resolves.toBeDefined();

    const exhausted = await createEnvelope(
      authority,
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      { position: Number.MAX_SAFE_INTEGER, sha256: digest("8") },
    );
    await expect(
      issue(authority, exhausted, Number.MAX_SAFE_INTEGER),
    ).rejects.toThrow("does not continue the envelope predecessor");
  });

  it("rejects a rejection, an approval without facts, head drift, chain drift, and body shape drift", async () => {
    const { receipt } = await genesisReceipt();
    for (const [patch, message] of [
      [{ event_kind: "rejected" }, "event kind is unsupported"],
      [{ policy_fact_outcome: { kind: "none" } }, "unexpected shape"],
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
  });

  it("denies every re-signed receipt-to-envelope binding mutation", async () => {
    const { authority, envelope, receipt } = await genesisReceipt();
    const mutations: readonly Record<string, unknown>[] = [
      { authority_id: "oau_00000000-0000-4000-8000-000000000003" },
      { organization_id: "org_00000000-0000-4000-8000-000000000004" },
      { state_lineage_id: "another-lineage" },
      { envelope_id: "another-envelope" },
      { semantic_idempotency_key: digest("1") },
      {
        policy_fact_outcome: {
          kind: "appended",
          policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
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
          codecs,
        ),
      ).toThrow();
    }

    const anotherEnvelope = await createEnvelope(
      authority,
      PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
    );
    expect(() =>
      verifyOrganizationRecordReceiptV2(
        receipt,
        anotherEnvelope,
        authority.pinned,
        STATE_LINEAGE_ID,
        codecs,
      ),
    ).toThrow("does not bind the exact record envelope v4");

    const chainedEnvelope = await createEnvelope(
      authority,
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      { position: 5, sha256: digest("5") },
    );
    const chainedReceipt = await issue(authority, chainedEnvelope, 6);
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
        codecs,
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
        codecs,
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
      mutable(input.envelope.body).event = {
        ...input.envelope.body.event,
        policy_id: PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
      };
      return authority.sign(bytes, keyId);
    };
    const receipt = await createOrganizationRecordReceiptV2(
      input,
      authority.pinned,
      STATE_LINEAGE_ID,
      mutatingSigner,
      codecs,
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
    const { authority, envelope, receipt } = await genesisReceipt();
    expect(() =>
      verifyOrganizationRecordReceiptV2(
        receipt,
        envelope,
        authority.pinned,
        "another-lineage",
        codecs,
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
        codecs,
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
        codecs,
      ),
    ).toThrow("signing key does not match the pinned Authority");
  });

  it("rejects v1 receipt and v4 record signature-domain substitution", async () => {
    const { authority, envelope, receipt } = await genesisReceipt();
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
        codecs,
      ),
    ).toThrow("signature is invalid");

    const v4Input = buildOrganizationRecordSignatureInputV4(
      envelope.body,
      receipt.signing_key_descriptor.key_id,
      codecs,
    );
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
        codecs,
      ),
    ).toThrow("signature is invalid");
  });

  it("rejects malformed/high-S signatures and hostile in-memory objects", async () => {
    const { receipt } = await genesisReceipt();
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
    const { authority, envelope, receipt } = await genesisReceipt();
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
      issue(
        authority,
        envelope,
        1,
        (async () => "not-a-buffer") as unknown as AuthorityDetachedSigner,
      ),
    ).rejects.toThrow("signature bytes");
  });
});
