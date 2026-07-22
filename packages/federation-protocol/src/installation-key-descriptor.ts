import { Buffer } from "node:buffer";
import { createPublicKey } from "node:crypto";
import { assertFederationId } from "./identifiers.js";
import type { InstallationKeyDescriptor } from "./protocol-types.js";
import { p256KeyId } from "./signature-profile.js";

/**
 * Validates descriptor syntax, public-key bytes, and protection-field
 * consistency. Protection and assurance values are claims, not attestation.
 */
export function verifyInstallationKeyDescriptor(
  descriptor: InstallationKeyDescriptor,
): Buffer {
  assertFederationId(descriptor.installation_id, "ins", "installation_id");
  if (descriptor.algorithm !== "ecdsa-p256-sha256-der-low-s") {
    throw new Error("installation signing algorithm is unsupported");
  }
  const supportedProtection =
    (descriptor.protection === "secure-enclave" &&
      descriptor.assurance === "hardware_bound" &&
      descriptor.private_key_exportable === false) ||
    (descriptor.protection === "keychain-this-device-only" &&
      descriptor.assurance === "platform_key_device_only" &&
      descriptor.private_key_exportable === false) ||
    (descriptor.protection === "development-file" &&
      descriptor.assurance === "software_key_development_only" &&
      descriptor.private_key_exportable === true);
  if (!supportedProtection) {
    throw new Error("installation key protection assurance is inconsistent");
  }
  const publicKey = Buffer.from(
    descriptor.public_key_spki_der_base64,
    "base64",
  );
  if (
    publicKey.length === 0 ||
    publicKey.toString("base64") !== descriptor.public_key_spki_der_base64
  ) {
    throw new Error("installation public key is not canonical base64");
  }
  if (p256KeyId(publicKey) !== descriptor.key_id) {
    throw new Error(
      "installation key fingerprint does not match its public key",
    );
  }
  const parsed = createPublicKey({
    key: publicKey,
    format: "der",
    type: "spki",
  });
  if (
    parsed.asymmetricKeyType !== "ec" ||
    parsed.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("installation public key must be P-256 SPKI DER");
  }
  const canonicalSpki = parsed.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(canonicalSpki) || !canonicalSpki.equals(publicKey)) {
    throw new Error(
      "installation public key must use canonical P-256 SPKI DER bytes",
    );
  }
  return publicKey;
}
