export class OrganizationProtocolValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`organization protocol: ${message}`, options);
    this.name = "OrganizationProtocolValidationError";
  }
}

export function isOrganizationProtocolValidationError(
  value: unknown,
): value is OrganizationProtocolValidationError {
  return value instanceof OrganizationProtocolValidationError;
}

export function organizationProtocolValidationFailure(
  message: string,
  cause?: unknown,
): never {
  throw new OrganizationProtocolValidationError(message, { cause });
}
