import { AuthorityOperationError } from "../domain/errors.js";
import { isCanonicalPersonEmail } from "../domain/person-session-rules.js";
import { personLoginGrantExpectedEmailSha256 } from "../domain/person-email-binding.js";
import type {
  IssuedPersonLoginGrant,
  PersonIdentitySessionApplication,
} from "./person-identity-sessions.js";

export interface IssuedCleanEmployeeInvitation {
  readonly login_grant: string;
  readonly expires_at: string;
}

export interface CleanEmployeeIdentityFactory {
  next(prefix: "prn" | "mem"): string;
}

function validateEmployeeName(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new AuthorityOperationError("invalid_request", "employee name is invalid");
  }
}

function validateEmployeeEmail(value: string): void {
  if (!isCanonicalPersonEmail(value)) {
    throw new AuthorityOperationError(
      "invalid_request",
      "employee email must be canonical lowercase ASCII",
    );
  }
}

function ownerOnly(membershipType: "owner" | "employee"): void {
  if (membershipType !== "owner") {
    throw new AuthorityOperationError("unauthorized", "person authentication failed");
  }
}

function invitation(grant: IssuedPersonLoginGrant): IssuedCleanEmployeeInvitation {
  return Object.freeze({
    login_grant: grant.login_grant,
    expires_at: grant.expires_at,
  });
}

/** Owner-only employee lifecycle. It is intentionally not a generic admin API. */
export class CleanPersonEmployeeLifecycleApplication {
  constructor(
    private readonly sessions: PersonIdentitySessionApplication,
    private readonly identities: CleanEmployeeIdentityFactory,
  ) {}

  invite(input: {
    access_token: string;
    name: string;
    email: string;
  }): IssuedCleanEmployeeInvitation {
    validateEmployeeName(input.name);
    validateEmployeeEmail(input.email);
    const emailSha256 = personLoginGrantExpectedEmailSha256(input.email);
    return this.sessions.withAuthenticatedMembershipWrite({
      access_token: input.access_token,
      commit: (authorization, transaction, observedAt) => {
        ownerOnly(authorization.membership_type);
        if (
          transaction.employeeMembershipByEmailSha256(emailSha256)?.status ===
          "active"
        ) {
          throw new AuthorityOperationError("conflict", "employee already exists");
        }
        const membership = transaction.createEmployeeMembership({
          principal_id: this.identities.next("prn"),
          membership_id: this.identities.next("mem"),
          display_name: input.name,
          email_sha256: emailSha256,
        });
        return invitation(
          this.sessions.issueEmployeeBootstrapLoginGrantAt(
            transaction,
            observedAt,
            { target_membership_id: membership.membership_id, expected_email: input.email },
          ),
        );
      },
    });
  }

  reissue(input: {
    access_token: string;
    email: string;
  }): IssuedCleanEmployeeInvitation {
    validateEmployeeEmail(input.email);
    const emailSha256 = personLoginGrantExpectedEmailSha256(input.email);
    return this.sessions.withAuthenticatedMembershipWrite({
      access_token: input.access_token,
      commit: (authorization, transaction, observedAt) => {
        ownerOnly(authorization.membership_type);
        const membership = transaction.employeeMembershipByEmailSha256(emailSha256);
        if (membership === undefined || membership.status !== "active") {
          throw new AuthorityOperationError("not_found", "active employee was not found");
        }
        transaction.invalidatePendingPersonLoginGrants(membership.membership_id);
        return invitation(
          this.sessions.issueEmployeeBootstrapLoginGrantAt(
            transaction,
            observedAt,
            { target_membership_id: membership.membership_id, expected_email: input.email },
          ),
        );
      },
    });
  }

  revoke(input: { access_token: string; email: string }): void {
    validateEmployeeEmail(input.email);
    const emailSha256 = personLoginGrantExpectedEmailSha256(input.email);
    this.sessions.withAuthenticatedMembershipWrite({
      access_token: input.access_token,
      commit: (authorization, transaction) => {
        ownerOnly(authorization.membership_type);
        const membership = transaction.employeeMembershipByEmailSha256(emailSha256);
        if (membership === undefined || membership.status !== "active") {
          throw new AuthorityOperationError("not_found", "active employee was not found");
        }
        transaction.invalidatePendingPersonLoginGrants(membership.membership_id);
        if (
          transaction.revokeEmployeeMembership(
            membership.membership_id,
            "owner_revoked_employee",
          ) === undefined
        ) {
          throw new AuthorityOperationError("conflict", "employee membership changed");
        }
      },
    });
  }
}
