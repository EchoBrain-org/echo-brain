import { readFileSync } from "node:fs";
import { Ajv, type ValidateFunction } from "ajv";
import { describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

interface SchemaDocument extends JsonObject {
  definitions: Record<string, unknown>;
}

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const AUTHORITY_ID = "oau_00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "org_00000000-0000-4000-8000-000000000001";
const PRINCIPAL_ID = "prn_00000000-0000-4000-8000-000000000001";
const MEMBERSHIP_ID = "mem_00000000-0000-4000-8000-000000000001";
const INSTALLATION_ID = "ins_00000000-0000-4000-8000-000000000001";
const ENROLLMENT_ID = "enr_00000000-0000-4000-8000-000000000001";
const PUBLIC_KEY = {
  key_id: DIGEST,
  algorithm: "ecdsa-p256-sha256-der-low-s",
  public_key_spki_der_base64:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9Q==",
} as const;
const INTEGRITY = {
  canonicalization: "RFC8785",
  payload_sha256: OTHER_DIGEST,
  signature_algorithm: "ecdsa-p256-sha256-der-low-s",
  key_id: DIGEST,
  signature_base64: "MEUCIQ==",
} as const;

function readSchema(name: string): SchemaDocument {
  return JSON.parse(
    readFileSync(
      new URL(`../schemas/${name}.v1.schema.json`, import.meta.url),
      "utf8",
    ),
  ) as SchemaDocument;
}

const schemas = {
  descriptor: readSchema("organization-authority-descriptor"),
  request: readSchema("organization-enrollment-request"),
  receipt: readSchema("organization-enrollment-receipt"),
  access: readSchema("organization-installation-access-state"),
};

const ajv = new Ajv({ allErrors: true, strict: true });

const validators = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]),
) as Record<keyof typeof schemas, ValidateFunction>;

const descriptor = {
  schema_version: 1,
  kind: "echo-organization-authority",
  authority_id: AUTHORITY_ID,
  organization_id: ORGANIZATION_ID,
  signing_key: PUBLIC_KEY,
};

const request = {
  schema_version: 1,
  kind: "echo-organization-enrollment-request",
  enrollment_grant_sha256: OTHER_DIGEST,
  authority_id: AUTHORITY_ID,
  authority_key_id: DIGEST,
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  installation_id: INSTALLATION_ID,
  installation_signing_key: PUBLIC_KEY,
  integrity: INTEGRITY,
};

const receipt = {
  schema_version: 1,
  kind: "echo-organization-enrollment-receipt",
  enrollment_id: ENROLLMENT_ID,
  authority_id: AUTHORITY_ID,
  authority_key_id: DIGEST,
  organization_id: ORGANIZATION_ID,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: "employee",
  installation_id: INSTALLATION_ID,
  installation_key_id: DIGEST,
  request_sha256: OTHER_DIGEST,
  enrolled_at: "2026-07-22T00:00:00.000Z",
  integrity: INTEGRITY,
};

const activeAccess = {
  schema_version: 1,
  kind: "echo-organization-installation-access-state",
  authority_id: AUTHORITY_ID,
  authority_key_id: DIGEST,
  organization_id: ORGANIZATION_ID,
  enrollment_id: ENROLLMENT_ID,
  enrollment_receipt_sha256: OTHER_DIGEST,
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: "employee",
  installation_id: INSTALLATION_ID,
  installation_key_id: DIGEST,
  access_state_sequence: 1,
  status: "active",
  revocation_reason: null,
  evaluated_at: "2026-07-22T00:00:00.000Z",
  valid_until: "2026-07-22T00:05:00.000Z",
  integrity: INTEGRITY,
};

function expectInvalid(validate: ValidateFunction, value: unknown): void {
  expect(validate(value), JSON.stringify(validate.errors)).toBe(false);
}

