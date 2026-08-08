import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

interface SchemaDocument extends JsonObject {
  definitions: Record<string, unknown>;
}

interface RecordFixture {
  approval_envelope: JsonObject;
  rejection_envelope: JsonObject;
  approval_receipt: JsonObject;
  rejection_receipt: JsonObject;
}

interface PayloadConformanceFixture {
  valid: { name: string; brief: JsonObject }[];
  invalid: { name: string; brief: JsonObject }[];
}

function readSchema(name: string): SchemaDocument {
  return JSON.parse(
    readFileSync(
      new URL(`../schemas/${name}.v1.schema.json`, import.meta.url),
      "utf8",
    ),
  ) as SchemaDocument;
}

function readFixture<T>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
}

const schemas = {
  envelope: readSchema("organization-record-envelope"),
  receipt: readSchema("organization-record-receipt"),
  enrollmentReceipt: readSchema("organization-enrollment-receipt"),
};

const ajv = new Ajv({ allErrors: true, strict: true });
const validators = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]),
) as Record<keyof typeof schemas, ValidateFunction>;

const fixture = readFixture<RecordFixture>("organization-record-chain.v1.json");
const conformance = readFixture<PayloadConformanceFixture>(
  "organization-record-payload-conformance.v1.json",
);

function expectInvalid(validate: ValidateFunction, value: unknown): void {
  expect(validate(value), JSON.stringify(validate.errors)).toBe(false);
}

function withoutKey(value: JsonObject, key: string): JsonObject {
  const clone = structuredClone(value);
  delete clone[key];
  return clone;
}

function approvalWithBrief(brief: unknown): JsonObject {
  const envelope = structuredClone(fixture.approval_envelope);
  const payload = envelope.payload as JsonObject;
  payload.brief = brief as JsonObject;
  return envelope;
}

