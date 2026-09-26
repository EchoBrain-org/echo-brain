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
