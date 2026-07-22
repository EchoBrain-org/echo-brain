import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertFederationId as promotedAssertFederationId,
  assertP256LowS as promotedAssertP256LowS,
  assertUtcMillisecondTimestamp as promotedAssertTimestamp,
  canonicalJson as promotedCanonicalJson,
  canonicalJsonBytes as promotedCanonicalJsonBytes,
  canonicalSha256 as promotedCanonicalSha256,
  createSignedDocumentWithKey as promotedCreateSignedDocument,
  normalizeP256LowS as promotedNormalizeP256LowS,
  p256KeyId as promotedKeyId,
  parseCanonicalJson as promotedParseCanonicalJson,
  sha256Digest as promotedSha256Digest,
  signedPayload as promotedSignedPayload,
  verifyInstallationKeyDescriptor as promotedVerifyDescriptor,
  verifyP256LowSSignature as promotedVerifySignature,
  verifySignedDocument as promotedVerifyDocument,
} from "../../packages/federation-protocol/src/index.js";
import type {
  InstallationKeyDescriptor as PromotedDescriptor,
  Sha256Digest as PromotedDigest,
  SignedDocument as PromotedSignedDocument,
} from "../../packages/federation-protocol/src/index.js";
import {
  canonicalJson as productCanonicalJson,
  canonicalJsonBytes as productCanonicalJsonBytes,
  canonicalSha256 as productCanonicalSha256,
  parseCanonicalJson as productParseCanonicalJson,
  sha256Digest as productSha256Digest,
} from "../../src/product/federation/foundation/canonical-json.js";
import {
  assertFederationId as productAssertFederationId,
  assertUtcMillisecondTimestamp as productAssertTimestamp,
} from "../../src/product/federation/foundation/identifiers.js";
import { verifyInstallationKeyDescriptor as productVerifyDescriptor } from "../../src/product/federation/foundation/installation-signer.js";
import type { InstallationKeyDescriptor as ProductDescriptor } from "../../src/product/federation/foundation/installation-signer.js";
import {
  assertP256LowS as productAssertP256LowS,
  normalizeP256LowS as productNormalizeP256LowS,
  p256KeyId as productKeyId,
  verifyP256LowSSignature as productVerifySignature,
} from "../../src/product/federation/foundation/signature-profile.js";
import {
  createSignedDocumentWithKey as productCreateSignedDocument,
  signedPayload as productSignedPayload,
  verifySignedDocument as productVerifyDocument,
} from "../../src/product/federation/foundation/signed-document.js";
import type {
  Sha256Digest as ProductDigest,
  SignedDocument as ProductSignedDocument,
} from "../../src/product/federation/contracts.js";

