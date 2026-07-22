import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";
import {
  CanonicalJsonError,
  assertFederationId,
  assertP256LowS,
  assertUtcMillisecondTimestamp,
  canonicalJson,
  canonicalJsonBytes,
  canonicalSha256,
  createSignedDocumentWithKey,
  federationId,
  normalizeP256LowS,
  p256KeyId,
  parseCanonicalJson,
  sha256Digest,
  signedPayload,
  verifyInstallationKeyDescriptor,
  verifyP256LowSSignature,
  verifySignedDocument,
} from "../src/index.js";
import type {
  InstallationKeyDescriptor,
  Sha256Digest,
  SignedDocument,
} from "../src/index.js";

interface GoldenFixture {
  fixture_version: number;
  kind: string;
  payload: Record<string, unknown>;
  canonical_payload: string;
  canonical_payload_utf8_base64: string;
  canonical_payload_sha256: Sha256Digest;
  public_key_spki_der_base64: string;
  key_id: Sha256Digest;
  signature_der_base64: string;
  signature_der_hex: string;
  high_s_signature_der_base64: string;
  alternate_p256_key_vector: {
    public_key_spki_der_base64: string;
    key_id: Sha256Digest;
    signature_der_base64: string;
  };
  non_p256_key_vector: {
    public_key_spki_der_base64: string;
    key_id: Sha256Digest;
  };
  installation_key_descriptor: InstallationKeyDescriptor;
  signed_document: SignedDocument & Record<string, unknown>;
  canonical_signed_document_utf8_base64: string;
  canonical_signed_document_sha256: Sha256Digest;
  utf16_property_order: {
    value: Record<string, string>;
    canonical: string;
    canonical_utf8_base64: string;
    sha256: Sha256Digest;
  };
}

