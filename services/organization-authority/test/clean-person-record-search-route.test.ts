import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalSha256, type Sha256Digest } from "@echo-brain/federation-protocol";
import {
  applyOrganizationRecordLogBaselineV1,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/new-lineage-v1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteCleanPersonRecordReadAuditV1 } from "../src/adapters/persistence/sqlite/clean-person-record-read-audit-v1.js";
import { applyAuthorityBaselineV1 } from "../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-unmigrated-database.js";
import type { PersonAccessAuthorization } from "../src/application/person-identity-sessions.js";
import { AuthorityOperationError } from "../src/domain/errors.js";
import { createCleanPersonRecordSearchRouteV1 } from "../src/composition/clean-person-record-search-route.js";

const roots: string[] = [];
const digest = (value: string): Sha256Digest => canonicalSha256({ value });
const RETRIEVAL_CONTRACT = digest("clean-retrieval-contract");

function root(): string {
  const created = mkdtempSync(join(tmpdir(), "echo-clean-search-route-"));
  chmodSync(created, 0o700);
  const value = realpathSync(created);
  roots.push(value);
  return value;
}

function authorization(): PersonAccessAuthorization {
  return {
    organization_id: "org_clean",
    principal_id: "principal_reader",
    membership_id: "membership_reader",
    membership_type: "employee",
    identity_binding_id: "identity_reader",
    session_family_id: "session_reader",
    access_credential_sha256: digest("access"),
    access_expires_at: "2026-08-22T13:00:00.000Z",
    hard_reauthentication_at: "2026-08-22T14:00:00.000Z",
    person_state_sha256: digest("person"),
    session_state_sha256: digest("session"),
    checked_at: "2026-08-22T12:00:00.000Z",
  };
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

function setup(pointer = true) {
  const authority = openAuthorityDatabase(":memory:");
  applyAuthorityBaselineV1(authority);
  authority
    .prepare(
      `INSERT INTO authority_metadata
       (singleton, authority_id, organization_id, organization_display_name,
        descriptor_json, created_at, last_observed_at)
       VALUES (1, ?, ?, ?, '{}', ?, ?)`,
    )
    .run(
      "oau_clean",
      "org_clean",
      "Clean Organization",
      "2026-08-22T11:00:00.000Z",
      "2026-08-22T11:00:00.000Z",
    );
  const record = openOrganizationRecordDatabase(":memory:");
  applyOrganizationRecordLogBaselineV1(record);
  if (pointer) {
    authority
      .prepare(
        `INSERT INTO authority_readable_search_active_generation
         (singleton, organization_id, generation_id, manifest_sha256,
          retrieval_contract_sha256, record_head_position,
          record_head_hash, published_at)
         VALUES (1, ?, ?, ?, ?, 0, NULL, ?)`,
      )
      .run(
        "org_clean",
        digest("generation"),
        digest("manifest"),
        RETRIEVAL_CONTRACT,
        "2026-08-22T11:59:00.000Z",
      );
  }
  return { authority, record, state_directory: root() };
}

describe("clean Person Layer 2 route", () => {
  it("uses only the bearer-derived reader tuple and writes one compact Layer 2 audit", () => {
    const value = setup();
    const search = vi.fn(() => ({
      generation_id: digest("generation"),
      exact_head: {
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        position: 0,
        record_sha256: null,
      },
      items: [
        {
          atom_id: digest("atom"),
          record_position: 1,
          record_sha256: digest("record"),
          envelope_sha256: digest("envelope"),
          item_kind: "decision" as const,
          text: "Choose the lean path.",
          policy_id: "organization-member-readable-person-v2" as const,
        },
      ],
    }));
    try {
      const route = createCleanPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: { authenticateAccess: () => authorization() },
        authority: value.authority,
        record: value.record,
        audit: new SqliteCleanPersonRecordReadAuditV1(value.authority),
        search_generation: search,
      });
      expect(
        route.search({
          access_token: "bearer-only",
          query: "unlogged-query-phrase",
        }),
      ).toEqual({
        schema_version: 1,
        kind: "echo-clean-person-record-search-v1",
        items: [
          {
            kind: "decision",
            text: "Choose the lean path.",
            policy_id: "organization-member-readable-person-v2",
          },
        ],
      });
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({
          state_directory: value.state_directory,
          reader: {
            principal_id: "principal_reader",
            membership_id: "membership_reader",
          },
          query: "unlogged-query-phrase",
        }),
      );
      const audit = value.authority
        .prepare(
          "SELECT body_json FROM authority_person_read_decision_audit_v2",
        )
        .get() as { readonly body_json: string };
      const body = JSON.parse(audit.body_json) as Record<string, unknown>;
      expect(body).toMatchObject({
        kind: "echo-clean-person-record-read-audit-v1",
        read_mode: "layer2",
        principal_id: "principal_reader",
        membership_id: "membership_reader",
        result_count: 1,
      });
      expect(audit.body_json).not.toContain("unlogged-query-phrase");
      expect(audit.body_json).not.toContain("Choose the lean path.");
    } finally {
      value.record.close();
      value.authority.close();
    }
  });

  it("returns unavailable without search or audit when the exact-head pointer is absent", () => {
    const value = setup(false);
    const search = vi.fn();
    try {
      const route = createCleanPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: { authenticateAccess: () => authorization() },
        authority: value.authority,
        record: value.record,
        audit: new SqliteCleanPersonRecordReadAuditV1(value.authority),
        search_generation: search,
      });
      expect(() =>
        route.search({ access_token: "bearer-only", query: "lean" }),
      ).toThrow(AuthorityOperationError);
      try {
        route.search({ access_token: "bearer-only", query: "lean" });
      } catch (error) {
        expect((error as AuthorityOperationError).code).toBe("unavailable");
      }
      expect(search).not.toHaveBeenCalled();
      expect(
        value.authority
          .prepare(
            "SELECT count(*) AS count FROM authority_person_read_decision_audit_v2",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      value.record.close();
      value.authority.close();
    }
  });

  it("refuses release when the active generation changes during the read", () => {
    const value = setup();
    try {
      const route = createCleanPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: { authenticateAccess: () => authorization() },
        authority: value.authority,
        record: value.record,
        audit: new SqliteCleanPersonRecordReadAuditV1(value.authority),
        search_generation: () => {
          value.authority
            .prepare(
              `UPDATE authority_readable_search_active_generation
                  SET generation_id = ? WHERE singleton = 1`,
            )
            .run(digest("replacement-generation"));
          return {
            generation_id: digest("generation"),
            exact_head: {
              authority_id: "oau_clean",
              organization_id: "org_clean",
              state_lineage_id: "lineage_clean",
              position: 0,
              record_sha256: null,
            },
            items: [],
          };
        },
      });
      expect(() =>
        route.search({ access_token: "bearer-only", query: "lean" }),
      ).toThrow("exact-head readable-search generation is not available");
      expect(
        value.authority
          .prepare(
            "SELECT count(*) AS count FROM authority_person_read_decision_audit_v2",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      value.record.close();
      value.authority.close();
    }
  });
});
