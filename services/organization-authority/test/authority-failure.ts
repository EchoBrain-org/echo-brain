import { AuthorityOperationError } from "@echo-brain/organization-authority-kernel/domain/errors";

/** The code and message of the Authority failure an operation throws. */
export function failure(operation: () => unknown): { readonly code: string; readonly message: string } {
  try { operation(); } catch (error) {
    if (error instanceof AuthorityOperationError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected an Authority failure");
}
