/** Real search generation over corpus-v1 atoms; synthetic lineage and proof fields. */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@echo-brain/federation-protocol";
import * as engine from "../../../packages/organization-retrieval/dist/readable-search-engine-v1.js";
import { POLICY_RESTRICTED_REVIEWER } from "./corpus-v1.mjs";

const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const LINEAGE = { authority_id: "auth_core_eval", organization_id: "org_core_eval", state_lineage_id: "lineage_core_eval" };
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
    creating_artifact_revision: "core-search-eval",
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

/** Synchronous callback keeps the generation's lifetime and cleanup in one place. */
export function withSearchGeneration(corpusAtoms, run) {
  const atoms = corpusAtoms.map(engineAtom);
  const last = atoms.reduce((best, atom) => atom.record_position > best.record_position ? atom : best);
  const state_directory = mkdtempSync(join(tmpdir(), "echo-core-search-eval-"));
  try {
    const started = performance.now();
    const built = engine.buildReadableSearchGenerationV1({
      state_directory,
      lineage: {
        ...LINEAGE,
        planes: {
          facts: plane("retrieval-facts", engine.READABLE_SEARCH_FACTS_BASELINE_V2, 2, engine.readableSearchPlaneBaselineSha256),
          content: plane("retrieval-content", engine.READABLE_SEARCH_CONTENT_BASELINE_V1, 1, engine.readableSearchPlaneBaselineSha256V1),
          lexical: plane("retrieval-lexical", engine.READABLE_SEARCH_LEXICAL_BASELINE_V1, 1, engine.readableSearchPlaneBaselineSha256V1),
        },
      },
      exact_head: { ...LINEAGE, position: last.record_position, record_sha256: last.record_sha256 },
      retrieval_contract_sha256: sha("core-search-eval-contract"),
      organization_member_policy_contract_sha256: contracts.member,
      restricted_reviewer_policy_contract_sha256: contracts.reviewer,
      analyzer: {
        analyzer_contract_sha256: sha("core-search-eval-analyzer-contract"),
        analyzer_source_sha256: sha("core-search-eval-analyzer-source"),
        node_version: process.versions.node,
        unicode_version: process.versions.unicode ?? "unknown",
        icu_version: process.versions.icu ?? "unknown",
      },
      source_revision: "core-search-eval",
      builder_artifact_sha256: sha("core-search-eval-builder"),
      sqlite_version: "eval",
      atoms,
    });
    const buildMs = performance.now() - started;
    const active_generation = {
      generation_id: built.manifest.generation_id,
      manifest_sha256: built.manifest_sha256,
      retrieval_contract_sha256: built.manifest.retrieval_contract_sha256,
      exact_head: built.manifest.exact_head,
    };
    const warmStarted = performance.now();
    engine.warmReadableSearchActiveGenerationV1({ state_directory, active_generation });
    return run({
      manifest: built.manifest,
      buildMs,
      warmMs: performance.now() - warmStarted,
      search: (reader, query) => engine.searchReadableSearchGenerationV1({ state_directory, active_generation, reader, query, limit: 10 }),
    });
  } finally {
    engine.clearReadableSearchActiveGenerationV1();
    rmSync(state_directory, { recursive: true, force: true });
  }
}
