import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { JsonValue, Sha256Digest } from "./protocol-types.js";
import { FederationProtocolValidationError } from "./validation-error.js";

const MAX_CANONICAL_JSON_DEPTH = 128;

export class CanonicalJsonError extends FederationProtocolValidationError {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalJsonError(`${label} contains an unpaired surrogate`);
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CanonicalJsonError(`${label} contains an unpaired surrogate`);
    }
  }
}

function canonicalize(
  value: unknown,
  path: string,
  seen: Set<object>,
  depth: number,
): string {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new CanonicalJsonError(`${path} exceeds the maximum nesting depth`);
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return JSON.stringify(value) as string;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(`${path} must be a finite JSON number`);
    }
    return JSON.stringify(value) as string;
  }
  if (typeof value !== "object") {
    throw new CanonicalJsonError(`${path} is not a JSON value`);
  }
  if (seen.has(value)) {
    throw new CanonicalJsonError(`${path} contains a cycle`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalJsonError(
            `${path}/${index} is a sparse array slot`,
          );
        }
        items.push(
          canonicalize(value[index], `${path}/${index}`, seen, depth + 1),
        );
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalJsonError(`${path} must be a plain JSON object`);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => {
        assertUnicodeScalarString(key, `${path} key`);
        return `${JSON.stringify(key)}:${canonicalize(
          record[key],
          `${path}/${key}`,
          seen,
          depth + 1,
        )}`;
      })
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** RFC 8785 / JSON Canonicalization Scheme bytes for an I-JSON value. */
export function canonicalJson(value: JsonValue | unknown): string {
  return canonicalize(value, "$", new Set<object>(), 0);
}

export function canonicalJsonBytes(value: JsonValue | unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

export function canonicalSha256(value: JsonValue | unknown): Sha256Digest {
  return `sha256:${createHash("sha256").update(canonicalJsonBytes(value)).digest("hex")}`;
}

export function sha256Digest(value: Buffer | string): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Parse bytes that must already be in their one canonical representation. */
export function parseCanonicalJson<T extends JsonValue = JsonValue>(
  raw: string,
): T {
  let parsed: T;
  try {
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    parsed = JSON.parse(withoutBom) as T;
  } catch (error) {
    throw new CanonicalJsonError(`invalid JSON: ${(error as Error).message}`);
  }
  if (canonicalJson(parsed) !== raw) {
    throw new CanonicalJsonError("JSON bytes are not RFC 8785 canonical");
  }
  return parsed;
}
