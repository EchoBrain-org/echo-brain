import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nearestRank95 } from "../grading.mjs";

const contract = JSON.parse(readFileSync(new URL("../metrics.v4.json", import.meta.url)));

test("nearest-rank p95 retains incorrect work as infinity", () => {
  assert.equal(nearestRank95([]), null);
  assert.equal(nearestRank95([...Array(18).fill(1), Infinity]), Infinity);
});

test("the future V4 metrics contract has every core threshold", () => {
  for (const name of ["search", "answer", "source_to_candidate", "approval_ack", "approval_to_search"]) assert.ok(contract.thresholds[name]);
});
