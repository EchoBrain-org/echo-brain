import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  applyOrganizationRecordLogBaselineV1,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/new-lineage-v1";
import {
  buildCleanReadableSearchGenerationV1,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  readableSearchPlaneBaselineSha256V1,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
  type BuildCleanReadableSearchGenerationV1Input,
  type CleanReadableSearchAtomV1,
} from "@echo-brain/organization-retrieval/new-lineage-v1";
import Database from "better-sqlite3";
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

function readerAuthorization(input: {
  readonly principal_id: string;
  readonly membership_id: string;
  readonly membership_type: "owner" | "employee";
}): PersonAccessAuthorization {
  return {
    ...authorization(),
    principal_id: input.principal_id,
    membership_id: input.membership_id,
    membership_type: input.membership_type,
    identity_binding_id: `identity_${input.principal_id}`,
    session_family_id: `session_${input.membership_id}`,
    access_credential_sha256: digest(`access_${input.membership_id}`),
  };
}

function realGenerationInput(
  state_directory: string,
  atoms: readonly CleanReadableSearchAtomV1[],
): BuildCleanReadableSearchGenerationV1Input {
  const authority_id = "oau_clean";
  const organization_id = "org_clean";
  const state_lineage_id = "lineage_clean";
  const exact_head = {
    authority_id,
    organization_id,
    state_lineage_id,
    position: 2,
    record_sha256: sha256Digest("restricted-record"),
  } as const;
  const plane = (role: string, schema_sha256: Sha256Digest) => {
    const manifest_json = canonicalJson({
      schema_version: 1,
      kind: "echo-state-lineage-database-manifest-v1",
      role,
      authority_id,
      organization_id,
      state_lineage_id,
      database_schema_version: 1,
      schema_sha256,
      created_at: "2026-08-22T00:00:00.000Z",
      creating_artifact_revision: "test",
    });
    return {
      database_schema_version: 1 as const,
      schema_sha256,
      manifest_json,
      manifest_sha256: sha256Digest(manifest_json),
    };
  };
  return {
    state_directory,
    lineage: {
      authority_id,
      organization_id,
      state_lineage_id,
      planes: {
        facts: plane(
          "retrieval-facts",
          readableSearchPlaneBaselineSha256V1(
            READABLE_SEARCH_FACTS_BASELINE_V1,
          ),
        ),
        content: plane(
          "retrieval-content",
          readableSearchPlaneBaselineSha256V1(
            READABLE_SEARCH_CONTENT_BASELINE_V1,
          ),
        ),
        lexical: plane(
          "retrieval-lexical",
          readableSearchPlaneBaselineSha256V1(
            READABLE_SEARCH_LEXICAL_BASELINE_V1,
          ),
        ),
      },
    },
    exact_head,
    retrieval_contract_sha256: RETRIEVAL_CONTRACT,
    organization_member_policy_contract_sha256: sha256Digest("member-policy"),
    restricted_reviewer_policy_contract_sha256: sha256Digest(
      "restricted-policy",
    ),
    analyzer: {
      analyzer_contract_sha256: sha256Digest("analyzer-contract"),
      analyzer_source_sha256: sha256Digest("analyzer-source"),
      node_version: "22.22.1",
      unicode_version: "16.0",
      icu_version: "76.1",
    },
    source_revision: "test",
    builder_artifact_sha256: sha256Digest("builder"),
    sqlite_version: "3.50.4",
    atoms,
  };
}

