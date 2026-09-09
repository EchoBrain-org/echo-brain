#!/usr/bin/env node
/** Real-engine target recall on corpus-v1. No reference scorer or model call. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@echo-brain/federation-protocol";
import { analyzeDocument, appendSyntheticAtoms, buildSyntheticCorpus, seededRandom, POLICY_RESTRICTED_REVIEWER } from "./corpus-v1.mjs";
import { nearestRank95 } from "./grading.mjs";
import { withSearchGeneration } from "./search-generation-fixture.mjs";

const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
const round = (value, digits = 4) => Number(value.toFixed(digits));
const sha = (value) => createHash("sha256").update(value).digest("hex");

export function runRetrievalQuality({ atomCount = 650, queryCount = 300, seed = "retrieval-quality-v1" } = {}) {
  assert.ok(Number.isSafeInteger(atomCount) && atomCount > 0, "atoms must be a positive integer");
  assert.ok(Number.isSafeInteger(queryCount) && queryCount > 0, "queries must be a positive integer");
  let corpus = buildSyntheticCorpus({ milestone: "M1", seed });
  if (atomCount > corpus.atoms.length) corpus = appendSyntheticAtoms(corpus, { count: atomCount - corpus.atoms.length, seed: "grow" });
  const atoms = corpus.atoms.slice(0, atomCount);

  // Frequencies select query terms only. Production code supplies all scores.
  // Omit item kind here so queries use actual text rather than category postings.
  const documentFrequency = new Map();
  const perAtomFrequencies = new Map();
  for (const atom of atoms) {
    const frequencies = analyzeDocument(atom.text);
    perAtomFrequencies.set(atom.atom_id, frequencies);
    for (const term of frequencies.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const frequentTerms = [...documentFrequency.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, 8).map(([term]) => term);
  const memberAtoms = atoms.filter((atom) => atom.policy_id !== POLICY_RESTRICTED_REVIEWER);
  assert.ok(queryCount <= memberAtoms.length, "queries exceeds the number of member-readable targets");
  const random = seededRandom(`${seed}:queries`);
  const targets = new Map();
  while (targets.size < queryCount) {
    const candidate = memberAtoms[Math.floor(random() * memberAtoms.length)];
    targets.set(candidate.atom_id, candidate);
  }
  const queries = [];
  for (const target of targets.values()) {
    const rare = [...perAtomFrequencies.get(target.atom_id).keys()]
      .filter((term) => !frequentTerms.includes(term))
      .sort((left, right) => documentFrequency.get(left) - documentFrequency.get(right) || (left < right ? -1 : 1))
      .slice(0, 2);
    assert.equal(rare.length, 2, "target must supply two content terms");
    const noise = frequentTerms.slice(0, 5);
    const variants = {
      content: rare.join(" "),
      question: `${noise[0]} ${rare[0]} ${noise[1]} ${rare[1]} ${noise[2]}`,
      question5: `${noise[0]} ${noise[1]} ${rare[0]} ${noise[2]} ${noise[3]} ${rare[1]} ${noise[4]}`,
    };
    for (const [queryClass, query] of Object.entries(variants)) queries.push({ queryClass, query, target: `sha256:${target.atom_id}` });
  }
  const codeFiles = [
    "./corpus-v1.mjs", "./retrieval-quality.mjs", "./search-generation-fixture.mjs", "./grading.mjs",
    "../../../packages/organization-retrieval/dist/readable-search-engine-v1.js",
    "../../../packages/organization-retrieval/dist/application/analyzer.js",
  ];
  const provenance = {
    seed,
    query_targets: targets.size,
    corpus_sha256: sha(canonicalJson(atoms)),
    queries_sha256: sha(canonicalJson(queries)),
    code_sha256: Object.fromEntries(codeFiles.map((path) => [path, sha(readFileSync(new URL(path, import.meta.url)))])),
    runtime: { node: process.versions.node, unicode: process.versions.unicode, icu: process.versions.icu },
  };
  return withSearchGeneration(atoms, ({ manifest, buildMs, warmMs, search }) => {
    const reader = { principal_id: "prn_member_reader", membership_id: "mem_member_reader" };
    const classes = { content: [], question: [], question5: [] };
    const latencies = [];
    for (const { queryClass, query, target } of queries) {
      const started = performance.now();
      const result = search(reader, query);
      latencies.push(performance.now() - started);
      classes[queryClass].push(result.items.findIndex((item) => item.atom_id === target));
    }
    latencies.sort((left, right) => left - right);
    const summarize = (ranks) => ({
      queries: ranks.length,
      "recall@10": round(mean(ranks.map((rank) => Number(rank !== -1)))),
      "mrr@10": round(mean(ranks.map((rank) => rank === -1 ? 0 : 1 / (rank + 1)))),
      top1: round(mean(ranks.map((rank) => Number(rank === 0)))),
    });
    return {
      dataset: "synthetic corpus-v1 shape through the real engine",
      provenance,
      atoms: atoms.length,
      segments: manifest.segments.length,
      postings: atoms.length * 25,
      noise_terms: frequentTerms.slice(0, 5),
      noise_document_fraction: round(mean(frequentTerms.slice(0, 5).map((term) => documentFrequency.get(term) / atoms.length))),
      classes: Object.fromEntries(Object.entries(classes).map(([name, ranks]) => [name, summarize(ranks)])),
      build_ms: round(buildMs, 1),
      warm_ms: round(warmMs, 1),
      search_p50_ms: round(latencies[Math.ceil(latencies.length * 0.5) - 1], 3),
      search_p95_ms: round(nearestRank95(latencies), 3),
      search_calls: latencies.length,
    };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  let output;
  const flags = { "--atoms": "atomCount", "--queries": "queryCount", "--seed": "seed" };
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    assert.ok((flag in flags || flag === "--out") && value && !value.startsWith("--"), "usage: --atoms N --queries N --seed SEED --out PATH");
    if (flag === "--out") output = value;
    else options[flags[flag]] = flag === "--seed" ? value : Number(value);
  }
  const json = `${JSON.stringify(runRetrievalQuality(options), null, 2)}\n`;
  if (output) writeFileSync(output, json);
  process.stdout.write(json);
}
