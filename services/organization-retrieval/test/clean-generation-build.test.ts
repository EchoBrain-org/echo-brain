import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { canonicalJson, sha256Digest } from "@echo-brain/federation-protocol";
import { describe, expect, it } from "vitest";
import {
  buildCleanReadableSearchGenerationV1,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
  READABLE_SEARCH_CONTENT_BASELINE_V1,
  READABLE_SEARCH_FACTS_BASELINE_V1,
  READABLE_SEARCH_LEXICAL_BASELINE_V1,
  readableSearchPlaneBaselineSha256V1,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
  searchCleanReadableSearchGenerationV1,
  type BuildCleanReadableSearchGenerationV1Input,
  type CleanReadableSearchAtomV1,
} from "../src/new-lineage-v1.js";

const digest = (value: string): `sha256:${string}` => sha256Digest(value);

function input(
  directory: string,
  atoms: readonly CleanReadableSearchAtomV1[] = [],
): BuildCleanReadableSearchGenerationV1Input {
  const authority_id = "auth_clean";
  const organization_id = "org_clean";
  const state_lineage_id = "lineage_clean";
  const exactHeadAtom = atoms.find((atom) => atom.record_position === 2);
  const plane = (role: string, schema_sha256: `sha256:${string}`) => {
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
      manifest_sha256: digest(manifest_json),
    };
  };
  return {
    state_directory: directory,
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
    exact_head: {
      authority_id,
      organization_id,
      state_lineage_id,
      position: 2,
      record_sha256: exactHeadAtom?.record_sha256 ?? digest("head"),
    },
    retrieval_contract_sha256: digest("contract"),
    organization_member_policy_contract_sha256: digest(
      `policy-${ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2}`,
    ),
    restricted_reviewer_policy_contract_sha256: digest(
      `policy-${RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2}`,
    ),
    analyzer: {
      analyzer_contract_sha256: digest("analyzer-contract"),
      analyzer_source_sha256: digest("analyzer-source"),
      node_version: "22.22.1",
      unicode_version: "16.0",
      icu_version: "76.1",
    },
    source_revision: "test",
    builder_artifact_sha256: digest("builder"),
    sqlite_version: "3.50.4",
    atoms,
  };
}

function atom(
  id: string,
  policy_id: CleanReadableSearchAtomV1["policy_id"],
): CleanReadableSearchAtomV1 {
  const reviewer = policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2;
  return {
    authority_id: "auth_clean",
    organization_id: "org_clean",
    state_lineage_id: "lineage_clean",
    record_position: reviewer ? 2 : 1,
    record_sha256: digest(`record-${id}`),
    envelope_sha256: digest(`envelope-${id}`),
    approval_id: `approval-${id}`,
    atom_id: digest(`atom-${id}`),
    atom_order: 0,
    signal_id_sha256: digest(`signal-${id}`),
    item_kind: "decision",
    text: `searchable ${id}`,
    text_sha256: digest(`searchable ${id}`),
    policy_id,
    policy_contract_sha256: digest(`policy-${policy_id}`),
    authorization_audit_event_id: `audit-${id}`,
    authorization_audit_sequence: reviewer ? 2 : 1,
    authorization_audit_entry_sha256: digest(`audit-entry-${id}`),
    provider_action_sha256: digest(`provider-${id}`),
    authorization_proof_sha256: digest(`proof-${id}`),
    reviewer_principal_id: reviewer ? "prn_reviewer" : null,
    reviewer_membership_id: reviewer ? "mem_reviewer" : null,
  };
}

