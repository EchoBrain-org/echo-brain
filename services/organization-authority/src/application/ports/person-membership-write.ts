import type { Sha256Digest } from "@echo-brain/federation-protocol";
import type { StoredAuthorityMembership } from "./authority-repository.js";

/** The intentionally small, owner-visible employee lifecycle projection. */
export interface EmployeeRosterEntry {
  readonly email: string;
  readonly display_name: string;
  readonly membership_status: "active" | "revoked";
  readonly invitation_state: "pending" | "expired" | "redeemed" | "none";
}

/**
 * The only online membership mutation capability. It intentionally
 * has no installation, machine, lease, admin-bearer, or generic Authority
 * write surface.
 */
export interface PersonMembershipWriteTransaction {
  metadata(): { readonly organization_id: string };
  employeeMembershipByEmailSha256(
    email_sha256: Sha256Digest,
  ): StoredAuthorityMembership | undefined;
  employeeMembershipHasActiveIdentityBinding(membership_id: string): boolean;
  listEmployeeRoster(observed_at: string): readonly EmployeeRosterEntry[];
  createEmployeeMembership(input: {
    principal_id: string;
    membership_id: string;
    display_name: string;
    email: string;
    email_sha256: Sha256Digest;
  }): StoredAuthorityMembership;
  invalidatePendingPersonLoginGrants(membership_id: string): number;
  revokeEmployeeMembership(
    membership_id: string,
    reason: "owner_revoked_employee",
  ): StoredAuthorityMembership | undefined;
}

export interface PersonMembershipWriteRepository {
  writeMembershipAtLinearization<T>(
    observe: () => string,
    operation: (
      transaction: PersonMembershipWriteTransaction,
      observed_at: string,
    ) => T,
  ): T;
}

export function isPersonMembershipWriteRepository(
  value: unknown,
): value is PersonMembershipWriteRepository {
  return (
    value !== null &&
    typeof value === "object" &&
    "writeMembershipAtLinearization" in value &&
    typeof (value as { writeMembershipAtLinearization?: unknown })
      .writeMembershipAtLinearization === "function"
  );
}
