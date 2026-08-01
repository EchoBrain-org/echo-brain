import { createHash } from "node:crypto";

const MAX_CANONICAL_JSON_DEPTH = 128;

export class CanonicalJsonError extends Error {
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

/**
 * RFC 8785 bytes. Keys sort by UTF-16 code unit, which is what a bare `sort()`
 * does; `localeCompare` would order them by the host's ICU locale and silently
 * change every persisted digest when the service moves machine.
 *
 * This mirrors `packages/federation-protocol/src/canonical-json.ts`, which the
 * control plane may not import (`allowed_workspace_packages` is empty). The
 * two copies are cross-checked by
 * `tests/architecture/canonical-json-conformance.test.ts`, which runs the same
 * vectors and the same rejection cases through both and requires byte-identical
 * output and matched refusal messages. Fix a divergence by correcting the copy
 * that is wrong, never by importing the shared implementation here.
 */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, "$", new Set<object>(), 0);
}

export function canonicalSha256(value: unknown): `sha256:${string}` {
  return sha256Digest(canonicalJson(value));
}

/** Hashes the string's own UTF-8 bytes, without JSON quoting. */
export function sha256Digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
