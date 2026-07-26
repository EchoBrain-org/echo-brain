import type { Buffer } from "node:buffer";
import { assertFederationId } from "./identifiers.js";
import type { InstallationKeyDescriptor } from "./protocol-types.js";
import { verifyP256SigningKeyDescriptor } from "./p256-signing-key-descriptor.js";

/**
 * Validates descriptor syntax, public-key bytes, and protection-field
 * consistency. Protection and assurance values are claims, not attestation.
 */
export function verifyInstallationKeyDescriptor(
  descriptor: InstallationKeyDescriptor,
): Buffer {
  assertFederationId(descriptor.installation_id, "ins", "installation_id");
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
  return verifyP256SigningKeyDescriptor(
    {
      key_id: descriptor.key_id,
      algorithm: descriptor.algorithm,
      public_key_spki_der_base64: descriptor.public_key_spki_der_base64,
    },
    "installation",
  );
}
