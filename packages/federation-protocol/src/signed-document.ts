import { Buffer } from "node:buffer";
import { canonicalJsonBytes, sha256Digest } from "./canonical-json.js";
import type {
  JsonObject,
  Sha256Digest,
  SignedDocument,
  SignedIntegrity,
} from "./protocol-types.js";
import {
  assertP256LowS,
  p256KeyId,
  verifyP256LowSSignature,
} from "./signature-profile.js";

export function signedPayload<T extends SignedDocument>(
  document: T,
): JsonObject {
  const { integrity: _integrity, ...payload } = document;
  return payload as JsonObject;
}

export async function createSignedDocumentWithKey<T extends object>(
  payload: T,
  keyId: Sha256Digest,
  sign: (bytes: Buffer) => Promise<Buffer>,
): Promise<T & { integrity: SignedIntegrity }> {
  const bytes = canonicalJsonBytes(payload);
  // Freeze the exact JSON value before control passes to an async key provider.
  const payloadSnapshot = JSON.parse(bytes.toString("utf8")) as T;
  const payloadDigest = sha256Digest(bytes);
  const signature = await sign(Buffer.from(bytes));
  assertP256LowS(signature);
  return {
    ...payloadSnapshot,
    integrity: {
      canonicalization: "RFC8785",
      payload_sha256: payloadDigest,
      signature_algorithm: "ecdsa-p256-sha256-der-low-s",
      key_id: keyId,
      signature_base64: signature.toString("base64"),
    },
  };
}

export function verifySignedDocument(
  document: SignedDocument,
  publicKeySpkiDer: Buffer,
  expectedKeyId: Sha256Digest,
): void {
  if (document.integrity.canonicalization !== "RFC8785") {
    throw new Error("signed document canonicalization is unsupported");
  }
  if (
    document.integrity.signature_algorithm !== "ecdsa-p256-sha256-der-low-s"
  ) {
    throw new Error("signed document algorithm is unsupported");
  }
  if (document.integrity.key_id !== expectedKeyId) {
    throw new Error(
      "signed document key does not match the active installation",
    );
  }
  if (p256KeyId(publicKeySpkiDer) !== expectedKeyId) {
    throw new Error(
      "signed document public key does not match its expected key id",
    );
  }
  const payload = signedPayload(document);
  const bytes = canonicalJsonBytes(payload);
  if (sha256Digest(bytes) !== document.integrity.payload_sha256) {
    throw new Error("signed document payload digest does not match");
  }
  const signature = Buffer.from(document.integrity.signature_base64, "base64");
  if (
    signature.length === 0 ||
    signature.toString("base64") !== document.integrity.signature_base64
  ) {
    throw new Error("signed document signature is not canonical base64");
  }
  if (!verifyP256LowSSignature(publicKeySpkiDer, bytes, signature)) {
    throw new Error("signed document signature is invalid");
  }
}
