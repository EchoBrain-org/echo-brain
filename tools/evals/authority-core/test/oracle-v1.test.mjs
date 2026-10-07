import assert from "node:assert/strict";
import test from "node:test";
import { assertCorpusShape, buildSyntheticCorpus } from "../corpus-v1.mjs";
import { ANALYZER_SOURCE_SHA256, buildQueryPlan } from "../oracle-v1.mjs";

const reader = Object.freeze({ principal_id: "employee-000", membership_id: "membership-000" });

test("M1 generator is deterministic and fulfills corpus shape", () => {
  const first = buildSyntheticCorpus({ milestone: "M1", seed: "oracle-test" });
  const second = buildSyntheticCorpus({ milestone: "M1", seed: "oracle-test" });
  assert.equal(first.exact_head.hash, second.exact_head.hash);
  assert.equal(first.atoms.length, 350);
  assert.deepEqual(assertCorpusShape(first), { posting_count: 8750, age_buckets: Array(10).fill(35) });
  assert.equal(ANALYZER_SOURCE_SHA256, "340d7f303a96bfb59b9661ce998a6b12b7cfd4947322eae7cd9a794451415d91");
});

test("query plan contains broad, medium, selective and ordinary negative queries", () => {
  const corpus = buildSyntheticCorpus({ milestone: "M1", seed: "query-shape" });
  const plan = buildQueryPlan({ corpus, reader, count: 20, seed: "held-out" });
  const counts = Object.groupBy(plan, ({ kind }) => kind);
  assert.equal(counts.selective.length, 8);
  assert.equal(counts.medium.length, 6);
  assert.equal(counts.broad.length, 4);
  assert.equal(counts.negative.length, 2);
  assert.ok(counts.medium.every(({ candidate_count: count }) => count >= 100));
  assert.ok(counts.broad.every(({ candidate_count: count }) => count >= 200));
  assert.ok(counts.negative.every(({ candidate_count: count }) => count === 0));
});
