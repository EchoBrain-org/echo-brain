export class FederationProtocolValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FederationProtocolValidationError";
  }
}

export function isFederationProtocolValidationError(
  value: unknown,
): value is FederationProtocolValidationError {
  return value instanceof FederationProtocolValidationError;
}

export function federationProtocolValidationFailure(
  message: string,
  cause?: unknown,
): never {
  throw new FederationProtocolValidationError(message, { cause });
}
