import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { canonicalJson, sha256Digest } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReadableSearchGenerationV1,
  listReadableSearchGenerationRecordsV1,
  listReadableSearchGenerationV1,
  readReadableSearchGenerationAtomsV1,
  READABLE_SEARCH_ADMISSION_BUDGET_V1,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID_V1,
  READABLE_SEARCH_CONTENT_BASELINE_V2,
  READABLE_SEARCH_FACTS_BASELINE_V3,
  READABLE_SEARCH_LEXICAL_BASELINE_V2,
  readableSearchActiveGenerationUsageV1,
  readableSearchExceededLimitV1,
  readableSearchPlaneBaselineSha256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
  retireReadableSearchGenerationsV1,
  searchReadableSearchGenerationV1,
  warmReadableSearchActiveGenerationV1,
  type BuildReadableSearchGenerationV1Input,
  type ReadableSearchAtomV1,
} from "../src/readable-search-engine-v1.js";

const digest = (value: string): `sha256:${string}` => sha256Digest(value);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A fresh state directory removed after the test. */
function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "echo-readable-search-generation-"));
  temporaryDirectories.push(directory);
  return directory;
}

function activeGeneration(built: ReturnType<typeof buildReadableSearchGenerationV1>) {
  return {
    generation_id: built.manifest.generation_id,
    manifest_sha256: built.manifest_sha256,
    retrieval_contract_sha256: built.manifest.retrieval_contract_sha256,
    exact_head: built.manifest.exact_head,
  };
}

