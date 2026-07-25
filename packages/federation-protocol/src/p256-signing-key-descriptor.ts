import { Buffer } from "node:buffer";
import { createPublicKey } from "node:crypto";
import type { P256SigningKeyDescriptor } from "./protocol-types.js";
import { p256KeyId } from "./signature-profile.js";
import { federationProtocolValidationFailure } from "./validation-error.js";

/**
 * Verifies the encoding and fingerprint of a public P-256 signing key.
 *
 * This proves only that the descriptor is internally consistent. It does not
 * prove possession of the private key or establish trust in the descriptor.
 */
export function verifyP256SigningKeyDescriptor(
  descriptor: P256SigningKeyDescriptor,
  label = "P-256",
): Buffer {
  if (
    typeof descriptor !== "object" ||
    descriptor === null ||
    Array.isArray(descriptor)
  ) {
    federationProtocolValidationFailure(
      `${label} signing key descriptor must be an object`,
    );
  }
  const actualKeys = Object.keys(descriptor).sort();
  const expectedKeys = ["algorithm", "key_id", "public_key_spki_der_base64"];
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    federationProtocolValidationFailure(
      `${label} signing key descriptor has an unexpected shape`,
    );
  }
  if (descriptor.algorithm !== "ecdsa-p256-sha256-der-low-s") {
    federationProtocolValidationFailure(
      `${label} signing algorithm is unsupported`,
    );
  }
  const encoded = descriptor.public_key_spki_der_base64;
  if (typeof encoded !== "string" || encoded.length > 256) {
    federationProtocolValidationFailure(
      `${label} public key is not canonical base64`,
    );
  }
  const publicKey = Buffer.from(encoded, "base64");
  if (publicKey.length === 0 || publicKey.toString("base64") !== encoded) {
    federationProtocolValidationFailure(
      `${label} public key is not canonical base64`,
    );
  }
  if (p256KeyId(publicKey) !== descriptor.key_id) {
    federationProtocolValidationFailure(
      `${label} key fingerprint does not match its public key`,
    );
  }
  let parsed;
  try {
    parsed = createPublicKey({
      key: publicKey,
      format: "der",
      type: "spki",
    });
  } catch (error) {
    federationProtocolValidationFailure(
      `${label} public key must be P-256 SPKI DER`,
      error,
    );
  }
  if (
    parsed.asymmetricKeyType !== "ec" ||
    parsed.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    federationProtocolValidationFailure(
      `${label} public key must be P-256 SPKI DER`,
    );
  }
  // OpenSSL preserves compressed EC points when it re-exports an imported
  // SPKI. Rebuild through JWK so the comparison is against the one canonical
  // named-curve SPKI encoding: an uncompressed P-256 point. Without this step,
  // the same mathematical key could have two accepted byte encodings and two
  // different key fingerprints.
  const canonicalSpki = createPublicKey({
    key: parsed.export({ format: "jwk" }),
    format: "jwk",
  }).export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(canonicalSpki) || !canonicalSpki.equals(publicKey)) {
    federationProtocolValidationFailure(
      `${label} public key must use canonical P-256 SPKI DER bytes`,
    );
  }
  return Buffer.from(publicKey);
}
