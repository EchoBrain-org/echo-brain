import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonBytes,
  decodeStrictP256DerSignature,
  encodeP256DerSignature,
} from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type {
  ApprovalDecisionPolicyIdV1,
  ApprovalDecisionRecordInputV2,
  ApprovalDecisionRefV2,
} from "../src/approval-decision-record-input-v2.js";
import {
  approvedDecisionSnapshotV2Sha256,
  validateApprovedDecisionSnapshotV2,
} from "../src/approved-decision-snapshot-v2.js";
import {
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID,
} from "../src/person-content-policy-v2.js";
import {
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
  OrganizationRecordEnvelopeBodyV4,
  OrganizationRecordEnvelopeV4,
} from "../src/record-envelope-v4.js";
import {
  AUTHORITY_ID,
  ORGANIZATION_ID,
  P256_ORDER,
  RECORD_INPUT_CODECS,
  STATE_LINEAGE_ID,
  approvalDecision,
  digest,
  envelopeInput,
  mutable,
  processorProvenance,
  sourceProvenance,
  testAuthority,
} from "./fixtures/record-v4-fixture.js";

const codecs = RECORD_INPUT_CODECS;

function recordBody(
  policyId: ApprovalDecisionPolicyIdV1 = RESTRICTED_REVIEWER_PERSON_POLICY_ID,
  predecessor: { position: number; sha256: Sha256Digest } | null = null,
): OrganizationRecordEnvelopeBodyV4 {
  const validated = codecs.validateInput(approvalDecision(policyId));
  const source = sourceProvenance();
  const processor = processorProvenance();
  return {
    schema_version: 4,
    kind: ORGANIZATION_RECORD_ENVELOPE_V4_KIND,
    envelope_id: `envelope-${policyId}`,
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

  it("joins the complete approval decision and exact approved provenance for both policies", () => {
    for (const policyId of [
      RESTRICTED_REVIEWER_PERSON_POLICY_ID,
      PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
    ] as const) {
      const body = recordBody(policyId);
      const validated = validateOrganizationRecordEnvelopeBodyV4(body, codecs);
      expect(validated.event.kind).toBe("approved");
      expect(
        (validated.human_act_resolution_ref as unknown as ApprovalDecisionRefV2)
          .selected_policy_id,
      ).toBe(policyId);
      expect(validated.semantic_idempotency_key).toBe(
        codecs.fromReference(body.human_act_resolution_ref, body.event)
          .semantic_idempotency_key,
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
    }
  });

  it("refuses a rejection: only an approval writes a record", () => {
    const body = recordBody(RESTRICTED_REVIEWER_PERSON_POLICY_ID, {
      position: 7,
      sha256: digest("7"),
    });
    expect(validateOrganizationRecordEnvelopeBodyV4(body, codecs).predecessor_position).toBe(7);
    expect(() =>
      validateOrganizationRecordEnvelopeBodyV4(
        replaceBody(body, {
          human_act_resolution_ref: { ...body.human_act_resolution_ref, action: "reject" },
        }),
        codecs,
      ),
    ).toThrow("Approval decision reference is unsupported");
    expect(() =>
      validateOrganizationRecordEnvelopeBodyV4(
        replaceBody(body, { event: { kind: "rejected" } }),
        codecs,
      ),
    ).toThrow("A rejection writes no approval decision record");
  });

  it("denies broken approval, coordinate, digest, and payload-provenance joins", async () => {
    const body = recordBody();
    expect(() =>
      validateOrganizationRecordEnvelopeBodyV4(
        replaceBody(body, { semantic_idempotency_key: digest("9") }),
        codecs,
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
        codecs,
      ),
    ).toThrow("does not match the record coordinates");
    expect(() =>
      validateOrganizationRecordEnvelopeBodyV4(
        replaceBody(body, {
          source_provenance_sha256: digest("8"),
        }),
        codecs,
      ),
    ).toThrow("source provenance digest");
    expect(() =>
      validateOrganizationRecordEnvelopeBodyV4(
        replaceBody(body, {
          processor_provenance_sha256: digest("8"),
        }),
        codecs,
      ),
    ).toThrow("processor provenance digest");

    for (const [mutatePayload, message] of [
      [
        (payload: Record<string, unknown>) => {
          mutable(payload.source).external_id = "another-meeting";
        },
        "does not match source provenance",
      ],
      [
        (payload: Record<string, unknown>) => {
          mutable(mutable(payload.brief).provenance).meeting_revision =
            "another-revision";
        },
        "meeting revision",
      ],
      [
        (payload: Record<string, unknown>) => {
          mutable(mutable(mutable(payload.brief).provenance).processor).version =
            "another-processing-version";
        },
        "processor identity",
      ],
    ] as const) {
      const broken = structuredClone(body);
      const brokenEvent = mutable(broken.event);
      mutatePayload(mutable(mutable(brokenEvent.approved_snapshot).approved_payload));
      brokenEvent.approved_snapshot_sha256 = approvedDecisionSnapshotV2Sha256(
        validateApprovedDecisionSnapshotV2(brokenEvent.approved_snapshot),
      );
      mutable(broken.human_act_resolution_ref).approved_snapshot_sha256 =
        brokenEvent.approved_snapshot_sha256;
      mutable(broken).semantic_idempotency_key = codecs.fromReference(
        broken.human_act_resolution_ref,
        broken.event,
      ).semantic_idempotency_key;
      expect(() => validateOrganizationRecordEnvelopeBodyV4(broken, codecs)).toThrow(
        message,
      );
    }

    const brokenDecision = approvalDecision();
    mutable(brokenDecision.approval_decision_ref_v2).approved_snapshot_sha256 =
      digest("9");
    const authority = testAuthority();
    await expect(
      createOrganizationRecordEnvelopeV4(
        { ...envelopeInput(), human_act_record_input: brokenDecision },
        authority.pinned,
        STATE_LINEAGE_ID,
        authority.sign,
        codecs,
      ),
    ).rejects.toThrow("differs from its approved event");
  });

  it("pins genesis/non-genesis pairing and exact signature-input bytes", () => {
    expect(
      validateOrganizationRecordEnvelopeBodyV4(
        recordBody(RESTRICTED_REVIEWER_PERSON_POLICY_ID, {
          position: 1,
          sha256: digest("1"),
        }),
        codecs,
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
          codecs,
        ),
      ).toThrow();
    }

    const signatureInput = buildOrganizationRecordSignatureInputV4(
      recordBody(),
      digest("9"),
      codecs,
    );
    expect(signatureInput).toEqual({
      schema_version: 4,
      kind: ORGANIZATION_RECORD_SIGNATURE_V4_KIND,
      authority_id: AUTHORITY_ID,
      organization_id: ORGANIZATION_ID,
      state_lineage_id: STATE_LINEAGE_ID,
      signing_key_id: digest("9"),
      record_sha256: organizationRecordEnvelopeBodyV4Sha256(recordBody(), codecs),
    });
    expect(
      organizationRecordSignatureInputV4Bytes(signatureInput).toString("utf8"),
    ).toBe(
      '{"authority_id":"oau_00000000-0000-4000-8000-000000000001","kind":"echo-organization-record-signature-v4","organization_id":"org_00000000-0000-4000-8000-000000000002","record_sha256":"sha256:4a5c4719fd08c567df786f0c8a87bea2fadb5892848dcdf4c30b1a80c62a852e","schema_version":4,"signing_key_id":"sha256:9999999999999999999999999999999999999999999999999999999999999999","state_lineage_id":"state-lineage-1"}',
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

  it("creates and verifies both policies with a pinned Authority key and lineage", async () => {
    const authority = testAuthority();
    const cases = [
      [RESTRICTED_REVIEWER_PERSON_POLICY_ID, null],
      [
        PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID,
        { position: 1, sha256: digest("1") },
      ],
    ] as const;
    for (const [policyId, predecessor] of cases) {
      const envelope = await createOrganizationRecordEnvelopeV4(
        envelopeInput(policyId, predecessor),
        authority.pinned,
        STATE_LINEAGE_ID,
        authority.sign,
        codecs,
      );
      expect(
        verifyOrganizationRecordEnvelopeV4(
          envelope,
          authority.pinned,
          STATE_LINEAGE_ID,
          codecs,
        ),
      ).toEqual(envelope);
      expect(envelope.body.event.kind).toBe("approved");
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
    const input = envelopeInput();
    const expectedBody = recordBody();
    const mutatingSigner: AuthorityDetachedSigner = async (bytes, keyId) => {
      mutable(input).envelope_id = "mutated-envelope";
      mutable(input.source_provenance).external_id = "mutated-source";
      mutable(input.processor_provenance).processor_adapter_version =
        "mutated-version";
      mutable(
        (input.human_act_record_input as ApprovalDecisionRecordInputV2)
          .approval_decision_ref_v2,
      ).approval_id = "mutated-approval";
      return authority.sign(bytes, keyId);
    };
    const envelope = await createOrganizationRecordEnvelopeV4(
      input,
      authority.pinned,
      STATE_LINEAGE_ID,
      mutatingSigner,
      codecs,
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
      envelopeInput(),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
      codecs,
    );
    expect(() =>
      verifyOrganizationRecordEnvelopeV4(
        { ...envelope, record_sha256: digest("0") },
        authority.pinned,
        STATE_LINEAGE_ID,
        codecs,
      ),
    ).toThrow("record digest");
    expect(() =>
      verifyOrganizationRecordEnvelopeV4(
        { ...envelope, signature: `${envelope.signature.slice(0, -4)}AAAA` },
        authority.pinned,
        STATE_LINEAGE_ID,
        codecs,
      ),
    ).toThrow();
    expect(() =>
      verifyOrganizationRecordEnvelopeV4(
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
      verifyOrganizationRecordEnvelopeV4(
        envelope,
        foreign.pinned,
        STATE_LINEAGE_ID,
        codecs,
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
        codecs,
      ),
    ).toThrow("signing key");

    // A self-consistent embedded key and signature are not trust: the exact
    // Authority descriptor remains independently pinned.
    const alternateSameAuthority = testAuthority();
    const alternateSignatureInput = buildOrganizationRecordSignatureInputV4(
      envelope.body,
      alternateSameAuthority.descriptor.signing_key.key_id,
      codecs,
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
        codecs,
      ),
    ).toThrow("signing key does not match the pinned Authority");
    expect(() =>
      validateOrganizationRecordEnvelopeV4({
        ...envelope,
        body: { ...envelope.body, schema_version: 3 },
      }, codecs),
    ).toThrow("unsupported envelope");

    const oldDomainBytes = canonicalJsonBytes({
      ...buildOrganizationRecordSignatureInputV4(
        envelope.body,
        envelope.signing_key_descriptor.key_id,
        codecs,
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
        codecs,
      ),
    ).toThrow("signature is invalid");
  });

  it("rejects malformed/high-S signatures and hostile in-memory objects", async () => {
    const authority = testAuthority();
    const envelope = await createOrganizationRecordEnvelopeV4(
      envelopeInput(),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
      codecs,
    );
    expect(() =>
      validateOrganizationRecordEnvelopeV4({
        ...envelope,
        signature: "not+canonical=",
      }, codecs),
    ).toThrow("canonical base64");
    expect(() =>
      validateOrganizationRecordEnvelopeV4({
        ...envelope,
        signature: Buffer.from("not DER").toString("base64"),
      }, codecs),
    ).toThrow("strict DER low-S");
    const decoded = decodeStrictP256DerSignature(
      Buffer.from(envelope.signature, "base64"),
    );
    const highS = encodeP256DerSignature(decoded.r, P256_ORDER - decoded.s);
    expect(() =>
      validateOrganizationRecordEnvelopeV4({
        ...envelope,
        signature: highS.toString("base64"),
      }, codecs),
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
    expect(() => validateOrganizationRecordEnvelopeV4(accessor, codecs)).toThrow(
      "enumerable data properties",
    );
    expect(bodyReads).toBe(0);

    const withSymbol = structuredClone(envelope);
    Object.defineProperty(withSymbol.body, Symbol("hidden"), {
      value: "hidden",
    });
    expect(() => validateOrganizationRecordEnvelopeV4(withSymbol, codecs)).toThrow(
      "symbol properties",
    );
    const nonEnumerable = structuredClone(envelope);
    Object.defineProperty(nonEnumerable.body.source_provenance, "hidden", {
      value: "hidden",
    });
    expect(() => validateOrganizationRecordEnvelopeV4(nonEnumerable, codecs)).toThrow(
      "enumerable data properties",
    );
    const customPrototype = structuredClone(envelope);
    Object.setPrototypeOf(customPrototype.body.processor_provenance, null);
    expect(() => validateOrganizationRecordEnvelopeV4(customPrototype, codecs)).toThrow(
      "plain object",
    );
    const cyclic = structuredClone(envelope) as OrganizationRecordEnvelopeV4 & {
      cycle?: unknown;
    };
    cyclic.cycle = cyclic;
    expect(() => validateOrganizationRecordEnvelopeV4(cyclic, codecs)).toThrow("cycle");
  });

  it("rejects wrapper drift and a non-Buffer detached signer result", async () => {
    const authority = testAuthority();
    const envelope = await createOrganizationRecordEnvelopeV4(
      envelopeInput(),
      authority.pinned,
      STATE_LINEAGE_ID,
      authority.sign,
      codecs,
    );
    for (const candidate of [
      { ...envelope, integrity: {} },
      { ...envelope, authorization_proof_sha256: digest("1") },
      { ...envelope, human_act_resolution_ref_sha256: digest("2") },
    ]) {
      expect(() => validateOrganizationRecordEnvelopeV4(candidate, codecs)).toThrow(
        "unexpected shape",
      );
    }
    const missing = { ...envelope } as unknown as Record<string, unknown>;
    delete missing.record_sha256;
    expect(() => validateOrganizationRecordEnvelopeV4(missing, codecs)).toThrow(
      "unexpected shape",
    );
    await expect(
      createOrganizationRecordEnvelopeV4(
        envelopeInput(),
        authority.pinned,
        STATE_LINEAGE_ID,
        (async () => "not-a-buffer") as unknown as AuthorityDetachedSigner,
        codecs,
      ),
    ).rejects.toThrow("signature bytes");
  });
});