describe("clean immutable readable-search generation v1", () => {
  it("builds an empty member generation from the exact head", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-clean-retrieval-"));
    try {
      const built = buildCleanReadableSearchGenerationV1(input(directory));
      expect(built.manifest.segments).toHaveLength(1);
      expect(built.manifest.segments[0]!.segment_id).toMatch(/^sha256:/);
      expect(
        existsSync(join(built.generation_directory, "manifest.json")),
      ).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("separates member and exact reviewer tuples into immutable segments", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-clean-retrieval-"));
    try {
      const built = buildCleanReadableSearchGenerationV1(
        input(directory, [
          atom("member", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2),
          atom("reviewer", RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2),
        ]),
      );
      expect(built.manifest.segments).toHaveLength(2);
      expect(
        built.manifest.segments.map((segment) => segment.segment_id),
      ).toEqual(
        [
          ...built.manifest.segments.map((segment) => segment.segment_id),
        ].sort(),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stamps every plane manifest and never creates a migration ledger", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-clean-retrieval-"));
    try {
      const built = buildCleanReadableSearchGenerationV1(
        input(directory, [
          atom("member", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2),
        ]),
      );
      const segment = built.manifest.segments[0]!;
      for (const plane of ["facts", "content", "lexical"]) {
        const database = new Database(
          join(
            built.generation_directory,
            "segments",
            segment.segment_id,
            `${plane}.sqlite`,
          ),
          { readonly: true },
        );
        try {
          expect(
            database
              .prepare(
                "SELECT manifest_sha256 FROM echo_state_lineage_manifest WHERE singleton = 1",
              )
              .get(),
          ).toBeDefined();
          expect(
            database
              .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'retrieval_schema_migrations'",
              )
              .get(),
          ).toBeUndefined();
        } finally {
          database.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reuses the exact completed generation without rewriting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-clean-retrieval-"));
    try {
      const source = input(directory, [
        atom("member", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2),
      ]);
      const first = buildCleanReadableSearchGenerationV1(source);
      const second = buildCleanReadableSearchGenerationV1(source);
      expect(second.generation_directory).toBe(first.generation_directory);
      expect(second.manifest_sha256).toBe(first.manifest_sha256);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("searches only the member segment and the reader's exact reviewer tuple", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-clean-retrieval-"));
    try {
      const built = buildCleanReadableSearchGenerationV1(
        input(directory, [
          atom("member", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2),
          atom("reviewer", RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2),
        ]),
      );
      const active_generation = {
        generation_id: built.manifest.generation_id,
        manifest_sha256: built.manifest_sha256,
        retrieval_contract_sha256: built.manifest.retrieval_contract_sha256,
        exact_head: built.manifest.exact_head,
      };
      const matching = searchCleanReadableSearchGenerationV1({
        state_directory: directory,
        active_generation,
        reader: {
          principal_id: "prn_reviewer",
          membership_id: "mem_reviewer",
        },
        query: "searchable",
      });
      expect(matching.items.map((item) => item.text)).toEqual([
        "searchable reviewer",
        "searchable member",
      ]);
      const otherReader = searchCleanReadableSearchGenerationV1({
        state_directory: directory,
        active_generation,
        reader: { principal_id: "prn_other", membership_id: "mem_reviewer" },
        query: "searchable",
      });
      expect(otherReader.items.map((item) => item.text)).toEqual([
        "searchable member",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when the active pointer does not bind the immutable manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-clean-retrieval-"));
    try {
      const built = buildCleanReadableSearchGenerationV1(input(directory));
      expect(() =>
        searchCleanReadableSearchGenerationV1({
          state_directory: directory,
          active_generation: {
            generation_id: built.manifest.generation_id,
            manifest_sha256: digest("wrong-manifest"),
            retrieval_contract_sha256: built.manifest.retrieval_contract_sha256,
            exact_head: built.manifest.exact_head,
          },
          reader: { principal_id: "prn_reader", membership_id: "mem_reader" },
          query: "searchable",
        }),
      ).toThrow("active clean retrieval pointer does not bind this generation");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not create a missing state directory while serving", () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-clean-retrieval-"));
    const missing = join(directory, "missing");
    try {
      expect(() =>
        searchCleanReadableSearchGenerationV1({
          state_directory: missing,
          active_generation: {
            generation_id: digest("generation"),
            manifest_sha256: digest("manifest"),
            retrieval_contract_sha256: digest("contract"),
            exact_head: {
              authority_id: "auth_clean",
              organization_id: "org_clean",
              state_lineage_id: "lineage_clean",
              position: 0,
              record_sha256: null,
            },
          },
          reader: { principal_id: "prn_reader", membership_id: "mem_reader" },
          query: "searchable",
        }),
      ).toThrow("clean retrieval state directory is missing");
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
