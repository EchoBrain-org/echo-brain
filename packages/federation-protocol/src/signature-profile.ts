import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import type { Sha256Digest } from "./protocol-types.js";

const P256_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);
const P256_HALF_ORDER = P256_ORDER / 2n;

interface DecodedEcdsaSignature {
  r: bigint;
  s: bigint;
}

function readInteger(
  bytes: Buffer,
  offset: number,
): { value: bigint; next: number } {
  if (bytes[offset] !== 0x02)
    throw new Error("ECDSA signature integer tag is invalid");
  const length = bytes[offset + 1];
  if (
    length === undefined ||
    length === 0 ||
    length > 33 ||
    (length & 0x80) !== 0
  ) {
    throw new Error("ECDSA signature integer length is invalid");
  }
  const start = offset + 2;
  const end = start + length;
  if (end > bytes.length)
    throw new Error("ECDSA signature integer is truncated");
  const integer = bytes.subarray(start, end);
  if ((integer[0]! & 0x80) !== 0) {
    throw new Error("ECDSA signature integer must be positive");
  }
  if (integer.length > 1 && integer[0] === 0 && (integer[1]! & 0x80) === 0) {
    throw new Error("ECDSA signature integer is not minimally encoded");
  }
  const magnitude = integer[0] === 0 ? integer.subarray(1) : integer;
  const value =
    magnitude.length === 0 ? 0n : BigInt(`0x${magnitude.toString("hex")}`);
  return { value, next: end };
}

function decodeStrictP256DerSignature(
  signature: Buffer,
): DecodedEcdsaSignature {
  if (signature.length < 8 || signature.length > 72 || signature[0] !== 0x30) {
    throw new Error("ECDSA signature sequence is invalid");
  }
  const length = signature[1];
  if (
    length === undefined ||
    (length & 0x80) !== 0 ||
    length !== signature.length - 2
  ) {
    throw new Error("ECDSA signature sequence length is invalid");
  }
  const r = readInteger(signature, 2);
  const s = readInteger(signature, r.next);
  if (s.next !== signature.length) {
    throw new Error("ECDSA signature has trailing bytes");
  }
  if (
    r.value <= 0n ||
    r.value >= P256_ORDER ||
    s.value <= 0n ||
    s.value >= P256_ORDER
  ) {
    throw new Error("ECDSA signature scalar is outside the P-256 group");
  }
  return { r: r.value, s: s.value };
}

function encodeInteger(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  let magnitude = Buffer.from(hex, "hex");
  if ((magnitude[0]! & 0x80) !== 0)
    magnitude = Buffer.concat([Buffer.from([0]), magnitude]);
  return Buffer.concat([Buffer.from([0x02, magnitude.length]), magnitude]);
}

function encodeP256DerSignature(r: bigint, s: bigint): Buffer {
  if (r <= 0n || r >= P256_ORDER || s <= 0n || s >= P256_ORDER) {
    throw new Error("ECDSA signature scalar is outside the P-256 group");
  }
  const encodedR = encodeInteger(r);
  const encodedS = encodeInteger(s);
  const body = Buffer.concat([encodedR, encodedS]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

export function normalizeP256LowS(signature: Buffer): Buffer {
  const decoded = decodeStrictP256DerSignature(signature);
  const lowS = decoded.s > P256_HALF_ORDER ? P256_ORDER - decoded.s : decoded.s;
  return encodeP256DerSignature(decoded.r, lowS);
}

export function assertP256LowS(signature: Buffer): void {
  const { s } = decodeStrictP256DerSignature(signature);
  if (s > P256_HALF_ORDER)
    throw new Error("ECDSA P-256 signature is not low-S");
}

export function p256KeyId(publicKeySpkiDer: Buffer): Sha256Digest {
  const digest = createHash("sha256").update(publicKeySpkiDer).digest("hex");
  return `sha256:${digest}`;
}

export function verifyP256LowSSignature(
  publicKeySpkiDer: Buffer,
  message: Buffer,
  signature: Buffer,
): boolean {
  assertP256LowS(signature);
  const key = createPublicKey({
    key: publicKeySpkiDer,
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ec") throw new Error("signing key is not EC");
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (curve !== "prime256v1") throw new Error("signing key is not P-256");
  return verify("sha256", message, { key, dsaEncoding: "der" }, signature);
}
