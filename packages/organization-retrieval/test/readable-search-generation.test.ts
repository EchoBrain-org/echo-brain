import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { canonicalJson, sha256Digest } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReadableSearchGenerationV1,
  expandReadableSearchRelatedAtomsV1,
  listReadableSearchGenerationRecordsV1,
  listReadableSearchGenerationV1,
  readReadableSearchGenerationAtomsV1,
  READABLE_SEARCH_ADMISSION_BUDGET_V1,
  ORGANIZATION_MEMBER_READABLE_PERSON_POLICY_ID_V2,
  PROJECT_MEMBERS_READABLE_PERSON_POLICY_ID_V1,
  READABLE_SEARCH_CONTENT_BASELINE_V2,
  READABLE_SEARCH_FACTS_BASELINE_V3,
  READABLE_SEARCH_LEXICAL_BASELINE_V2,
  readableSearchPlaneBaselineSha256,
  RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2,
  searchReadableSearchGenerationV1,
  warmReadableSearchActiveGenerationV1,
  type BuildReadableSearchGenerationV1Input,
  type ReadableSearchAtomV1,
  type ReadableSearchRelatedAtomPairV1,
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

function relatedPair(
  left: ReadableSearchAtomV1,
  right: ReadableSearchAtomV1,
): ReadableSearchRelatedAtomPairV1 {
  return left.atom_id < right.atom_id
    ? { left_atom_id: left.atom_id, right_atom_id: right.atom_id }
    : { left_atom_id: right.atom_id, right_atom_id: left.atom_id };
}