describe("organization protocol JSON Schemas", () => {
  it("compiles and accepts representative stable documents", () => {
    expect(validators.descriptor(descriptor)).toBe(true);
    expect(validators.request(request)).toBe(true);
    expect(validators.receipt(receipt)).toBe(true);
    expect(validators.access(activeAccess)).toBe(true);
    expect(
      validators.access({
        ...activeAccess,
        access_state_sequence: Number.MAX_SAFE_INTEGER,
        status: "revoked",
        revocation_reason: "membership_revoked",
        valid_until: null,
      }),
    ).toBe(true);
  });

  it("rejects unknown, missing, and malformed fields", () => {
    expectInvalid(validators.descriptor, { ...descriptor, extra: true });
    const missingSigningKey = structuredClone(descriptor) as JsonObject;
    delete missingSigningKey["signing_key"];
    expectInvalid(validators.descriptor, missingSigningKey);
    expectInvalid(validators.descriptor, {
      ...descriptor,
      authority_id: AUTHORITY_ID.toUpperCase(),
    });
    expectInvalid(validators.descriptor, {
      ...descriptor,
      signing_key: { ...PUBLIC_KEY, public_key_spki_der_base64: "AQ==" },
    });

    expectInvalid(validators.request, { ...request, extra: true });
    const missingGrant = structuredClone(request) as JsonObject;
    delete missingGrant["enrollment_grant_sha256"];
    expectInvalid(validators.request, missingGrant);
    expectInvalid(validators.request, {
      ...request,
      membership_id: "mem_not-a-uuid",
    });
    expectInvalid(validators.request, {
      ...request,
      enrollment_grant_sha256: `sha256:${"A".repeat(64)}`,
    });
    expectInvalid(validators.request, {
      ...request,
      installation_signing_key: { ...PUBLIC_KEY, extra: true },
    });
    expectInvalid(validators.request, {
      ...request,
      integrity: { ...INTEGRITY, signature_base64: "not base64" },
    });

    expectInvalid(validators.receipt, { ...receipt, extra: true });
    const missingEnrollment = structuredClone(receipt) as JsonObject;
    delete missingEnrollment["enrollment_id"];
    expectInvalid(validators.receipt, missingEnrollment);
    expectInvalid(validators.receipt, {
      ...receipt,
      installation_id: "ins_00000000-0000-3000-8000-000000000001",
    });
    expectInvalid(validators.receipt, {
      ...receipt,
      membership_type: "contractor",
    });
    expectInvalid(validators.receipt, {
      ...receipt,
      enrolled_at: "2026-13-30T00:00:00.000Z",
    });
    expectInvalid(validators.receipt, {
      ...receipt,
      integrity: { ...INTEGRITY, extra: true },
    });

    expectInvalid(validators.access, { ...activeAccess, extra: true });
    const missingSequence = structuredClone(activeAccess) as JsonObject;
    delete missingSequence["access_state_sequence"];
    expectInvalid(validators.access, missingSequence);
    expectInvalid(validators.access, {
      ...activeAccess,
      access_state_sequence: 0,
    });
    expectInvalid(validators.access, {
      ...activeAccess,
      access_state_sequence: Number.MAX_SAFE_INTEGER + 1,
    });
    expectInvalid(validators.access, {
      ...activeAccess,
      membership_type: "contractor",
    });
  });

  it("enforces coherent active and revoked access states", () => {
    expectInvalid(validators.access, {
      ...activeAccess,
      revocation_reason: "membership_revoked",
    });
    expectInvalid(validators.access, { ...activeAccess, valid_until: null });
    expectInvalid(validators.access, {
      ...activeAccess,
      status: "revoked",
      revocation_reason: null,
      valid_until: null,
    });
    expectInvalid(validators.access, {
      ...activeAccess,
      status: "revoked",
      revocation_reason: "installation_revoked",
      valid_until: "2026-07-22T00:05:00.000Z",
    });
    expectInvalid(validators.access, {
      ...activeAccess,
      status: "revoked",
      revocation_reason: "organization_revoked",
      valid_until: null,
    });
  });

  it("keeps shared definitions byte-for-byte aligned", () => {
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

    expectSame("authorityId", ["descriptor", "request", "receipt", "access"]);
    expectSame("organizationId", [
      "descriptor",
      "request",
      "receipt",
      "access",
    ]);
    expectSame("principalId", ["request", "receipt", "access"]);
    expectSame("membershipId", ["request", "receipt", "access"]);
    expectSame("membershipType", ["receipt", "access"]);
    expectSame("installationId", ["request", "receipt", "access"]);
    expectSame("enrollmentId", ["receipt", "access"]);
    expectSame("digest", ["descriptor", "request", "receipt", "access"]);
    expectSame("base64", ["descriptor", "request", "receipt", "access"]);
    expectSame("p256PublicKey", ["descriptor", "request"]);
    expectSame("integrity", ["request", "receipt", "access"]);
    expectSame("timestamp", ["receipt", "access"]);
  });
});