interface CompatibilityFixture {
  payload: Record<string, unknown>;
  canonical_payload: string;
  canonical_payload_sha256: PromotedDigest;
  public_key_spki_der_base64: string;
  key_id: PromotedDigest;
  signature_der_base64: string;
  high_s_signature_der_base64: string;
  alternate_p256_key_vector: {
    public_key_spki_der_base64: string;
    key_id: PromotedDigest;
    signature_der_base64: string;
  };
  non_p256_key_vector: {
    public_key_spki_der_base64: string;
    key_id: PromotedDigest;
  };
  installation_key_descriptor: PromotedDescriptor;
  signed_document: PromotedSignedDocument & Record<string, unknown>;
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../packages/federation-protocol/fixtures/signed-document-p256-rfc8785.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as CompatibilityFixture;
const publicKey = Buffer.from(fixture.public_key_spki_der_base64, "base64");
const lowS = Buffer.from(fixture.signature_der_base64, "base64");
const highS = Buffer.from(fixture.high_s_signature_der_base64, "base64");
const invalidLowS = Buffer.from(lowS);
invalidLowS[invalidLowS.length - 1] =
  invalidLowS[invalidLowS.length - 1]! ^ 0x01;
const alternatePublicKey = Buffer.from(
  fixture.alternate_p256_key_vector.public_key_spki_der_base64,
  "base64",
);

function accepts(operation: () => unknown): boolean {
  try {
    operation();
    return true;
  } catch {
    return false;
  }
}

function booleanOutcome(
  operation: () => boolean,
): { kind: "returned"; value: boolean } | { kind: "threw" } {
  try {
    return { kind: "returned", value: operation() };
  } catch {
    return { kind: "threw" };
  }
}

function documentWithIntegrity(
  patch: Record<string, unknown>,
): PromotedSignedDocument {
  return {
    ...structuredClone(fixture.signed_document),
    integrity: {
      ...fixture.signed_document.integrity,
      ...patch,
    },
  } as PromotedSignedDocument;
}

describe("promoted federation protocol compatibility", () => {
  it("preserves canonical bytes, hashes, and canonical parsing", () => {
    expect(promotedCanonicalJson(fixture.payload)).toBe(
      productCanonicalJson(fixture.payload),
    );
    expect(promotedCanonicalJsonBytes(fixture.payload)).toEqual(
      productCanonicalJsonBytes(fixture.payload),
    );
    expect(promotedCanonicalSha256(fixture.payload)).toBe(
      productCanonicalSha256(fixture.payload),
    );
    expect(promotedSha256Digest(Buffer.from("echo"))).toBe(
      productSha256Digest(Buffer.from("echo")),
    );
    expect(promotedParseCanonicalJson(fixture.canonical_payload)).toEqual(
      productParseCanonicalJson(fixture.canonical_payload),
    );

    const sparse: unknown[] = [];
    sparse[2] = true;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const invalidValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      new Date("2026-07-21T00:00:00.000Z"),
      sparse,
      cyclic,
      "\ud800",
    ];
    for (const value of invalidValues) {
      expect(accepts(() => promotedCanonicalJson(value))).toBe(
        accepts(() => productCanonicalJson(value)),
      );
    }

    for (const raw of [
      fixture.canonical_payload,
      JSON.stringify(fixture.payload),
      `${fixture.canonical_payload}\n`,
      `\uFEFF${fixture.canonical_payload}`,
      '{"a":1,"a":1}',
      fixture.canonical_payload.replace('"unicode":"€"', '"unicode":"\\u20ac"'),
      '{"number":1.0}',
      "{",
    ]) {
      expect(accepts(() => promotedParseCanonicalJson(raw))).toBe(
        accepts(() => productParseCanonicalJson(raw)),
      );
    }
  });

  it("preserves identifier and timestamp acceptance", () => {
    const ids = [
      "ins_00000000-0000-4000-8000-000000000001",
      "dev_00000000-0000-4000-8000-000000000001",
      "ins_00000000-0000-1000-8000-000000000001",
      "ins_00000000-0000-4000-7000-000000000001",
      "INS_00000000-0000-4000-8000-000000000001",
    ];
    for (const id of ids) {
      expect(
        accepts(() => promotedAssertFederationId(id, "ins", "installation_id")),
      ).toBe(
        accepts(() => productAssertFederationId(id, "ins", "installation_id")),
      );
    }

    const timestamps = [
      "2024-02-29T23:59:59.999Z",
      "2023-02-29T00:00:00.000Z",
      "2026-07-21T00:00:00.000Z",
      "2026-07-21T24:00:00.000Z",
      "2026-07-21T00:00:00Z",
      "2026-07-21T00:00:00.000+00:00",
    ];
    for (const timestamp of timestamps) {
      expect(
        accepts(() => promotedAssertTimestamp(timestamp, "issued_at")),
      ).toBe(accepts(() => productAssertTimestamp(timestamp, "issued_at")));
    }
  });

  it("preserves the key fingerprint and strict DER low-S profile", () => {
    expect(promotedKeyId(publicKey)).toBe(productKeyId(publicKey));
    expect(promotedNormalizeP256LowS(lowS)).toEqual(
      productNormalizeP256LowS(lowS),
    );
    expect(promotedNormalizeP256LowS(highS)).toEqual(
      productNormalizeP256LowS(highS),
    );

    for (const signature of [
      lowS,
      invalidLowS,
      highS,
      Buffer.from([0x30, 0x00]),
      Buffer.concat([lowS, Buffer.from([0])]),
    ]) {
      expect(accepts(() => promotedAssertP256LowS(signature))).toBe(
        accepts(() => productAssertP256LowS(signature)),
      );
      expect(accepts(() => promotedNormalizeP256LowS(signature))).toBe(
        accepts(() => productNormalizeP256LowS(signature)),
      );
      expect(
        booleanOutcome(() =>
          promotedVerifySignature(
            publicKey,
            Buffer.from(fixture.canonical_payload, "utf8"),
            signature,
          ),
        ),
      ).toEqual(
        booleanOutcome(() =>
          productVerifySignature(
            publicKey,
            Buffer.from(fixture.canonical_payload, "utf8"),
            signature,
          ),
        ),
      );
    }

    expect(
      promotedVerifySignature(
        publicKey,
        Buffer.from(fixture.canonical_payload, "utf8"),
        lowS,
      ),
    ).toBe(
      productVerifySignature(
        publicKey,
        Buffer.from(fixture.canonical_payload, "utf8"),
        lowS,
      ),
    );
    expect(
      promotedVerifySignature(
        publicKey,
        Buffer.from(fixture.canonical_payload, "utf8"),
        invalidLowS,
      ),
    ).toBe(false);
    expect(
      productVerifySignature(
        publicKey,
        Buffer.from(fixture.canonical_payload, "utf8"),
        invalidLowS,
      ),
    ).toBe(false);
  });

  it("preserves descriptor and signed-document verification behavior", () => {
    const publicKeyWithTrailingByte = Buffer.concat([
      publicKey,
      Buffer.from([0]),
    ]);
    const descriptorVariants = [
      fixture.installation_key_descriptor,
      { ...fixture.installation_key_descriptor, private_key_exportable: false },
      {
        ...fixture.installation_key_descriptor,
        installation_id: "installation-1",
      },
      {
        ...fixture.installation_key_descriptor,
        algorithm: "not-supported",
      },
      {
        ...fixture.installation_key_descriptor,
        key_id: `sha256:${"0".repeat(64)}`,
      },
      {
        ...fixture.installation_key_descriptor,
        public_key_spki_der_base64: `${fixture.public_key_spki_der_base64}\n`,
      },
      {
        ...fixture.installation_key_descriptor,
        key_id: promotedKeyId(publicKeyWithTrailingByte),
        public_key_spki_der_base64:
          publicKeyWithTrailingByte.toString("base64"),
      },
      {
        ...fixture.installation_key_descriptor,
        key_id: fixture.non_p256_key_vector.key_id,
        public_key_spki_der_base64:
          fixture.non_p256_key_vector.public_key_spki_der_base64,
      },
    ];
    for (const descriptor of descriptorVariants) {
      expect(
        accepts(() =>
          promotedVerifyDescriptor(descriptor as PromotedDescriptor),
        ),
      ).toBe(
        accepts(() => productVerifyDescriptor(descriptor as ProductDescriptor)),
      );
    }
    expect(
      promotedVerifyDescriptor(fixture.installation_key_descriptor),
    ).toEqual(
      productVerifyDescriptor(
        fixture.installation_key_descriptor as ProductDescriptor,
      ),
    );

    const tampered = structuredClone(fixture.signed_document);
    tampered.fixture_id = "evt_00000000-0000-4000-8000-000000000002";
    const tamperedWithMatchingDigest = structuredClone(tampered);
    tamperedWithMatchingDigest.integrity.payload_sha256 =
      promotedCanonicalSha256(
        promotedSignedPayload(tamperedWithMatchingDigest),
      );
    const documents = [
      fixture.signed_document,
      tampered,
      tamperedWithMatchingDigest,
      documentWithIntegrity({ canonicalization: "not-supported" }),
      documentWithIntegrity({ signature_algorithm: "not-supported" }),
      documentWithIntegrity({
        signature_base64: `${fixture.signature_der_base64}\n`,
      }),
      documentWithIntegrity({
        signature_base64: fixture.high_s_signature_der_base64,
      }),
      documentWithIntegrity({
        signature_base64: invalidLowS.toString("base64"),
      }),
    ];
    for (const document of documents) {
      expect(
        accepts(() =>
          promotedVerifyDocument(document, publicKey, fixture.key_id),
        ),
      ).toBe(
        accepts(() =>
          productVerifyDocument(
            document as ProductSignedDocument,
            publicKey,
            fixture.key_id as ProductDigest,
          ),
        ),
      );
      expect(promotedSignedPayload(document)).toEqual(
        productSignedPayload(document as ProductSignedDocument),
      );
    }

    expect(
      accepts(() =>
        promotedVerifyDocument(
          tamperedWithMatchingDigest,
          publicKey,
          fixture.key_id,
        ),
      ),
    ).toBe(false);
    expect(
      accepts(() =>
        productVerifyDocument(
          tamperedWithMatchingDigest as ProductSignedDocument,
          publicKey,
          fixture.key_id as ProductDigest,
        ),
      ),
    ).toBe(false);

    const forgedKeyBinding = documentWithIntegrity({
      signature_base64: fixture.alternate_p256_key_vector.signature_der_base64,
    });
    expect(
      promotedVerifySignature(
        alternatePublicKey,
        Buffer.from(fixture.canonical_payload, "utf8"),
        Buffer.from(
          fixture.alternate_p256_key_vector.signature_der_base64,
          "base64",
        ),
      ),
    ).toBe(true);
    expect(
      accepts(() =>
        promotedVerifyDocument(
          forgedKeyBinding,
          alternatePublicKey,
          fixture.key_id,
        ),
      ),
    ).toBe(false);
    expect(
      accepts(() =>
        productVerifyDocument(
          forgedKeyBinding as ProductSignedDocument,
          alternatePublicKey,
          fixture.key_id as ProductDigest,
        ),
      ),
    ).toBe(false);
  });

  it("preserves deterministic signed-document construction", async () => {
    const promoted = await promotedCreateSignedDocument(
      fixture.payload,
      fixture.key_id,
      async (bytes) => {
        expect(bytes).toEqual(Buffer.from(fixture.canonical_payload, "utf8"));
        return Buffer.from(lowS);
      },
    );
    const product = await productCreateSignedDocument(
      fixture.payload,
      fixture.key_id as ProductDigest,
      async (bytes) => {
        expect(bytes).toEqual(Buffer.from(fixture.canonical_payload, "utf8"));
        return Buffer.from(lowS);
      },
    );

    expect(promoted).toEqual(product);
    expect(promoted).toEqual(fixture.signed_document);

    const promotedMutablePayload = structuredClone(fixture.payload);
    const productMutablePayload = structuredClone(fixture.payload);
    const promotedSnapshot = await promotedCreateSignedDocument(
      promotedMutablePayload,
      fixture.key_id,
      async () => {
        promotedMutablePayload.fixture_id =
          "evt_00000000-0000-4000-8000-000000000002";
        return Buffer.from(lowS);
      },
    );
    const productSnapshot = await productCreateSignedDocument(
      productMutablePayload,
      fixture.key_id as ProductDigest,
      async () => {
        productMutablePayload.fixture_id =
          "evt_00000000-0000-4000-8000-000000000002";
        return Buffer.from(lowS);
      },
    );

    expect(promotedSnapshot).toEqual(productSnapshot);
    expect(promotedSnapshot).toEqual(fixture.signed_document);
  });
});
