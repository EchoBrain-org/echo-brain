import { canonicalSha256 } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { applyAuthorityBaselineV1 } from "../../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../../src/adapters/persistence/sqlite/open-unmigrated-database.js";
import { personLoginGrantExpectedEmailSha256 } from "../../src/domain/person-email-binding.js";
import type { GranolaMeetingOwnerObservationV1 } from "../../src/composition/granola-meeting-owner-observation.js";
import {
  resolveGranolaMeetingOwnerAssigneeV1,
  type CleanMeetingOwnerAssigneeV1,
} from "../../src/composition/sqlite-granola-meeting-owner-assignee-resolver.js";

const ORGANIZATION_ID = "org_clean";
const OBSERVED_EMAIL = "owner@example.com";
const ISSUED_AT = "2026-08-28T00:00:00.000Z";
const BOUND_AT = "2026-08-28T00:01:00.000Z";
const EXPIRES_AT = "2026-08-28T00:15:00.000Z";

function digest(value: string): string {
  return canonicalSha256({ value });
}

function observation(
  values: Partial<GranolaMeetingOwnerObservationV1> = {},
): GranolaMeetingOwnerObservationV1 {
  return {
    provider: "granola",
    relationship: "calendar_organizer",
    subject: { kind: "email", value: OBSERVED_EMAIL },
    assurance: "provider_calendar_organizer_email_observed",
    source_path: "meeting.extensions.granola.calendar_event.organizer",
    ...values,
  };
}

interface Fixture {
  readonly database: ReturnType<typeof openAuthorityDatabase>;
  addMembership(input: {
    readonly principal_id: string;
    readonly membership_id: string;
    readonly membership_type: "owner" | "employee";
    readonly employee_email?: string;
    readonly employee_email_sha256?: string;
  }): void;
  addBinding(input: {
    readonly principal_id: string;
    readonly membership_id: string;
    readonly membership_type: "owner" | "employee";
    readonly expected_email?: string;
    readonly consumed?: boolean;
    readonly status?: "active" | "revoked";
  }): void;
  resolve(
    input?: GranolaMeetingOwnerObservationV1,
  ): CleanMeetingOwnerAssigneeV1 | undefined;
}

