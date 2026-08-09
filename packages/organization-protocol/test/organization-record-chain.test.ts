import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalJsonBytes,
  canonicalSha256,
  signedPayload,
} from "@echo-brain/federation-protocol";
import type { P256SigningKeyDescriptor } from "@echo-brain/federation-protocol";
import {
  CONSERVATIVE_ORGANIZATION_RECORD_INTENT,
  createOrganizationRecordApprovalEnvelope,
  createOrganizationRecordReceipt,
  createOrganizationRecordRejectionEnvelope,
  MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES,
  MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
  organizationAuthorityPinSha256,
  organizationRecordEnvelopeId,
  OrganizationProtocolValidationError,
  validateOrganizationRecordEnvelope,
  validateOrganizationRecordReceipt,
  verifyOrganizationAuthorityPin,
  verifyOrganizationRecordEnvelope,
  verifyOrganizationRecordReceipt,
} from "../src/index.js";
import {
  MAX_ORGANIZATION_RECORD_REJECTION_REASON_BYTES,
  validateOrganizationRecordDecisionBrief,
} from "../src/record-payload.js";
import {
  validateOrganizationRecordApprovalEnvelope,
  validateOrganizationRecordRejectionEnvelope,
  verifyOrganizationRecordApprovalEnvelope,
  verifyOrganizationRecordRejectionEnvelope,
} from "../src/record-envelope.js";
import type {
  CanonicalPayloadSigner,
  OrganizationAuthorityDescriptorV1,
  OrganizationRecordApprovalEnvelopeV1,
  OrganizationRecordDecisionBriefV1,
  OrganizationRecordReceiptV1,
  OrganizationRecordRejectionEnvelopeV1,
} from "../src/index.js";
import { canonicalSnapshot } from "../src/validation-support.js";

interface GoldenVector {
  payload_canonical_utf8_base64: string;
  payload_sha256: string;
  document_canonical_utf8_base64: string;
  document_sha256: string;
}

interface RecordFixture {
  fixture_version: number;
  kind: string;
  authority_descriptor: OrganizationAuthorityDescriptorV1;
  authority_pin_sha256: string;
  installation_signing_key: P256SigningKeyDescriptor;
  approval_envelope: OrganizationRecordApprovalEnvelopeV1;
  approval_envelope_vector: GoldenVector;
  approval_receipt: OrganizationRecordReceiptV1;
  approval_receipt_vector: GoldenVector;
  rejection_envelope: OrganizationRecordRejectionEnvelopeV1;
  rejection_envelope_vector: GoldenVector;
  rejection_receipt: OrganizationRecordReceiptV1;
  rejection_receipt_vector: GoldenVector;
}

interface PayloadConformanceCase {
  name: string;
  reason?: string;
  core_accepts?: boolean;
  brief: unknown;
}

interface PayloadConformanceFixture {
  fixture_version: number;
  kind: string;
  valid: PayloadConformanceCase[];
  invalid: PayloadConformanceCase[];
  record_only_invalid: PayloadConformanceCase[];
}

function readFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

const fixture = readFixture<RecordFixture>("organization-record-chain.v1.json");
const conformance = readFixture<PayloadConformanceFixture>(
  "organization-record-payload-conformance.v1.json",
);

const pinnedAuthority = verifyOrganizationAuthorityPin(
  fixture.authority_descriptor,
  fixture.authority_pin_sha256,
);
const installationKey = fixture.installation_signing_key;

function assertGoldenVector(document: object, vector: GoldenVector): void {
  const payload = signedPayload(document as never);
  expect(canonicalJsonBytes(payload).toString("base64")).toBe(
    vector.payload_canonical_utf8_base64,
  );
  expect(canonicalSha256(payload)).toBe(vector.payload_sha256);
  expect(canonicalJsonBytes(document).toString("base64")).toBe(
    vector.document_canonical_utf8_base64,
  );
  expect(canonicalSha256(document)).toBe(vector.document_sha256);
}

function replaySigner(
  vector: GoldenVector,
  signatureBase64: string,
): CanonicalPayloadSigner {
  return async (bytes) => {
    expect(bytes.toString("base64")).toBe(vector.payload_canonical_utf8_base64);
    return Buffer.from(signatureBase64, "base64");
  };
}

