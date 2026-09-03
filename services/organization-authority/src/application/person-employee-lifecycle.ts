import { AuthorityOperationError } from "../domain/errors.js";
import {
  isCanonicalPersonEmail,
  isExpectedPersonEmail,
} from "../domain/person-session-rules.js";
import { personLoginGrantExpectedEmailSha256 } from "../domain/person-email-binding.js";
import type {
  EmployeeRosterEntry,
} from "./ports/person-membership-write.js";
import type {
  IssuedPersonLoginGrant,
  PersonIdentitySessionApplication,
} from "./person-identity-sessions.js";

export interface IssuedEmployeeInvitation {
  readonly login_grant: string;
  readonly expires_at: string;
}

export interface EmployeeRosterV1 {
  readonly schema_version: 1;
  readonly kind: "echo-clean-person-employee-roster-v1";
  readonly employees: readonly EmployeeRosterEntry[];
}

export interface EmployeeIdentityFactory {
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

function validateNewEmployeeEmail(value: string): void {
  if (!isExpectedPersonEmail(value)) {
    throw new AuthorityOperationError(
      "invalid_request",
      "employee email must be canonical lowercase ASCII",
    );
  }
}

function validateDurableEmployeeEmail(value: string): void {
  if (!isCanonicalPersonEmail(value)) {
    throw new AuthorityOperationError(
      "invalid_request",
      "employee email must be a canonical durable identity",
    );
  }
}

function ownerOnly(membershipType: "owner" | "employee"): void {
  if (membershipType !== "owner") {
    throw new AuthorityOperationError("unauthorized", "person authentication failed");
  }
}

function invitation(grant: IssuedPersonLoginGrant): IssuedEmployeeInvitation {
  return Object.freeze({
    login_grant: grant.login_grant,
    expires_at: grant.expires_at,
  });
}

/** Owner-only employee lifecycle. It is intentionally not a generic admin API. */
export class PersonEmployeeLifecycleApplication {
  constructor(
    private readonly sessions: PersonIdentitySessionApplication,
    private readonly identities: EmployeeIdentityFactory,
  ) {}

  invite(input: {
    access_token: string;
    name: string;
    email: string;
  }): IssuedEmployeeInvitation {
    validateEmployeeName(input.name);
    validateNewEmployeeEmail(input.email);
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
          email: input.email,
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

  list(input: { access_token: string }): EmployeeRosterV1 {
    return this.sessions.withAuthenticatedMembershipWrite({
      access_token: input.access_token,
      commit: (authorization, transaction, observedAt) => {
        ownerOnly(authorization.membership_type);
        return Object.freeze({
          schema_version: 1 as const,
          kind: "echo-clean-person-employee-roster-v1" as const,
          employees: Object.freeze([...transaction.listEmployeeRoster(observedAt)]),
        });
      },
    });
  }

  reissue(input: {
    access_token: string;
    email: string;
  }): IssuedEmployeeInvitation {
    validateDurableEmployeeEmail(input.email);
    const emailSha256 = personLoginGrantExpectedEmailSha256(input.email);
    return this.sessions.withAuthenticatedMembershipWrite({
      access_token: input.access_token,
      commit: (authorization, transaction, observedAt) => {
        ownerOnly(authorization.membership_type);
        const membership = transaction.employeeMembershipByEmailSha256(emailSha256);
        if (membership === undefined || membership.status !== "active") {
          throw new AuthorityOperationError("not_found", "active employee was not found");
        }
        if (
          transaction.employeeMembershipHasActiveIdentityBinding(
            membership.membership_id,
          )
        ) {
          throw new AuthorityOperationError(
            "conflict",
            "employee already completed identity onboarding",
          );
        }
        transaction.invalidatePendingPersonLoginGrants(membership.membership_id);
        return invitation(
          isExpectedPersonEmail(input.email)
            ? this.sessions.issueEmployeeBootstrapLoginGrantAt(
                transaction,
                observedAt,
                { target_membership_id: membership.membership_id, expected_email: input.email },
              )
            : this.sessions.issueEmployeeBootstrapLoginGrantForDurableIdentityAt(
                transaction,
                observedAt,
                { target_membership_id: membership.membership_id, expected_email: input.email },
              ),
        );
      },
    });
  }

  revoke(input: { access_token: string; email: string }): void {
    validateDurableEmployeeEmail(input.email);
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
