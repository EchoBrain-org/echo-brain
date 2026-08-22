import { canonicalSha256 } from "@echo-brain/federation-protocol";
import type { Sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import { SqliteCleanPersonRecordReadAuditV1 } from "../src/adapters/persistence/sqlite/clean-person-record-read-audit-v1.js";
import { applyAuthorityBaselineV1 } from "../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-unmigrated-database.js";
import type { PersonAccessAuthorization } from "../src/application/person-identity-sessions.js";
import { createCleanPersonRecordReadRouteV1 } from "../src/composition/clean-person-record-read-route.js";

const digest = (value: string): Sha256Digest => canonicalSha256({ value });

function authorization(
  values: Partial<PersonAccessAuthorization> = {},
): PersonAccessAuthorization {
  return {
    organization_id: "org_clean",
    principal_id: "principal_founder",
    membership_id: "membership_founder",
    membership_type: "owner",
    identity_binding_id: "identity_founder",
    session_family_id: "session_founder",
    access_credential_sha256: digest("access"),
    access_expires_at: "2026-08-22T01:00:00.000Z",
    hard_reauthentication_at: "2026-08-22T02:00:00.000Z",
    person_state_sha256: digest("person"),
    session_state_sha256: digest("session"),
    checked_at: "2026-08-22T00:00:00.000Z",
    ...values,
  };
}

function setup(
  authorizations: readonly PersonAccessAuthorization[] = [
    authorization(),
    authorization(),
  ],
) {
  const authority = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV1(authority);
  let authenticateCalls = 0;
  const inputs: unknown[] = [];
  const route = createCleanPersonRecordReadRouteV1({
    authority_id: "authority_clean",
    organization_id: "org_clean",
    state_lineage_id: "lineage_clean",
    sessions: {
      authenticateAccess: () => {
        const value = authorizations[authenticateCalls];
        authenticateCalls += 1;
        if (value === undefined) throw new Error("unexpected authentication");
        return value;
      },
    },
    records: {
      list: (input) => {
        inputs.push(input);
        return Object.freeze([
          Object.freeze({
            position: 7,
            approval_id: "approval_7",
            record_sha256: digest("record-7"),
            envelope: Object.freeze({ record: "approved" }),
          }),
        ]);
      },
    },
    audit: new SqliteCleanPersonRecordReadAuditV1(authority),
  });
  return {
    authority,
    route,
    inputs,
    authenticateCalls: () => authenticateCalls,
  };
}

describe("clean Person V4 record read route", () => {
  it("derives the V4 reader tuple from the bearer, rechecks it at release, and commits one minimized audit", () => {
    const value = setup();
    try {
      const response = value.route.list({
        access_token: "bearer-only",
        limit: 3,
      });

      expect(value.authenticateCalls()).toBe(2);
      expect(value.inputs).toEqual([
        {
          authority_id: "authority_clean",
          organization_id: "org_clean",
          state_lineage_id: "lineage_clean",
          principal_id: "principal_founder",
          membership_id: "membership_founder",
          limit: 3,
        },
      ]);
      expect(response).toEqual({
        schema_version: 1,
        kind: "echo-clean-person-record-list-v1",
        records: [
          {
            position: 7,
            approval_id: "approval_7",
            record_sha256: digest("record-7"),
            envelope: { record: "approved" },
          },
        ],
      });
      expect(Object.isFrozen(response)).toBe(true);
      expect(Object.isFrozen(response.records)).toBe(true);

      const audit = value.authority
        .prepare(
          `SELECT body_json, context_kind, prompt_sha256, answer_sha256, recorded_at
             FROM authority_person_read_decision_audit_v2`,
        )
        .get() as {
        body_json: string;
        context_kind: string;
        prompt_sha256: string | null;
        answer_sha256: string | null;
        recorded_at: string;
      };
      expect(JSON.parse(audit.body_json)).toMatchObject({
        kind: "echo-clean-person-record-read-audit-v1",
        read_mode: "layer1",
        authority_id: "authority_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        principal_id: "principal_founder",
        membership_id: "membership_founder",
        result_count: 1,
      });
      expect(audit.recorded_at).toBe("2026-08-22T00:00:00.000Z");
      expect(audit.context_kind).toBe("record_read");
      expect(audit.prompt_sha256).toBeNull();
      expect(audit.answer_sha256).toBeNull();
    } finally {
      value.authority.close();
    }
  });

  it("does not release rows or append an audit when the current membership changes before release", () => {
    const value = setup([
      authorization(),
      authorization({ membership_id: "membership_revoked" }),
    ]);
    try {
      expect(() => value.route.list({ access_token: "bearer-only" })).toThrow(
        "person authentication failed",
      );
      expect(
        value.authority
          .prepare(
            `SELECT count(*) AS count FROM authority_person_read_decision_audit_v2`,
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      value.authority.close();
    }
  });
});
