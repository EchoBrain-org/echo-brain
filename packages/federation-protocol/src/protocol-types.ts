export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type Sha256Digest = `sha256:${string}`;

export interface P256SigningKeyDescriptor {
  key_id: Sha256Digest;
  algorithm: "ecdsa-p256-sha256-der-low-s";
  public_key_spki_der_base64: string;
}

export type KeyProtection =
  "secure-enclave" | "keychain-this-device-only" | "development-file";

export type KeyProtectionAssurance =
  | "hardware_bound"
  | "platform_key_device_only"
  | "software_key_development_only";

export interface SignedIntegrity {
  canonicalization: "RFC8785";
  payload_sha256: Sha256Digest;
  signature_algorithm: "ecdsa-p256-sha256-der-low-s";
  key_id: Sha256Digest;
  signature_base64: string;
}

export interface SignedDocument {
  integrity: SignedIntegrity;
}

export interface InstallationKeyDescriptor extends P256SigningKeyDescriptor {
  installation_id: string;
  protection: KeyProtection;
  assurance: KeyProtectionAssurance;
  private_key_exportable: boolean;
}
