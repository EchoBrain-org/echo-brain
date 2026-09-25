import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Fixture-only serialization used to make expected persisted bytes explicit.
 * Production canonicalizers deliberately remain independent implementations.
 */
export function canonicalJsonForTest(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonForTest).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonForTest(record[key])}`)
    .join(",")}}`;
}

export function sha256FileForTest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
