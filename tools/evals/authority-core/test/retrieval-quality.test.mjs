import assert from "node:assert/strict";
import { test } from "node:test";
import { runRetrievalQuality } from "../retrieval-quality.mjs";

test("target facts stay in the top ten when frequent terms are added to a query", () => {
  const result = runRetrievalQuality();
  assert.equal(result.atoms, 650);
  assert.equal(result.search_calls, 900);
  for (const [name, metrics] of Object.entries(result.classes)) {
    assert.equal(metrics.queries, 300, `${name}: every target must be measured`);
    // Separate from oracle agreement: targets are chosen before any scoring.
    // A term-frequency sum loses targets in the question/noise classes.
    assert.equal(metrics["recall@10"], 1, `${name}: target recall regressed`);
    assert.equal(metrics["mrr@10"], 1, `${name}: target ranking regressed`);
    assert.equal(metrics.top1, 1, `${name}: target must remain first`);
  }
});
