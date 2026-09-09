#!/usr/bin/env node
/**
 * Engine-level retrieval quality and latency on an atom-shaped synthetic corpus.
 *
 * Builds a real immutable generation with buildReadableSearchGenerationV1,
 * warms it, and issues real searchReadableSearchGenerationV1 calls.  Whatever
 * scorer the shipped engine uses is what gets measured; there is no scorer
 * flag.  Ground truth is independent of the scorer: every query is built from
 * one known target atom, so "correct" means the target is retrieved.
 *
 * Corpus shape follows tools/evals/authority-core/corpus-v1.mjs (4,096-word
 * Zipf vocabulary, 25 postings per atom, tf 1/2/3 at 70/20/10, 70/30 policy
 * split per meeting) grown with appendSyntheticAtoms to fill the admission
 * budget.
 *
 * Query classes (all deterministic from the seed):
 *   content   two of the target's rarest terms (control: both scorers should do well)
 *   question  the same two rare terms plus three top-rank words, mimicking a
 *             natural-language question whose function words also occur in
 *             most atoms
 *   question5 the same two rare terms plus five top-rank words (heavier
 *             function-word load; the analyzer deduplicates repeated terms,
 *             so repeating a word in the query is not a distinct class)
 *
 *   node tools/evals/retrieval-quality/synthetic-engine.mjs --atoms 650 --queries 300
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendSyntheticAtoms,
  buildSyntheticCorpus,
  seededRandom,
  POLICY_RESTRICTED_REVIEWER,
} from "../authority-core/corpus-v1.mjs";
import { mean, percentile, round } from "./metrics.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const enginePath = resolve(
  here,
  "../../../packages/organization-retrieval/dist/readable-search-engine-v1.js",
);

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function sha(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const LINEAGE = Object.freeze({
  authority_id: "auth_quality_bench",
  organization_id: "org_quality_bench",
  state_lineage_id: "lineage_quality_bench",
});

function plane(engine, role, baseline, database_schema_version, sha256Of) {
  const schema_sha256 = sha256Of(baseline);
  const manifest_json = canonicalJson({
    schema_version: 1,
    kind: "echo-state-lineage-database-manifest-v1",
    role,
    ...LINEAGE,
    database_schema_version,
    schema_sha256,
    created_at: "2026-09-09T00:00:00.000Z",
    creating_artifact_revision: "retrieval-quality-bench",
  });
  return { database_schema_version, schema_sha256, manifest_json, manifest_sha256: sha(manifest_json) };
}

function toEngineAtom(engine, atom, policyContracts) {
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
    policy_contract_sha256: reviewer ? policyContracts.reviewer : policyContracts.member,
    authorization_audit_event_id: `audit-${atom.atom_id}`,
    authorization_audit_sequence: atom.log_position,
    authorization_audit_entry_sha256: sha(`audit-entry-${atom.atom_id}`),
    provider_action_sha256: sha(`provider-${atom.atom_id}`),
    authorization_proof_sha256: sha(`proof-${atom.atom_id}`),
    reviewer_principal_id: reviewer ? atom.reviewer_principal_id : null,
    reviewer_membership_id: reviewer ? atom.reviewer_membership_id : null,
  };
}

function buildInput(engine, directory, atoms, policyContracts) {
  const last = atoms.reduce((best, atom) => (atom.record_position > best.record_position ? atom : best));
  return {
    state_directory: directory,
    lineage: {
      ...LINEAGE,
      planes: {
        facts: plane(engine, "retrieval-facts", engine.READABLE_SEARCH_FACTS_BASELINE_V2, 2, engine.readableSearchPlaneBaselineSha256),
        content: plane(engine, "retrieval-content", engine.READABLE_SEARCH_CONTENT_BASELINE_V1, 1, engine.readableSearchPlaneBaselineSha256V1),
        lexical: plane(engine, "retrieval-lexical", engine.READABLE_SEARCH_LEXICAL_BASELINE_V1, 1, engine.readableSearchPlaneBaselineSha256V1),
      },
    },
    exact_head: { ...LINEAGE, position: last.record_position, record_sha256: last.record_sha256 },
    retrieval_contract_sha256: sha("retrieval-quality-bench-contract"),
    organization_member_policy_contract_sha256: policyContracts.member,
    restricted_reviewer_policy_contract_sha256: policyContracts.reviewer,
    analyzer: {
      analyzer_contract_sha256: sha("retrieval-quality-bench-analyzer-contract"),
      analyzer_source_sha256: sha("retrieval-quality-bench-analyzer-source"),
      node_version: process.versions.node,
      unicode_version: process.versions.unicode ?? "unknown",
      icu_version: process.versions.icu ?? "unknown",
    },
    source_revision: "retrieval-quality-bench",
    builder_artifact_sha256: sha("retrieval-quality-bench-builder"),
    sqlite_version: "bench",
    atoms,
  };
}

function termFrequencies(text) {
  const frequencies = new Map();
  for (const run of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const term = run.toLowerCase();
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return frequencies;
}

export async function runSyntheticEngine({ atomCount = 650, queryCount = 300, seed = "retrieval-quality-v1" }) {
  const engine = await import(enginePath);
  let corpus = buildSyntheticCorpus({ milestone: "M1", seed });
  if (atomCount > corpus.atoms.length) {
    corpus = appendSyntheticAtoms(corpus, { count: atomCount - corpus.atoms.length, seed: "grow" });
  }
  const corpusAtoms = corpus.atoms.slice(0, atomCount);
  const policyContracts = Object.freeze({ member: sha("policy-member"), reviewer: sha("policy-reviewer") });
  const atoms = corpusAtoms.map((atom) => toEngineAtom(engine, atom, policyContracts));

  // Corpus-wide document frequencies for choosing query terms.  This is used
  // only to construct queries; scoring happens inside the engine.
  const documentFrequency = new Map();
  const perAtomFrequencies = new Map();
  for (const atom of corpusAtoms) {
    const frequencies = termFrequencies(atom.text);
    perAtomFrequencies.set(atom.atom_id, frequencies);
    for (const term of frequencies.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const frequentTerms = [...documentFrequency.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, 8)
    .map(([term]) => term);

  const directory = mkdtempSync(join(tmpdir(), "echo-retrieval-quality-"));
  try {
    const buildStarted = process.hrtime.bigint();
    const built = engine.buildReadableSearchGenerationV1(buildInput(engine, directory, atoms, policyContracts));
    const buildMs = Number(process.hrtime.bigint() - buildStarted) / 1e6;
    const active_generation = {
      generation_id: built.manifest.generation_id,
      manifest_sha256: built.manifest_sha256,
      retrieval_contract_sha256: built.manifest.retrieval_contract_sha256,
      exact_head: built.manifest.exact_head,
    };
    const warmStarted = process.hrtime.bigint();
    engine.warmReadableSearchActiveGenerationV1({ state_directory: directory, active_generation });
    const warmMs = Number(process.hrtime.bigint() - warmStarted) / 1e6;

    // Member-policy targets only, so one member reader can retrieve every target.
    const random = seededRandom(`${seed}:queries`);
    const memberAtoms = corpusAtoms.filter((atom) => atom.policy_id !== POLICY_RESTRICTED_REVIEWER);
    const targets = [];
    const used = new Set();
    while (targets.length < Math.min(queryCount, memberAtoms.length)) {
      const candidate = memberAtoms[Math.floor(random() * memberAtoms.length)];
      if (used.has(candidate.atom_id)) continue;
      used.add(candidate.atom_id);
      targets.push(candidate);
    }
    const reader = { principal_id: "prn_member_reader", membership_id: "mem_member_reader" };
    const classes = { content: [], question: [], question5: [] };
    const latencies = [];
    for (const target of targets) {
      const frequencies = perAtomFrequencies.get(target.atom_id);
      const rare = [...frequencies.keys()]
        .filter((term) => !frequentTerms.includes(term))
        .sort((left, right) => (documentFrequency.get(left) - documentFrequency.get(right)) || (left < right ? -1 : 1))
        .slice(0, 2);
      if (rare.length < 2) continue;
      const noise = frequentTerms.slice(0, 5);
      const queries = {
        content: rare.join(" "),
        question: `${noise[0]} ${rare[0]} ${noise[1]} ${rare[1]} ${noise[2]}`,
        question5: `${noise[0]} ${noise[1]} ${rare[0]} ${noise[2]} ${noise[3]} ${rare[1]} ${noise[4]}`,
      };
      for (const [className, query] of Object.entries(queries)) {
        const started = process.hrtime.bigint();
        const result = engine.searchReadableSearchGenerationV1({ state_directory: directory, active_generation, reader, query, limit: 10 });
        latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
        const rank = result.items.findIndex((item) => item.atom_id === `sha256:${target.atom_id}`);
        classes[className].push({ hit: rank !== -1, rr: rank === -1 ? 0 : 1 / (rank + 1), top1: rank === 0 });
      }
    }
    latencies.sort((left, right) => left - right);
    const summarize = (rows) => ({
      queries: rows.length,
      "recall@10": round(mean(rows.map((row) => (row.hit ? 1 : 0)))),
      "mrr@10": round(mean(rows.map((row) => row.rr))),
      "top1": round(mean(rows.map((row) => (row.top1 ? 1 : 0)))),
    });
    const result = Object.freeze({
      dataset: "synthetic corpus-v1 shape through the real engine",
      atoms: atoms.length,
      segments: built.manifest.segments.length,
      postings: corpusAtoms.length * 25,
      noise_terms: frequentTerms.slice(0, 5),
      noise_document_fraction: round(mean(frequentTerms.slice(0, 5).map((term) => documentFrequency.get(term) / corpusAtoms.length))),
      classes: Object.fromEntries(Object.entries(classes).map(([name, rows]) => [name, summarize(rows)])),
      build_ms: round(buildMs, 1),
      warm_ms: round(warmMs, 1),
      search_p50_ms: round(percentile(latencies, 0.5), 3),
      search_p95_ms: round(percentile(latencies, 0.95), 3),
      search_calls: latencies.length,
    });
    return result;
  } finally {
    engine.clearReadableSearchActiveGenerationV1();
    rmSync(directory, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  const result = await runSyntheticEngine({
    atomCount: Number(argument("atoms", 650)),
    queryCount: Number(argument("queries", 300)),
    seed: argument("seed", "retrieval-quality-v1"),
  });
  console.log(JSON.stringify(result, null, 2));
  const out = argument("out", null);
  if (out !== null) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}
