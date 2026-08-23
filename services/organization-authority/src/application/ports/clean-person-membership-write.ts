import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { StoredAuthorityMembership } from "./authority-repository.js";

/**
 * The only clean online membership mutation capability.  It intentionally
 * has no installation, machine, lease, admin-bearer, or generic Authority
 * write surface.
 */
export interface CleanPersonMembershipWriteTransaction {
  metadata(): { readonly organization_id: string };
  employeeMembershipByEmailSha256(
    email_sha256: Sha256Digest,
  ): StoredAuthorityMembership | undefined;
  createEmployeeMembership(input: {
    principal_id: string;
    membership_id: string;
    display_name: string;
    email_sha256: Sha256Digest;
  }): StoredAuthorityMembership;
  invalidatePendingPersonLoginGrants(membership_id: string): number;
  revokeEmployeeMembership(
    membership_id: string,
    reason: "owner_revoked_employee",
  ): StoredAuthorityMembership | undefined;
}

export interface CleanPersonMembershipWriteRepository {
  writeMembershipAtLinearization<T>(
    observe: () => string,
    operation: (
      transaction: CleanPersonMembershipWriteTransaction,
      observed_at: string,
    ) => T,
  ): T;
}

export function isCleanPersonMembershipWriteRepository(
  value: unknown,
): value is CleanPersonMembershipWriteRepository {
  return (
    value !== null &&
    typeof value === "object" &&
    "writeMembershipAtLinearization" in value &&
    typeof (value as { writeMembershipAtLinearization?: unknown })
      .writeMembershipAtLinearization === "function"
  );
}
