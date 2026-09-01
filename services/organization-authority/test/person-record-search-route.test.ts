import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  canonicalJson,
  canonicalSha256,
  sha256Digest,
  type Sha256Digest,
} from "@echo-brain/federation-protocol";
import {
  applyOrganizationRecordLogBaselineV1,
  openOrganizationRecordDatabase,
} from "@echo-brain/organization-record/organization-record-api-v1";
import {
  buildReadableSearchGenerationV1,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  readableSearchPlaneBaselineSha256V1,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
  warmReadableSearchActiveGenerationV1,
  type BuildReadableSearchGenerationV1Input,
  type ReadableSearchAtomV1,
} from "@echo-brain/organization-retrieval/readable-search-engine-v1";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlitePersonRecordReadAuditV1 } from "../src/adapters/persistence/sqlite/person-record-read-audit-v1.js";
import { applyAuthorityBaselineV1 } from "../src/adapters/persistence/sqlite/baseline.js";
import { openAuthorityDatabase } from "../src/adapters/persistence/sqlite/open-authority-database.js";
import type { PersonAccessAuthorization } from "../src/application/person-identity-sessions.js";
import { AuthorityOperationError } from "../src/domain/errors.js";
import { createPersonRecordSearchRouteV1 } from "../src/composition/person-record-search-route.js";

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
  atoms: readonly ReadableSearchAtomV1[],
): BuildReadableSearchGenerationV1Input {
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
    restricted_reviewer_policy_contract_sha256:
      sha256Digest("restricted-policy"),
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
  readonly policy_id: ReadableSearchAtomV1["policy_id"];
}): ReadableSearchAtomV1 {
  const reviewer = input.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2;
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

function benchmarkAtom(index: number): ReadableSearchAtomV1 {
  const reviewer = index >= 500;
  // Fourteen benchmark reviewer tuples plus the exact owner tuple used by the
  // policy fixture yield fifteen reviewer segments and one member segment.
  const reviewerIndex = reviewer ? index % 14 : 0;
  const text = Array.from(
    { length: 16 },
    (_, term) => `benchmark${term}`,
  ).join(" ");
  return {
    ...policyAtom({
      id: reviewer ? "restricted" : "member",
      policy_id: reviewer
        ? RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2
        : ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
    }),
    record_position: 1,
    record_sha256: sha256Digest(`benchmark-record-${index}`),
    envelope_sha256: sha256Digest(`benchmark-envelope-${index}`),
    approval_id: `benchmark-approval-${index}`,
    atom_id: sha256Digest(`benchmark-atom-${index}`),
    atom_order: index,
    signal_id_sha256: sha256Digest(`benchmark-signal-${index}`),
    text,
    text_sha256: sha256Digest(text),
    authorization_audit_event_id: `benchmark-audit-${index}`,
    authorization_audit_sequence: index + 1,
    authorization_audit_entry_sha256: sha256Digest(
      `benchmark-audit-entry-${index}`,
    ),
    provider_action_sha256: sha256Digest(`benchmark-provider-${index}`),
    authorization_proof_sha256: sha256Digest(`benchmark-proof-${index}`),
    reviewer_principal_id: reviewer ? `reviewer-${reviewerIndex}` : null,
    reviewer_membership_id: reviewer ? `membership-${reviewerIndex}` : null,
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

describe("Person Layer 2 route", () => {
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
      const route = createPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: { authenticateAccess: () => authorization() },
        authority: value.authority,
        record: value.record,
        audit: new SqlitePersonRecordReadAuditV1(value.authority),
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

  it("releases each policy only to the authenticated active member tuple it admits", async () => {
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
    const buildStarted = performance.now();
    const built = buildReadableSearchGenerationV1(
      realGenerationInput(value.state_directory, [
        policyAtom({
          id: "member",
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
        }),
        policyAtom({
          id: "restricted",
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
        }),
        ...Array.from({ length: 998 }, (_, index) =>
          benchmarkAtom(index + 2),
        ),
      ]),
    );
    const buildMilliseconds = performance.now() - buildStarted;
    const prewarmStarted = performance.now();
    warmReadableSearchActiveGenerationV1({
      state_directory: value.state_directory,
      active_generation: {
        generation_id: built.manifest.generation_id,
        manifest_sha256: built.manifest_sha256,
        retrieval_contract_sha256: built.manifest.retrieval_contract_sha256,
        exact_head: built.manifest.exact_head,
      },
    });
    const prewarmMilliseconds = performance.now() - prewarmStarted;
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
      const route = createPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: {
          authenticateAccess: ({ access_token }) => {
            const current =
              authorizations[access_token as keyof typeof authorizations];
            if (current === undefined) throw new Error("unexpected bearer");
            return current;
          },
        },
        authority: value.authority,
        record,
        audit: new SqlitePersonRecordReadAuditV1(value.authority),
      });

      const owner = route.search({
        access_token: "owner-bearer",
        query: "policy",
      });
      const eventLoopStarted = performance.now();
      const eventLoopProbe = new Promise<number>((resolve) =>
        setImmediate(() => resolve(performance.now() - eventLoopStarted)),
      );
      const requestStarted = performance.now();
      const benchmark = route.searchBatch({
        access_token: "owner-bearer",
        queries: ["benchmark0", "benchmark1", "benchmark2", "benchmark3"],
      });
      const requestMilliseconds = performance.now() - requestStarted;
      const eventLoopDelayMilliseconds = await eventLoopProbe;
      expect(benchmark.response.items).toHaveLength(10);
      expect(
        benchmark.response.items.every(
          (item) =>
            item.policy_id ===
            ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
        ),
      ).toBe(true);
      console.info("clean-readable-search lean-v1 benchmark", {
        atoms: 1_000,
        segments: built.manifest.segments.length,
        postings: 15_974,
        buildMilliseconds,
        prewarmMilliseconds,
        fourQueryRequestMilliseconds: requestMilliseconds,
        eventLoopDelayMilliseconds,
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

      const maximumCallerTermDecisionQuery = route.search({
        access_token: "owner-bearer",
        query: `decision ${Array.from({ length: 31 }, (_, index) => `term${index}`).join(" ")}`,
      });
      expect(maximumCallerTermDecisionQuery.items).toHaveLength(10);

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

  it("narrows only already-authorized merged atoms to an exact release, with broad fallback", () => {
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
    const releaseId = "clean-v1-staging-20260830-014";
    const atom = (input: {
      readonly name: string;
      readonly policy_id: ReadableSearchAtomV1["policy_id"];
      readonly text: string;
      readonly atom_order: number;
    }): ReadableSearchAtomV1 => {
      const restricted =
        input.policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2;
      const base = policyAtom({
        id: restricted ? "restricted" : "member",
        policy_id: input.policy_id,
      });
      return {
        ...base,
        atom_id: sha256Digest(`${input.name}-atom`),
        envelope_sha256: sha256Digest(`${input.name}-envelope`),
        approval_id: `${input.name}-approval`,
        signal_id_sha256: sha256Digest(`${input.name}-signal`),
        atom_order: input.atom_order,
        text: input.text,
        text_sha256: sha256Digest(input.text),
        authorization_audit_event_id: `${input.name}-audit`,
        authorization_audit_entry_sha256: sha256Digest(`${input.name}-entry`),
      };
    };
    const embeddedReleaseIds = [
      ["uppercase-prefix", `X${releaseId}`],
      ["underscore-prefix", `_${releaseId}`],
      ["underscore-suffix", `${releaseId}_other`],
      ["unicode-prefix", `é${releaseId}`],
      ["combining-suffix", `${releaseId}\u0301`],
    ] as const;
    const built = buildReadableSearchGenerationV1(
      realGenerationInput(value.state_directory, [
        atom({
          name: "older-member",
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
          text: "Synthetic staging canary clean-v1-staging-20260829-013 was accepted.",
          atom_order: 0,
        }),
        atom({
          name: "exact-member",
          policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
          text: `Synthetic staging release ${releaseId} approved the new decision.`,
          atom_order: 1,
        }),
        atom({
          name: "older-reviewer",
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
          text: "Private canary clean-v1-staging-20260829-013 owner approval delivered.",
          atom_order: 0,
        }),
        atom({
          name: "exact-reviewer",
          policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
          text: `Private release ${releaseId} owner approval delivery completed.`,
          atom_order: 1,
        }),
        ...embeddedReleaseIds.map(([name, embeddedId], index) =>
          atom({
            name,
            policy_id: ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
            text: `Synthetic staging release ${embeddedId} is not exact evidence.`,
            atom_order: index + 2,
          }),
        ),
      ]),
    );
    warmReadableSearchActiveGenerationV1({
      state_directory: value.state_directory,
      active_generation: {
        generation_id: built.manifest.generation_id,
        manifest_sha256: built.manifest_sha256,
        retrieval_contract_sha256: built.manifest.retrieval_contract_sha256,
        exact_head: built.manifest.exact_head,
      },
    });
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
    const owner = readerAuthorization({
      principal_id: "principal_owner",
      membership_id: "membership_owner",
      membership_type: "owner",
    });
    const employee = readerAuthorization({
      principal_id: "principal_employee",
      membership_id: "membership_employee",
      membership_type: "employee",
    });
    try {
      const route = createPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: {
          authenticateAccess: ({ access_token }) => {
            if (access_token === "owner") return owner;
            if (access_token === "employee") return employee;
            throw new AuthorityOperationError(
              "unauthorized",
              "person authentication failed",
            );
          },
        },
        authority: value.authority,
        record,
        audit: new SqlitePersonRecordReadAuditV1(value.authority),
      });
      const query = "synthetic staging release";
      const ownerResult = route.searchBatch({
        access_token: "owner",
        queries: [query],
        exact_release_id: releaseId,
      });
      expect(ownerResult.response.items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ atom_id: sha256Digest("exact-member-atom") }),
          expect.objectContaining({ atom_id: sha256Digest("exact-reviewer-atom") }),
        ]),
      );
      expect(ownerResult.response.items).toHaveLength(2);

      const employeeResult = route.searchBatch({
        access_token: "employee",
        queries: [query],
        exact_release_id: releaseId,
      });
      expect(employeeResult.response.items).toEqual([
        expect.objectContaining({ atom_id: sha256Digest("exact-member-atom") }),
      ]);
      expect(() =>
        route.searchBatch({
          access_token: "unauthorized",
          queries: [query],
          exact_release_id: releaseId,
        }),
      ).toThrow("person authentication failed");

      const fallback = route.searchBatch({
        access_token: "owner",
        queries: [query],
        exact_release_id: "clean-v1-staging-20260901-016",
      });
      expect(fallback.response.items).toHaveLength(9);
      expect(
        fallback.response.items.some((item) =>
          item.text.includes("clean-v1-staging-20260829-013"),
        ),
      ).toBe(true);
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
      const route = createPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: { authenticateAccess: () => authorization() },
        authority: value.authority,
        record: value.record,
        audit: new SqlitePersonRecordReadAuditV1(value.authority),
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

  it("runs a bounded Layer 4 plan under one reader and snapshot, then releases one aggregate audit", () => {
    const value = setup();
    const item = (
      name: string,
    ): {
      readonly atom_id: Sha256Digest;
      readonly record_position: number;
      readonly record_sha256: Sha256Digest;
      readonly envelope_sha256: Sha256Digest;
      readonly item_kind: "decision";
      readonly text: string;
      readonly policy_id: "organization-member-readable-person-v2";
    } => ({
      atom_id: digest(`atom-${name}`),
      record_position: 1,
      record_sha256: digest(`record-${name}`),
      envelope_sha256: digest(`envelope-${name}`),
      item_kind: "decision",
      text: `evidence ${name}`,
      policy_id: "organization-member-readable-person-v2",
    });
    const answers = {
      original: [item("original"), item("shared")],
      focused: [item("focused"), item("shared")],
      third: [item("third")],
    } as const;
    const search = vi.fn((input: { readonly query: string }) => ({
      generation_id: digest("generation"),
      exact_head: {
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        position: 0,
        record_sha256: null,
      },
      items: answers[input.query as keyof typeof answers],
    }));
    let authenticateCount = 0;
    try {
      const route = createPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: {
          authenticateAccess: () => {
            authenticateCount += 1;
            return authorization();
          },
        },
        authority: value.authority,
        record: value.record,
        audit: new SqlitePersonRecordReadAuditV1(value.authority),
        search_generation: search,
      });
      const batch = route.searchBatch({
        access_token: "bearer-only",
        queries: ["original", "focused", "third"],
      });

      expect(authenticateCount).toBe(2);
      expect(search).toHaveBeenCalledTimes(3);
      for (const call of search.mock.calls) {
        expect(call[0]).toMatchObject({
          reader: {
            principal_id: "principal_reader",
            membership_id: "membership_reader",
          },
          active_generation: {
            generation_id: digest("generation"),
            exact_head: { position: 0, record_sha256: null },
          },
        });
      }
      expect(batch.response.items.map((result) => result.atom_id)).toEqual([
        digest("atom-original"),
        digest("atom-focused"),
        digest("atom-third"),
        digest("atom-shared"),
      ]);
      expect(batch.release).toMatchObject({
        initial_authorization: {
          principal_id: "principal_reader",
          membership_id: "membership_reader",
        },
        current_authorization: {
          principal_id: "principal_reader",
          membership_id: "membership_reader",
        },
        active_pointer: {
          generation_id: digest("generation"),
          record_head: { position: 0, record_sha256: null },
        },
        record_read_audit_row_sha256: expect.stringMatching(/^sha256:/),
      });
      expect(
        value.authority
          .prepare(
            "SELECT count(*) AS count FROM authority_person_read_decision_audit_v2",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      value.record.close();
      value.authority.close();
    }
  });

  it.each([
    ["zero queries", []],
    ["five queries", ["one", "two", "three", "four", "five"]],
    ["duplicate queries", ["one", "one"]],
    ["invalid query", [" leading space"]],
    [
      "query with 33 unique terms",
      [Array.from({ length: 33 }, (_, index) => `term${index}`).join(" ")],
    ],
  ])("rejects %s before retrieval or audit", (_name, queries) => {
    const value = setup();
    const search = vi.fn();
    const authenticateAccess = vi.fn(() => authorization());
    try {
      const route = createPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: { authenticateAccess },
        authority: value.authority,
        record: value.record,
        audit: new SqlitePersonRecordReadAuditV1(value.authority),
        search_generation: search,
      });
      expect(() =>
        route.searchBatch({ access_token: "bearer-only", queries }),
      ).toThrow("request is invalid");
      expect(authenticateAccess).not.toHaveBeenCalled();
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

  it("revalidates only the route-local release against the same bearer, pointer, and head", () => {
    const value = setup();
    let currentAuthorization = authorization();
    try {
      const route = createPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: { authenticateAccess: () => currentAuthorization },
        authority: value.authority,
        record: value.record,
        audit: new SqlitePersonRecordReadAuditV1(value.authority),
        search_generation: () => ({
          generation_id: digest("generation"),
          exact_head: {
            authority_id: "oau_clean",
            organization_id: "org_clean",
            state_lineage_id: "lineage_clean",
            position: 0,
            record_sha256: null,
          },
          items: [],
        }),
      });
      const { release } = route.searchBatch({
        access_token: "bearer-only",
        queries: ["original"],
      });
      expect(
        route.revalidateBatchRelease({
          access_token: "bearer-only",
          release,
        }),
      ).toMatchObject({
        principal_id: "principal_reader",
        membership_id: "membership_reader",
      });
      expect(
        value.authority
          .prepare(
            "SELECT count(*) AS count FROM authority_person_read_decision_audit_v2",
          )
          .get(),
      ).toEqual({ count: 1 });

      expect(() =>
        route.revalidateBatchRelease({
          access_token: "bearer-only",
          release: { ...release },
        }),
      ).toThrow("person authentication failed");
      currentAuthorization = {
        ...authorization(),
        session_family_id: "session-replacement",
      };
      expect(() =>
        route.revalidateBatchRelease({
          access_token: "bearer-only",
          release,
        }),
      ).toThrow("person authentication failed");
      currentAuthorization = authorization();

      value.authority
        .prepare(
          `UPDATE authority_readable_search_active_generation
              SET generation_id = ? WHERE singleton = 1`,
        )
        .run(digest("replacement-generation"));
      expect(() =>
        route.revalidateBatchRelease({
          access_token: "bearer-only",
          release,
        }),
      ).toThrow("person authentication failed");
    } finally {
      value.record.close();
      value.authority.close();
    }
  });

  it("refuses release when the active generation changes during the read", () => {
    const value = setup();
    try {
      const route = createPersonRecordSearchRouteV1({
        state_directory: value.state_directory,
        authority_id: "oau_clean",
        organization_id: "org_clean",
        state_lineage_id: "lineage_clean",
        retrieval_contract_sha256: RETRIEVAL_CONTRACT,
        sessions: { authenticateAccess: () => authorization() },
        authority: value.authority,
        record: value.record,
        audit: new SqlitePersonRecordReadAuditV1(value.authority),
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
        const route = createPersonRecordSearchRouteV1({
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
          audit: new SqlitePersonRecordReadAuditV1(value.authority),
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