function approvalWithPayload(
  mutate: (payload: Record<string, unknown>) => void,
): unknown {
  const envelope = structuredClone(
    fixture.approval_envelope,
  ) as unknown as Record<string, unknown>;
  mutate(envelope.payload as Record<string, unknown>);
  return envelope;
}

/** Grows one verbatim quote until the canonical envelope is exactly `target` bytes. */
function approvalEnvelopeOfCanonicalSize(target: number): unknown {
  const envelope = structuredClone(fixture.approval_envelope) as unknown as {
    payload: { brief: { decisions: { text: string }[] } };
  };
  const decision = envelope.payload.brief.decisions[0]!;
  const base = decision.text;
  const overhead = canonicalJsonBytes(envelope).length;
  decision.text = base + "x".repeat(Math.max(0, target - overhead));
  expect(canonicalJsonBytes(envelope).length).toBe(target);
  return envelope;
}

describe("organization record golden chain", () => {
  it("freezes every signed byte of the approval and rejection chain", () => {
    expect(fixture.fixture_version).toBe(1);
    expect(fixture.kind).toBe("echo-organization-record-golden-fixture");
    expect(organizationAuthorityPinSha256(fixture.authority_descriptor)).toBe(
      fixture.authority_pin_sha256,
    );
    assertGoldenVector(
      fixture.approval_envelope,
      fixture.approval_envelope_vector,
    );
    assertGoldenVector(
      fixture.rejection_envelope,
      fixture.rejection_envelope_vector,
    );
    assertGoldenVector(
      fixture.approval_receipt,
      fixture.approval_receipt_vector,
    );
    assertGoldenVector(
      fixture.rejection_receipt,
      fixture.rejection_receipt_vector,
    );
  });

  it("replays creation over the exact canonical payload bytes", async () => {
    const approval = await createOrganizationRecordApprovalEnvelope(
      {
        envelope_id: fixture.approval_envelope.envelope_id,
        idempotency_key: fixture.approval_envelope.idempotency_key,
        payload: fixture.approval_envelope.payload,
        reviewer: fixture.approval_envelope.reviewer,
        intent: fixture.approval_envelope.intent,
        submitter: fixture.approval_envelope.submitter,
        installation_signing_key: installationKey,
      },
      pinnedAuthority,
      replaySigner(
        fixture.approval_envelope_vector,
        fixture.approval_envelope.integrity.signature_base64,
      ),
    );
    expect(approval).toEqual(fixture.approval_envelope);

    const rejection = await createOrganizationRecordRejectionEnvelope(
      {
        envelope_id: fixture.rejection_envelope.envelope_id,
        idempotency_key: fixture.rejection_envelope.idempotency_key,
        payload: fixture.rejection_envelope.payload,
        reviewer: fixture.rejection_envelope.reviewer,
        submitter: fixture.rejection_envelope.submitter,
        installation_signing_key: installationKey,
      },
      pinnedAuthority,
      replaySigner(
        fixture.rejection_envelope_vector,
        fixture.rejection_envelope.integrity.signature_base64,
      ),
    );
    expect(rejection).toEqual(fixture.rejection_envelope);

    const receipt = await createOrganizationRecordReceipt(
      {
        envelope: approval,
        installation_signing_key: installationKey,
        position: fixture.approval_receipt.position,
        record_hash: fixture.approval_receipt.record_hash,
        recorded_at: fixture.approval_receipt.recorded_at,
      },
      pinnedAuthority,
      replaySigner(
        fixture.approval_receipt_vector,
        fixture.approval_receipt.integrity.signature_base64,
      ),
    );
    expect(receipt).toEqual(fixture.approval_receipt);
  });

  it("validates, verifies, and digests both envelope types", () => {
    expect(
      validateOrganizationRecordApprovalEnvelope(fixture.approval_envelope),
    ).toEqual(fixture.approval_envelope);
    expect(
      validateOrganizationRecordRejectionEnvelope(fixture.rejection_envelope),
    ).toEqual(fixture.rejection_envelope);
    expect(
      validateOrganizationRecordEnvelope(fixture.approval_envelope).event_type,
    ).toBe("approval");
    expect(
      validateOrganizationRecordEnvelope(fixture.rejection_envelope).event_type,
    ).toBe("rejection");
    expect(
      verifyOrganizationRecordApprovalEnvelope(
        fixture.approval_envelope,
        pinnedAuthority,
        installationKey,
      ),
    ).toEqual(fixture.approval_envelope);
    expect(
      verifyOrganizationRecordRejectionEnvelope(
        fixture.rejection_envelope,
        pinnedAuthority,
        installationKey,
      ),
    ).toEqual(fixture.rejection_envelope);

    for (const [envelope, vector] of [
      [fixture.approval_envelope, fixture.approval_envelope_vector],
      [fixture.rejection_envelope, fixture.rejection_envelope_vector],
    ] as const) {
      expect(canonicalSha256(envelope)).toBe(vector.document_sha256);
      expect(canonicalJsonBytes(envelope).toString("base64")).toBe(
        vector.document_canonical_utf8_base64,
      );
    }
  });

  it("binds each receipt to the exact envelope it acknowledges", () => {
    expect(
      validateOrganizationRecordReceipt(fixture.approval_receipt),
    ).toEqual(fixture.approval_receipt);
    expect(
      verifyOrganizationRecordReceipt(
        fixture.approval_receipt,
        pinnedAuthority,
        fixture.approval_envelope,
        installationKey,
      ),
    ).toEqual(fixture.approval_receipt);
    expect(fixture.approval_receipt.envelope_sha256).toBe(
      fixture.approval_envelope_vector.document_sha256,
    );
    expect(fixture.rejection_receipt.envelope_sha256).toBe(
      fixture.rejection_envelope_vector.document_sha256,
    );
    expect(fixture.approval_receipt.position).toBe(1);
    expect(fixture.rejection_receipt.position).toBe(2);

    // A receipt for the other envelope of the same chain must not verify.
    expect(() =>
      verifyOrganizationRecordReceipt(
        fixture.approval_receipt,
        pinnedAuthority,
        fixture.rejection_envelope,
        installationKey,
      ),
    ).toThrow("does not bind the exact envelope");
    for (const mutation of [
      { envelope_sha256: `sha256:${"0".repeat(64)}` },
      { envelope_id: "rec_00000000-0000-4000-8000-00000000ffff" },
      { installation_id: "ins_00000000-0000-4000-8000-00000000ffff" },
      { idempotency_key: "0".repeat(64) },
    ]) {
      expect(() =>
        verifyOrganizationRecordReceipt(
          { ...fixture.approval_receipt, ...mutation },
          pinnedAuthority,
          fixture.approval_envelope,
          installationKey,
        ),
      ).toThrow("does not bind the exact envelope");
    }
    expect(() =>
      verifyOrganizationRecordReceipt(
        { ...fixture.approval_receipt, organization_id: "org_00000000-0000-4000-8000-00000000ffff" },
        pinnedAuthority,
        fixture.approval_envelope,
        installationKey,
      ),
    ).toThrow("does not match the pinned authority");
    expect(() =>
      validateOrganizationRecordReceipt({
        ...fixture.approval_receipt,
        position: 0,
      }),
    ).toThrow("position must be a positive safe integer");
  });

  it("names the log position exactly as the record core does", () => {
    // The receipt payload is the member's copy of one log row's identity, so
    // its field names are the record core's field names, not aliases of them.
    expect(Object.keys(fixture.approval_receipt).sort()).toEqual([
      "authority_id",
      "envelope_id",
      "envelope_sha256",
      "idempotency_key",
      "installation_id",
      "integrity",
      "kind",
      "organization_id",
      "position",
      "record_hash",
      "recorded_at",
      "schema_version",
    ]);
    expect("log_position" in fixture.approval_receipt).toBe(false);
    // The signing key is carried once, by the integrity block.
    expect("authority_key_id" in fixture.approval_receipt).toBe(false);
    expect(fixture.approval_receipt.integrity.key_id).toBe(
      fixture.authority_descriptor.signing_key.key_id,
    );
    expect(() =>
      validateOrganizationRecordReceipt({
        ...fixture.approval_receipt,
        authority_key_id: fixture.authority_descriptor.signing_key.key_id,
      }),
    ).toThrow("organization record receipt has an unexpected shape");
  });

  it("verifies the signing key against the pinned authority, not a payload claim", () => {
    const foreign = structuredClone(fixture.approval_receipt);
    foreign.integrity = {
      ...foreign.integrity,
      key_id: fixture.installation_signing_key.key_id,
    };
    expect(() =>
      verifyOrganizationRecordReceipt(
        foreign,
        pinnedAuthority,
        fixture.approval_envelope,
        installationKey,
      ),
    ).toThrow("does not match the pinned authority");

    // A receipt whose bytes were altered still fails the signature check even
    // though every binding field and the key id still look right.
    const tampered = structuredClone(fixture.approval_receipt);
    tampered.record_hash = `sha256:${"9".repeat(64)}`;
    expect(() =>
      verifyOrganizationRecordReceipt(
        tampered,
        pinnedAuthority,
        fixture.approval_envelope,
        installationKey,
      ),
    ).toThrow("payload digest does not match");
  });

  it("rejects the reserved correction event type by name", () => {
    const correction = {
      ...structuredClone(fixture.approval_envelope),
      event_type: "correction",
    };
    expect(() => validateOrganizationRecordEnvelope(correction)).toThrow(
      "correction is reserved and is not supported in schema version 1",
    );
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(correction),
    ).toThrow("correction is reserved and is not supported in schema version 1");
    expect(() =>
      validateOrganizationRecordEnvelope({
        ...structuredClone(fixture.approval_envelope),
        event_type: "amendment",
      }),
    ).toThrow("event_type is unsupported");
  });

  it("requires allowed authorization evidence bound to this exact submission", () => {
    const withReviewer = (patch: Record<string, unknown>): unknown => {
      const envelope = structuredClone(fixture.approval_envelope);
      return {
        ...envelope,
        reviewer: { ...envelope.reviewer, ...patch },
      };
    };
    const withEvidence = (patch: Record<string, unknown>): unknown => {
      const envelope = structuredClone(fixture.approval_envelope);
      return {
        ...envelope,
        reviewer: {
          ...envelope.reviewer,
          authorization: { ...envelope.reviewer.authorization, ...patch },
        },
      };
    };

    const withoutAuthorization = structuredClone(
      fixture.approval_envelope,
    ) as unknown as Record<string, unknown>;
    delete (withoutAuthorization.reviewer as Record<string, unknown>)
      .authorization;
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(withoutAuthorization),
    ).toThrow("reviewer has an unexpected shape");

    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        withEvidence({ allowed: false }),
      ),
    ).toThrow("authorization must be an allow decision");
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        withEvidence({ approval_id: "0".repeat(64) }),
      ),
    ).toThrow("authorization does not bind this exact submission");
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        withEvidence({
          installation_id: "ins_00000000-0000-4000-8000-00000000ffff",
        }),
      ),
    ).toThrow("authorization does not bind this exact submission");
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        withReviewer({
          principal_id: "prn_00000000-0000-4000-8000-00000000ffff",
        }),
      ),
    ).toThrow("authorization does not bind this exact submission");
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        withEvidence({ permission_grant_id: null }),
      ),
    ).toThrow("permission_grant_id must be a canonical pgr identifier");
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        withEvidence({ adapter_binding_id: null }),
      ),
    ).toThrow("adapter_binding_id must be a canonical bnd identifier");
    expect(() =>
      verifyOrganizationRecordEnvelope(
        withEvidence({
          organization_id: "org_00000000-0000-4000-8000-00000000ffff",
        }),
        pinnedAuthority,
        installationKey,
      ),
    ).toThrow("does not match the pinned authority");
  });

  it("requires the allowed action to match the event type exactly", () => {
    expect(fixture.approval_envelope.reviewer.authorization.action).toBe(
      "approve",
    );
    expect(fixture.rejection_envelope.reviewer.authorization.action).toBe(
      "reject",
    );

    const withAction = (
      envelope:
        | OrganizationRecordApprovalEnvelopeV1
        | OrganizationRecordRejectionEnvelopeV1,
      action: unknown,
    ): unknown => {
      const clone = structuredClone(envelope);
      return {
        ...clone,
        reviewer: {
          ...clone.reviewer,
          authorization: { ...clone.reviewer.authorization, action },
        },
      };
    };

    // An allow decision for one act must never authorize the other.
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        withAction(fixture.approval_envelope, "reject"),
      ),
    ).toThrow("authorization action does not authorize this approval event");
    expect(() =>
      validateOrganizationRecordRejectionEnvelope(
        withAction(fixture.rejection_envelope, "approve"),
      ),
    ).toThrow("authorization action does not authorize this rejection event");
    expect(() =>
      validateOrganizationRecordEnvelope(
        withAction(fixture.approval_envelope, "reject"),
      ),
    ).toThrow("authorization action does not authorize this approval event");

    for (const action of ["", "APPROVE", "correction", null, 1]) {
      expect(() =>
        validateOrganizationRecordApprovalEnvelope(
          withAction(fixture.approval_envelope, action),
        ),
        String(action),
      ).toThrow("authorization action must be approve or reject");
    }

    const withoutAction = structuredClone(
      fixture.approval_envelope,
    ) as unknown as { reviewer: { authorization: Record<string, unknown> } };
    delete withoutAction.reviewer.authorization.action;
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(withoutAction),
    ).toThrow("reviewer authorization has an unexpected shape");
  });

  it("pins schema version 1 intent to the conservative default", () => {
    const withIntent = (intent: unknown): unknown => ({
      ...structuredClone(fixture.approval_envelope),
      intent,
    });
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        withIntent({ restricted: false, reconsider_after: null }),
      ),
    ).toThrow("must be the conservative installation default");
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        withIntent({
          restricted: true,
          reconsider_after: "2026-09-01T09:00:00.000Z",
        }),
      ),
    ).toThrow("must be the conservative installation default");
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        withIntent({ restricted: "true", reconsider_after: null }),
      ),
    ).toThrow("restricted must be a boolean");
    // Both fields stay in the contract so relaxing the pin later is a
    // validator change, not a schema change.
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(withIntent({ restricted: true })),
    ).toThrow("intent has an unexpected shape");
    expect(
      validateOrganizationRecordApprovalEnvelope(
        withIntent(CONSERVATIVE_ORGANIZATION_RECORD_INTENT),
      ).intent,
    ).toEqual({ restricted: true, reconsider_after: null });
  });

  it("rejects repeated participant ids so every valid payload is derivable", () => {
    const duplicated = approvalWithPayload((payload) => {
      const brief = payload.brief as {
        meeting: { participants: Record<string, unknown>[] };
      };
      brief.meeting.participants = [
        brief.meeting.participants[0]!,
        { ...brief.meeting.participants[0]!, display_name: "Ada F." },
      ];
    });
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(duplicated),
    ).toThrow("meeting.participants must have unique ids");
  });

  it("pins the shape-stability fields and the conservative intent default", () => {
    expect(CONSERVATIVE_ORGANIZATION_RECORD_INTENT).toEqual({
      restricted: true,
      reconsider_after: null,
    });
    expect(Object.isFrozen(CONSERVATIVE_ORGANIZATION_RECORD_INTENT)).toBe(true);
    expect(fixture.approval_envelope.intent).toEqual(
      CONSERVATIVE_ORGANIZATION_RECORD_INTENT,
    );

    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        approvalWithPayload((payload) => {
          payload.alternatives = [{ note: "considered" }];
        }),
      ),
    ).toThrow("alternatives must be an empty array in schema version 1");
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        approvalWithPayload((payload) => {
          payload.links = { parent: null, supersedes: "node-1" };
        }),
      ),
    ).toThrow("links must be null in schema version 1");
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        approvalWithPayload((payload) => {
          payload.surface = "Slack Reactions";
        }),
      ),
    ).toThrow("surface must be a canonical surface name");
  });

  it("keeps intent off rejections and bounds the organization-visible reason", () => {
    expect("intent" in fixture.rejection_envelope).toBe(false);
    expect(fixture.rejection_envelope.payload.reconsider_after).toBe(
      "2026-09-01T09:00:00.000Z",
    );
    expect("brief" in fixture.rejection_envelope.payload).toBe(false);

    const withReason = (reason: unknown): unknown => {
      const envelope = structuredClone(fixture.rejection_envelope);
      return {
        ...envelope,
        payload: { ...envelope.payload, reason },
      };
    };
    expect(MAX_ORGANIZATION_RECORD_REJECTION_REASON_BYTES).toBe(2 * 1024);
    expect(
      validateOrganizationRecordRejectionEnvelope(
        withReason("x".repeat(MAX_ORGANIZATION_RECORD_REJECTION_REASON_BYTES)),
      ).payload.reason,
    ).toHaveLength(MAX_ORGANIZATION_RECORD_REJECTION_REASON_BYTES);
    expect(() =>
      validateOrganizationRecordRejectionEnvelope(
        withReason(
          "x".repeat(MAX_ORGANIZATION_RECORD_REJECTION_REASON_BYTES + 1),
        ),
      ),
    ).toThrow("reason must be at most 2048 UTF-8 bytes");
    // Multi-byte characters are bounded by bytes, not by code units.
    expect(() =>
      validateOrganizationRecordRejectionEnvelope(
        withReason("é".repeat(MAX_ORGANIZATION_RECORD_REJECTION_REASON_BYTES)),
      ),
    ).toThrow("reason must be at most 2048 UTF-8 bytes");
    expect(validateOrganizationRecordRejectionEnvelope(withReason(null)).payload.reason).toBeNull();
  });

  it("exempts record documents at exactly 256 KiB without moving the shared default", () => {
    expect(MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES).toBe(16 * 1024);
    expect(MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES).toBe(256 * 1024);

    const atLimit = approvalEnvelopeOfCanonicalSize(
      MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES,
    );
    expect(
      canonicalJsonBytes(validateOrganizationRecordApprovalEnvelope(atLimit))
        .length,
    ).toBe(MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES);
    expect(() =>
      validateOrganizationRecordApprovalEnvelope(
        approvalEnvelopeOfCanonicalSize(
          MAX_ORGANIZATION_RECORD_DOCUMENT_BYTES + 1,
        ),
      ),
    ).toThrow("must be between 1 and 262144 canonical bytes");

    // The exemption is per document: the shared default still binds elsewhere.
    expect(() =>
      canonicalSnapshot(
        { value: "x".repeat(MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES) },
        "oversized organization document",
      ),
    ).toThrow("must be between 1 and 16384 canonical bytes");
    expect(() =>
      validateOrganizationRecordReceipt({
        ...fixture.approval_receipt,
        recorded_at: "x".repeat(MAX_ORGANIZATION_PROTOCOL_DOCUMENT_BYTES),
      }),
    ).toThrow("must be between 1 and 16384 canonical bytes");
  });

  it("generates stable envelope ids in the record namespace", () => {
    const first = organizationRecordEnvelopeId();
    expect(first).toMatch(
      /^rec_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(organizationRecordEnvelopeId()).not.toBe(first);
    expect(() =>
      validateOrganizationRecordApprovalEnvelope({
        ...structuredClone(fixture.approval_envelope),
        envelope_id: "env_00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow("envelope_id must be a canonical rec identifier");
  });

  it("agrees with the shared payload conformance fixture", () => {
    expect(conformance.kind).toBe(
      "echo-organization-record-payload-conformance-fixture",
    );
    expect(conformance.valid.length).toBeGreaterThan(0);
    expect(conformance.invalid.length).toBeGreaterThan(0);
    for (const testCase of conformance.valid) {
      expect(
        validateOrganizationRecordDecisionBrief(testCase.brief),
        testCase.name,
      ).toEqual(testCase.brief as OrganizationRecordDecisionBriefV1);
    }
    for (const testCase of [
      ...conformance.invalid,
      ...conformance.record_only_invalid,
    ]) {
      let thrown: unknown;
      try {
        validateOrganizationRecordDecisionBrief(testCase.brief);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, testCase.name).toBeInstanceOf(
        OrganizationProtocolValidationError,
      );
    }
    // The record-only cases are the deliberate divergence from core, and the
    // core suite asserts the other half: that core still accepts them.
    expect(conformance.record_only_invalid.length).toBeGreaterThan(0);
    for (const testCase of conformance.record_only_invalid) {
      expect(testCase.core_accepts, testCase.name).toBe(true);
    }
  });

  it("carries the approved brief into the envelope unchanged", () => {
    expect(
      validateOrganizationRecordDecisionBrief(
        fixture.approval_envelope.payload.brief,
      ),
    ).toEqual(fixture.approval_envelope.payload.brief);
    expect(
      fixture.approval_envelope.payload.brief.meeting.participants.map(
        (participant) => participant.attendance,
      ),
    ).toEqual(["attended", "no_show"]);
    expect(fixture.approval_envelope.payload.source).toEqual({
      adapter_id: "granola",
      instance_id: "default",
      external_id: "granola-meeting-8871",
    });
  });
});
