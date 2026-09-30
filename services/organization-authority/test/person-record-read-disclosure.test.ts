import { canonicalSha256, sha256Digest } from "@echo-brain/federation-protocol";
import {
  OrganizationRecordAppenderV4,
  PersonRecordReaderV1,
} from "@echo-brain/organization-record/organization-record-api-v1";
import { applyAuthorityBaselineV10 } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/baseline";
import { openAuthorityDatabase } from "@echo-brain/organization-authority-kernel/adapters/persistence/sqlite/open-authority-database";
import type { PersonAccessAuthorization } from "@echo-brain/organization-authority-kernel/application/ports/person-access-authorization";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COORDINATES,
  database,
  protocolAuthority,
} from "../../../packages/organization-record/test/fixtures/record-append-fixture.js";
import { SqlitePersonRecordReadAuditV1 } from "../src/adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { createPersonRecordReadRouteV1 } from "../src/composition/person-record-read-route.js";
import type { PersonRecordReadResponseV1 } from "../src/presentation/person-record-read-http-application.js";
import { SIGNED_APPROVAL_PROJECTORS, approveSignedSlackV2 } from "./fixtures/signed-slack-approval-v2.js";

/**
 * Characterizes what the Layer 1 record list discloses beyond the records a
 * reader may read. The `it.fails` cases state the minimized-projection target
 * proposed in ADR-0020 and fail against today's full signed-envelope passthrough.
 * Remove `.fails` when that projection is implemented, or replace these cases
 * with an explicit accepted-exposure pin if ADR-0020 is rejected.
 */

const OWNER = { principal_id: "principal-owner", membership_id: "membership-owner" };
const SHARED_PROJECT = "prj_00000000-0000-4000-8000-000000000011";
const UNJOINED_PROJECT = "prj_00000000-0000-4000-8000-000000000012";

/** An employee with one current project grant: the shared project only. */
const member: PersonAccessAuthorization = {
  organization_id: COORDINATES.organization_id,
  principal_id: "principal-member",
  membership_id: "membership-member",
  membership_type: "employee",
  identity_binding_id: "identity-member",
  session_family_id: "session-member",
  access_credential_sha256: sha256Digest("access-member"),
  access_expires_at: "2026-08-22T01:00:00.000Z",
  hard_reauthentication_at: "2026-08-22T02:00:00.000Z",
  person_state_sha256: sha256Digest("person-member"),
  session_state_sha256: sha256Digest("session-member"),
  checked_at: "2026-08-22T00:00:00.000Z",
};

/** Every global record-log coordinate a response carries, by JSON path. */
function recordLogCoordinates(value: unknown, path = "$"): { readonly path: string; readonly value: unknown }[] {
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
    const found = ["position", "predecessor_position", "predecessor_record_sha256"].includes(key)
      ? [{ path: childPath, value: child }]
      : [];
    return [...found, ...recordLogCoordinates(child, childPath)];
  });
}

describe("Person Layer 1 record list disclosure", () => {
  const record = database();
  const authorityDatabase = openAuthorityDatabase(":memory:");
  let response: PersonRecordReadResponseV1;

  beforeAll(async () => {
    applyAuthorityBaselineV10(authorityDatabase);
    const authority = protocolAuthority();
    const app = new OrganizationRecordAppenderV4(record, COORDINATES, SIGNED_APPROVAL_PROJECTORS);
    // Positions 1 and 3 are released to the member; position 2 is the owner's Only me record.
    await approveSignedSlackV2(app, authority, { approval_id: "approval-shared-and-unjoined", audit_sequence: 1, projects: [SHARED_PROJECT, UNJOINED_PROJECT], final_approver: OWNER });
    await approveSignedSlackV2(app, authority, { approval_id: "approval-owner-only", audit_sequence: 2, projects: [], final_approver: OWNER });
    await approveSignedSlackV2(app, authority, { approval_id: "approval-shared", audit_sequence: 3, projects: [SHARED_PROJECT], final_approver: OWNER });
    const route = createPersonRecordReadRouteV1({
      ...COORDINATES,
      sessions: { authenticateAccess: () => member },
      records: new PersonRecordReaderV1(record),
      audit: new SqlitePersonRecordReadAuditV1(authorityDatabase),
      capture_projects: () => ({ project_ids: [SHARED_PROJECT], grants_sha256: canonicalSha256([SHARED_PROJECT]) }),
    });
    response = route.list({ access_token: "bearer-member" });
    // Guard the expected-failure cases below: only a correct fixture may reach them.
    expect(response.records.map((item) => item.approval_id)).toEqual(["approval-shared", "approval-shared-and-unjoined"]);
  });

  afterAll(() => {
    record.close();
    authorityDatabase.close();
  });

  it.fails("does not name a project the reader is not a member of", () => {
    expect(JSON.stringify(response)).not.toContain(UNJOINED_PROJECT);
  });

  it.fails("does not let the reader count records it cannot see", () => {
    // Today: item positions 3 and 1, and an envelope predecessor_position of 2,
    // reveal exactly one hidden append between the two released records.
    expect(recordLogCoordinates(response)).toEqual([]);
  });
});
