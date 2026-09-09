import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bm25,
  bm25IdfFixed,
  collectStatistics,
  documentLength,
  FIXED_POINT_SCALE,
  tfSum,
} from "../scorers.mjs";
import { mean, ndcgAt, percentile, recallAt, reciprocalRank } from "../metrics.mjs";

const doc = (entries) => new Map(entries);

test("tfSum adds raw term frequencies and ignores absent terms", () => {
  assert.equal(tfSum(doc([["a", 3], ["b", 1]]), 4, ["a", "b", "zzz"]), 4);
});

test("bm25 idf is a fixed-point integer that falls as document frequency rises", () => {
  const rare = bm25IdfFixed(1, 1000);
  const common = bm25IdfFixed(900, 1000);
  assert.ok(Number.isInteger(rare) && Number.isInteger(common));
  assert.ok(rare > common);
  assert.equal(bm25IdfFixed(0, 1000), 0);
  // ln(1 + (1000 - 1 + 0.5) / 1.5) = ln(667.333...) = 6.5033...
  assert.equal(rare, Math.round(Math.log(1 + 999.5 / 1.5) * FIXED_POINT_SCALE));
});

test("bm25 prefers the document matching the rare term over one matching the common term", () => {
  const documents = [
    doc([["common", 1], ["rare", 1]]),
    doc([["common", 2]]),
    doc([["common", 1]]),
    doc([["common", 1], ["other", 1]]),
  ];
  const statistics = collectStatistics(documents);
  const query = ["common", "rare"];
  const scores = documents.map((frequencies) =>
    bm25(frequencies, documentLength(frequencies), query, statistics),
  );
  assert.ok(scores[0] > scores[1], "rare match outranks doubled common match");
  assert.equal(tfSum(documents[0], 2, query), tfSum(documents[1], 2, query), "tfSum ties them");
  assert.ok(scores.every((score) => Number.isInteger(score)));
});

test("bm25 saturates term frequency", () => {
  const documents = [doc([["x", 1]]), doc([["x", 10]]), doc([["y", 1]])];
  const statistics = collectStatistics(documents);
  const one = bm25(documents[0], 1, ["x"], statistics);
  const ten = bm25(documents[1], 10, ["x"], statistics);
  assert.ok(ten > one);
  assert.ok(ten < one * 3, "tf 10 scores well under 3x tf 1");
});

test("controlled terms use a constant weight instead of idf", () => {
  const documents = [doc([["decision", 1], ["a", 1]]), doc([["decision", 1], ["b", 1]])];
  const statistics = collectStatistics(documents);
  const withIdf = bm25(documents[0], 2, ["decision"], statistics);
  const constant = bm25(documents[0], 2, ["decision"], statistics, {
    controlled_terms: new Set(["decision"]),
  });
  assert.ok(withIdf < constant, "a term in every document would otherwise score near zero");
});

test("ranked metrics", () => {
  const relevant = new Set(["r1", "r2"]);
  assert.equal(reciprocalRank(["x", "r1", "r2"], relevant, 10), 0.5);
  assert.equal(recallAt(["x", "r1", "y"], relevant, 3), 0.5);
  assert.equal(recallAt(["x", "r1", "r2"], relevant, 2), 0.5);
  assert.equal(ndcgAt(["r1", "r2"], relevant, 10), 1);
  assert.ok(ndcgAt(["x", "r1", "r2"], relevant, 10) < 1);
  assert.equal(ndcgAt(["x", "y"], relevant, 10), 0);
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
});
