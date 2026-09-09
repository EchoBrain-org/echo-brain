/**
 * The independent capacity oracle and the shipped engine must produce the
 * same complete ordered top ten for the same reader, head and query.  This is
 * the check that fixed-point BM25 and the admitted-union statistics scope are
 * reproduced exactly outside the candidate.  Requires `npm run build:workspaces`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildSyntheticCorpus, POLICY_RESTRICTED_REVIEWER } from "../../authority-core/corpus-v1.mjs";
import { buildQueryPlan, searchAtHead } from "../../authority-core/oracle-v1.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const engine = await import(
  resolve(here, "../../../../packages/organization-retrieval/dist/readable-search-engine-v1.js")
);

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonicalJson = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonicalJson).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
      : JSON.stringify(value);
const LINEAGE = { authority_id: "auth_agree", organization_id: "org_agree", state_lineage_id: "lineage_agree" };
const contracts = { member: sha("policy-member"), reviewer: sha("policy-reviewer") };

function plane(role, baseline, version, sha256Of) {
  const schema_sha256 = sha256Of(baseline);
  const manifest_json = canonicalJson({
    schema_version: 1,
    kind: "echo-state-lineage-database-manifest-v1",
    role,
    ...LINEAGE,
    database_schema_version: version,
    schema_sha256,
    created_at: "2026-09-09T00:00:00.000Z",
    creating_artifact_revision: "agreement-test",
  });
  return { database_schema_version: version, schema_sha256, manifest_json, manifest_sha256: sha(manifest_json) };
}

function engineAtom(atom) {
  const reviewer = atom.policy_id === POLICY_RESTRICTED_REVIEWER;
  return {
    ...LINEAGE,
    record_position: atom.log_position,
    record_sha256: `sha256:${atom.record_hash}`,
    envelope_sha256: sha(`envelope-${atom.atom_id}`),
    approval_id: `approval-${atom.source_id}`,
    atom_id: `sha256:${atom.atom_id}`,
    atom_order: atom.atom_order,
    signal_id_sha256: sha(`signal-${atom.atom_id}`),
    item_kind: atom.item_kind,
    text: atom.text,
    text_sha256: sha(atom.text),
    policy_id: atom.policy_id,
    policy_contract_sha256: reviewer ? contracts.reviewer : contracts.member,
    authorization_audit_event_id: `audit-${atom.atom_id}`,
    authorization_audit_sequence: atom.log_position,
    authorization_audit_entry_sha256: sha(`audit-entry-${atom.atom_id}`),
    provider_action_sha256: sha(`provider-${atom.atom_id}`),
    authorization_proof_sha256: sha(`proof-${atom.atom_id}`),
    reviewer_principal_id: reviewer ? atom.reviewer_principal_id : null,
    reviewer_membership_id: reviewer ? atom.reviewer_membership_id : null,
  };
}

test("engine top ten equals the independent oracle top ten for held-out queries and both reader kinds", () => {
  const corpus = buildSyntheticCorpus({ milestone: "M1", seed: "oracle-engine-agreement" });
  const atoms = corpus.atoms.map(engineAtom);
  const last = atoms[atoms.length - 1];
  const directory = mkdtempSync(join(tmpdir(), "echo-oracle-agreement-"));
  try {
    const built = engine.buildReadableSearchGenerationV1({
      state_directory: directory,
      lineage: {
        ...LINEAGE,
        planes: {
          facts: plane("retrieval-facts", engine.READABLE_SEARCH_FACTS_BASELINE_V2, 2, engine.readableSearchPlaneBaselineSha256),
          content: plane("retrieval-content", engine.READABLE_SEARCH_CONTENT_BASELINE_V1, 1, engine.readableSearchPlaneBaselineSha256V1),
          lexical: plane("retrieval-lexical", engine.READABLE_SEARCH_LEXICAL_BASELINE_V1, 1, engine.readableSearchPlaneBaselineSha256V1),
        },
      },
      exact_head: { ...LINEAGE, position: last.record_position, record_sha256: last.record_sha256 },
      retrieval_contract_sha256: sha("agreement-contract"),
      organization_member_policy_contract_sha256: contracts.member,
      restricted_reviewer_policy_contract_sha256: contracts.reviewer,
      analyzer: {
        analyzer_contract_sha256: sha("agreement-analyzer-contract"),
        analyzer_source_sha256: sha("agreement-analyzer-source"),
        node_version: process.versions.node,
        unicode_version: process.versions.unicode ?? "unknown",
        icu_version: process.versions.icu ?? "unknown",
      },
      source_revision: "agreement-test",
      builder_artifact_sha256: sha("agreement-builder"),
      sqlite_version: "test",
      atoms,
    });
    const active_generation = {
      generation_id: built.manifest.generation_id,
      manifest_sha256: built.manifest_sha256,
      retrieval_contract_sha256: built.manifest.retrieval_contract_sha256,
      exact_head: built.manifest.exact_head,
    };
    engine.warmReadableSearchActiveGenerationV1({ state_directory: directory, active_generation });

    const readers = [
      { principal_id: "employee-000", membership_id: "membership-000" },
      { principal_id: "employee-003", membership_id: "membership-003" },
      { principal_id: "prn_member_only", membership_id: "mem_member_only" },
    ];
    let compared = 0;
    for (const reader of readers) {
      const plan = buildQueryPlan({ corpus, reader, count: 60, seed: `agreement-${reader.principal_id}` });
      for (const { query } of plan) {
        const expected = searchAtHead({ corpus, exactHead: corpus.exact_head, reader, query, limit: 10 });
        const actual = engine.searchReadableSearchGenerationV1({
          state_directory: directory,
          active_generation,
          reader,
          query,
          limit: 10,
        });
        assert.deepEqual(
          actual.items.map((item) => item.atom_id),
          expected.items.map((item) => `sha256:${item.atom_id}`),
          `top ten differs for reader ${reader.principal_id} query "${query}"`,
        );
        compared += 1;
      }
    }
    assert.equal(compared, 180);
  } finally {
    engine.clearReadableSearchActiveGenerationV1();
    rmSync(directory, { recursive: true, force: true });
  }
});