describe("organization record JSON Schemas", () => {
  it("accepts the frozen golden documents", () => {
    expect(
      validators.envelope(fixture.approval_envelope),
      JSON.stringify(validators.envelope.errors),
    ).toBe(true);
    expect(
      validators.envelope(fixture.rejection_envelope),
      JSON.stringify(validators.envelope.errors),
    ).toBe(true);
    expect(
      validators.receipt(fixture.approval_receipt),
      JSON.stringify(validators.receipt.errors),
    ).toBe(true);
    expect(
      validators.receipt(fixture.rejection_receipt),
      JSON.stringify(validators.receipt.errors),
    ).toBe(true);
  });

  it("dispatches both event types and refuses the reserved correction type", () => {
    expectInvalid(validators.envelope, {
      ...fixture.approval_envelope,
      event_type: "correction",
    });
    expectInvalid(validators.envelope, {
      ...fixture.rejection_envelope,
      event_type: "correction",
    });
    expectInvalid(validators.receipt, fixture.approval_envelope);
    expectInvalid(validators.envelope, {
      ...fixture.approval_envelope,
      kind: "echo-organization-record-receipt",
    });
  });

  it("rejects unknown, missing, and malformed envelope fields", () => {
    expectInvalid(validators.envelope, {
      ...fixture.approval_envelope,
      extra: true,
    });
    for (const key of [
      "envelope_id",
      "idempotency_key",
      "payload",
      "reviewer",
      "intent",
      "submitter",
      "integrity",
    ]) {
      expectInvalid(validators.envelope, withoutKey(fixture.approval_envelope, key));
    }
    expectInvalid(validators.envelope, {
      ...fixture.approval_envelope,
      envelope_id: "env_00000000-0000-4000-8000-000000000001",
    });
    expectInvalid(validators.envelope, {
      ...fixture.approval_envelope,
      idempotency_key: "A".repeat(64),
    });
    expectInvalid(validators.envelope, withoutKey(fixture.rejection_envelope, "payload"));
    expectInvalid(validators.envelope, {
      ...fixture.rejection_envelope,
      intent: { restricted: true, reconsider_after: null },
    });
  });

  it("requires an allow decision with complete attribution evidence", () => {
    const withEvidence = (patch: JsonObject): JsonObject => {
      const envelope = structuredClone(fixture.approval_envelope);
      const reviewer = envelope.reviewer as JsonObject;
      reviewer.authorization = {
        ...(reviewer.authorization as JsonObject),
        ...patch,
      };
      return envelope;
    };
    expectInvalid(validators.envelope, withEvidence({ allowed: false }));
    expectInvalid(validators.envelope, withEvidence({ principal_id: null }));
    expectInvalid(validators.envelope, withEvidence({ membership_id: null }));
    expectInvalid(validators.envelope, withEvidence({ adapter_binding_id: null }));
    expectInvalid(validators.envelope, withEvidence({ permission_grant_id: null }));
    expectInvalid(
      validators.envelope,
      withEvidence({ kind: "echo-organization-permission-check-decision" }),
    );

    const withoutEvidence = structuredClone(fixture.approval_envelope);
    delete (withoutEvidence.reviewer as JsonObject).authorization;
    expectInvalid(validators.envelope, withoutEvidence);
  });

  it("pins the V1 shape-stability and intent fields", () => {
    const withPayload = (patch: JsonObject): JsonObject => {
      const envelope = structuredClone(fixture.approval_envelope);
      envelope.payload = { ...(envelope.payload as JsonObject), ...patch };
      return envelope;
    };
    expectInvalid(validators.envelope, withPayload({ alternatives: [{}] }));
    expectInvalid(
      validators.envelope,
      withPayload({ links: { parent: null, supersedes: null } }),
    );
    expectInvalid(validators.envelope, withPayload({ surface: "Slack" }));

    const withIntent = (intent: unknown): JsonObject => ({
      ...structuredClone(fixture.approval_envelope),
      intent,
    });
    expectInvalid(validators.envelope, withIntent({ restricted: true }));
    expectInvalid(
      validators.envelope,
      withIntent({ restricted: "yes", reconsider_after: null }),
    );
    // Schema version 1 pins intent to the conservative installation default:
    // no approval surface can set either value, so anything else on the wire
    // would misrepresent approver intent. Both fields stay required so
    // relaxing the pin later changes constants, not shape.
    expectInvalid(
      validators.envelope,
      withIntent({ restricted: false, reconsider_after: null }),
    );
    expectInvalid(
      validators.envelope,
      withIntent({
        restricted: true,
        reconsider_after: "2026-09-01T09:00:00.000Z",
      }),
    );
    expect(
      validators.envelope(withIntent({ restricted: true, reconsider_after: null })),
    ).toBe(true);
  });

  it("pins the allowed action to the envelope's own event type", () => {
    const withAction = (envelope: JsonObject, action: unknown): JsonObject => {
      const clone = structuredClone(envelope);
      const reviewer = clone.reviewer as JsonObject;
      reviewer.authorization = {
        ...(reviewer.authorization as JsonObject),
        action,
      };
      return clone;
    };
    expectInvalid(
      validators.envelope,
      withAction(fixture.approval_envelope, 'reject'),
    );
    expectInvalid(
      validators.envelope,
      withAction(fixture.rejection_envelope, 'approve'),
    );
    expectInvalid(
      validators.envelope,
      withAction(fixture.approval_envelope, 'correction'),
    );
    const withoutAction = structuredClone(fixture.approval_envelope);
    const reviewer = withoutAction.reviewer as JsonObject;
    delete (reviewer.authorization as JsonObject).action;
    expectInvalid(validators.envelope, withoutAction);
  });

  it("rejects a brief whose participant entries are identical", () => {
    const duplicated = structuredClone(fixture.approval_envelope);
    const brief = (duplicated.payload as JsonObject).brief as JsonObject;
    const meeting = brief.meeting as JsonObject;
    const participants = meeting.participants as JsonObject[];
    meeting.participants = [participants[0]!, structuredClone(participants[0]!)];
    expectInvalid(validators.envelope, duplicated);

    // uniqueItems is structural: two entries sharing an id but differing in
    // any other fact still pass the schema, and the runtime validator owns
    // that rule. This asserts the exact limit of the structural check.
    meeting.participants = [
      participants[0]!,
      { ...structuredClone(participants[0]!), display_name: 'Ada F.' },
    ];
    expect(validators.envelope(duplicated)).toBe(true);
  });

  it("bounds the organization-visible rejection reason and keeps briefs out", () => {
    const withPayload = (patch: JsonObject): JsonObject => {
      const envelope = structuredClone(fixture.rejection_envelope);
      envelope.payload = { ...(envelope.payload as JsonObject), ...patch };
      return envelope;
    };
    expect(validators.envelope(withPayload({ reason: null }))).toBe(true);
    expect(validators.envelope(withPayload({ reason: "x".repeat(2048) }))).toBe(
      true,
    );
    expectInvalid(validators.envelope, withPayload({ reason: "x".repeat(2049) }));
    expectInvalid(validators.envelope, withPayload({ reason: "   " }));

    // JSON Schema cannot express a UTF-8 byte count: maxLength counts UTF-16
    // code units. The bound is sound in one direction -- every reason within
    // 2048 bytes is within 2048 code units, so the schema never rejects a
    // valid one -- but it is coarse in the other, and only the runtime
    // validator rejects this 4096-byte reason. The protocol suite asserts the
    // runtime side of exactly this value.
    const multibyte = "é".repeat(2048);
    expect(Buffer.byteLength(multibyte, "utf8")).toBe(4096);
    expect(validators.envelope(withPayload({ reason: multibyte }))).toBe(true);
    expectInvalid(
      validators.envelope,
      withPayload({ brief: { schema_version: 1 } }),
    );
    expectInvalid(
      validators.envelope,
      withPayload({ reconsider_after: "2026-09-01T09:00:00Z" }),
    );
  });

  it("rejects malformed receipts", () => {
    expectInvalid(validators.receipt, {
      ...fixture.approval_receipt,
      extra: true,
    });
    for (const key of [
      "envelope_sha256",
      "record_hash",
      "position",
      "idempotency_key",
      "recorded_at",
    ]) {
      expectInvalid(validators.receipt, withoutKey(fixture.approval_receipt, key));
    }
    expectInvalid(validators.receipt, {
      ...fixture.approval_receipt,
      position: 0,
    });
    expectInvalid(validators.receipt, {
      ...fixture.approval_receipt,
      position: 1.5,
    });
    expectInvalid(validators.receipt, {
      ...fixture.approval_receipt,
      record_hash: `sha256:${"A".repeat(64)}`,
    });
  });

  it("names the log position exactly and restates no signing key", () => {
    expect(Object.keys(fixture.approval_receipt)).toContain("position");
    expect(Object.keys(fixture.approval_receipt)).not.toContain("log_position");
    expect(Object.keys(fixture.approval_receipt)).not.toContain(
      "authority_key_id",
    );
    // The closed schema refuses both the old name and the removed field.
    expectInvalid(validators.receipt, {
      ...withoutKey(fixture.approval_receipt, "position"),
      log_position: 1,
    });
    expectInvalid(validators.receipt, {
      ...fixture.approval_receipt,
      authority_key_id: (fixture.approval_receipt.integrity as JsonObject)
        .key_id,
    });
  });

  it("agrees with the shared payload conformance fixture", () => {
    for (const testCase of conformance.valid) {
      const envelope = approvalWithBrief(testCase.brief);
      expect(
        validators.envelope(envelope),
        `${testCase.name}: ${JSON.stringify(validators.envelope.errors)}`,
      ).toBe(true);
    }
    // Cross-signal and cross-field rules (unique ids, resolvable rationale
    // links, ordered meeting windows) are validator work, not wire shape, and
    // timestamp schemas constrain syntax rather than the real calendar, so the
    // schema is deliberately not expected to reject every negative case.
    const shapeOnlyRejections = conformance.invalid.filter(
      (testCase) => !validators.envelope(approvalWithBrief(testCase.brief)),
    );
    expect(shapeOnlyRejections.length).toBeGreaterThan(0);
    for (const name of [
      "unknown top-level key",
      "unsupported schema version",
      "missing provenance",
      "blank brief id",
      "signal without evidence",
      "confidence above one",
      "decision signal in the actions collection",
      "processor of the wrong adapter kind",
      "participant with an unknown field",
      "provenance timestamp without milliseconds",
    ]) {
      expect(
        shapeOnlyRejections.some((testCase) => testCase.name === name),
        name,
      ).toBe(true);
    }
  });

  it("keeps shared definitions aligned with the stable protocol schemas", () => {
    const expectSame = (
      definition: string,
      schemaNames: readonly (keyof typeof schemas)[],
    ): void => {
      const [first, ...rest] = schemaNames.map(
        (name) => schemas[name].definitions[definition],
      );
      expect(first, definition).toBeDefined();
      for (const candidate of rest) {
        expect(candidate, definition).toEqual(first);
      }
    };

    expectSame("authorityId", [
      "envelope",
      "receipt",
      "enrollmentReceipt",
    ]);
    expectSame("organizationId", [
      "envelope",
      "receipt",
      "enrollmentReceipt",
    ]);
    expectSame("installationId", [
      "envelope",
      "receipt",
      "enrollmentReceipt",
    ]);
    expectSame("digest", [
      "envelope",
      "receipt",
      "enrollmentReceipt",
    ]);
    expectSame("timestamp", [
      "envelope",
      "receipt",
      "enrollmentReceipt",
    ]);
    expectSame("base64", [
      "envelope",
      "receipt",
      "enrollmentReceipt",
    ]);
    expectSame("integrity", [
      "envelope",
      "receipt",
      "enrollmentReceipt",
    ]);
    expectSame("principalId", ["envelope", "enrollmentReceipt"]);
    expectSame("membershipId", ["envelope", "enrollmentReceipt"]);
    expectSame("enrollmentId", ["envelope", "enrollmentReceipt"]);
    expectSame("recordEnvelopeId", ["envelope", "receipt"]);
    expectSame("idempotencyKey", ["envelope", "receipt"]);
  });
});