function input(
  directory: string,
  atoms: readonly ReadableSearchAtomV1[] = [],
): BuildReadableSearchGenerationV1Input {
  const authority_id = "auth_test";
  const organization_id = "org_test";
  const state_lineage_id = "lineage_test";
  const exactHeadAtom = atoms.find((atom) => atom.record_position === 2);
  const plane = (
    role: string,
    schema_sha256: `sha256:${string}`,
    database_schema_version: 1 | 2 | 3 = 1,
  ) => {
    const manifest_json = canonicalJson({
      schema_version: 1,
      kind: "echo-state-lineage-database-manifest-v1",
      role,
      authority_id,
      organization_id,
      state_lineage_id,
      database_schema_version,
      schema_sha256,
      created_at: "2026-08-22T00:00:00.000Z",
      creating_artifact_revision: "test",
    });
    return {
      database_schema_version,
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
          readableSearchPlaneBaselineSha256(READABLE_SEARCH_FACTS_BASELINE_V3),
          3,
        ),
        content: plane(
          "retrieval-content",
          readableSearchPlaneBaselineSha256(READABLE_SEARCH_CONTENT_BASELINE_V2), 2,
        ),
        lexical: plane(
          "retrieval-lexical",
          readableSearchPlaneBaselineSha256(READABLE_SEARCH_LEXICAL_BASELINE_V2), 2,
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
  policy_id: ReadableSearchAtomV1["policy_id"],
): ReadableSearchAtomV1 {
  const reviewer = policy_id === RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2;
  return {
    authority_id: "auth_test",
    organization_id: "org_test",
    state_lineage_id: "lineage_test",
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

function atomWith(
  id: string,
  overrides: Partial<ReadableSearchAtomV1> = {},
): ReadableSearchAtomV1 {
  const base = atom(id, ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2);
  const value = { ...base, ...overrides };
  return { ...value, text_sha256: digest(value.text) };
}

describe("immutable readable-search generation v1", () => {
  it("admits a project audience union, then narrows scores by the authoritative project scope", () => {
    const directory = tempDirectory();
    const projectPolicy = PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID_V1;
    const alpha = {
      ...atom("project-alpha", projectPolicy),
      text: "alpha roadmap",
      text_sha256: digest("alpha roadmap"),
      audience_project_ids: ["prj_alpha", "prj_beta"],
      association_project_ids: ["prj_alpha"],
    };
    const beta = {
      ...atom("project-beta", projectPolicy),
      atom_order: 1,
      text: "beta roadmap",
      text_sha256: digest("beta roadmap"),
      audience_project_ids: ["prj_alpha", "prj_beta"],
      association_project_ids: ["prj_beta"],
    };
    const built = buildReadableSearchGenerationV1({
      ...input(directory, [alpha, beta]),
      project_members_policy_contract_sha256: digest(`policy-${projectPolicy}`),
    });
    const active = activeGeneration(built);
    warmReadableSearchActiveGenerationV1({ state_directory: directory, active_generation: active });
    const alphaReader = { principal_id: "prn_alpha", membership_id: "mem_alpha", project_ids: ["prj_alpha"] };
    expect(searchReadableSearchGenerationV1({ state_directory: directory, active_generation: active, reader: alphaReader, query: "roadmap" }).items.map((item) => item.text)).toEqual(["alpha roadmap", "beta roadmap"]);
    expect(searchReadableSearchGenerationV1({ state_directory: directory, active_generation: active, reader: alphaReader, project_id: "prj_alpha", query: "roadmap" }).items.map((item) => item.text)).toEqual(["alpha roadmap"]);
    expect(() => searchReadableSearchGenerationV1({ state_directory: directory, active_generation: active, reader: alphaReader, project_id: "prj_beta", query: "roadmap" })).toThrow("project scope");
    expect(searchReadableSearchGenerationV1({ state_directory: directory, active_generation: active, reader: { ...alphaReader, project_ids: [] }, query: "roadmap" }).items).toEqual([]);
  });

  it("admits a reviewer atom its approver filed in a project to that approver alone, then narrows it by association (ADR-0049)", () => {
    const directory = tempDirectory();
    const projectPolicy = PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID_V1;
    const shared = { ...atom("project-shared", projectPolicy), text: "shared roadmap", text_sha256: digest("shared roadmap"),
      audience_project_ids: ["prj_alpha"], association_project_ids: ["prj_alpha"] };
    const kept = { ...atom("reviewer-kept", RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2), text: "private roadmap", text_sha256: digest("private roadmap"),
      audience_project_ids: [], association_project_ids: ["prj_alpha"] };
    const built = buildReadableSearchGenerationV1({ ...input(directory, [shared, kept]), project_members_policy_contract_sha256: digest(`policy-${projectPolicy}`) });
    const active = activeGeneration(built);
    warmReadableSearchActiveGenerationV1({ state_directory: directory, active_generation: active });
    const read = (reader: { principal_id: string; membership_id: string; project_ids: string[] }, project_id?: string) =>
      searchReadableSearchGenerationV1({ state_directory: directory, active_generation: active, reader, query: "roadmap", ...(project_id === undefined ? {} : { project_id }) })
        .items.map((item) => item.text).sort();
    const listed = (reader: { principal_id: string; membership_id: string; project_ids: string[] }, project_id?: string) =>
      listReadableSearchGenerationRecordsV1({ state_directory: directory, active_generation: active, reader, ...(project_id === undefined ? {} : { project_id }) })
        .records.map((record) => record.record_sha256).sort();
    const approver = { principal_id: "prn_reviewer", membership_id: "mem_reviewer", project_ids: ["prj_alpha", "prj_beta"] };
    const member = { principal_id: "prn_member", membership_id: "mem_member", project_ids: ["prj_alpha", "prj_beta"] };
    expect(read(approver)).toEqual(["private roadmap", "shared roadmap"]);
    expect(read(approver, "prj_alpha")).toEqual(["private roadmap", "shared roadmap"]);
    expect(read(approver, "prj_beta")).toEqual([]);
    expect(listed(approver, "prj_alpha")).toEqual([kept.record_sha256, shared.record_sha256].sort());
    // Another member of the project reads the shared record there, and never the approver's own.
    for (const project_id of [undefined, "prj_alpha", "prj_beta"]) {
      expect(read(member, project_id)).toEqual(project_id === "prj_beta" ? [] : ["shared roadmap"]);
      expect(listed(member, project_id)).not.toContain(kept.record_sha256);
    }
  });

  it("refuses a member atom filed in a project and a reviewer atom with an audience project", () => {
    const directory = tempDirectory();
    expect(() => buildReadableSearchGenerationV1(input(directory, [{ ...atom("member-filed", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2), association_project_ids: ["prj_alpha"] }])))
      .toThrow("member atom must not carry project associations");
    expect(() => buildReadableSearchGenerationV1(input(directory, [{ ...atom("reviewer-audience", RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2), audience_project_ids: ["prj_alpha"], association_project_ids: ["prj_alpha"] }])))
      .toThrow("reviewer atom must not carry a project audience");
  });

  it("fails closed when a project-policy atom lacks the frozen audience or association facts", () => {
    const directory = tempDirectory();
    const projectPolicy = PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID_V1;
    const incomplete = {
      ...atom("project-incomplete", projectPolicy),
      audience_project_ids: ["prj_alpha"],
    };
    expect(() => buildReadableSearchGenerationV1({
      ...input(directory, [incomplete]),
      project_members_policy_contract_sha256: digest(`policy-${projectPolicy}`),
    })).toThrow("association_project_ids");
  });
  it("batches each segment's plane writes in one transaction", () => {
    const directory = tempDirectory();
    const transaction = vi.spyOn(Database.prototype, "transaction");
    try {
      buildReadableSearchGenerationV1(
        input(directory, [
          atom("member", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2),
          atom("reviewer", RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2),
        ]),
      );
      expect(transaction).toHaveBeenCalledTimes(6);
    } finally {
      transaction.mockRestore();
    }
  });

  it("removes a staged generation after a plane transaction rolls back", () => {
    const directory = tempDirectory();
    const originalTransaction = Database.prototype.transaction;
    const transaction = vi
      .spyOn(Database.prototype, "transaction")
      .mockImplementationOnce(originalTransaction)
      .mockImplementationOnce(function (this: Database.Database, callback) {
        return originalTransaction.call(this, () => {
          callback();
          throw new Error("injected content transaction failure");
        });
      });
    try {
      expect(() =>
        buildReadableSearchGenerationV1(
          input(directory, [
            atom("member", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2),
          ]),
        ),
      ).toThrow("injected content transaction failure");
      expect(
        readdirSync(join(directory, "record-retrieval", "generations")),
      ).toEqual([]);
      expect(transaction).toHaveBeenCalledTimes(2);
    } finally {
      transaction.mockRestore();
    }
  });

  it.each([
    [
      "maximum_atoms",
      () =>
        Array.from(
          { length: READABLE_SEARCH_ADMISSION_BUDGET_V1.maximum_atoms + 1 },
          (_, index) => atomWith(`atom-limit-${index}`),
        ),
    ],
    [
      "maximum_segments",
      () =>
        Array.from(
          { length: READABLE_SEARCH_ADMISSION_BUDGET_V1.maximum_segments },
          (_, index) =>
            atomWith(`segment-limit-${index}`, {
              policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
              policy_contract_sha256: digest(
                `policy-${RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2}`,
              ),
              reviewer_principal_id: `reviewer-${index}`,
              reviewer_membership_id: `membership-${index}`,
            }),
        ),
    ],
    [
      "maximum_atom_text_utf8_bytes",
      () => [
        atomWith("text-limit", {
          text: "é".repeat(
            READABLE_SEARCH_ADMISSION_BUDGET_V1.maximum_atom_text_utf8_bytes /
              2 +
              1,
          ),
        }),
      ],
    ],
    [
      "maximum_postings",
      () =>
        Array.from(
          { length: READABLE_SEARCH_ADMISSION_BUDGET_V1.maximum_atoms },
          (_, index) =>
            atomWith(`posting-limit-${index}`, {
              text: Array.from(
                {
                  length:
                    READABLE_SEARCH_ADMISSION_BUDGET_V1.maximum_postings /
                      READABLE_SEARCH_ADMISSION_BUDGET_V1.maximum_atoms +
                    1,
                },
                (__, term) => `term${term}x${index}`,
              ).join(" "),
            }),
        ),
    ],
  ])("rejects %s before staging, naming the limit", (dimension, atoms) => {
    const directory = tempDirectory();
    let refused: unknown;
    expect(() => {
      try {
        buildReadableSearchGenerationV1(input(directory, atoms()));
      } catch (error) {
        refused = error;
        throw error;
      }
    }).toThrow(dimension);
    expect(readableSearchExceededLimitV1(refused)).toBe(dimension);
    expect(existsSync(join(directory, "record-retrieval"))).toBe(false);
  });

  it("names a limit only for an admission refusal", () => {
    for (const failure of [
      new Error("readable-search generation exceeds current admission budget"),
      new Error("readable-search generation exceeds constructor"),
      new Error("injected content transaction failure"),
      "readable-search generation exceeds maximum_atoms",
    ])
      expect(readableSearchExceededLimitV1(failure)).toBeUndefined();
  });

  it("builds, warms and searches a generation exactly at its atom, segment and posting budget", () => {
    const budget = READABLE_SEARCH_ADMISSION_BUDGET_V1;
    const directory = tempDirectory();
    // Tuple 0 is the member segment; every other tuple is one reviewer segment.
    // Every decision atom has its content terms plus the controlled category posting.
    const contentTerms = budget.maximum_postings / budget.maximum_atoms - 1;
    const lastTuple = budget.maximum_segments - 1;
    const lastAtom = budget.maximum_atoms - 1;
    const atoms = Array.from({ length: budget.maximum_atoms }, (_, index) => {
      const tuple = index % budget.maximum_segments;
      const text = [
        "capacity",
        `segment${tuple}`,
        ...Array.from({ length: contentTerms - 2 }, (__, term) => `term${term}x${index}`),
      ].join(" ");
      return atomWith(`capacity-${index}`, {
        atom_order: index,
        text,
        ...(tuple === 0
          ? {}
          : {
              policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
              policy_contract_sha256: digest(`policy-${RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2}`),
              reviewer_principal_id: `reviewer-${tuple}`,
              reviewer_membership_id: `membership-${tuple}`,
            }),
      });
    });
    const built = buildReadableSearchGenerationV1(input(directory, atoms));
    const counts = built.manifest.segments.map((segment) =>
      JSON.parse(readFileSync(join(built.generation_directory, "segments", segment.segment_id, "segment-manifest.json"), "utf8")) as
        { fact_count: number; posting_count: number });
    expect(counts).toHaveLength(budget.maximum_segments);
    expect(counts.reduce((sum, count) => sum + count.fact_count, 0)).toBe(budget.maximum_atoms);
    expect(counts.reduce((sum, count) => sum + count.posting_count, 0)).toBe(budget.maximum_postings);

    const active_generation = activeGeneration(built);
    warmReadableSearchActiveGenerationV1({ state_directory: directory, active_generation });
    expect(readableSearchActiveGenerationUsageV1()).toEqual({
      atoms: budget.maximum_atoms,
      segments: budget.maximum_segments,
      postings: budget.maximum_postings,
    });
    const search = (tuple: number | null, query: string) =>
      searchReadableSearchGenerationV1({
        state_directory: directory,
        active_generation,
        reader: tuple === null
          ? { principal_id: "prn_member", membership_id: "mem_member" }
          : { principal_id: `reviewer-${tuple}`, membership_id: `membership-${tuple}` },
        query,
      });
    // Equal scores fall back to atom order: a member reads the member segment alone,
    // and the last reviewer reads it merged with their own segment.
    const member = search(null, "capacity");
    expect(member.items.map((item) => item.atom_order)).toEqual(
      Array.from({ length: 10 }, (_, rank) => rank * budget.maximum_segments),
    );
    expect(member.truncated).toBe(true);
    expect(search(lastTuple, "capacity").items.map((item) => item.atom_order)).toEqual(
      Array.from({ length: 5 }, (_, rank) => [rank * budget.maximum_segments, rank * budget.maximum_segments + lastTuple]).flat(),
    );
    // The last atom's own term reaches its reviewer and no one else.
    expect(lastAtom % budget.maximum_segments).toBe(lastTuple);
    expect(search(lastTuple, `term0x${lastAtom}`).items.map((item) => item.text)).toEqual([atoms[lastAtom]!.text]);
    expect(search(lastTuple - 1, `term0x${lastAtom}`).items).toEqual([]);
    expect(search(null, `term0x${lastAtom}`).items).toEqual([]);
  });

  it("retires every generation but the published one, leaving the builder's staging alone", () => {
    const directory = tempDirectory();
    const member = ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2;
    const older = buildReadableSearchGenerationV1(input(directory, [atom("older", member)]));
    const published = buildReadableSearchGenerationV1(input(directory, [atom("published", member)]));
    const root = join(directory, "record-retrieval");
    const generations = join(root, "generations");
    const staging = `.staging-${"a".repeat(32)}`;
    mkdirSync(join(generations, staging), { mode: 0o700 });
    // What a retirement interrupted after its rename leaves.
    mkdirSync(join(root, `.retired-${"b".repeat(32)}`), { mode: 0o700 });
    const retire = (keep_generation_id: `sha256:${string}`) =>
      retireReadableSearchGenerationsV1({ state_directory: directory, keep_generation_id });

    expect(() => retire(digest("never published"))).toThrow("kept readable-search generation is missing");
    expect(readdirSync(generations)).toContain(older.manifest.generation_id);
    expect(retire(published.manifest.generation_id)).toBe(1);
    expect(readdirSync(generations).sort()).toEqual([staging, published.manifest.generation_id].sort());
    expect(readdirSync(root)).toEqual(["generations"]);
    expect(retire(published.manifest.generation_id)).toBe(0);
    warmReadableSearchActiveGenerationV1({ state_directory: directory, active_generation: activeGeneration(published) });
  });

  it("reuses the exact completed generation without rewriting it, and stamps every plane manifest without a migration ledger", () => {
    const directory = tempDirectory();
    const source = input(directory, [
      atom("member", ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2),
    ]);
    const first = buildReadableSearchGenerationV1(source);
    const second = buildReadableSearchGenerationV1(source);
    expect(second.generation_directory).toBe(first.generation_directory);
    expect(second.manifest_sha256).toBe(first.manifest_sha256);
    const segment = first.manifest.segments[0]!;
    for (const plane of ["facts", "content", "lexical"]) {
      const database = new Database(
        join(
          first.generation_directory,
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
  });

  it("separates member and exact reviewer tuples into immutable segments, then searches only the member segment and the reader's exact reviewer tuple", () => {
    const directory = tempDirectory();
    const built = buildReadableSearchGenerationV1(
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
    const active_generation = activeGeneration(built);
    warmReadableSearchActiveGenerationV1({
      state_directory: directory,
      active_generation,
    });
    const matching = searchReadableSearchGenerationV1({
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
    const otherReader = searchReadableSearchGenerationV1({
      state_directory: directory,
      active_generation,
      reader: { principal_id: "prn_other", membership_id: "mem_reviewer" },
      query: "searchable",
    });
    expect(otherReader.items.map((item) => item.text)).toEqual([
      "searchable member",
    ]);
  });

  it("ranks by BM25 over the reader's admitted segments only, so private statistics never move member results", () => {
    const directory = tempDirectory();
    // Two member atoms tie on tf-sum for "beta gamma" and on BM25 when the
    // scoring scope is the member segment alone (df(beta) = df(gamma) = 1).
    // The tie-break (same log position, lower atom order first) puts the
    // gamma atom first. Five private atoms also contain "gamma"; if their
    // document frequency leaked into a member's scope, gamma would become
    // common, the beta atom would win, and the order would flip.
    const gammaAtom = atomWith("member-gamma", { atom_order: 0, text: "alpha gamma" });
    const betaAtom = atomWith("member-beta", { atom_order: 1, text: "alpha beta" });
    const privateAtoms = Array.from({ length: 5 }, (_, index) =>
      atomWith(`private-${index}`, {
        record_position: 1,
        atom_order: 10 + index,
        text: `gamma private${index}`,
        policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
        policy_contract_sha256: digest(`policy-${RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2}`),
        reviewer_principal_id: "prn_reviewer",
        reviewer_membership_id: "mem_reviewer",
      }),
    );
    const built = buildReadableSearchGenerationV1(
      input(directory, [gammaAtom, betaAtom, ...privateAtoms]),
    );
    const active_generation = activeGeneration(built);
    warmReadableSearchActiveGenerationV1({ state_directory: directory, active_generation });
    const member = searchReadableSearchGenerationV1({
      state_directory: directory,
      active_generation,
      reader: { principal_id: "prn_member", membership_id: "mem_member" },
      query: "beta gamma",
    });
    expect(member.items.map((item) => item.text)).toEqual(["alpha gamma", "alpha beta"]);

    // The exact reviewer's scope includes the private segment, so for them
    // "gamma" is common (6 of 7 documents) and the rare "beta" atom ranks first.
    const reviewer = searchReadableSearchGenerationV1({
      state_directory: directory,
      active_generation,
      reader: { principal_id: "prn_reviewer", membership_id: "mem_reviewer" },
      query: "beta gamma",
    });
    expect(reviewer.items[0]?.text).toBe("alpha beta");
    expect(reviewer.items).toHaveLength(7);

    // A common function word must not outrank the atom that has the rare term.
    const noisy = searchReadableSearchGenerationV1({
      state_directory: directory,
      active_generation,
      reader: { principal_id: "prn_reviewer", membership_id: "mem_reviewer" },
      query: "gamma gamma beta",
    });
    expect(noisy.items[0]?.text).toBe("alpha beta");
  });

  it("recalls decision-category atoms without source-word overlap, with exact reviewer controls and repeatable results", () => {
    const firstDirectory = tempDirectory();
    const secondDirectory = tempDirectory();
    const atoms = [
      atomWith("member-category", {
        text: "We approved the launch for Tuesday.",
        item_kind: "decision",
      }),
      atomWith("reviewer-category", {
        record_position: 2,
        record_sha256: digest("record-reviewer-category"),
        text: "The reviewer approved the hiring plan.",
        item_kind: "decision",
        policy_id: RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
        policy_contract_sha256: digest(`policy-${RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2}`),
        reviewer_principal_id: "prn_reviewer",
        reviewer_membership_id: "mem_reviewer",
      }),
    ];
    const first = buildReadableSearchGenerationV1(input(firstDirectory, atoms));
    const second = buildReadableSearchGenerationV1(input(secondDirectory, atoms));
    expect(second.manifest.generation_id).toBe(first.manifest.generation_id);
    expect(second.manifest_sha256).toBe(first.manifest_sha256);
    expect(second.manifest.roots).toEqual(first.manifest.roots);
    for (const [directory, built] of [[firstDirectory, first], [secondDirectory, second]] as const) {
      const active_generation = activeGeneration(built);
      warmReadableSearchActiveGenerationV1({ state_directory: directory, active_generation });
      const query = "what decisions did i make";
      expect(searchReadableSearchGenerationV1({
        state_directory: directory,
        active_generation,
        reader: { principal_id: "prn_reviewer", membership_id: "mem_reviewer" },
        query,
      }).items.map((item) => item.text)).toEqual([
        "The reviewer approved the hiring plan.",
        "We approved the launch for Tuesday.",
      ]);
      expect(searchReadableSearchGenerationV1({
        state_directory: directory,
        active_generation,
        reader: { principal_id: "prn_other", membership_id: "mem_reviewer" },
        query,
      }).items.map((item) => item.text)).toEqual([
        "We approved the launch for Tuesday.",
      ]);
    }
  });

  it("builds an empty member generation from the exact head, then fails closed when the active pointer does not bind its immutable manifest", () => {
    const directory = tempDirectory();
    const built = buildReadableSearchGenerationV1(input(directory));
    expect(built.manifest.segments).toHaveLength(1);
    expect(built.manifest.segments[0]!.segment_id).toMatch(/^sha256:/);
    expect(
      existsSync(join(built.generation_directory, "manifest.json")),
    ).toBe(true);
    expect(() =>
      searchReadableSearchGenerationV1({
        state_directory: directory,
        active_generation: { ...activeGeneration(built), manifest_sha256: digest("wrong-manifest") },
        reader: { principal_id: "prn_reader", membership_id: "mem_reader" },
        query: "searchable",
      }),
    ).toThrow("active-generation handle is unavailable");
  });

  it("does not create a missing state directory while serving", () => {
    const directory = tempDirectory();
    const missing = join(directory, "missing");
    expect(() =>
      searchReadableSearchGenerationV1({
        state_directory: missing,
        active_generation: {
          generation_id: digest("generation"),
          manifest_sha256: digest("manifest"),
          retrieval_contract_sha256: digest("contract"),
          exact_head: {
            authority_id: "auth_test",
            organization_id: "org_test",
            state_lineage_id: "lineage_test",
            position: 0,
            record_sha256: null,
          },
        },
        reader: { principal_id: "prn_reader", membership_id: "mem_reader" },
        query: "searchable",
      }),
    ).toThrow("active-generation handle is unavailable");
    expect(existsSync(missing)).toBe(false);
  });
  describe("record inventory and record narrowing (ADR-0024)", () => {
    const projectPolicy = PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID_V1;
    const inRecord = (record: string, position: number, order: number, text: string, overrides: Partial<ReadableSearchAtomV1> = {}): ReadableSearchAtomV1 =>
      atomWith(`${record}-${order}`, { record_position: position, record_sha256: digest(`record-${record}`), envelope_sha256: digest(`envelope-${record}`), approval_id: `approval-${record}`, atom_order: order, text, ...overrides });
    const A0 = inRecord("a", 1, 0, "alpha launch");
    const A1 = inRecord("a", 1, 1, "alpha owner");
    const R0 = { ...atom("restricted", RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2), record_position: 2, record_sha256: digest("record-r"), envelope_sha256: digest("envelope-r"), approval_id: "approval-r", text: "reviewer launch", text_sha256: digest("reviewer launch") };
    const P0 = inRecord("p", 3, 0, "project launch", { policy_id: projectPolicy, policy_contract_sha256: digest(`policy-${projectPolicy}`), audience_project_ids: ["prj_alpha", "prj_beta"], association_project_ids: ["prj_alpha"] });
    const B0 = inRecord("b", 4, 0, "beta launch");
    const MEMBER = { principal_id: "prn_member", membership_id: "mem_member" };
    const REVIEWER = { principal_id: "prn_reviewer", membership_id: "mem_reviewer" };
    const ALPHA = { principal_id: "prn_alpha", membership_id: "mem_alpha", project_ids: ["prj_alpha"] };

    function warmed(directory: string, atoms: readonly ReadableSearchAtomV1[]) {
      const head = atoms.reduce((top, value) => value.record_position > top.record_position ? value : top);
      const built = buildReadableSearchGenerationV1({
        ...input(directory, atoms),
        exact_head: { ...input(directory).exact_head, position: head.record_position, record_sha256: head.record_sha256 },
        project_members_policy_contract_sha256: digest(`policy-${projectPolicy}`),
      });
      const active_generation = activeGeneration(built);
      warmReadableSearchActiveGenerationV1({ state_directory: directory, active_generation });
      return { state_directory: directory, active_generation };
    }

    it("lists one row per admitted record, newest first, under the same admission as search", () => {
      const directory = tempDirectory();
      const active = warmed(directory, [A0, A1, R0, P0, B0]);
      const records = (reader: typeof MEMBER & { project_ids?: readonly string[] }, extra: { project_id?: string; record_sha256s?: readonly `sha256:${string}`[] } = {}) =>
        listReadableSearchGenerationRecordsV1({ ...active, reader, ...extra }).records;
      expect(records(MEMBER)).toEqual([
        { record_position: 4, record_sha256: B0.record_sha256, envelope_sha256: B0.envelope_sha256, approval_id: B0.approval_id, policy_id: B0.policy_id, audience_project_count: 0, atom_count: 1 },
        { record_position: 1, record_sha256: A0.record_sha256, envelope_sha256: A0.envelope_sha256, approval_id: A0.approval_id, policy_id: A0.policy_id, audience_project_count: 0, atom_count: 2 },
      ]);
      expect(records(REVIEWER).map((row) => row.record_sha256)).toEqual([B0.record_sha256, R0.record_sha256, A0.record_sha256]);
      expect(records(ALPHA).map((row) => [row.record_sha256, row.audience_project_count])).toEqual([[B0.record_sha256, 0], [P0.record_sha256, 2], [A0.record_sha256, 0]]);
      expect(records(ALPHA, { project_id: "prj_alpha" }).map((row) => row.record_sha256)).toEqual([P0.record_sha256]);
      expect(() => records(MEMBER, { project_id: "prj_alpha" })).toThrow("project scope");
      expect(records(REVIEWER, { record_sha256s: [A0.record_sha256, R0.record_sha256].sort() }).map((row) => row.record_sha256)).toEqual([R0.record_sha256, A0.record_sha256]);
      // Narrowing never admits: the member still cannot see the reviewer's record.
      expect(records(MEMBER, { record_sha256s: [R0.record_sha256] })).toEqual([]);
      expect(records(MEMBER, { record_sha256s: [] })).toEqual([]);
    });

    it("narrows search, list and read to the given records", () => {
      const directory = tempDirectory();
      const active = warmed(directory, [A0, A1, R0, P0, B0]);
      const onlyA = { record_sha256s: [A0.record_sha256] };
      const texts = (items: readonly { readonly text: string }[]) => items.map((item) => item.text);
      expect(texts(searchReadableSearchGenerationV1({ ...active, reader: MEMBER, query: "launch" }).items)).toEqual(["beta launch", "alpha launch"]);
      const atom_orders = new Map([[A0.record_sha256, new Set([A0.atom_order])], [R0.record_sha256, new Set([R0.atom_order])]]);
      expect(texts(searchReadableSearchGenerationV1({ ...active, reader: MEMBER, query: 'launch', atom_orders, limit: 1 }).items)).toEqual(['alpha launch']);
      expect(texts(listReadableSearchGenerationV1({ ...active, reader: MEMBER, atom_orders, limit: 1 }).items)).toEqual(['alpha launch']);
      expect(listReadableSearchGenerationV1({ ...active, reader: MEMBER, atom_orders: new Map([[R0.record_sha256, new Set([R0.atom_order])]]) }).items).toEqual([]);

      expect(texts(searchReadableSearchGenerationV1({ ...active, reader: MEMBER, query: "launch", ...onlyA }).items)).toEqual(["alpha launch"]);
      expect(texts(listReadableSearchGenerationV1({ ...active, reader: MEMBER, ...onlyA }).items)).toEqual(["alpha launch", "alpha owner"]);
      expect(texts(readReadableSearchGenerationAtomsV1({ ...active, reader: MEMBER, atom_ids: [A0.atom_id, B0.atom_id], ...onlyA }).items)).toEqual(["alpha launch"]);
      for (const empty of [{ record_sha256s: [] }, { record_sha256s: [R0.record_sha256] }]) {
        expect(searchReadableSearchGenerationV1({ ...active, reader: MEMBER, query: "launch", ...empty }).items).toEqual([]);
        expect(listReadableSearchGenerationV1({ ...active, reader: MEMBER, ...empty }).items).toEqual([]);
      }
    });

    it("leaves excluded records and policies out after scoring and before the limit, so none takes a result's place", () => {
      const directory = tempDirectory();
      // The reviewer reads three launch atoms of record A, record R (theirs alone) and record B; A's outrank B's.
      const many = [0, 1, 2].map((order) => inRecord("a", 1, order, `launch launch launch ${order}`));
      const active = warmed(directory, [...many, R0, B0]);
      const texts = (items: readonly { readonly text: string }[]) => items.map((item) => item.text);
      const search = (exclude?: { readonly record_sha256s: readonly `sha256:${string}`[]; readonly policy_ids: readonly (typeof RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2)[] }) =>
        searchReadableSearchGenerationV1({ ...active, reader: REVIEWER, query: "launch", limit: 2, ...(exclude === undefined ? {} : { exclude }) });
      expect(texts(search().items)).toHaveLength(2);
      expect(texts(search().items).every((text) => text.startsWith("launch launch"))).toBe(true);
      // Record A left out: the next permitted atoms fill the page, and the page is complete.
      const withoutA = search({ record_sha256s: [many[0]!.record_sha256], policy_ids: [] });
      expect(texts(withoutA.items).sort()).toEqual(["beta launch", "reviewer launch"]);
      expect(withoutA.truncated).toBe(false);
      // The reviewer's own restricted record left out by its policy, as for a shared record's research.
      expect(texts(search({ record_sha256s: [many[0]!.record_sha256], policy_ids: [RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2] }).items)).toEqual(["beta launch"]);
      // The inventory leaves them out before its limit too.
      expect(texts(listReadableSearchGenerationV1({ ...active, reader: REVIEWER, limit: 1, exclude: { record_sha256s: [many[0]!.record_sha256], policy_ids: [RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2] } }).items)).toEqual(["beta launch"]);
      // An exclusion never admits: unknown policies and unsorted records are refused.
      expect(() => search({ record_sha256s: [B0.record_sha256, many[0]!.record_sha256].sort().reverse(), policy_ids: [] })).toThrow("record narrowing");
      expect(() => search({ record_sha256s: [], policy_ids: ["team" as never] })).toThrow("known policies");
    });

    it("recomputes BM25 statistics over the narrowed records, as a project scope does", () => {
      const directory = tempDirectory();
      // Across the generation "alpha" is common and "beta" rare, so beta ranks first.
      // Within record A both terms are equally rare, and the atom order breaks the tie.
      const x = inRecord("a", 1, 0, "alpha");
      const y = inRecord("a", 1, 1, "beta");
      const others = [0, 1, 2].map((order) => inRecord("b", 2, order, `alpha other${order}`));
      const active = warmed(directory, [x, y, ...others]);
      const top = (extra: { record_sha256s?: readonly `sha256:${string}`[] }) =>
        searchReadableSearchGenerationV1({ ...active, reader: MEMBER, query: "alpha beta", ...extra }).items.slice(0, 2).map((item) => item.text);
      expect(top({})).toEqual(["beta", "alpha"]);
      expect(top({ record_sha256s: [x.record_sha256] })).toEqual(["alpha", "beta"]);
    });

    it("refuses unsorted, duplicate, malformed and oversized record narrowing", () => {
      const directory = tempDirectory();
      const active = warmed(directory, [A0, A1, B0]);
      const sorted = [A0.record_sha256, B0.record_sha256].sort();
      const oversized = Array.from({ length: READABLE_SEARCH_ADMISSION_BUDGET_V1.maximum_atoms + 1 }, (_, index) => digest(`narrow-${index}`)).sort();
      for (const record_sha256s of [[...sorted].reverse(), [sorted[0]!, sorted[0]!], ["record-a"], oversized]) {
        const narrowing = { record_sha256s: record_sha256s as `sha256:${string}`[] };
        expect(() => listReadableSearchGenerationRecordsV1({ ...active, reader: MEMBER, ...narrowing })).toThrow("record narrowing");
        expect(() => searchReadableSearchGenerationV1({ ...active, reader: MEMBER, query: "launch", ...narrowing })).toThrow("record narrowing");
        expect(() => listReadableSearchGenerationV1({ ...active, reader: MEMBER, ...narrowing })).toThrow("record narrowing");
        expect(() => readReadableSearchGenerationAtomsV1({ ...active, reader: MEMBER, atom_ids: [A0.atom_id], ...narrowing })).toThrow("record narrowing");
      }
    });
  });
});