describe("immutable readable-search generation v1", () => {
  it("admits a project audience union, then narrows scores and adjacency by the authoritative project scope", () => {
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
    const pair = [alpha, beta]
      .map((value) => value.atom_id)
      .sort() as [`sha256:${string}`, `sha256:${string}`];
    const built = buildReadableSearchGenerationV1({
      ...input(directory, [alpha, beta]),
      project_members_policy_contract_sha256: digest(`policy-${projectPolicy}`),
      related_atom_pairs: [{ left_atom_id: pair[0], right_atom_id: pair[1] }],
    });
    const active = activeGeneration(built);
    warmReadableSearchActiveGenerationV1({ state_directory: directory, active_generation: active });
    const alphaReader = { principal_id: "prn_alpha", membership_id: "mem_alpha", project_ids: ["prj_alpha"] };
    expect(searchReadableSearchGenerationV1({ state_directory: directory, active_generation: active, reader: alphaReader, query: "roadmap" }).items.map((item) => item.text)).toEqual(["alpha roadmap", "beta roadmap"]);
    expect(searchReadableSearchGenerationV1({ state_directory: directory, active_generation: active, reader: alphaReader, project_id: "prj_alpha", query: "roadmap" }).items.map((item) => item.text)).toEqual(["alpha roadmap"]);
    expect(() => searchReadableSearchGenerationV1({ state_directory: directory, active_generation: active, reader: alphaReader, project_id: "prj_beta", query: "roadmap" })).toThrow("project scope");
    expect(searchReadableSearchGenerationV1({ state_directory: directory, active_generation: active, reader: { ...alphaReader, project_ids: [] }, query: "roadmap" }).items).toEqual([]);
    expect(expandReadableSearchRelatedAtomsV1({ state_directory: directory, active_generation: active, reader: alphaReader, project_id: "prj_alpha", anchor_atom_ids: [alpha.atom_id] }).items).toEqual([]);
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
                { length: 17 },
                (__, term) => `term${term}x${index}`,
              ).join(" "),
            }),
        ),
    ],
  ])("rejects %s before staging", (dimension, atoms) => {
    const directory = tempDirectory();
    expect(() =>
      buildReadableSearchGenerationV1(input(directory, atoms())),
    ).toThrow(dimension);
    expect(existsSync(join(directory, "record-retrieval"))).toBe(false);
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

  it("balances source-record packets without admitting restricted siblings or unknown anchors", () => {
    const directory = tempDirectory();
    const first = atomWith("first-anchor");
    const second = atomWith("second-anchor", { record_position: 2 });
    const siblings = [first, second].flatMap((anchor, index) =>
      Array.from({ length: 5 }, (_, order) => atomWith(`sibling-${index}-${order}`, {
        record_position: anchor.record_position, record_sha256: anchor.record_sha256, envelope_sha256: anchor.envelope_sha256,
        atom_order: order + 1, item_kind: order === 0 ? "rationale" : "action",
      })),
    );
    const restricted = atomWith("private-sibling", {
      ...atom("private-sibling", RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2),
      record_position: first.record_position, record_sha256: first.record_sha256,
      atom_order: 6, text: "Private commercial terms",
    });
    const built = buildReadableSearchGenerationV1({
      ...input(directory, [first, second, ...siblings, restricted]),
      related_atom_pairs: [relatedPair(first, siblings[6]!)],
    });
    const request = {
      state_directory: directory,
      active_generation: activeGeneration(built),
      reader: { principal_id: "prn_reader", membership_id: "mem_reader" },
      anchor_atom_ids: [first.atom_id, second.atom_id], limit: 4,
    };
    warmReadableSearchActiveGenerationV1(request);
    expect(expandReadableSearchRelatedAtomsV1(request).items.map(item => item.atom_id))
      .toEqual([siblings[6]!.atom_id]);
    const packet = expandReadableSearchRelatedAtomsV1({ ...request, include_anchor_records: true });
    expect(packet.items.map(item => item.atom_id)).toEqual([
      siblings[1]!.atom_id, siblings[6]!.atom_id, siblings[2]!.atom_id, siblings[7]!.atom_id,
    ]);
    expect(expandReadableSearchRelatedAtomsV1({ ...request, include_anchor_records: true, limit: 16 }).items)
      .toHaveLength(10);
    for (const anchor of [restricted.atom_id, digest("unapproved")]) {
      expect(expandReadableSearchRelatedAtomsV1({ ...request, include_anchor_records: true,
        anchor_atom_ids: [anchor] }).items).toEqual([]);
    }
  });

  it("keeps direct related expansion anchor-first at its shared cap", () => {
    const directory = tempDirectory();
    const first = atomWith("direct-first");
    const second = atomWith("direct-second", { record_position: 2 });
    const firstRelated = atomWith("direct-first-related", {
      record_position: second.record_position,
      record_sha256: second.record_sha256,
      envelope_sha256: second.envelope_sha256,
      atom_order: 1,
    });
    const secondRelated = atomWith("direct-second-related", {
      record_position: first.record_position,
      record_sha256: first.record_sha256,
      envelope_sha256: first.envelope_sha256,
      atom_order: 1,
    });
    const built = buildReadableSearchGenerationV1({
      ...input(directory, [first, second, firstRelated, secondRelated]),
      related_atom_pairs: [
        relatedPair(first, firstRelated),
        relatedPair(second, secondRelated),
      ],
    });
    const request = {
      state_directory: directory,
      active_generation: activeGeneration(built),
      reader: { principal_id: "prn_reader", membership_id: "mem_reader" },
      anchor_atom_ids: [first.atom_id, second.atom_id],
      limit: 1,
    };
    warmReadableSearchActiveGenerationV1(request);
    expect(expandReadableSearchRelatedAtomsV1(request).items.map((item) => item.atom_id))
      .toEqual([firstRelated.atom_id]);
  });

  it("stores a canonical segment-local pair and expands it from a warmed authorized anchor", () => {
    const directory = tempDirectory();
    const anchor = atomWith("anchor", { atom_order: 0, text: "Decision: launch only after readiness review." });
    const first = atomWith("first-related", { atom_order: 1, text: "The readiness review requires the signed addendum." });
    const second = atomWith("second-related", { atom_order: 2, text: "The signed addendum gates production access." });
    const built = buildReadableSearchGenerationV1({
      ...input(directory, [anchor, first, second]),
      related_atom_pairs: [relatedPair(anchor, second), relatedPair(anchor, first)],
    });
    const active_generation = activeGeneration(built);
    warmReadableSearchActiveGenerationV1({ state_directory: directory, active_generation });
    expect(expandReadableSearchRelatedAtomsV1({
      state_directory: directory,
      active_generation,
      reader: { principal_id: "prn_reader", membership_id: "mem_reader" },
      anchor_atom_ids: [anchor.atom_id],
    }).items.map((item) => item.atom_id)).toEqual([first.atom_id, second.atom_id]);
  });

  const pairAtoms = (): readonly [ReadableSearchAtomV1, ReadableSearchAtomV1] =>
    [atomWith("pair-left", { atom_order: 0 }), atomWith("pair-right", { atom_order: 1 })];
  const sameRecordAtoms = (): readonly [ReadableSearchAtomV1, ReadableSearchAtomV1] => {
    const record_sha256 = digest("shared-pair-record");
    return [
      atomWith("same-record-left", { record_sha256, atom_order: 0 }),
      atomWith("same-record-right", { record_sha256, atom_order: 1 }),
    ];
  };
  it.each([
    ["self", pairAtoms, (left: ReadableSearchAtomV1, _right: ReadableSearchAtomV1) => ({ left_atom_id: left.atom_id, right_atom_id: left.atom_id }),
      "related atom pair must be canonical, non-self, and non-reversed"],
    ["reversed", pairAtoms, (left: ReadableSearchAtomV1, right: ReadableSearchAtomV1) => {
      const canonical = relatedPair(left, right);
      return { left_atom_id: canonical.right_atom_id, right_atom_id: canonical.left_atom_id };
    }, "related atom pair must be canonical, non-self, and non-reversed"],
    ["dangling", pairAtoms, (left: ReadableSearchAtomV1, _right: ReadableSearchAtomV1) => ({ left_atom_id: left.atom_id, right_atom_id: digest("missing") }),
      "related atom pair has a dangling atom"],
    ["same-record", sameRecordAtoms, relatedPair, "related atom pair must cross source records"],
  ])("rejects a %s related pair before staging", (_name, atoms, pair, message) => {
    const directory = tempDirectory();
    const [left, right] = atoms();
    expect(() => buildReadableSearchGenerationV1({
      ...input(directory, [left, right]),
      related_atom_pairs: [pair(left, right)],
    })).toThrow(message);
    expect(existsSync(join(directory, "record-retrieval"))).toBe(false);
  });

  it("rejects cross-policy and duplicate related pairs without exposing a restricted endpoint", () => {
    const directory = tempDirectory();
    const member = atomWith("pair-member");
    const reviewer = atom("pair-reviewer", RESTRICTED_REVIEWER_PERSON_POLICY_ID_V2);
    const crossSegment = relatedPair(member, reviewer);
    expect(() => buildReadableSearchGenerationV1({
      ...input(directory, [member, reviewer]),
      related_atom_pairs: [crossSegment],
    })).toThrow("crosses policy segments");
    const secondMember = atomWith("pair-second-member", { atom_order: 1 });
    const duplicate = relatedPair(member, secondMember);
    expect(() => buildReadableSearchGenerationV1({
      ...input(directory, [member, secondMember]),
      related_atom_pairs: [duplicate, duplicate],
    })).toThrow("duplicate related atom pair");
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

    function warmed(directory: string, atoms: readonly ReadableSearchAtomV1[], related: readonly ReadableSearchRelatedAtomPairV1[] = []) {
      const head = atoms.reduce((top, value) => value.record_position > top.record_position ? value : top);
      const built = buildReadableSearchGenerationV1({
        ...input(directory, atoms),
        exact_head: { ...input(directory).exact_head, position: head.record_position, record_sha256: head.record_sha256 },
        project_members_policy_contract_sha256: digest(`policy-${projectPolicy}`),
        related_atom_pairs: related,
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

    it("narrows search, list, read and expansion to the given records", () => {
      const directory = tempDirectory();
      const active = warmed(directory, [A0, A1, R0, P0, B0], [relatedPair(A0, B0)]);
      const onlyA = { record_sha256s: [A0.record_sha256] };
      const texts = (items: readonly { readonly text: string }[]) => items.map((item) => item.text);
      expect(texts(searchReadableSearchGenerationV1({ ...active, reader: MEMBER, query: "launch" }).items)).toEqual(["beta launch", "alpha launch"]);
      expect(texts(searchReadableSearchGenerationV1({ ...active, reader: MEMBER, query: "launch", ...onlyA }).items)).toEqual(["alpha launch"]);
      expect(texts(listReadableSearchGenerationV1({ ...active, reader: MEMBER, ...onlyA }).items)).toEqual(["alpha launch", "alpha owner"]);
      expect(texts(readReadableSearchGenerationAtomsV1({ ...active, reader: MEMBER, atom_ids: [A0.atom_id, B0.atom_id], ...onlyA }).items)).toEqual(["alpha launch"]);
      expect(texts(expandReadableSearchRelatedAtomsV1({ ...active, reader: MEMBER, anchor_atom_ids: [A0.atom_id] }).items)).toEqual(["beta launch"]);
      expect(expandReadableSearchRelatedAtomsV1({ ...active, reader: MEMBER, anchor_atom_ids: [A0.atom_id], ...onlyA }).items).toEqual([]);
      expect(texts(expandReadableSearchRelatedAtomsV1({ ...active, reader: MEMBER, anchor_atom_ids: [A0.atom_id], include_anchor_records: true, ...onlyA }).items)).toEqual(["alpha owner"]);
      expect(expandReadableSearchRelatedAtomsV1({ ...active, reader: MEMBER, anchor_atom_ids: [A0.atom_id], record_sha256s: [B0.record_sha256] }).items).toEqual([]);
      for (const empty of [{ record_sha256s: [] }, { record_sha256s: [R0.record_sha256] }]) {
        expect(searchReadableSearchGenerationV1({ ...active, reader: MEMBER, query: "launch", ...empty }).items).toEqual([]);
        expect(listReadableSearchGenerationV1({ ...active, reader: MEMBER, ...empty }).items).toEqual([]);
      }
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
        expect(() => expandReadableSearchRelatedAtomsV1({ ...active, reader: MEMBER, anchor_atom_ids: [A0.atom_id], ...narrowing })).toThrow("record narrowing");
      }
    });
  });
});