function fixture(): Fixture {
  const database = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV1(database);
  database.pragma("foreign_keys = OFF");
  // This fixture isolates the resolver's read contract. The Authority writer's
  // provenance trigger is covered by the session repository tests; reproducing
  // a full successful OIDC callback here would obscure the exact rows under
  // test.
  database.exec(
    "DROP TRIGGER authority_oidc_identity_bindings_provenance_insert",
  );
  database
    .prepare(
      `INSERT INTO authority_metadata
         (singleton, authority_id, organization_id, organization_display_name,
          descriptor_json, created_at, last_observed_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "authority_clean",
      ORGANIZATION_ID,
      "Clean Organization",
      "{}",
      ISSUED_AT,
      ISSUED_AT,
    );
  let bindingSequence = 0;

  return {
    database,
    addMembership(input) {
      database
        .prepare(
          `INSERT OR IGNORE INTO authority_principals
             (principal_id, organization_id, display_name, provisioned_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(input.principal_id, ORGANIZATION_ID, input.principal_id, ISSUED_AT);
      const employee = input.membership_type === "employee";
      const employeeEmail = employee
        ? (input.employee_email ?? OBSERVED_EMAIL)
        : null;
      const employeeEmailSha256 = employee
        ? (input.employee_email_sha256 ??
          personLoginGrantExpectedEmailSha256(employeeEmail!))
        : null;
      database
        .prepare(
          `INSERT INTO authority_memberships
             (membership_id, organization_id, principal_id, membership_type,
              status, provisioned_at, revoked_at, revocation_reason,
              employee_email, employee_email_sha256)
           VALUES (?, ?, ?, ?, 'active', ?, NULL, NULL, ?, ?)`,
        )
        .run(
          input.membership_id,
          ORGANIZATION_ID,
          input.principal_id,
          input.membership_type,
          ISSUED_AT,
          employeeEmail,
          employeeEmailSha256,
        );
    },
    addBinding(input) {
      bindingSequence += 1;
      const expectedEmail = input.expected_email ?? OBSERVED_EMAIL;
      const loginGrantSha256 = digest(`login-grant-${bindingSequence}`);
      const configurationSha256 = digest("oidc-configuration");
      const status = input.status ?? "active";
      const suffix = String(bindingSequence).padStart(12, "0");
      database
        .prepare(
          `INSERT INTO authority_person_login_grants
             (login_grant_sha256, grant_purpose, organization_id, principal_id,
              membership_id, membership_type, expected_issuer,
              expected_email_sha256, oidc_configuration_sha256, issued_at,
              expires_at, consumed_at, invalidated_at)
           VALUES (?, 'oidc_identity_bootstrap', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          loginGrantSha256,
          ORGANIZATION_ID,
          input.principal_id,
          input.membership_id,
          input.membership_type,
          "https://issuer.example",
          personLoginGrantExpectedEmailSha256(expectedEmail),
          configurationSha256,
          ISSUED_AT,
          EXPIRES_AT,
        );
      if (input.consumed !== false) {
        database
          .prepare(
            `UPDATE authority_person_login_grants
                SET consumed_at = ?
              WHERE login_grant_sha256 = ?`,
          )
          .run(BOUND_AT, loginGrantSha256);
      }
      database
        .prepare(
          `INSERT INTO authority_oidc_identity_bindings
             (identity_binding_id, issuer, subject, tenant_constraint_sha256,
              oidc_configuration_sha256, initial_login_attempt_id,
              initial_login_grant_sha256, organization_id, principal_id,
              membership_id, membership_type, status, bound_at, revoked_at,
              revocation_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `oib_00000000-0000-4000-8000-${suffix}`,
          "https://issuer.example",
          `subject-${bindingSequence}`,
          digest("tenant-constraint"),
          configurationSha256,
          `ola_00000000-0000-4000-8000-${suffix}`,
          loginGrantSha256,
          ORGANIZATION_ID,
          input.principal_id,
          input.membership_id,
          input.membership_type,
          "active",
          BOUND_AT,
          null,
          null,
        );
      if (status === "revoked") {
        database
          .prepare(
            `UPDATE authority_oidc_identity_bindings
                SET status = 'revoked', revoked_at = ?, revocation_reason = ?
              WHERE identity_binding_id = ?`,
          )
          .run(
            "2026-08-28T00:02:00.000Z",
            "test revocation",
            `oib_00000000-0000-4000-8000-${suffix}`,
          );
      }
    },
    resolve(input = observation()) {
      return resolveGranolaMeetingOwnerAssigneeV1({
        authority_database: database,
        organization_id: ORGANIZATION_ID,
        observation: input,
      });
    },
  };
}

describe("SQLite Granola meeting-owner assignee resolver v1", () => {
  it("resolves an active owner and collapses multiple exact bindings to one immutable tuple", () => {
    const value = fixture();
    try {
      value.addMembership({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });
      value.addBinding({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });
      value.addBinding({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });

      const result = value.resolve();
      expect(result).toEqual({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain(OBSERVED_EMAIL);
    } finally {
      value.database.close();
    }
  });

  it("resolves an active employee only when its membership email commitment matches", () => {
    const value = fixture();
    try {
      value.addMembership({
        principal_id: "principal_employee",
        membership_id: "membership_employee",
        membership_type: "employee",
      });
      value.addBinding({
        principal_id: "principal_employee",
        membership_id: "membership_employee",
        membership_type: "employee",
      });

      expect(value.resolve()).toEqual({
        principal_id: "principal_employee",
        membership_id: "membership_employee",
        membership_type: "employee",
      });
    } finally {
      value.database.close();
    }
  });

  it("fails closed for a missing binding, a wrong email, a revoked binding, and an unconsumed grant", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly binding?: Parameters<Fixture["addBinding"]>[0];
    }> = [
      { name: "missing binding" },
      {
        name: "wrong email",
        binding: {
          principal_id: "principal_owner",
          membership_id: "membership_owner",
          membership_type: "owner",
          expected_email: "other@example.com",
        },
      },
      {
        name: "revoked binding",
        binding: {
          principal_id: "principal_owner",
          membership_id: "membership_owner",
          membership_type: "owner",
          status: "revoked",
        },
      },
      {
        name: "unconsumed grant",
        binding: {
          principal_id: "principal_owner",
          membership_id: "membership_owner",
          membership_type: "owner",
          consumed: false,
        },
      },
    ];
    for (const testCase of cases) {
      const value = fixture();
      try {
        value.addMembership({
          principal_id: "principal_owner",
          membership_id: "membership_owner",
          membership_type: "owner",
        });
        if (testCase.binding !== undefined) value.addBinding(testCase.binding);

        expect(value.resolve(), testCase.name).toBeUndefined();
      } finally {
        value.database.close();
      }
    }
  });

  it("fails closed when an employee membership email commitment differs from the completed grant", () => {
    const value = fixture();
    try {
      value.addMembership({
        principal_id: "principal_employee",
        membership_id: "membership_employee",
        membership_type: "employee",
        employee_email: "different@example.com",
      });
      value.addBinding({
        principal_id: "principal_employee",
        membership_id: "membership_employee",
        membership_type: "employee",
      });

      expect(value.resolve()).toBeUndefined();
    } finally {
      value.database.close();
    }
  });

  it("fails closed when the otherwise exact membership has been revoked", () => {
    const value = fixture();
    try {
      value.addMembership({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });
      value.addBinding({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });
      value.database
        .prepare(
          `UPDATE authority_memberships
              SET status = 'revoked', revoked_at = ?, revocation_reason = ?
            WHERE membership_id = ?`,
        )
        .run(
          "2026-08-28T00:02:00.000Z",
          "test revocation",
          "membership_owner",
        );

      expect(value.resolve()).toBeUndefined();
    } finally {
      value.database.close();
    }
  });

  it("fails closed outside the exact organization that owns the identity evidence", () => {
    const value = fixture();
    try {
      value.addMembership({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });
      value.addBinding({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });

      for (const organization_id of ["org_other", "org_missing"]) {
        expect(
          resolveGranolaMeetingOwnerAssigneeV1({
            authority_database: value.database,
            organization_id,
            observation: observation(),
          }),
        ).toBeUndefined();
      }
    } finally {
      value.database.close();
    }
  });

  it("fails closed when the same observed organizer resolves to distinct active memberships", () => {
    const value = fixture();
    try {
      value.addMembership({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });
      value.addBinding({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });
      value.addMembership({
        principal_id: "principal_employee",
        membership_id: "membership_employee",
        membership_type: "employee",
      });
      value.addBinding({
        principal_id: "principal_employee",
        membership_id: "membership_employee",
        membership_type: "employee",
      });

      expect(value.resolve()).toBeUndefined();
    } finally {
      value.database.close();
    }
  });

  it("rejects malformed or wrong provider observations before resolving an assignee", () => {
    const value = fixture();
    try {
      value.addMembership({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });
      value.addBinding({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      });
      const wrongObservations: readonly unknown[] = [
        { ...observation(), provider: "slack" },
        { ...observation(), relationship: "record_owner" },
        { ...observation(), assurance: "provider_record_owner_observed" },
        { ...observation(), subject: { kind: "slack_user_id", value: "U123" } },
        { ...observation(), subject: { kind: "email", value: " OWNER@EXAMPLE.COM " } },
        { ...observation(), source_path: "meeting.participants[0]" },
      ];

      for (const invalid of wrongObservations) {
        expect(
          value.resolve(invalid as GranolaMeetingOwnerObservationV1),
        ).toBeUndefined();
      }
    } finally {
      value.database.close();
    }
  });
});
