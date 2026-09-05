import {
  canonicalSha256,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";

/**
 * An opaque caller-supplied operation binding. Its narrow grammar keeps it
 * safe for propagation while its value remains outside authorization, search,
 * and answer content.
 */
export const PERSON_OPERATION_CORRELATION_HEADER_V1 =
  "x-echo-operation-correlation";

const OPERATION_CORRELATION_PATTERN_V1 = /^[A-Za-z0-9_-]{16,128}$/;

export function isPersonOperationCorrelationV1(
  value: unknown,
): value is string {
  return (
    typeof value === "string" && OPERATION_CORRELATION_PATTERN_V1.test(value)
  );
}

/** Commits an opaque value without persisting the value itself. */
export function personOperationCorrelationSha256V1(
  operationCorrelation: string,
): Sha256Digest {
  return canonicalSha256({
    schema_version: 1,
    kind: "echo-person-operation-correlation-commitment-v1",
    operation_correlation: operationCorrelation,
  });
}