const fixturePath = new URL(
  "../fixtures/signed-document-p256-rfc8785.v1.json",
  import.meta.url,
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as GoldenFixture;
const publicKey = Buffer.from(fixture.public_key_spki_der_base64, "base64");
const lowSSignature = Buffer.from(fixture.signature_der_base64, "base64");
const highSSignature = Buffer.from(
  fixture.high_s_signature_der_base64,
  "base64",
);
const invalidLowSSignature = Buffer.from(lowSSignature);
invalidLowSSignature[invalidLowSSignature.length - 1] =
  invalidLowSSignature[invalidLowSSignature.length - 1]! ^ 0x01;
const alternatePublicKey = Buffer.from(
  fixture.alternate_p256_key_vector.public_key_spki_der_base64,
  "base64",
);
const alternateSignature = Buffer.from(
  fixture.alternate_p256_key_vector.signature_der_base64,
  "base64",
);

function signedDocumentWithIntegrity(
  patch: Record<string, unknown>,
): SignedDocument {
  return {
    ...structuredClone(fixture.signed_document),
    integrity: {
      ...fixture.signed_document.integrity,
      ...patch,
    },
  } as SignedDocument;
}

describe("federation protocol golden fixture", () => {
  it("fixes canonical payload bytes and digests byte-for-byte", () => {
    const bytes = canonicalJsonBytes(fixture.payload);

    expect(fixture.fixture_version).toBe(1);
    expect(canonicalJson(fixture.payload)).toBe(fixture.canonical_payload);
    expect(bytes.toString("base64")).toBe(
      fixture.canonical_payload_utf8_base64,
    );
    expect(canonicalSha256(fixture.payload)).toBe(
      fixture.canonical_payload_sha256,
    );
    expect(sha256Digest(bytes)).toBe(fixture.canonical_payload_sha256);
    expect(parseCanonicalJson(fixture.canonical_payload)).toEqual(
      fixture.payload,
    );
  });

  it("uses RFC 8785 UTF-16 property ordering", () => {
    const canonical = canonicalJson(fixture.utf16_property_order.value);

    expect(canonical).toBe(fixture.utf16_property_order.canonical);
    expect(Buffer.from(canonical, "utf8").toString("base64")).toBe(
      fixture.utf16_property_order.canonical_utf8_base64,
    );
    expect(canonicalSha256(fixture.utf16_property_order.value)).toBe(
      fixture.utf16_property_order.sha256,
    );
  });

  it("fixes the P-256 key ID, DER encoding, and low-S profile", () => {
    expect(p256KeyId(publicKey)).toBe(fixture.key_id);
    expect(lowSSignature.toString("hex")).toBe(fixture.signature_der_hex);
    expect(() => assertP256LowS(lowSSignature)).not.toThrow();
    expect(() => assertP256LowS(highSSignature)).toThrow(
      "ECDSA P-256 signature is not low-S",
    );
    expect(normalizeP256LowS(highSSignature)).toEqual(lowSSignature);
    expect(
      verifyP256LowSSignature(
        publicKey,
        Buffer.from(fixture.canonical_payload, "utf8"),
        lowSSignature,
      ),
    ).toBe(true);
    expect(() => assertP256LowS(invalidLowSSignature)).not.toThrow();
    expect(
      verifyP256LowSSignature(
        publicKey,
        Buffer.from(fixture.canonical_payload, "utf8"),
        invalidLowSSignature,
      ),
    ).toBe(false);
    expect(p256KeyId(alternatePublicKey)).toBe(
      fixture.alternate_p256_key_vector.key_id,
    );
    expect(
      verifyP256LowSSignature(
        alternatePublicKey,
        Buffer.from(fixture.canonical_payload, "utf8"),
        alternateSignature,
      ),
    ).toBe(true);
  });

  it("verifies the public installation-key descriptor", () => {
    expect(
      verifyInstallationKeyDescriptor(fixture.installation_key_descriptor),
    ).toEqual(publicKey);
  });

  it("replays deterministic signing over the exact canonical bytes", async () => {
    const document = await createSignedDocumentWithKey(
      fixture.payload,
      fixture.key_id,
      async (bytes) => {
        expect(bytes.toString("base64")).toBe(
          fixture.canonical_payload_utf8_base64,
        );
        return Buffer.from(lowSSignature);
      },
    );

    expect(document).toEqual(fixture.signed_document);
    expect(canonicalJsonBytes(document).toString("base64")).toBe(
      fixture.canonical_signed_document_utf8_base64,
    );
    expect(canonicalSha256(document)).toBe(
      fixture.canonical_signed_document_sha256,
    );
    expect(signedPayload(document)).toEqual(fixture.payload);
    expect(() =>
      verifySignedDocument(document, publicKey, fixture.key_id),
    ).not.toThrow();
  });

  it("snapshots the payload before awaiting the signing provider", async () => {
    const mutablePayload = structuredClone(fixture.payload);
    const document = await createSignedDocumentWithKey(
      mutablePayload,
      fixture.key_id,
      async () => {
        mutablePayload.fixture_id = "evt_00000000-0000-4000-8000-000000000002";
        return Buffer.from(lowSSignature);
      },
    );

    expect(signedPayload(document)).toEqual(fixture.payload);
    expect(() =>
      verifySignedDocument(document, publicKey, fixture.key_id),
    ).not.toThrow();
  });

  it("keeps strict canonical JSON rejection behavior", () => {
    const sparse: unknown[] = [];
    sparse[1] = "value";
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => parseCanonicalJson(JSON.stringify(fixture.payload))).toThrow(
      CanonicalJsonError,
    );
    expect(() => parseCanonicalJson(`${fixture.canonical_payload}\n`)).toThrow(
      CanonicalJsonError,
    );
    expect(() =>
      parseCanonicalJson(`\uFEFF${fixture.canonical_payload}`),
    ).toThrow(CanonicalJsonError);
    expect(() => parseCanonicalJson('{"a":1,"a":1}')).toThrow(
      CanonicalJsonError,
    );
    expect(() =>
      parseCanonicalJson(
        fixture.canonical_payload.replace(
          '"unicode":"€"',
          '"unicode":"\\u20ac"',
        ),
      ),
    ).toThrow(CanonicalJsonError);
    expect(() => parseCanonicalJson('{"number":1.0}')).toThrow(
      CanonicalJsonError,
    );
    for (const invalid of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      new Date("2026-07-21T00:00:00.000Z"),
      sparse,
      cyclic,
      "\ud800",
    ]) {
      expect(() => canonicalJson(invalid)).toThrow(CanonicalJsonError);
    }
  });

  it("rejects signature, key, descriptor, and document mutations", () => {
    const malformedDerSignatures = [
      Buffer.from([0x30, 0x00]),
      Buffer.concat([lowSSignature, Buffer.from([0])]),
      Buffer.from(
        "3046022100dc19e6eec6521dd87bb508e4061c4078f1cadd931aefb43d5865576faf7429bb022100442fea3ab33a589ee11d00d5026612c7339ec62388a5f734bab3e174a4e576e9",
        "hex",
      ),
      Buffer.from("3006020100020101", "hex"),
      Buffer.from(
        "3026022100ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551020101",
        "hex",
      ),
    ];
    for (const signature of malformedDerSignatures) {
      expect(() => normalizeP256LowS(signature)).toThrow();
    }
    expect(() =>
      verifyP256LowSSignature(
        publicKey,
        Buffer.from(fixture.canonical_payload, "utf8"),
        highSSignature,
      ),
    ).toThrow("ECDSA P-256 signature is not low-S");
    expect(() =>
      verifyP256LowSSignature(
        Buffer.from("not-spki"),
        Buffer.from("x"),
        lowSSignature,
      ),
    ).toThrow();

    expect(() =>
      verifyInstallationKeyDescriptor({
        ...fixture.installation_key_descriptor,
        private_key_exportable: false,
      }),
    ).toThrow("installation key protection assurance is inconsistent");
    expect(() =>
      verifyInstallationKeyDescriptor({
        ...fixture.installation_key_descriptor,
        key_id: `sha256:${"0".repeat(64)}`,
      }),
    ).toThrow("installation key fingerprint does not match its public key");
    expect(() =>
      verifyInstallationKeyDescriptor({
        ...fixture.installation_key_descriptor,
        installation_id: "installation-1",
      }),
    ).toThrow("installation_id must be a canonical ins identifier");
    expect(() =>
      verifyInstallationKeyDescriptor({
        ...fixture.installation_key_descriptor,
        algorithm: "not-supported",
      } as unknown as InstallationKeyDescriptor),
    ).toThrow("installation signing algorithm is unsupported");
    expect(() =>
      verifyInstallationKeyDescriptor({
        ...fixture.installation_key_descriptor,
        public_key_spki_der_base64: `${fixture.public_key_spki_der_base64}\n`,
      }),
    ).toThrow("installation public key is not canonical base64");

    const publicKeyWithTrailingByte = Buffer.concat([
      publicKey,
      Buffer.from([0]),
    ]);
    expect(() =>
      verifyInstallationKeyDescriptor({
        ...fixture.installation_key_descriptor,
        key_id: p256KeyId(publicKeyWithTrailingByte),
        public_key_spki_der_base64:
          publicKeyWithTrailingByte.toString("base64"),
      }),
    ).toThrow(
      "installation public key must use canonical P-256 SPKI DER bytes",
    );
    expect(() =>
      verifyInstallationKeyDescriptor({
        ...fixture.installation_key_descriptor,
        key_id: fixture.non_p256_key_vector.key_id,
        public_key_spki_der_base64:
          fixture.non_p256_key_vector.public_key_spki_der_base64,
      }),
    ).toThrow("installation public key must be P-256 SPKI DER");

    const tampered = structuredClone(fixture.signed_document);
    tampered.fixture_id = "evt_00000000-0000-4000-8000-000000000002";
    expect(() =>
      verifySignedDocument(tampered, publicKey, fixture.key_id),
    ).toThrow("signed document payload digest does not match");
    expect(() =>
      verifySignedDocument(
        fixture.signed_document,
        publicKey,
        `sha256:${"0".repeat(64)}`,
      ),
    ).toThrow("signed document key does not match the active installation");
    expect(() =>
      verifySignedDocument(
        signedDocumentWithIntegrity({ canonicalization: "not-supported" }),
        publicKey,
        fixture.key_id,
      ),
    ).toThrow("signed document canonicalization is unsupported");
    expect(() =>
      verifySignedDocument(
        signedDocumentWithIntegrity({ signature_algorithm: "not-supported" }),
        publicKey,
        fixture.key_id,
      ),
    ).toThrow("signed document algorithm is unsupported");
    expect(() =>
      verifySignedDocument(
        signedDocumentWithIntegrity({
          signature_base64: `${fixture.signature_der_base64}\n`,
        }),
        publicKey,
        fixture.key_id,
      ),
    ).toThrow("signed document signature is not canonical base64");
    expect(() =>
      verifySignedDocument(
        signedDocumentWithIntegrity({
          signature_base64: fixture.high_s_signature_der_base64,
        }),
        publicKey,
        fixture.key_id,
      ),
    ).toThrow("ECDSA P-256 signature is not low-S");

    expect(() =>
      verifySignedDocument(
        signedDocumentWithIntegrity({
          signature_base64: invalidLowSSignature.toString("base64"),
        }),
        publicKey,
        fixture.key_id,
      ),
    ).toThrow("signed document signature is invalid");

    const tamperedWithMatchingDigest = structuredClone(fixture.signed_document);
    tamperedWithMatchingDigest.fixture_id =
      "evt_00000000-0000-4000-8000-000000000002";
    tamperedWithMatchingDigest.integrity.payload_sha256 = canonicalSha256(
      signedPayload(tamperedWithMatchingDigest),
    );
    expect(() =>
      verifySignedDocument(
        tamperedWithMatchingDigest,
        publicKey,
        fixture.key_id,
      ),
    ).toThrow("signed document signature is invalid");

    const alternateKeyDocument = signedDocumentWithIntegrity({
      key_id: fixture.alternate_p256_key_vector.key_id,
      signature_base64: fixture.alternate_p256_key_vector.signature_der_base64,
    });
    expect(() =>
      verifySignedDocument(
        alternateKeyDocument,
        alternatePublicKey,
        fixture.alternate_p256_key_vector.key_id,
      ),
    ).not.toThrow();
    const forgedKeyBinding = signedDocumentWithIntegrity({
      signature_base64: fixture.alternate_p256_key_vector.signature_der_base64,
    });
    expect(() =>
      verifySignedDocument(
        forgedKeyBinding,
        alternatePublicKey,
        fixture.key_id,
      ),
    ).toThrow("signed document public key does not match its expected key id");
  });

  it("validates canonical IDs and real UTC millisecond timestamps", () => {
    const generated = federationId("ins");
    expect(() =>
      assertFederationId(generated, "ins", "installation_id"),
    ).not.toThrow();
    expect(() =>
      assertFederationId(
        "ins_00000000-0000-4000-8000-000000000001",
        "ins",
        "installation_id",
      ),
    ).not.toThrow();
    expect(() =>
      assertFederationId(
        "ins_00000000-0000-1000-8000-000000000001",
        "ins",
        "installation_id",
      ),
    ).toThrow("installation_id must be a canonical ins identifier");

    for (const timestamp of [
      "2024-02-29T23:59:59.999Z",
      "2026-07-21T00:00:00.000Z",
    ]) {
      expect(() =>
        assertUtcMillisecondTimestamp(timestamp, "issued_at"),
      ).not.toThrow();
    }
    for (const timestamp of [
      "2023-02-29T00:00:00.000Z",
      "2026-13-01T00:00:00.000Z",
      "2026-07-21T00:00:00Z",
      "2026-07-21T00:00:00.000+00:00",
    ]) {
      expect(() =>
        assertUtcMillisecondTimestamp(timestamp, "issued_at"),
      ).toThrow();
    }
  });

  it("exposes only the intended protocol surface", () => {
    expect(Object.keys(protocol).sort()).toEqual([
      "CanonicalJsonError",
      "assertFederationId",
      "assertP256LowS",
      "assertUtcMillisecondTimestamp",
      "canonicalJson",
      "canonicalJsonBytes",
      "canonicalSha256",
      "createSignedDocumentWithKey",
      "federationId",
      "normalizeP256LowS",
      "p256KeyId",
      "parseCanonicalJson",
      "sha256Digest",
      "signedPayload",
      "verifyInstallationKeyDescriptor",
      "verifyP256LowSSignature",
      "verifySignedDocument",
    ]);
  });
});
