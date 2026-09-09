#!/usr/bin/env node
/**
 * Scorer-level retrieval quality on BEIR SciFact (human relevance labels).
 *
 * Tokenization, query analysis and tie-break order come from the real
 * analyzer; only the scoring formula is swapped.  Documents are ranked by
 * (score desc, log_position desc, atom_order asc, id) exactly as Layer 3
 * orders candidates, with corpus order standing in for log position.
 *
 *   node tools/evals/retrieval-quality/scifact.mjs --data /path/to/scifact --scorer real
 *
 * The data directory must contain corpus.jsonl, queries.jsonl and
 * qrels_test.tsv (BEIR layout).  Nothing is downloaded by this script.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadAnalyzer } from "./analyzer-bridge.mjs";
import { collectStatistics, documentLength, resolveScorer } from "./scorers.mjs";
import { mean, ndcgAt, recallAt, reciprocalRank, round } from "./metrics.mjs";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function nfc(value) {
  return String(value ?? "").normalize("NFC");
}

export async function runScifact({ data, scorerName, k = 10 }) {
  const analyzer = await loadAnalyzer();
  const scorer = resolveScorer(scorerName, analyzer);
  const corpus = readJsonl(resolve(data, "corpus.jsonl"));
  const queries = readJsonl(resolve(data, "queries.jsonl"));
  const qrels = new Map();
  for (const line of readFileSync(resolve(data, "qrels_test.tsv"), "utf8").split("\n").slice(1)) {
    if (line.length === 0) continue;
    const [queryId, corpusId, score] = line.split("\t");
    if (Number(score) <= 0) continue;
    if (!qrels.has(queryId)) qrels.set(queryId, new Set());
    qrels.get(queryId).add(corpusId);
  }

  const started = process.hrtime.bigint();
  const documents = corpus.map((entry, index) => {
    const frequencies = analyzer.analyzeReadableSearchDocument(
      nfc(`${entry.title} ${entry.text}`),
    );
    return {
      id: String(entry._id),
      log_position: index + 1,
      frequencies,
      length: documentLength(frequencies),
    };
  });
  const statistics = collectStatistics(documents.map((document) => document.frequencies));
  const postings = new Map();
  for (const document of documents) {
    for (const term of document.frequencies.keys()) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push(document);
    }
  }
  const indexMs = Number(process.hrtime.bigint() - started) / 1e6;

  const perQuery = [];
  let skipped = 0;
  const queryTimes = [];
  for (const query of queries) {
    const relevant = qrels.get(String(query._id));
    if (relevant === undefined) continue;
    let terms;
    try {
      terms = analyzer.analyzeReadableSearchQuery(nfc(query.text));
    } catch {
      skipped += 1;
      continue;
    }
    const queryStarted = process.hrtime.bigint();
    const candidates = new Map();
    for (const term of terms) {
      for (const document of postings.get(term) ?? []) candidates.set(document.id, document);
    }
    const ranked = [...candidates.values()]
      .map((document) => ({
        id: document.id,
        score: scorer.score(document.frequencies, document.length, terms, statistics),
        log_position: document.log_position,
        atom_order: 0,
        atom_id: document.id,
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => analyzer.compareReadableSearchCandidates(left, right))
      .map((candidate) => candidate.id);
    queryTimes.push(Number(process.hrtime.bigint() - queryStarted) / 1e6);
    perQuery.push({
      query_id: String(query._id),
      terms: terms.length,
      candidates: candidates.size,
      ndcg: ndcgAt(ranked, relevant, k),
      recall: recallAt(ranked, relevant, k),
      recall_50: recallAt(ranked, relevant, 50),
      mrr: reciprocalRank(ranked, relevant, k),
    });
  }
  queryTimes.sort((left, right) => left - right);
  return Object.freeze({
    dataset: "BEIR/scifact (test qrels)",
    scorer: scorer.name,
    k,
    documents: documents.length,
    queries: perQuery.length,
    skipped_queries: skipped,
    [`ndcg@${k}`]: round(mean(perQuery.map((entry) => entry.ndcg))),
    [`recall@${k}`]: round(mean(perQuery.map((entry) => entry.recall))),
    "recall@50": round(mean(perQuery.map((entry) => entry.recall_50))),
    [`mrr@${k}`]: round(mean(perQuery.map((entry) => entry.mrr))),
    mean_candidates: round(mean(perQuery.map((entry) => entry.candidates)), 1),
    index_ms: round(indexMs, 1),
    query_p50_ms: round(queryTimes[Math.floor(queryTimes.length / 2)] ?? 0, 3),
    query_p95_ms: round(queryTimes[Math.max(0, Math.ceil(queryTimes.length * 0.95) - 1)] ?? 0, 3),
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  const data = argument("data", "/tmp/scifact");
  const scorerName = argument("scorer", "real");
  const out = argument("out", null);
  const result = await runScifact({ data, scorerName });
  console.log(JSON.stringify(result, null, 2));
  if (out !== null) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}