function policyAtom(input: {
  readonly id: "member" | "restricted";
  readonly policy_id: CleanReadableSearchAtomV1["policy_id"];
}): CleanReadableSearchAtomV1 {
  const reviewer =
    input.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2;
  return {
    authority_id: "oau_clean",
    organization_id: "org_clean",
    state_lineage_id: "lineage_clean",
    record_position: reviewer ? 2 : 1,
    record_sha256: sha256Digest(`${input.id}-record`),
    envelope_sha256: sha256Digest(`${input.id}-envelope`),
    approval_id: `approval-${input.id}`,
    atom_id: sha256Digest(`${input.id}-atom`),
    atom_order: 0,
    signal_id_sha256: sha256Digest(`${input.id}-signal`),
    item_kind: "decision",
    text: `${input.id} policy signal`,
    text_sha256: sha256Digest(`${input.id} policy signal`),
    policy_id: input.policy_id,
    policy_contract_sha256: sha256Digest(`${input.id}-policy`),
    authorization_audit_event_id: `audit-${input.id}`,
    authorization_audit_sequence: reviewer ? 2 : 1,
    authorization_audit_entry_sha256: sha256Digest(`${input.id}-audit`),
    provider_action_sha256: sha256Digest(`${input.id}-provider`),
    authorization_proof_sha256: sha256Digest(`${input.id}-proof`),
    reviewer_principal_id: reviewer ? "principal_owner" : null,
    reviewer_membership_id: reviewer ? "membership_owner" : null,
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
        generation_id: digest("generation"),
        record_head: { position: 0, record_sha256: null },
        items: [
          {
            atom_id: digest("atom"),
            record_sha256: digest("record"),
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

  it("releases each policy only to the authenticated active member tuple it admits", () => {
    const value = setup(false);
    const record = new Database(":memory:");
    record.exec(
      "CREATE TABLE organization_record_log (position INTEGER PRIMARY KEY, record_sha256 TEXT NOT NULL)",
    );
    const restrictedRecordHash = sha256Digest("restricted-record");
    record
      .prepare(
        "INSERT INTO organization_record_log (position, record_sha256) VALUES (?, ?)",
      )
      .run(2, restrictedRecordHash);
    const built = buildCleanReadableSearchGenerationV1(
      realGenerationInput(value.state_directory, [
        policyAtom({
          id: "member",
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
        }),
        policyAtom({
          id: "restricted",
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
        }),
      ]),
    );
    value.authority
      .prepare(
        `INSERT INTO authority_readable_search_active_generation
         (singleton, organization_id, generation_id, manifest_sha256,
          retrieval_contract_sha256, record_head_position,
          record_head_hash, published_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "org_clean",
        built.manifest.generation_id,
        built.manifest_sha256,
        RETRIEVAL_CONTRACT,
        2,
        restrictedRecordHash,
        "2026-08-22T11:59:00.000Z",
      );
    const authorizations = {
      "owner-bearer": readerAuthorization({
        principal_id: "principal_owner",
        membership_id: "membership_owner",
        membership_type: "owner",
      }),
      "employee-bearer": readerAuthorization({
        principal_id: "principal_employee",
        membership_id: "membership_employee",
        membership_type: "employee",
      }),
      "replacement-owner-bearer": readerAuthorization({
        principal_id: "principal_owner",
        membership_id: "membership_owner_replacement",
        membership_type: "owner",
      }),
    } as const;
    try {
      const route = createCleanPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: {
          authenticateAccess: ({ access_token }) => {
            const current = authorizations[access_token as keyof typeof authorizations];
            if (current === undefined) throw new Error("unexpected bearer");
            return current;
          },
        },
        authority: value.authority,
        record,
        audit: new SqliteCleanPersonRecordReadAuditV1(value.authority),
      });

      const owner = route.search({
        access_token: "owner-bearer",
        query: "policy",
      });
      expect(owner).toMatchObject({
        generation_id: built.manifest.generation_id,
        record_head: { position: 2, record_sha256: restrictedRecordHash },
      });
      expect(owner.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            atom_id: sha256Digest("member-atom"),
            record_sha256: sha256Digest("member-record"),
            policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
          }),
          expect.objectContaining({
            atom_id: sha256Digest("restricted-atom"),
            record_sha256: restrictedRecordHash,
            policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
          }),
        ]),
      );
      expect(owner.items).toHaveLength(2);

      const employee = route.search({
        access_token: "employee-bearer",
        query: "policy",
      });
      expect(employee.items).toEqual([
        expect.objectContaining({
          atom_id: sha256Digest("member-atom"),
          record_sha256: sha256Digest("member-record"),
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
        }),
      ]);

      const replacementOwner = route.search({
        access_token: "replacement-owner-bearer",
        query: "policy",
      });
      expect(replacementOwner.items).toEqual([
        expect.objectContaining({
          atom_id: sha256Digest("member-atom"),
          record_sha256: sha256Digest("member-record"),
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
        }),
      ]);
    } finally {
      record.close();
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

  it.each([
    [
      "membership",
      (current: PersonAccessAuthorization): PersonAccessAuthorization => ({
        ...current,
        membership_id: "membership_replacement",
      }),
    ],
    [
      "session",
      (current: PersonAccessAuthorization): PersonAccessAuthorization => ({
        ...current,
        session_family_id: "session_replacement",
      }),
    ],
    [
      "authorization state",
      (current: PersonAccessAuthorization): PersonAccessAuthorization => ({
        ...current,
        person_state_sha256: digest("person-state-replacement"),
      }),
    ],
  ])(
    "does not release or audit when %s changes during the search",
    (_change, changedAuthorization) => {
      const value = setup();
      const admitted = authorization();
      let authenticateCount = 0;
      try {
        const route = createCleanPersonRecordSearchRouteV1({
          state_directory: value.state_directory,
          authority_id: "oau_clean",
          organization_id: "org_clean",
          state_lineage_id: "lineage_clean",
          retrieval_contract_sha256: RETRIEVAL_CONTRACT,
          sessions: {
            authenticateAccess: () => {
              authenticateCount += 1;
              return authenticateCount === 1
                ? admitted
                : changedAuthorization(admitted);
            },
          },
          authority: value.authority,
          record: value.record,
          audit: new SqliteCleanPersonRecordReadAuditV1(value.authority),
          search_generation: () => ({
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
                text: "must not leave the Authority",
                policy_id: "organization-member-readable-person-v2" as const,
              },
            ],
          }),
        });

        expect(() =>
          route.search({ access_token: "bearer-only", query: "lean" }),
        ).toThrow("person authentication failed");
        expect(authenticateCount).toBe(2);
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
    },
  );
});
