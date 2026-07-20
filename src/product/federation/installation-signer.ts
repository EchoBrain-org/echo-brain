import { createPublicKey } from "node:crypto";
import type {
  KeyProtection,
  KeyProtectionAssurance,
  Sha256Digest,
} from "./contracts.js";
import {
  assertP256LowS,
  p256KeyId,
  verifyP256LowSSignature,
} from "./signature-profile.js";

export interface InstallationKeyDescriptor {
  installation_id: string;
  key_id: Sha256Digest;
  algorithm: "ecdsa-p256-sha256-der-low-s";
  public_key_spki_der_base64: string;
  protection: KeyProtection;
  assurance: KeyProtectionAssurance;
  private_key_exportable: false;
}

export interface InstallationSigner {
  generate(installationId: string): Promise<InstallationKeyDescriptor>;
  inspect(installationId: string): Promise<InstallationKeyDescriptor | null>;
  sign(
    installationId: string,
    message: Buffer,
    expectedKeyId?: Sha256Digest,
  ): Promise<Buffer>;
  deleteOrphan?(
    installationId: string,
    expectedKeyId: Sha256Digest,
  ): Promise<boolean>;
}

export function verifyInstallationKeyDescriptor(
  descriptor: InstallationKeyDescriptor,
): Buffer {
  if (descriptor.algorithm !== "ecdsa-p256-sha256-der-low-s") {
    throw new Error("installation signing algorithm is unsupported");
  }
  if (descriptor.private_key_exportable !== false) {
    throw new Error("installation private key must be non-exportable");
  }
  if (
    (descriptor.protection === "secure-enclave" &&
      descriptor.assurance !== "hardware_bound") ||
    (descriptor.protection === "keychain-this-device-only" &&
      descriptor.assurance !== "platform_key_device_only")
  ) {
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

export async function signWithInstallationKey(
  signer: InstallationSigner,
  installationId: string,
  expectedKeyId: Sha256Digest,
  message: Buffer,
): Promise<Buffer> {
  const descriptor = await signer.inspect(installationId);
  if (descriptor === null)
    throw new Error("installation signing key is unavailable");
  if (descriptor.installation_id !== installationId) {
    throw new Error(
      "installation signing key descriptor belongs to a different installation",
    );
  }
  const publicKey = verifyInstallationKeyDescriptor(descriptor);
  if (descriptor.key_id !== expectedKeyId) {
    throw new Error(
      "installation signing key does not match the active identity",
    );
  }
  const verificationMessage = Buffer.from(message);
  const signature = await signer.sign(
    installationId,
    Buffer.from(verificationMessage),
    expectedKeyId,
  );
  assertP256LowS(signature);
  if (!verifyP256LowSSignature(publicKey, verificationMessage, signature)) {
    throw new Error("installation signer returned an invalid signature");
  }
  return signature;
}
