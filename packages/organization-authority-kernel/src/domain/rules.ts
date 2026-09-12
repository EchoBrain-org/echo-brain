import { assertUtcMillisecondTimestamp } from "@echo-brain/federation-protocol";
import { AuthorityOperationError } from "./errors.js";

export function timestampMillis(value: string, label: string): number {
  assertUtcMillisecondTimestamp(value, label);
  return Date.parse(value);
}

export function assertDisplayName(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AuthorityOperationError(
      'invalid_request',
      'membership display name is invalid',
    );
  }
}
